import type { GraphDescription, GraphNode } from './schema.js';

export interface NodeSize {
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** Horizontal space between columns. */
  columnGap?: number;
  /** Vertical space between nodes in a column. */
  rowGap?: number;
  /** Size of each node as drawn. The viewer passes its own so boxes do not overlap. */
  size?: (node: GraphNode) => NodeSize;
  /**
   * Wrap onto a new band below once the columns so far would pass this width, the way text
   * wraps. A long pass chain then reads left to right, row after row, instead of running off
   * the screen. A column wider than this still gets a band to itself.
   */
  wrapWidth?: number;
  /** Vertical space between wrapped bands. Defaults to three row gaps. */
  bandGap?: number;
}

export interface GraphLayout {
  positions: Record<string, { x: number; y: number }>;
  /** Column index of each node, left to right. */
  layers: Record<string, number>;
  /** Wrapped band of each node, top to bottom; all 0 without `wrapWidth`. */
  bands: Record<string, number>;
  width: number;
  height: number;
}

const defaultSize = (node: GraphNode): NodeSize =>
  node.role === 'data' ? { width: 160, height: 36 } : { width: 200, height: 72 };

/**
 * A left-to-right layered layout: each node one column right of its furthest predecessor.
 *
 * Not a general graph layout. Producers here emit DAGs of tens of nodes with a schedule order,
 * and for those longest-path layering plus a barycenter pass reads well and costs nothing. A
 * dependency on dagre or elk would be the first runtime dependency of the package and would buy
 * crossing minimization these graphs rarely need.
 *
 * A cycle does not throw. A producer can describe one (a buffer read and written by the same
 * pass, when it does not version resources), so the node with the lowest `order` among the
 * stuck ones is placed as if its unplaced predecessors were not there.
 */
export function layoutGraph(description: GraphDescription, options: LayoutOptions = {}): GraphLayout {
  const { columnGap = 80, rowGap = 24, size = defaultSize } = options;
  const nodes = description.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const succs = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of description.edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
  }

  const rank = (n: GraphNode) => n.order ?? Number.POSITIVE_INFINITY;
  const layers: Record<string, number> = {};
  const waiting = new Map(nodes.map((n) => [n.id, preds.get(n.id)!.length]));
  const ready = nodes.filter((n) => waiting.get(n.id) === 0).map((n) => n.id);
  let placed = 0;
  const place = (id: string) => {
    const known = preds.get(id)!.filter((p) => p in layers);
    layers[id] = known.length ? Math.max(...known.map((p) => layers[p])) + 1 : 0;
    placed++;
    for (const s of succs.get(id)!) {
      const left = waiting.get(s)! - 1;
      waiting.set(s, left);
      if (left === 0) ready.push(s);
    }
  };
  while (placed < nodes.length) {
    const id = ready.shift();
    if (id !== undefined) {
      if (!(id in layers)) place(id);
      continue;
    }
    const stuck = nodes.filter((n) => !(n.id in layers)).sort((a, b) => rank(a) - rank(b))[0];
    place(stuck.id);
  }

  // Order inside a column by the mean row of each node's predecessors, so a chain stays level.
  const columnCount = nodes.length ? Math.max(...Object.values(layers)) + 1 : 0;
  const columns: GraphNode[][] = Array.from({ length: columnCount }, () => []);
  for (const n of nodes) columns[layers[n.id]].push(n);
  const row: Record<string, number> = {};
  for (const column of columns) {
    const key = (n: GraphNode) => {
      const ps = preds.get(n.id)!.filter((p) => p in row);
      return ps.length ? ps.reduce((sum, p) => sum + row[p], 0) / ps.length : Number.POSITIVE_INFINITY;
    };
    column.sort((a, b) => key(a) - key(b) || rank(a) - rank(b) || a.id.localeCompare(b.id));
    column.forEach((n, i) => { row[n.id] = i; });
  }

  // Columns are as wide as their widest node and centered on the tallest column of their band.
  const widths = columns.map((c) => Math.max(...c.map((n) => size(n).width)));
  const heights = columns.map((c) => c.reduce((h, n) => h + size(n).height, 0) + rowGap * Math.max(0, c.length - 1));

  // Greedy: a column joins the current band if the band stays within the wrap width.
  const bandOf: number[] = [];
  let band = 0;
  let run = 0;
  widths.forEach((w, i) => {
    const next = run === 0 ? w : run + columnGap + w;
    if (options.wrapWidth !== undefined && run > 0 && next > options.wrapWidth) { band++; run = w; } else run = next;
    bandOf[i] = band;
  });
  const bandCount = band + 1;
  const bandHeights = Array.from({ length: bandCount }, (_, b) => Math.max(0, ...heights.filter((_, i) => bandOf[i] === b)));
  const bandGap = options.bandGap ?? rowGap * 3;

  const positions: GraphLayout['positions'] = {};
  const bands: GraphLayout['bands'] = {};
  let width = 0;
  let top = 0;
  for (let b = 0; b < bandCount; b++) {
    let x = 0;
    columns.forEach((column, i) => {
      if (bandOf[i] !== b) return;
      let y = top + (bandHeights[b] - heights[i]) / 2;
      for (const n of column) {
        const s = size(n);
        positions[n.id] = { x: x + (widths[i] - s.width) / 2, y };
        bands[n.id] = b;
        y += s.height + rowGap;
      }
      x += widths[i] + columnGap;
    });
    width = Math.max(width, x - columnGap);
    top += bandHeights[b] + bandGap;
  }
  return { positions, layers, bands, width: Math.max(0, width), height: Math.max(0, top - bandGap) };
}
