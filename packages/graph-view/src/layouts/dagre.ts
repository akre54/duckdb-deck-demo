import { Graph, layout } from '@dagrejs/dagre';
import type { GraphDescription } from '../schema.js';
import { layoutGraph, type GraphLayout, type LayoutOptions } from '../layout.js';

/**
 * dagre's layered layout, left to right. Compared with `layoutGraph` it minimizes edge crossings
 * and balances nodes within a rank, which reads better on a graph that fans out and back in (a
 * group-by's seven independent passes), at the cost of a dependency and less regular columns.
 * `wrapWidth` is ignored: dagre places the whole graph as one band.
 */
export function dagreLayout(description: GraphDescription, options: LayoutOptions = {}): GraphLayout {
  const { columnGap = 80, rowGap = 24 } = options;
  const size = options.size ?? ((n) => (n.role === 'data' ? { width: 160, height: 36 } : { width: 200, height: 72 }));
  const g = new Graph();
  g.setGraph({ rankdir: 'LR', nodesep: rowGap, ranksep: columnGap, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(description.nodes.map((n) => n.id));
  for (const n of description.nodes) g.setNode(n.id, { ...size(n) });
  for (const e of description.edges) {
    if (e.from !== e.to && ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  }
  layout(g);

  // dagre places centers; the viewer and `layoutGraph` place top-left corners.
  const positions: GraphLayout['positions'] = {};
  let width = 0;
  let height = 0;
  for (const n of description.nodes) {
    const placed = g.node(n.id);
    const s = size(n);
    positions[n.id] = { x: placed.x - s.width / 2, y: placed.y - s.height / 2 };
    width = Math.max(width, positions[n.id].x + s.width);
    height = Math.max(height, positions[n.id].y + s.height);
  }
  const { layers } = layoutGraph(description, options);
  const bands = Object.fromEntries(description.nodes.map((n) => [n.id, 0]));
  return { positions, layers, bands, width, height };
}
