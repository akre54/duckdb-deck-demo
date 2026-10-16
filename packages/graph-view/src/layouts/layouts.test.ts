import { describe, it, expect } from 'vitest';
import type { GraphDescription, GraphNode } from '../schema.js';
import type { GraphLayout } from '../layout.js';
import { dagreLayout, forceLayout } from './index.js';

/**
 * A graph shaped like a luma group-by: three independent passes that each write a buffer, all
 * read by one pass, which feeds a chain of two. Fan-in plus a chain is what tells the layouts
 * apart, and what they each have to get right.
 */
const node = (id: string, role?: 'data'): GraphNode => ({ id, kind: role ? 'buffer' : 'compute', ...(role ? { role } : {}) });
const graph: GraphDescription = {
  version: 1,
  id: 'g',
  nodes: [
    node('a'), node('b'), node('c'),
    node('a-out', 'data'), node('b-out', 'data'), node('c-out', 'data'),
    node('join'), node('join-out', 'data'), node('tail'), node('tail-out', 'data'),
  ],
  edges: [
    { from: 'a', to: 'a-out' }, { from: 'b', to: 'b-out' }, { from: 'c', to: 'c-out' },
    { from: 'a-out', to: 'join' }, { from: 'b-out', to: 'join' }, { from: 'c-out', to: 'join' },
    { from: 'join', to: 'join-out' }, { from: 'join-out', to: 'tail' }, { from: 'tail', to: 'tail-out' },
  ],
};
const size = (n: GraphNode) => (n.role === 'data' ? { width: 120, height: 30 } : { width: 180, height: 80 });
const options = { size, columnGap: 60, rowGap: 20 };

function overlaps(layout: GraphLayout): string[] {
  const boxes = graph.nodes.map((n) => ({ id: n.id, ...layout.positions[n.id], ...size(n) }));
  const hits: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) hits.push(`${a.id}/${b.id}`);
    }
  }
  return hits;
}

describe.each([
  ['dagreLayout', dagreLayout],
  ['forceLayout', forceLayout],
])('%s', (_, layout) => {
  it('places every node with no two boxes overlapping, inside its reported extent', () => {
    const result = layout(graph, options);
    expect(Object.keys(result.positions).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
    expect(overlaps(result)).toEqual([]);
    for (const n of graph.nodes) {
      const p = result.positions[n.id];
      expect(p.x).toBeGreaterThanOrEqual(-0.5);
      expect(p.y).toBeGreaterThanOrEqual(-0.5);
      expect(p.x + size(n).width).toBeLessThanOrEqual(result.width + 0.5);
      expect(p.y + size(n).height).toBeLessThanOrEqual(result.height + 0.5);
    }
  });
});

describe('dagreLayout', () => {
  it('runs left to right: every edge ends right of where it starts', () => {
    const { positions } = dagreLayout(graph, options);
    const backward = graph.edges.filter((e) => positions[e.to].x <= positions[e.from].x);
    expect(backward).toEqual([]);
  });
});

describe('forceLayout', () => {
  it('lays out the same graph the same way every time', () => {
    expect(forceLayout(graph, options).positions).toEqual(forceLayout(graph, options).positions);
  });

  it('still reads left to right: each layer sits right of the one before, on average', () => {
    const { positions, layers } = forceLayout(graph, options);
    const byLayer = new Map<number, number[]>();
    for (const n of graph.nodes) (byLayer.get(layers[n.id]) ?? byLayer.set(layers[n.id], []).get(layers[n.id])!).push(positions[n.id].x + size(n).width / 2);
    const means = [...byLayer.keys()].sort((a, b) => a - b).map((l) => byLayer.get(l)!.reduce((s, x) => s + x, 0) / byLayer.get(l)!.length);
    for (let i = 1; i < means.length; i++) expect(means[i]).toBeGreaterThan(means[i - 1]);
  });

  it('asks for straight edges, since its nodes sit at any angle to each other', () => {
    expect(forceLayout(graph, options).edgeShape).toBe('straight');
  });
});
