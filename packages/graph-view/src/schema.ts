/**
 * The graph description: what a producer emits and the viewer draws.
 *
 * Plain JSON on purpose. A producer (luma's command graph, the planner's physical plan, an
 * editor network) should be able to emit one without importing this package, and a description
 * saved from a running app should load in a viewer somewhere else. So nothing here is a class,
 * a callback or a GPU handle, and every field the viewer does not understand is still carried.
 *
 * Resources are nodes, not edge labels. A GPU graph's interesting facts are mostly about its
 * buffers (which ones are transient, which share an allocation, how big they are), and an edge
 * has nowhere to hang those. A producer marks them `role: 'data'`; `collapseData` turns them back
 * into labelled edges for a pass-only view.
 */

export const GRAPH_DESCRIPTION_VERSION = 1;

export interface GraphDescription {
  version: typeof GRAPH_DESCRIPTION_VERSION;
  id: string;
  label?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Whole-graph figures: totals, allocation stats, device limits. */
  metrics?: Record<string, GraphMetric>;
}

export interface GraphNode {
  id: string;
  /**
   * Free-form category the viewer colors by. A GPU producer uses `compute`, `render`, `copy`,
   * `buffer` and `texture`; other producers bring their own.
   */
  kind: string;
  label?: string;
  /** `work` (the default) is something that runs. `data` is something work reads or writes. */
  role?: GraphNodeRole;
  /** Semantic grouping, such as the operation that contributed the node. */
  group?: string;
  /**
   * Schedule position, when the producer has one. The layout uses it to order nodes inside a
   * column, so a pass graph reads in the order it encodes.
   */
  order?: number;
  metrics?: Record<string, GraphMetric>;
  attributes?: Record<string, string | number | boolean>;
}

export type GraphNodeRole = 'work' | 'data';

export interface GraphMetric {
  value: number;
  unit?: GraphMetricUnit;
  /** For a sampled metric: the 95th percentile beside `value`'s median. */
  p95?: number;
}

export type GraphMetricUnit = 'ms' | 'bytes' | 'count';

export interface GraphEdge {
  from: string;
  to: string;
  /**
   * `read` (data to work), `write` (work to data) and `dependency` (an ordering with no data
   * between) are the ones the viewer styles; anything else is drawn as a plain edge.
   */
  kind?: string;
  label?: string;
  /** What moves along the edge: `bytes` sets its width, and all of them show in its tooltip. */
  metrics?: Record<string, GraphMetric>;
  attributes?: Record<string, string | number | boolean>;
}
