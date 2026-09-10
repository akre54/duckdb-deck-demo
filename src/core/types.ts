/**
 * The JSON graph schema.
 *
 * Deliberately thin. `scale`, `colorscale` and `project` are sugar: they desugar into
 * `attribute` nodes whose expressions go through the same IR as everything else. That
 * keeps exactly one thing to compile, and it is the answer to noodles' open question
 * about MapRangeOp / ColorRampOp — they do not need to be operators, they need to be
 * expression templates.
 */

import type { Expr } from './expr.js';
import { parseWrangle, expandWrangle } from './wrangle.js';

export type RampName = 'viridis' | 'magma' | 'turbo' | 'cividis';

export interface ParamSpec {
  value: number;
  /**
   * `value` params rebind cheaply (uniform write / prepared-statement rebind).
   * `structural` params change the shape of the plan and force a recompile.
   */
  kind?: 'value' | 'structural';
  /**
   * Expected changes per second, the planner's amortization input.
   *
   * This is what lets placement respond to interaction rather than only to data size: a
   * parameter dragged on a slider is worth keeping on the GPU, where rebinding is a
   * 16-byte uniform write, even if putting its node in SQL would build marginally faster.
   * Defaults to 2/s for `value` params and 0 for `structural` ones (a structural change
   * recompiles the plan, so amortizing it here would double count).
   */
  changeRate?: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

export interface SourceNode {
  id: string;
  type: 'source';
  /** Either a synthetic generator or a URL DuckDB can read (parquet/csv). */
  /**
   * Which registered source provides the rows.
   *
   * `ref` names an entry in the host's `SourceRegistry`; everything else is passed through
   * to that provider untouched. Keeping the payload opaque is what stops a particular
   * dataset (the demo's synthetic generator, say) from becoming part of the graph schema.
   *
   * `estimatedRows` is an optional hint used only when no catalog statistics exist yet, so
   * the very first plan has a finite cost to compare against.
   */
  dataset: { ref: string; estimatedRows?: number; [key: string]: unknown };
}

/** Row filter. Pushed into the SQL WHERE clause whenever the predicate is SQL-expressible. */
export interface FilterNode {
  id: string;
  type: 'filter';
  input: string;
  /**
   * Multi-input form. When present it replaces `input`, so a node can read attributes
   * produced along several upstream paths. Inputs merge namespaces over a shared row set;
   * relational joins are out of scope.
   */
  inputs?: string[];
  predicate: string;
}

/** GROUP BY + aggregates. Always SQL: aggregates collapse rows. */
export interface AggregateNode {
  id: string;
  type: 'aggregate';
  input: string;
  /**
   * Multi-input form. When present it replaces `input`, so a node can read attributes
   * produced along several upstream paths. Inputs merge namespaces over a shared row set;
   * relational joins are out of scope.
   */
  inputs?: string[];
  groupBy: string[];
  aggs: { name: string; expr: string }[];
}

/**
 * Scalar reduction whose results become bindable parameters, e.g. a scale domain.
 * `stats` is what lets a scale say "domain: auto" without a CPU pass over the column.
 */
export interface StatsNode {
  id: string;
  type: 'stats';
  input: string;
  /**
   * Multi-input form. When present it replaces `input`, so a node can read attributes
   * produced along several upstream paths. Inputs merge namespaces over a shared row set;
   * relational joins are out of scope.
   */
  inputs?: string[];
  column: string;
  ops: StatOp[];
}

export type StatOp = 'min' | 'max' | 'mean' | 'median' | 'p01' | 'p99' | 'stddev';

/** The wrangle. Creates or overwrites a named point attribute. */
export interface AttributeNode {
  id: string;
  type: 'attribute';
  input: string;
  /**
   * Multi-input form. When present it replaces `input`, so a node can read attributes
   * produced along several upstream paths. Inputs merge namespaces over a shared row set;
   * relational joins are out of scope.
   */
  inputs?: string[];
  name: string;
  /**
   * The expression. A string in authored JSON; desugaring may instead pass an
   * already-parsed tree, which avoids round-tripping through an unparser whose precedence
   * handling would be one more thing to get wrong.
   */
  expr: string | Expr;
  /** Set by wrangle expansion: the source text, for display. */
  source?: string;
}

/** Sugar -> attribute. Numeric remap with an optional auto domain from a stats node. */
export interface ScaleNode {
  id: string;
  type: 'scale';
  input: string;
  /**
   * Multi-input form. When present it replaces `input`, so a node can read attributes
   * produced along several upstream paths. Inputs merge namespaces over a shared row set;
   * relational joins are out of scope.
   */
  inputs?: string[];
  name: string;
  expr: string;
  kind?: 'linear' | 'log' | 'sqrt';
  /** Two expressions, or `'auto'` to read the domain from `statsFrom`. */
  domain?: [string, string] | 'auto';
  statsFrom?: string;
  range: [string, string];
  clamp?: boolean;
}

/** Sugar -> attribute. Numeric remap into a ramp lookup. */
export interface ColorScaleNode {
  id: string;
  type: 'colorscale';
  input: string;
  /**
   * Multi-input form. When present it replaces `input`, so a node can read attributes
   * produced along several upstream paths. Inputs merge namespaces over a shared row set;
   * relational joins are out of scope.
   */
  inputs?: string[];
  /** Defaults to `Cd`. */
  name?: string;
  expr: string;
  ramp: RampName;
  domain?: [string, string] | 'auto';
  statsFrom?: string;
}

/** Sugar -> attribute. Produces a vec3 `P`. */
export interface ProjectNode {
  id: string;
  type: 'project';
  input: string;
  /**
   * Multi-input form. When present it replaces `input`, so a node can read attributes
   * produced along several upstream paths. Inputs merge namespaces over a shared row set;
   * relational joins are out of scope.
   */
  inputs?: string[];
  mode: 'mercator' | 'identity';
  x: string;
  y: string;
  z?: string;
  /** World-unit scale applied after projection, so the orbit camera sees sane numbers. */
  worldScale?: string;
}

/** GPU binning into a 2D grid, consumed by the heatmap raster pass. */
export interface Bin2dNode {
  id: string;
  type: 'bin2d';
  input: string;
  /**
   * Multi-input form. When present it replaces `input`, so a node can read attributes
   * produced along several upstream paths. Inputs merge namespaces over a shared row set;
   * relational joins are out of scope.
   */
  inputs?: string[];
  resolution: number;
  /** Expression contributing to each bin; defaults to 1 (a plain count). */
  weight?: string;
  ramp: RampName;
  /** Bin value mapped through the ramp between 0 and this. `'auto'` uses the max bin. */
  ceiling?: string | 'auto';
}

export interface RenderNode {
  id: string;
  type: 'render';
  input: string;
  /**
   * Multi-input form. When present it replaces `input`, so a node can read attributes
   * produced along several upstream paths. Inputs merge namespaces over a shared row set;
   * relational joins are out of scope.
   */
  inputs?: string[];
  mode: 'points' | 'heatmap';
  /** Points mode: attribute names bound to visual channels. */
  position?: string;
  color?: string;
  size?: string;
  opacity?: string;
  background?: [number, number, number];
}

/**
 * Sugar -> N attribute nodes. A VEX-style multi-statement body, which is what makes the
 * pipeline programmable rather than a closed catalogue of operator types. See
 * `src/graph/wrangle.ts` for the grammar.
 */
export interface WrangleNode {
  id: string;
  type: 'wrangle';
  input: string;
  inputs?: string[];
  /** Statements separated by `;`. `@name = expr` writes an attribute, `var name = expr` a local. */
  body: string;
  /** Ramp used by any `ramp()` call in the body. Defaults to viridis. */
  ramp?: RampName;
}

export type GraphNode =
  | SourceNode | FilterNode | AggregateNode | StatsNode | AttributeNode
  | ScaleNode | ColorScaleNode | ProjectNode | WrangleNode | Bin2dNode | RenderNode;

export interface Graph {
  name?: string;
  params?: Record<string, ParamSpec>;
  nodes: GraphNode[];
  /** Node id of the render node to evaluate. Defaults to the last render node. */
  output?: string;
}

// ---------------------------------------------------------------------------
// Desugaring
// ---------------------------------------------------------------------------

/** Nodes that survive into the planner. */
export type CoreNode =
  | SourceNode | FilterNode | AggregateNode | StatsNode | AttributeNode
  | Bin2dNode | RenderNode;

export const RAMP_STOPS: Record<RampName, [number, number, number][]> = {
  // 8-stop approximations, linearly interpolated in the LUT builder. Close enough for
  // a prototype and far cheaper than shipping the full 256-entry tables.
  viridis: [
    [0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.53],
    [0.207, 0.372, 0.553], [0.164, 0.471, 0.558], [0.128, 0.567, 0.551],
    [0.267, 0.749, 0.441], [0.993, 0.906, 0.144],
  ],
  magma: [
    [0.001, 0.000, 0.014], [0.116, 0.066, 0.232], [0.298, 0.079, 0.446],
    [0.478, 0.137, 0.505], [0.665, 0.199, 0.480], [0.851, 0.302, 0.392],
    [0.972, 0.556, 0.351], [0.987, 0.991, 0.750],
  ],
  turbo: [
    [0.190, 0.072, 0.232], [0.246, 0.552, 0.925], [0.113, 0.855, 0.792],
    [0.322, 0.980, 0.443], [0.708, 0.999, 0.180], [0.960, 0.799, 0.176],
    [0.973, 0.427, 0.106], [0.720, 0.087, 0.021],
  ],
  cividis: [
    [0.000, 0.135, 0.305], [0.000, 0.223, 0.410], [0.196, 0.310, 0.415],
    [0.336, 0.396, 0.427], [0.459, 0.484, 0.450], [0.593, 0.577, 0.437],
    [0.740, 0.678, 0.393], [0.995, 0.909, 0.218],
  ],
};

/** Stat op -> the aggregate expression that computes it. */
export function statExpr(op: StatOp, column: string): string {
  switch (op) {
    case 'min': return `minAgg(${column})`;
    case 'max': return `maxAgg(${column})`;
    case 'mean': return `avg(${column})`;
    case 'median': return `median(${column})`;
    case 'p01': return `quantile(${column}, 0.01)`;
    case 'p99': return `quantile(${column}, 0.99)`;
    case 'stddev': return `stddev(${column})`;
  }
}

/** The parameter name a stats node publishes for one of its ops. */
export function statParamName(nodeId: string, op: StatOp): string {
  return `${nodeId}_${op}`;
}

/**
 * Rewrite sugar nodes into core nodes. Every sugar node becomes one or more
 * `attribute` nodes, so the planner only ever sees expressions.
 */
export function desugar(graph: Graph): { nodes: CoreNode[]; notes: string[]; ramp?: RampName } {
  const out: CoreNode[] = [];
  const notes: string[] = [];
  // One LUT is bound per kernel, so this prototype supports one ramp per graph.
  // Two colorscales with different ramps is a real use case and a real limitation.
  const ramps = new Set<RampName>();
  /**
   * Sugar that expands into several nodes changes which id represents its output, so any
   * node downstream still pointing at the original has to be redirected. Recorded here and
   * applied in one pass at the end, because JSON node order is not guaranteed topological.
   */
  const idRewrites = new Map<string, string>();

  const domainRefs = (
    node: { domain?: [string, string] | 'auto'; statsFrom?: string; id: string },
  ): [string, string] => {
    if (node.domain && node.domain !== 'auto') return node.domain;
    if (!node.statsFrom) {
      throw new Error(`Node ${node.id}: domain 'auto' requires 'statsFrom' naming a stats node`);
    }
    return [
      `{{${statParamName(node.statsFrom, 'min')}}}`,
      `{{${statParamName(node.statsFrom, 'max')}}}`,
    ];
  };

  for (const node of graph.nodes) {
    switch (node.type) {
      case 'scale': {
        const [d0, d1] = domainRefs(node);
        const warp =
          node.kind === 'log' ? (s: string) => `ln(max(${s}, 1e-9))`
          : node.kind === 'sqrt' ? (s: string) => `sqrt(max(${s}, 0.0))`
          : (s: string) => s;
        const fit = `fit(${warp(`(${node.expr})`)}, ${warp(`(${d0})`)}, ${warp(`(${d1})`)}, ${node.range[0]}, ${node.range[1]})`;
        const expr = node.clamp === false
          ? fit
          : `clamp(${fit}, min(${node.range[0]}, ${node.range[1]}), max(${node.range[0]}, ${node.range[1]}))`;
        out.push({ id: node.id, type: 'attribute', input: node.input, name: node.name, expr });
        notes.push(`${node.id}: scale desugared to attribute '${node.name}'`);
        break;
      }

      case 'colorscale': {
        ramps.add(node.ramp);
        const [d0, d1] = domainRefs(node);
        const t = `clamp(fit((${node.expr}), (${d0}), (${d1}), 0.0, 1.0), 0.0, 1.0)`;
        out.push({
          id: node.id,
          type: 'attribute',
          input: node.input,
          name: node.name ?? 'Cd',
          expr: `ramp(${t})`,
        });
        notes.push(`${node.id}: colorscale desugared to attribute '${node.name ?? 'Cd'}' via ramp()`);
        break;
      }

      case 'project': {
        const scale = node.worldScale ?? '1.0';
        const z = node.z ?? '0.0';
        const expr = node.mode === 'mercator'
          // Web Mercator, normalized to [-0.5, 0.5] on both axes so the orbit camera
          // starts with the whole world inside the near/far planes.
          ? `[((${node.x}) / 360.0) * (${scale}), ` +
            `(ln(tan(0.7853981634 + (${node.y}) * 0.008726646259971648)) / 6.283185307) * (${scale}), ` +
            `(${z}) * (${scale})]`
          : `[(${node.x}) * (${scale}), (${node.y}) * (${scale}), (${z}) * (${scale})]`;
        out.push({ id: node.id, type: 'attribute', input: node.input, name: 'P', expr });
        notes.push(`${node.id}: project(${node.mode}) desugared to attribute 'P'`);
        break;
      }

      case 'wrangle': {
        // One statement becomes one attribute node, so the planner places each statement
        // independently and the existing kernel fusion merges them back into one dispatch.
        // The planner needs no knowledge of wrangles at all.
        const statements = parseWrangle(node.body);
        const expanded = expandWrangle(node.id, statements);
        if (/\bramp\s*\(/.test(node.body)) ramps.add(node.ramp ?? 'viridis');
        let input = node.inputs?.[0] ?? node.input;
        for (const s of expanded) {
          out.push({
            id: `${node.id}#${s.name}`,
            type: 'attribute',
            input,
            // Only the first statement inherits the wrangle's multi-input list; the rest
            // chain off their predecessor so ordering within the body is preserved.
            inputs: input === (node.inputs?.[0] ?? node.input) ? node.inputs : undefined,
            name: s.name,
            expr: s.expr,
            source: `line ${s.line}`,
          });
          input = `${node.id}#${s.name}`;
        }
        // The wrangle's output is its final statement, so that is what its consumers
        // should read.
        idRewrites.set(node.id, `${node.id}#${expanded[expanded.length - 1].name}`);
        notes.push(
          `${node.id}: wrangle expanded to ${expanded.length} attribute node(s) (${expanded.map((s) => s.name).join(', ')})`,
        );
        break;
      }

      default:
        if (node.type === 'bin2d') ramps.add(node.ramp);
        out.push(node);
        break;
    }
  }

  if (ramps.size > 1) {
    throw new Error(
      `Graph uses ${ramps.size} different ramps (${[...ramps].join(', ')}); this prototype binds one LUT per graph`,
    );
  }

  // Redirect references to any node whose id changed during expansion. Nodes created by
  // the expansion already point at each other, so only pre-existing ids are rewritten.
  if (idRewrites.size > 0) {
    const created = new Set(out.map((n) => n.id));
    for (const node of out) {
      if (!('input' in node)) continue;
      const redirect = (id: string) => (created.has(id) ? id : idRewrites.get(id) ?? id);
      if (node.inputs) node.inputs = node.inputs.map(redirect);
      node.input = redirect(node.input);
    }
  }

  return { nodes: out, notes, ramp: [...ramps][0] };
}

/** Build a 256-entry RGB LUT from a ramp's stops. */
export function buildRampLut(ramp: RampName, size = 256): Float32Array {
  const stops = RAMP_STOPS[ramp];
  const lut = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = (i / (size - 1)) * (stops.length - 1);
    const lo = Math.min(Math.floor(t), stops.length - 2);
    const f = t - lo;
    const a = stops[lo];
    const b = stops[lo + 1];
    lut[i * 4 + 0] = a[0] + (b[0] - a[0]) * f;
    lut[i * 4 + 1] = a[1] + (b[1] - a[1]) * f;
    lut[i * 4 + 2] = a[2] + (b[2] - a[2]) * f;
    lut[i * 4 + 3] = 1;
  }
  return lut;
}
