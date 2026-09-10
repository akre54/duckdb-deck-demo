/**
 * The planner. Logical graph -> physical plan, once at compile time.
 *
 * The cost model is the whole point, so it is stated explicitly rather than buried:
 *
 *   volume-reducing ops        -> SQL   (filter, aggregate: fewer bytes to upload)
 *   volume-preserving per-row  -> GPU   (attribute math: reparameterizable by a
 *                                        uniform write, with no requery and no
 *                                        buffer reallocation)
 *   GPU-impossible (aggregates)-> SQL   (forced, from the op table)
 *   SQL-impossible (ramp, swizzle) -> GPU (forced, from the op table)
 *
 * `policy` lets you override the middle rule and push per-row math into SQL too, so
 * the two strategies can be measured against each other instead of argued about.
 */

import {
  type Expr, parseExpr, columnsOf, paramsOf, enginesFor, isAggregate, widthOf,
} from './expr.js';
import { toSql, toSqlColumns, quoteIdent } from './backends/sql.js';
import { toWgsl, wgslType, type Resolver } from './backends/wgsl.js';
import {
  type Graph, type CoreNode, type RenderNode, type Bin2dNode, type StatsNode,
  type ParamSpec, desugar, statExpr, statParamName, type RampName,
} from './types.js';

export type Policy = 'auto' | 'sql-first' | 'gpu-first';

/** Column name -> component count. Source columns are scalars; attributes may be wider. */
export type Schema = Map<string, number>;

export interface AttributeDecl {
  name: string;
  width: number;
  /** `arrow` = came straight out of the query; `derived` = written by a kernel. */
  provenance: 'arrow' | 'derived';
  /** For arrow attributes: the query column names backing each component. */
  sourceColumns?: string[];
}

export interface KernelPlan {
  id: string;
  /** WGSL source for the whole compute module. */
  code: string;
  /** Attributes read from GPU buffers (bound read-only). */
  reads: string[];
  /** Attributes written (bound read-write). */
  writes: string[];
  /** Uniform param names this kernel reads, in struct field order. */
  params: string[];
  /** True if the kernel calls `ramp()` and therefore needs the LUT bound. */
  usesRamp: boolean;
  /** Which graph nodes fused into this kernel — for the inspector. */
  nodeIds: string[];
}

export interface StatsPlan {
  nodeId: string;
  sql: string;
  /** Result column name -> the parameter it publishes. */
  outputs: { column: string; param: string }[];
  /** Parameter names in `?` bind order. Stats inherit the row query's WHERE clause. */
  params: string[];
}

export interface PhysicalPlan {
  /** The row query. Positional `?` binds listed in `sqlParams`. */
  sql: string;
  sqlParams: string[];
  /** Stats queries, run before the row query so their results can bind into it. */
  stats: StatsPlan[];
  kernels: KernelPlan[];
  /**
   * The nodes assigned to the GPU, as parsed IR, in evaluation order. Exposed so an
   * alternative backend can evaluate the identical graph — the CPU backend feeding
   * deck.gl uses this, which is what makes that comparison a comparison.
   */
  gpuStage: { nodeId: string; name: string; expr: Expr }[];
  attributes: AttributeDecl[];
  /** Uniform struct field order, shared by every kernel and the render passes. */
  uniformParams: string[];
  params: Record<string, ParamSpec>;
  render: RenderNode;
  /** The single color ramp this graph uses, if any. */
  ramp?: RampName;
  bin2d?: Bin2dNode;
  /** Per-node engine assignment, for the inspector. */
  assignments: { nodeId: string; type: string; engine: 'sql' | 'gpu' | 'scalar' | 'render' | 'source'; why: string }[];
  notes: string[];
  /** GPU-evaluated filters become a mask attribute the point shader discards on. */
  maskAttribute?: string;
}

export class PlanError extends Error {}

const WORKGROUP = 256;

// ---------------------------------------------------------------------------

export function plan(graph: Graph, sourceSchema: Schema, policy: Policy = 'auto'): PhysicalPlan {
  const { nodes, notes: sugarNotes, ramp } = desugar(graph);
  const notes = [...sugarNotes];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // --- pick the output and walk its ancestry into a linear chain ------------
  const renderNode = (graph.output ? byId.get(graph.output) : [...nodes].reverse().find((n) => n.type === 'render')) as
    | RenderNode | undefined;
  if (!renderNode || renderNode.type !== 'render') {
    throw new PlanError('Graph has no render node');
  }

  const chain: CoreNode[] = [];
  const statsNodes: StatsNode[] = [];
  {
    let cursor: CoreNode | undefined = renderNode;
    const guard = new Set<string>();
    while (cursor) {
      if (guard.has(cursor.id)) throw new PlanError(`Cycle through node ${cursor.id}`);
      guard.add(cursor.id);
      chain.unshift(cursor);
      const inputId: string | undefined = 'input' in cursor ? cursor.input : undefined;
      if (!inputId) break;
      const next = byId.get(inputId);
      if (!next) throw new PlanError(`Node ${cursor.id} references unknown input ${inputId}`);
      cursor = next;
    }
  }
  // Stats nodes hang off the chain rather than sitting in it.
  for (const n of nodes) {
    if (n.type === 'stats') {
      if (!chain.some((c) => c.id === n.input)) {
        throw new PlanError(`Stats node ${n.id} reads ${n.input}, which is not upstream of the render node`);
      }
      statsNodes.push(n);
    }
  }

  const source = chain[0];
  if (source.type !== 'source') throw new PlanError('Chain does not start at a source node');

  // --- state threaded through the walk -------------------------------------
  const schema: Schema = new Map(sourceSchema);
  const assignments: PhysicalPlan['assignments'] = [
    { nodeId: source.id, type: 'source', engine: 'source', why: source.dataset.kind === 'synthetic' ? `${source.dataset.rows} synthetic rows` : source.dataset.url },
  ];

  let sqlStageOpen = true;
  const wherePredicates: { sql: string; params: string[] }[] = [];
  const selectItems: { items: string[]; params: string[] }[] = [];
  /** Attributes materialized by the SQL query, in declaration order. */
  const arrowAttributes: AttributeDecl[] = [];
  let aggregate: { groupBy: string[]; aggs: { name: string; expr: Expr }[] } | undefined;

  /** GPU stage: attribute nodes to fuse, plus GPU-side filters. */
  const gpuNodes: { nodeId: string; name: string; expr: Expr }[] = [];
  let maskAttribute: string | undefined;

  const parseOrThrow = (src: string, nodeId: string): Expr => {
    try {
      return parseExpr(src);
    } catch (err) {
      throw new PlanError(`Node ${nodeId}: ${(err as Error).message}`);
    }
  };

  const requireColumns = (e: Expr, nodeId: string) => {
    for (const c of columnsOf(e)) {
      if (!schema.has(c)) {
        throw new PlanError(
          `Node ${nodeId} references unknown attribute '${c}'. Available: ${[...schema.keys()].join(', ')}`,
        );
      }
    }
  };

  // --- the walk ------------------------------------------------------------
  for (const node of chain.slice(1)) {
    switch (node.type) {
      case 'filter': {
        const e = parseOrThrow(node.predicate, node.id);
        requireColumns(e, node.id);
        const engines = enginesFor(e);
        const canSql = engines.has('sql') && sqlStageOpen && !isAggregate(e);
        if (canSql && policy !== 'gpu-first') {
          const emitted = toSql(e);
          wherePredicates.push({ sql: emitted.code, params: emitted.params });
          assignments.push({ nodeId: node.id, type: 'filter', engine: 'sql', why: 'volume-reducing, SQL-expressible -> WHERE clause' });
        } else {
          if (!engines.has('gpu')) {
            throw new PlanError(`Node ${node.id}: predicate is neither SQL- nor GPU-expressible`);
          }
          // GPU filters cannot remove rows from a buffer cheaply, so they become a
          // mask the point shader discards on. Honest about the cost: the row still
          // occupies memory and an instance slot.
          sqlStageOpen = false;
          maskAttribute = '__mask';
          const prior = gpuNodes.find((g) => g.name === '__mask');
          const combined: Expr = prior
            ? { kind: 'binary', op: '&&', left: prior.expr, right: e }
            : e;
          if (prior) prior.expr = combined;
          else gpuNodes.push({ nodeId: node.id, name: '__mask', expr: combined });
          schema.set('__mask', 1);
          assignments.push({
            nodeId: node.id,
            type: 'filter',
            engine: 'gpu',
            why: sqlStageOpen ? 'policy: gpu-first' : 'not SQL-expressible -> discard mask (row still occupies an instance slot)',
          });
          notes.push(`${node.id}: evaluated as a GPU discard mask; rows are not actually removed`);
        }
        break;
      }

      case 'aggregate': {
        if (!sqlStageOpen) {
          throw new PlanError(
            `Node ${node.id}: aggregate cannot run after the SQL stage has closed. Move it upstream of the GPU-only nodes.`,
          );
        }
        if (aggregate) throw new PlanError(`Node ${node.id}: only one aggregate per chain in this prototype`);
        const aggs = node.aggs.map((a) => {
          const e = parseOrThrow(a.expr, node.id);
          requireColumns(e, node.id);
          if (!isAggregate(e)) {
            throw new PlanError(`Node ${node.id}: agg '${a.name}' (${a.expr}) is not an aggregate expression`);
          }
          return { name: a.name, expr: e };
        });
        for (const g of node.groupBy) {
          if (!schema.has(g)) throw new PlanError(`Node ${node.id}: unknown groupBy column '${g}'`);
        }
        aggregate = { groupBy: node.groupBy, aggs };
        // After aggregation the schema is exactly the group keys plus the aggregates.
        const keep = new Set([...node.groupBy, ...aggs.map((a) => a.name)]);
        for (const key of [...schema.keys()]) if (!keep.has(key)) schema.delete(key);
        for (const a of aggs) schema.set(a.name, 1);
        assignments.push({ nodeId: node.id, type: 'aggregate', engine: 'sql', why: 'aggregates collapse rows; no per-invocation GPU analogue' });
        break;
      }

      case 'attribute': {
        const e = parseOrThrow(node.expr, node.id);
        requireColumns(e, node.id);
        if (isAggregate(e)) {
          throw new PlanError(`Node ${node.id}: attribute expressions cannot aggregate; use an 'aggregate' node`);
        }
        const engines = enginesFor(e);
        const width = widthOf(e, (n) => schema.get(n) ?? 1);

        const sqlPossible = engines.has('sql') && sqlStageOpen;
        const gpuPossible = engines.has('gpu');
        if (!sqlPossible && !gpuPossible) {
          throw new PlanError(
            `Node ${node.id}: expression needs SQL (not GPU-expressible) but the SQL stage is already closed`,
          );
        }

        // The cost model, applied.
        const useSql = policy === 'sql-first' ? sqlPossible : !gpuPossible;

        if (useSql) {
          const emitted = toSqlColumns(e, node.name);
          selectItems.push(emitted);
          arrowAttributes.push({
            name: node.name,
            width,
            provenance: 'arrow',
            sourceColumns: width === 1 ? [node.name] : Array.from({ length: width }, (_, i) => `${node.name}_${i}`),
          });
          assignments.push({
            nodeId: node.id,
            type: 'attribute',
            engine: 'sql',
            why: policy === 'sql-first' ? 'policy: sql-first' : 'no GPU equivalent for one of its functions',
          });
        } else {
          sqlStageOpen = false;
          gpuNodes.push({ nodeId: node.id, name: node.name, expr: e });
          assignments.push({
            nodeId: node.id,
            type: 'attribute',
            engine: 'gpu',
            why: engines.has('sql')
              ? 'volume-preserving per-row math -> kernel, so value params rebind via a uniform write'
              : 'not SQL-expressible (ramp/swizzle)',
          });
        }
        schema.set(node.name, width);
        break;
      }

      case 'bin2d':
        assignments.push({ nodeId: node.id, type: 'bin2d', engine: 'gpu', why: 'atomic binning compute pass' });
        break;

      case 'render':
        assignments.push({ nodeId: node.id, type: 'render', engine: 'render', why: `mode=${node.mode}` });
        break;

      case 'stats':
        // Handled separately below; a stats node in the chain is a pass-through.
        break;

      default:
        throw new PlanError(`Unhandled node type in chain: ${(node as { type: string }).type}`);
    }
  }

  const binNode = chain.find((n): n is Bin2dNode => n.type === 'bin2d');

  // --- stats queries -------------------------------------------------------
  const stats: StatsPlan[] = statsNodes.map((s) => {
    if (!sourceSchema.has(s.column) && !schema.has(s.column)) {
      throw new PlanError(`Stats node ${s.id}: unknown column '${s.column}'`);
    }
    const outputs = s.ops.map((op) => ({ column: `${op}`, param: statParamName(s.id, op) }));
    // DuckDB binds `?` by order of appearance in the SQL text, so SELECT-list params
    // must be collected before WHERE params.
    const params: string[] = [];
    const items = s.ops.map((op) => {
      const emitted = toSql(parseExpr(statExpr(op, s.column)));
      params.push(...emitted.params);
      return `${emitted.code} AS ${quoteIdent(op)}`;
    });
    // Stats read the filtered source, so they share the WHERE clause. They deliberately
    // do not share the aggregate: a scale domain over pre-aggregation rows is a
    // different question from one over groups.
    const where = wherePredicates.length ? ` WHERE ${wherePredicates.map((p) => p.sql).join(' AND ')}` : '';
    params.push(...wherePredicates.flatMap((p) => p.params));
    return {
      nodeId: s.id,
      sql: `SELECT ${items.join(', ')} FROM ${SOURCE_RELATION}${where}`,
      outputs,
      params,
    };
  });
  const statsParams = new Set(stats.flatMap((s) => s.outputs.map((o) => o.param)));

  // --- assemble the row query ---------------------------------------------
  const sqlParams: string[] = [];
  let sql: string;
  if (aggregate) {
    const groupItems = aggregate.groupBy.map((g) => quoteIdent(g));
    const aggItems = aggregate.aggs.map((a) => {
      const em = toSql(a.expr);
      sqlParams.push(...em.params);
      return `${em.code} AS ${quoteIdent(a.name)}`;
    });
    const where = wherePredicates.length ? ` WHERE ${wherePredicates.map((p) => p.sql).join(' AND ')}` : '';
    // Positional binds follow the order the `?` appear in the text: SELECT, then WHERE.
    sqlParams.push(...wherePredicates.flatMap((p) => p.params));
    sql = `SELECT ${[...groupItems, ...aggItems].join(', ')} FROM ${SOURCE_RELATION}${where} GROUP BY ${groupItems.join(', ')}`;
    for (const g of aggregate.groupBy) arrowAttributes.unshift({ name: g, width: 1, provenance: 'arrow', sourceColumns: [g] });
    for (const a of aggregate.aggs) arrowAttributes.push({ name: a.name, width: 1, provenance: 'arrow', sourceColumns: [a.name] });
  } else {
    // Projection pushdown: only the columns something downstream actually reads.
    const needed = new Set<string>();
    for (const g of gpuNodes) for (const c of columnsOf(g.expr)) needed.add(c);
    for (const item of selectItems) void item; // SQL-side attributes are already in the list
    for (const s of statsNodes) needed.add(s.column);
    if (binNode) {
      for (const src of [binNode.weight].filter(Boolean) as string[]) {
        for (const c of columnsOf(parseExpr(src))) needed.add(c);
      }
    }
    // Only real source columns can be selected; attributes produced by SQL nodes are
    // already select items, and attributes produced by kernels do not exist yet.
    const passthrough = [...needed].filter((c) => sourceSchema.has(c)).sort();

    const items = [
      ...passthrough.map((c) => quoteIdent(c)),
      ...selectItems.flatMap((s) => s.items),
    ];
    // Positional binds follow the order the `?` appear in the text: SELECT, then WHERE.
    for (const s of selectItems) sqlParams.push(...s.params);
    sqlParams.push(...wherePredicates.flatMap((p) => p.params));
    if (items.length === 0) items.push('1 AS "__unit"');
    const where = wherePredicates.length ? ` WHERE ${wherePredicates.map((p) => p.sql).join(' AND ')}` : '';
    sql = `SELECT ${items.join(', ')} FROM ${SOURCE_RELATION}${where}`;
    for (const c of passthrough) arrowAttributes.unshift({ name: c, width: 1, provenance: 'arrow', sourceColumns: [c] });
    notes.push(`projection pushdown: ${passthrough.length} of ${sourceSchema.size} source columns selected`);
  }

  // --- fuse the GPU stage into one kernel ---------------------------------
  const derivedAttributes: AttributeDecl[] = [];
  const kernels: KernelPlan[] = [];
  const uniformParams = new Set<string>();

  if (gpuNodes.length > 0) {
    const kernel = buildKernel(gpuNodes, arrowAttributes, derivedAttributes);
    kernels.push(kernel);
    for (const p of kernel.params) uniformParams.add(p);
  }

  // Params referenced anywhere, plus the stats-published ones.
  const declaredParams: Record<string, ParamSpec> = { ...(graph.params ?? {}) };
  for (const p of statsParams) {
    if (!declaredParams[p]) declaredParams[p] = { value: 0, kind: 'value', label: p };
  }
  for (const p of [...sqlParams, ...uniformParams]) {
    if (!declaredParams[p]) {
      throw new PlanError(`Parameter '${p}' is referenced but not declared in graph.params`);
    }
  }

  const attributes = [...arrowAttributes, ...derivedAttributes];

  // --- validate the render bindings ---------------------------------------
  if (renderNode.mode === 'points') {
    const posName = renderNode.position ?? 'P';
    const pos = attributes.find((a) => a.name === posName);
    if (!pos) throw new PlanError(`Render node needs attribute '${posName}' for position; none was produced`);
    if (pos.width < 2) throw new PlanError(`Position attribute '${posName}' must have 2+ components, got ${pos.width}`);
  } else if (!binNode) {
    throw new PlanError(`Render mode 'heatmap' requires a bin2d node upstream`);
  }

  return {
    sql,
    sqlParams,
    stats,
    kernels,
    gpuStage: gpuNodes,
    attributes,
    uniformParams: [...uniformParams],
    params: declaredParams,
    render: renderNode,
    ramp,
    bin2d: binNode,
    assignments,
    notes,
    maskAttribute,
  };
}

/** The relation name the executor registers the source table under. */
export const SOURCE_RELATION = '"src"';

// ---------------------------------------------------------------------------
// Kernel codegen
// ---------------------------------------------------------------------------

function buildKernel(
  gpuNodes: { nodeId: string; name: string; expr: Expr }[],
  arrowAttributes: AttributeDecl[],
  derivedOut: AttributeDecl[],
): KernelPlan {
  /** SSA: attribute name -> current WGSL local and width. */
  const live = new Map<string, { code: string; width: number }>();
  let ssa = 0;

  const reads = new Set<string>();
  const writes: string[] = [];
  const params = new Set<string>();
  const widths = new Map<string, number>();
  for (const a of arrowAttributes) widths.set(a.name, a.width);

  const body: string[] = [];
  let usesRamp = false;

  const resolve: Resolver = (name) => {
    const existing = live.get(name);
    if (existing) return existing;
    const width = widths.get(name);
    if (width === undefined) {
      throw new PlanError(`Kernel references attribute '${name}' that no upstream stage produced`);
    }
    reads.add(name);
    const local = `r${ssa++}`;
    const code = width === 1 ? `${bufName(name)}[i]` : `${wgslType(width)}(${range(width).map((c) => `${bufName(name)}[i * ${width}u + ${c}u]`).join(', ')})`;
    body.push(`  let ${local} = ${code};`);
    const val = { code: local, width };
    live.set(name, val);
    return val;
  };

  for (const node of gpuNodes) {
    const emitted = toWgsl(node.expr, resolve);
    for (const p of emitted.params) params.add(p);
    if (/\bsampleRamp\(/.test(emitted.code)) usesRamp = true;
    const local = `v${ssa++}`;
    body.push(`  // ${node.nodeId}: ${node.name}`);
    body.push(`  let ${local} = ${emitted.code};`);
    // Rebind the name so a later node reading it sees the new value, not a buffer load.
    live.set(node.name, { code: local, width: emitted.width });
    widths.set(node.name, emitted.width);
    if (!writes.includes(node.name)) writes.push(node.name);
    derivedOut.push({ name: node.name, width: emitted.width, provenance: 'derived' });
    if (emitted.width === 1) {
      body.push(`  ${bufName(node.name)}[i] = ${local};`);
    } else {
      for (const c of range(emitted.width)) {
        body.push(`  ${bufName(node.name)}[i * ${emitted.width}u + ${c}u] = ${local}[${c}];`);
      }
    }
  }

  // Dedupe: a name both read and written needs one binding, read_write.
  const readOnly = [...reads].filter((r) => !writes.includes(r));

  const bindings: string[] = [];
  let slot = 0;
  const paramList = [...params];
  bindings.push(
    paramList.length > 0
      ? `struct Params {\n${paramList.map((p) => `  ${p}: f32,`).join('\n')}\n};\n@group(0) @binding(${slot++}) var<uniform> params: Params;`
      : `@group(0) @binding(${slot++}) var<uniform> params: vec4<f32>;`,
  );
  // Not `meta` — that is a WGSL reserved keyword.
  bindings.push(`@group(0) @binding(${slot++}) var<uniform> rowInfo: vec4<u32>; // .x = row count`);
  if (usesRamp) {
    bindings.push(`@group(0) @binding(${slot++}) var<storage, read> ramp_lut: array<vec4<f32>>;`);
  }
  for (const name of readOnly) {
    bindings.push(`@group(0) @binding(${slot++}) var<storage, read> ${bufName(name)}: array<f32>;`);
  }
  for (const name of writes) {
    bindings.push(`@group(0) @binding(${slot++}) var<storage, read_write> ${bufName(name)}: array<f32>;`);
  }

  const prelude = usesRamp
    ? `
fn sampleRamp(t: f32) -> vec3<f32> {
  let n = f32(arrayLength(&ramp_lut) - 1u);
  let x = clamp(t, 0.0, 1.0) * n;
  let i0 = u32(floor(x));
  let i1 = min(i0 + 1u, u32(n));
  let f = x - floor(x);
  return mix(ramp_lut[i0].rgb, ramp_lut[i1].rgb, f);
}
`
    : '';

  const code = `${bindings.join('\n')}
${prelude}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= rowInfo.x) { return; }
${body.join('\n')}
}
`;

  return {
    id: 'kernel0',
    code,
    reads: readOnly,
    writes,
    params: paramList,
    usesRamp,
    nodeIds: gpuNodes.map((n) => n.nodeId),
  };
}

function bufName(attr: string): string {
  return `b_${attr.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

export { bufName, WORKGROUP };
export { paramsOf };
