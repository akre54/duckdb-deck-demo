/**
 * Phase 1 of planning: turn a graph into a costable, placeable description.
 *
 * Analysis answers only questions with objective answers — what is the topological order,
 * which engines *could* run each node, how wide is each attribute, how many scalar
 * operations does each expression cost. It makes no placement decisions. Keeping this
 * separate from `optimize` and `emit` is the change that makes a cost model possible at
 * all: in the original single-pass planner the decision was interleaved with codegen, so
 * there was no moment at which a plan existed as data that could be priced or compared.
 */

import {
  type Expr, parseExpr, columnsOf, enginesFor, isAggregate, widthOf,
} from './expr.js';
import {
  type Graph, type CoreNode, type RenderNode, type Bin2dNode, type StatsNode,
  type SourceNode, type ParamSpec, type RampName, desugar,
} from './types.js';

export type Stage = 'sql' | 'cpu' | 'gpu';

export class PlanError extends Error {}

/** Column or attribute name -> component count. */
export type Schema = Map<string, number>;

export interface AnalyzedNode {
  id: string;
  node: CoreNode;
  kind: 'filter' | 'aggregate' | 'attribute' | 'bin2d';
  /** Attribute nodes: the name they write. */
  name?: string;
  /** Filter predicate or attribute expression. */
  expr?: Expr;
  /** Aggregate nodes: parsed aggregate expressions, so emit does not re-parse. */
  aggs?: { name: string; expr: Expr }[];
  /** Aggregate nodes: the group-by columns. */
  groupBy?: string[];
  /** Result width for attribute nodes. */
  width: number;
  /** Approximate scalar operation count, the marginal-cost input. */
  ops: number;
  /** Engines that could evaluate this node, ignoring stage ordering. */
  feasible: Set<Stage>;
  /** True for wrangle locals, which the inspector hides. */
  internal: boolean;
  /** Attributes this node reads. */
  reads: string[];
  /** Parameters this node reads. */
  params: string[];
}

export interface Analysis {
  source: SourceNode;
  render: RenderNode;
  bin2d?: Bin2dNode;
  statsNodes: StatsNode[];
  /** Placeable nodes in topological order. */
  order: AnalyzedNode[];
  sourceSchema: Schema;
  /** Final attribute widths, after every node has run. */
  widths: Schema;
  /** Group-by columns of the single aggregate, if any. */
  groupBy: string[];
  aggregateNames: string[];
  ramp?: RampName;
  params: Record<string, ParamSpec>;
  notes: string[];
}

/**
 * The CPU (generated JS) backend implements every function the GPU backend does — see the
 * `JS_FN` table in `backends/js.ts` — so a node is CPU-feasible exactly when it is
 * GPU-feasible. Stated once here rather than implied by two parallel checks that could
 * drift.
 */
function feasibleStages(e: Expr): Set<Stage> {
  const engines = enginesFor(e);
  const out = new Set<Stage>();
  if (engines.has('sql')) out.add('sql');
  if (engines.has('gpu')) {
    out.add('gpu');
    out.add('cpu');
  }
  return out;
}

/**
 * Scalar operations in an expression, as a cost proxy.
 *
 * Counts interior tree nodes and multiplies by the result width, since an elementwise
 * vec3 operation costs three scalar operations. Crude, but it is a *relative* measure and
 * every engine is charged with the same yardstick, which is what the optimizer needs.
 */
export function opCount(e: Expr, width: number): number {
  let interior = 0;
  const walk = (n: Expr): void => {
    switch (n.kind) {
      case 'unary': interior++; walk(n.operand); break;
      case 'binary': interior++; walk(n.left); walk(n.right); break;
      case 'call': interior++; n.args.forEach(walk); break;
      case 'cond': interior += 1; walk(n.test); walk(n.then); walk(n.else); break;
      case 'vec': n.components.forEach(walk); break;
      case 'swizzle': walk(n.target); break;
      default: break;
    }
  };
  walk(e);
  return Math.max(1, interior) * Math.max(1, width);
}

export function analyze(graph: Graph, sourceSchema: Schema): Analysis {
  const { nodes, notes: sugarNotes, ramp } = desugar(graph);
  const notes = [...sugarNotes];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const source = nodes.find((n): n is SourceNode => n.type === 'source');
  if (!source) throw new PlanError('Graph has no source node');

  const render = (graph.output ? byId.get(graph.output) : [...nodes].reverse().find((n) => n.type === 'render')) as
    | RenderNode | undefined;
  if (!render || render.type !== 'render') throw new PlanError('Graph has no render node');

  // --- topological order over the ancestry of the render node --------------
  const ordered = topoSort(nodes, byId, render, notes);

  const schema: Schema = new Map(sourceSchema);
  const order: AnalyzedNode[] = [];
  const statsNodes: StatsNode[] = [];
  let groupBy: string[] = [];
  let aggregateNames: string[] = [];
  let sawAggregate = false;

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

  for (const node of ordered) {
    switch (node.type) {
      case 'source':
      case 'render':
        break;

      case 'stats':
        statsNodes.push(node);
        break;

      case 'filter': {
        const expr = parseOrThrow(node.predicate, node.id);
        requireColumns(expr, node.id);
        const feasible = feasibleStages(expr);
        if (feasible.size === 0) {
          throw new PlanError(`Node ${node.id}: predicate is neither SQL- nor GPU-expressible`);
        }
        order.push({
          id: node.id, node, kind: 'filter', expr, width: 1,
          ops: opCount(expr, 1), feasible, internal: false,
          reads: columnsOf(expr), params: paramsOfExpr(expr),
        });
        break;
      }

      case 'aggregate': {
        if (sawAggregate) {
          throw new PlanError(`Node ${node.id}: only one aggregate per graph in this prototype`);
        }
        sawAggregate = true;
        const aggs = node.aggs.map((a) => {
          const expr = parseOrThrow(a.expr, node.id);
          requireColumns(expr, node.id);
          if (!isAggregate(expr)) {
            throw new PlanError(`Node ${node.id}: agg '${a.name}' (${a.expr}) is not an aggregate expression`);
          }
          return { name: a.name, expr };
        });
        for (const g of node.groupBy) {
          if (!schema.has(g)) throw new PlanError(`Node ${node.id}: unknown groupBy column '${g}'`);
        }
        groupBy = node.groupBy;
        aggregateNames = aggs.map((a) => a.name);

        // The aggregate reshapes the namespace: only group keys and aggregates survive.
        const keep = new Set([...node.groupBy, ...aggregateNames]);
        for (const key of [...schema.keys()]) if (!keep.has(key)) schema.delete(key);
        for (const name of aggregateNames) schema.set(name, 1);

        order.push({
          id: node.id, node, kind: 'aggregate', width: 1, aggs, groupBy: node.groupBy,
          ops: aggs.reduce((s, a) => s + opCount(a.expr, 1), 0),
          // Aggregates collapse rows; there is no per-invocation GPU or CPU analogue.
          feasible: new Set<Stage>(['sql']),
          internal: false,
          reads: aggs.flatMap((a) => columnsOf(a.expr)),
          params: aggs.flatMap((a) => paramsOfExpr(a.expr)),
        });
        break;
      }

      case 'attribute': {
        const expr = typeof node.expr === 'string' ? parseOrThrow(node.expr, node.id) : node.expr;
        requireColumns(expr, node.id);
        if (isAggregate(expr)) {
          throw new PlanError(`Node ${node.id}: attribute expressions cannot aggregate; use an 'aggregate' node`);
        }
        const width = widthOf(expr, (n) => schema.get(n) ?? 1);
        const feasible = feasibleStages(expr);
        order.push({
          id: node.id, node, kind: 'attribute', name: node.name, expr, width,
          ops: opCount(expr, width), feasible,
          internal: node.name.startsWith('__'),
          reads: columnsOf(expr), params: paramsOfExpr(expr),
        });
        schema.set(node.name, width);
        break;
      }

      case 'bin2d':
        order.push({
          id: node.id, node, kind: 'bin2d', width: 1,
          // Atomic binning has no SQL or CPU form in this prototype.
          ops: 4, feasible: new Set<Stage>(['gpu']), internal: false, reads: [], params: [],
        });
        break;

      default:
        throw new PlanError(`Unhandled node type: ${(node as { type: string }).type}`);
    }
  }

  for (const s of statsNodes) {
    if (!sourceSchema.has(s.column) && !schema.has(s.column)) {
      throw new PlanError(`Stats node ${s.id}: unknown column '${s.column}'`);
    }
  }

  return {
    source,
    render,
    bin2d: ordered.find((n): n is Bin2dNode => n.type === 'bin2d'),
    statsNodes,
    order,
    sourceSchema,
    widths: schema,
    groupBy,
    aggregateNames,
    ramp,
    params: { ...(graph.params ?? {}) },
    notes,
  };
}

// ---------------------------------------------------------------------------

/**
 * Kahn's algorithm over the render node's ancestry.
 *
 * Nodes not upstream of the render output are dropped — dead-code elimination, and the
 * reason an unused branch costs nothing. Ties are broken by the graph's declaration order
 * so the resulting plan is deterministic; a different tie-break would produce a different
 * (equally legal) stage boundary and make the EXPLAIN output unstable between runs.
 */
function topoSort(
  nodes: CoreNode[],
  byId: Map<string, CoreNode>,
  render: RenderNode,
  notes: string[],
): CoreNode[] {
  const declarationIndex = new Map(nodes.map((n, i) => [n.id, i]));

  const inputsOf = (n: CoreNode): string[] => {
    const explicit = 'inputs' in n && Array.isArray(n.inputs) ? n.inputs : undefined;
    if (explicit) return explicit;
    return 'input' in n && typeof n.input === 'string' ? [n.input] : [];
  };

  // Reachable set: the render node plus everything it transitively depends on, plus any
  // stats node whose own input is reachable (stats branch off the main path).
  const reachable = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    if (reachable.has(id)) return;
    if (path.has(id)) throw new PlanError(`Cycle in graph through node ${id}`);
    const node = byId.get(id);
    if (!node) throw new PlanError(`Unknown node id '${id}'`);
    path.add(id);
    for (const dep of inputsOf(node)) visit(dep, path);
    path.delete(id);
    reachable.add(id);
  };
  visit(render.id, new Set());

  for (const n of nodes) {
    if (n.type === 'stats' && reachable.has(n.input)) visit(n.id, new Set());
  }

  const dropped = nodes.filter((n) => !reachable.has(n.id));
  if (dropped.length) {
    notes.push(`dead-code elimination: ${dropped.length} node(s) not upstream of the output were dropped (${dropped.map((n) => n.id).join(', ')})`);
  }

  const live = nodes.filter((n) => reachable.has(n.id));
  const indegree = new Map<string, number>();
  const consumers = new Map<string, string[]>();
  for (const n of live) {
    const deps = inputsOf(n).filter((d) => reachable.has(d));
    indegree.set(n.id, deps.length);
    for (const d of deps) consumers.set(d, [...(consumers.get(d) ?? []), n.id]);
  }

  const ready = live.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out: CoreNode[] = [];
  while (ready.length) {
    // Stable order: earliest declaration first.
    ready.sort((a, b) => (declarationIndex.get(a) ?? 0) - (declarationIndex.get(b) ?? 0));
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const c of consumers.get(id) ?? []) {
      const left = (indegree.get(c) ?? 0) - 1;
      indegree.set(c, left);
      if (left === 0) ready.push(c);
    }
  }

  if (out.length !== live.length) throw new PlanError('Cycle in graph: topological sort did not consume every node');
  return out;
}

function paramsOfExpr(e: Expr): string[] {
  const out = new Set<string>();
  const walk = (n: Expr): void => {
    switch (n.kind) {
      case 'param': out.add(n.name); break;
      case 'unary': walk(n.operand); break;
      case 'binary': walk(n.left); walk(n.right); break;
      case 'call': n.args.forEach(walk); break;
      case 'vec': n.components.forEach(walk); break;
      case 'swizzle': walk(n.target); break;
      case 'cond': walk(n.test); walk(n.then); walk(n.else); break;
      default: break;
    }
  };
  walk(e);
  return [...out];
}
