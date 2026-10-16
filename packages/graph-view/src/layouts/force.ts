import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { GraphDescription } from '../schema.js';
import { layoutGraph, type GraphLayout, type LayoutOptions, type NodeSize } from '../layout.js';

type SimNode = SimulationNodeDatum & { id: string; size: NodeSize; layer: number };

/**
 * A force-directed layout (d3-force), still pulled left to right: each node is drawn toward the
 * x of its layer, so the graph reads in the order it runs while connected nodes cluster. After
 * noodles.gl PR #268's D3-Force option.
 *
 * d3's collision force works on circles and the cards are wide rectangles, so a final pass pushes
 * apart any boxes that still overlap. The simulation is run to a fixed tick count from d3's
 * deterministic starting arrangement, so the same graph lays out the same way every time.
 * `wrapWidth` is ignored.
 */
export function forceLayout(description: GraphDescription, options: LayoutOptions = {}): GraphLayout {
  const { columnGap = 80, rowGap = 24 } = options;
  const size = options.size ?? ((n) => (n.role === 'data' ? { width: 160, height: 36 } : { width: 200, height: 72 }));
  const { layers } = layoutGraph(description, options);
  const pitch = Math.max(0, ...description.nodes.map((n) => size(n).width)) + columnGap;

  const nodes: SimNode[] = description.nodes.map((n) => ({ id: n.id, size: size(n), layer: layers[n.id] ?? 0 }));
  const ids = new Set(nodes.map((n) => n.id));
  const links: SimulationLinkDatum<SimNode>[] = description.edges
    .filter((e) => e.from !== e.to && ids.has(e.from) && ids.has(e.to))
    .map((e) => ({ source: e.from, target: e.to }));

  const simulation = forceSimulation(nodes)
    .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => d.id).distance(pitch * 0.8).strength(0.4))
    .force('charge', forceManyBody().strength(-400))
    .force('collide', forceCollide<SimNode>((d) => Math.max(d.size.width, d.size.height) / 2 + rowGap / 2))
    .force('x', forceX<SimNode>((d) => d.layer * pitch).strength(0.8))
    .force('y', forceY<SimNode>(0).strength(0.08))
    .stop();
  simulation.tick(300);

  // Centers to top-left corners, then separate whatever the circles let overlap.
  const boxes = nodes.map((n) => ({ id: n.id, x: (n.x ?? 0) - n.size.width / 2, y: (n.y ?? 0) - n.size.height / 2, ...n.size }));
  separate(boxes, rowGap / 2);
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const positions: GraphLayout['positions'] = {};
  let width = 0;
  let height = 0;
  for (const b of boxes) {
    positions[b.id] = { x: b.x - minX, y: b.y - minY };
    width = Math.max(width, b.x - minX + b.width);
    height = Math.max(height, b.y - minY + b.height);
  }
  const bands = Object.fromEntries(description.nodes.map((n) => [n.id, 0]));
  return { positions, layers, bands, width: boxes.length ? width : 0, height: boxes.length ? height : 0, edgeShape: 'straight' };
}

/**
 * Push overlapping boxes apart along the axis they overlap less on, half each, until none do or
 * the pass limit is hit. Quadratic, which is fine for the tens of nodes these graphs have.
 */
function separate(boxes: { x: number; y: number; width: number; height: number }[], margin: number, passes = 100): void {
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const dx = Math.min(a.x + a.width + margin - b.x, b.x + b.width + margin - a.x);
        const dy = Math.min(a.y + a.height + margin - b.y, b.y + b.height + margin - a.y);
        if (dx <= 0 || dy <= 0) continue;
        moved = true;
        if (dx < dy) {
          const push = (a.x < b.x ? -dx : dx) / 2;
          a.x += push;
          b.x -= push;
        } else {
          const push = (a.y < b.y ? -dy : dy) / 2;
          a.y += push;
          b.y -= push;
        }
      }
    }
    if (!moved) return;
  }
}
