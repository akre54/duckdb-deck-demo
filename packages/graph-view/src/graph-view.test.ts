import { describe, it, expect } from 'vitest';
import { collapseData, formatMetric, layoutGraph, validateGraph, type GraphDescription } from './index.js';

/** filter writes mask; compact reads mask and writes ids; count reads ids. `src` is imported. */
const passes: GraphDescription = {
  version: 1,
  id: 'g',
  nodes: [
    { id: 'src@0', kind: 'buffer', role: 'data' },
    { id: 'filter', kind: 'compute', order: 0 },
    { id: 'mask@1', kind: 'buffer', role: 'data', label: 'mask' },
    { id: 'compact', kind: 'compute', order: 1 },
    { id: 'ids@1', kind: 'buffer', role: 'data', label: 'ids' },
    { id: 'count', kind: 'compute', order: 2 },
    { id: 'n@1', kind: 'buffer', role: 'data', label: 'n' },
  ],
  edges: [
    { from: 'src@0', to: 'filter', kind: 'read' },
    { from: 'filter', to: 'mask@1', kind: 'write' },
    { from: 'mask@1', to: 'compact', kind: 'read' },
    { from: 'compact', to: 'ids@1', kind: 'write' },
    { from: 'ids@1', to: 'count', kind: 'read' },
    { from: 'count', to: 'n@1', kind: 'write' },
  ],
};

describe('validateGraph', () => {
  it('accepts a well-formed description', () => {
    expect(validateGraph(passes)).toEqual([]);
  });

  it('reports duplicate ids, dangling edges and an unknown version', () => {
    const bad = {
      ...passes,
      version: 2,
      nodes: [...passes.nodes, { id: 'filter', kind: 'compute' }],
      edges: [...passes.edges, { from: 'nowhere', to: 'filter' }],
    } as unknown as GraphDescription;
    expect(validateGraph(bad)).toEqual([
      'unsupported version 2; expected 1',
      'duplicate node id "filter"',
      'edge from missing node "nowhere"',
    ]);
  });
});

describe('layoutGraph', () => {
  it('puts each node one column right of its furthest predecessor', () => {
    const { layers } = layoutGraph(passes);
    expect(layers).toEqual({ 'src@0': 0, filter: 1, 'mask@1': 2, compact: 3, 'ids@1': 4, count: 5, 'n@1': 6 });
  });

  it('places columns left to right without overlap', () => {
    const { positions } = layoutGraph(passes, { size: () => ({ width: 100, height: 40 }), columnGap: 20 });
    const xs = passes.nodes.map((n) => positions[n.id].x);
    expect(xs).toEqual([0, 120, 240, 360, 480, 600, 720]);
  });

  it('stacks a column in schedule order and centers it on the tallest', () => {
    const fan: GraphDescription = {
      version: 1, id: 'fan',
      nodes: [{ id: 'a', kind: 'k', order: 0 }, { id: 'c', kind: 'k', order: 2 }, { id: 'b', kind: 'k', order: 1 }, { id: 'z', kind: 'k' }],
      edges: [{ from: 'z', to: 'a' }, { from: 'z', to: 'b' }, { from: 'z', to: 'c' }],
    };
    const { positions, height } = layoutGraph(fan, { size: () => ({ width: 10, height: 10 }), rowGap: 5 });
    expect([positions.a.y, positions.b.y, positions.c.y]).toEqual([0, 15, 30]);
    expect(height).toBe(40);
    expect(positions.z.y).toBe(15);
  });

  it('wraps columns onto bands below once a band would pass the wrap width', () => {
    const size = () => ({ width: 100, height: 40 });
    // Seven columns of 100 with gaps of 20: three fit in 340, the fourth would make 460.
    const { positions, bands, width, height } = layoutGraph(passes, { size, columnGap: 20, rowGap: 10, wrapWidth: 340 });
    expect(passes.nodes.map((n) => bands[n.id])).toEqual([0, 0, 0, 1, 1, 1, 2]);
    // Each band restarts at the left edge, one band height plus the gap (3 row gaps) lower.
    expect(passes.nodes.map((n) => positions[n.id].x)).toEqual([0, 120, 240, 0, 120, 240, 0]);
    expect(passes.nodes.map((n) => positions[n.id].y)).toEqual([0, 0, 0, 70, 70, 70, 140]);
    expect([width, height]).toEqual([340, 180]);
  });

  it('gives a column wider than the wrap width a band of its own instead of looping', () => {
    const { bands } = layoutGraph(passes, { size: () => ({ width: 500, height: 40 }), wrapWidth: 300 });
    expect(passes.nodes.map((n) => bands[n.id])).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('lays out a cycle instead of throwing', () => {
    const loop: GraphDescription = {
      version: 1, id: 'loop',
      nodes: [{ id: 'a', kind: 'k', order: 0 }, { id: 'b', kind: 'k', order: 1 }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    };
    const { layers } = layoutGraph(loop);
    expect(layers).toEqual({ a: 0, b: 1 });
  });
});

describe('collapseData', () => {
  it('turns data between two passes into a labelled edge and keeps inputs and outputs', () => {
    const view = collapseData(passes);
    expect(view.nodes.map((n) => n.id)).toEqual(['src@0', 'filter', 'compact', 'count', 'n@1']);
    expect(view.edges).toEqual([
      { from: 'src@0', to: 'filter', kind: 'read' },
      { from: 'count', to: 'n@1', kind: 'write' },
      { from: 'filter', to: 'compact', kind: 'data', label: 'mask' },
      { from: 'compact', to: 'count', kind: 'data', label: 'ids' },
    ]);
    expect(validateGraph(view)).toEqual([]);
  });

  it('sums the bytes of the resources a bridged edge stands for', () => {
    const sized: GraphDescription = {
      ...passes,
      nodes: passes.nodes.map((n) => (n.id === 'mask@1' ? { ...n, metrics: { bytes: { value: 4096, unit: 'bytes' as const } } } : n)),
    };
    const edge = collapseData(sized).edges.find((e) => e.from === 'filter' && e.to === 'compact');
    expect(edge?.metrics?.bytes).toEqual({ value: 4096, unit: 'bytes' });
  });

  it('merges several resources between the same two passes into one edge', () => {
    const two: GraphDescription = {
      version: 1, id: 'two',
      nodes: [
        { id: 'p', kind: 'compute' }, { id: 'q', kind: 'compute' },
        { id: 'x', kind: 'buffer', role: 'data' }, { id: 'y', kind: 'buffer', role: 'data' },
      ],
      edges: [{ from: 'p', to: 'x' }, { from: 'p', to: 'y' }, { from: 'x', to: 'q' }, { from: 'y', to: 'q' }],
    };
    expect(collapseData(two).edges).toEqual([{ from: 'p', to: 'q', kind: 'data', label: 'x, y' }]);
  });
});

describe('formatMetric', () => {
  it('formats each unit', () => {
    expect(formatMetric({ value: 0.042, unit: 'ms' })).toBe('42 µs');
    expect(formatMetric({ value: 1.234, unit: 'ms', p95: 2.5 })).toBe('1.23 ms (p95 2.50 ms)');
    expect(formatMetric({ value: 4 * 1024 * 1024, unit: 'bytes' })).toBe('4.0 MB');
    expect(formatMetric({ value: 512, unit: 'bytes' })).toBe('512 B');
    expect(formatMetric({ value: 20000, unit: 'count' })).toBe('20,000');
  });
});
