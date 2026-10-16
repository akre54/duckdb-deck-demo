import { describe, it, expect, beforeAll } from 'vitest';
import { GPUCommandGraphInspector } from '@luma.gl/gpgpu/gpu-core';
import { parseExpr } from '@noodles.gl/planner';
import { validateGraph, collapseData, type GraphDescription } from '@noodles.gl/graph-view';
import { LumaFilter, LumaGroupBy, describeCommandGraph } from '../../src/luma/index.js';
import { gpuDevice, storageBuffer, expectNoGpuError } from './harness.js';

/**
 * `describeCommandGraph` over graphs luma really compiled, not hand-built fixtures.
 *
 * The adapter reads luma's private `compiledNodes`, so a luma upgrade that renames or reshapes
 * it would fail here rather than draw an empty graph. And the description is checked for the
 * facts a debugger is for: the predicate pass writes the selection mask, the compaction reads
 * it, the input column reaches the row ids, and no edge points at a node that is not there.
 */

const ROWS = 20_000;

let device: GPUDevice;
let adapter: GPUAdapter;
let v: GPUBuffer;
let bin: GPUBuffer;

beforeAll(async () => {
  device = await gpuDevice();
  // luma's device wrapper wants an adapter for its info; any adapter of this device will do.
  adapter = (await navigator.gpu.requestAdapter())!;
  const values = new Float32Array(ROWS).map((_, i) => (i % 100) / 100);
  v = storageBuffer(device, values, 'v');
  const keys = new Uint32Array(ROWS).map((_, i) => i % 8);
  bin = device.createBuffer({ size: keys.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  device.queue.writeBuffer(bin, 0, keys);
});

/** Ids of every node reachable downstream of `from`. */
function downstream(d: GraphDescription, from: string): Set<string> {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of d.edges) if (e.from === id && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
  }
  return seen;
}

describe('describeCommandGraph', () => {
  it('describes a compiled filter: schedule, resources and data flow', async () => {
    const filter = new LumaFilter({ device, adapter, columns: { v }, rows: ROWS, predicate: parseExpr('v > {{cut}}'), params: { cut: 0.5 } });
    const d = describeCommandGraph(filter.commandGraph);
    expect(validateGraph(d)).toEqual([]);

    // Every scheduled pass is a work node, in schedule order.
    const work = d.nodes.filter((n) => n.role !== 'data');
    expect(work.map((n) => n.id)).toEqual(filter.commandGraph.stats.nodeOrder);
    expect(work.map((n) => n.order)).toEqual(work.map((_, i) => i));

    const byLabel = (pattern: RegExp) => d.nodes.filter((n) => pattern.test(n.label ?? ''));
    const predicate = byLabel(/^predicate-batch-0$/)[0];
    const mask = byLabel(/^selection-mask$/)[0];
    const rowIds = byLabel(/^row-indices$/)[0];
    expect(predicate && mask && rowIds).toBeTruthy();
    expect(d.edges).toContainEqual(expect.objectContaining({ from: predicate.id, to: mask.id, kind: 'write' }));
    expect(d.edges.some((e) => e.from === mask.id && e.kind === 'read')).toBe(true);

    // The imported column reaches the compacted ids. luma names an imported column by position.
    const input = d.nodes.find((n) => n.role === 'data' && !d.edges.some((e) => e.to === n.id) && /input/.test(n.label ?? ''));
    expect(input).toBeDefined();
    expect(downstream(d, input!.id).has(rowIds.id)).toBe(true);

    // A pass that reads and writes one buffer gets a new version, so the graph stays acyclic.
    const versioned = d.nodes.filter((n) => n.role === 'data' && Number(n.attributes?.version) > 1);
    expect(versioned.length).toBeGreaterThan(0);

    // The pass-only view keeps the passes and the graph's inputs and outputs.
    const passes = collapseData(d);
    expect(validateGraph(passes)).toEqual([]);
    expect(passes.nodes.filter((n) => n.role !== 'data')).toHaveLength(work.length);
    expect(passes.nodes.some((n) => n.id === rowIds.id)).toBe(true);

    filter.destroy();
  });

  it('carries the inspector’s timings for every encoding, from two graphs on one inspector', async () => {
    // Two filters on one inspector: they used to share the id `noodles-luma-filter`, and the
    // inspector replaced the first registration with the second, dropping its timings silently.
    const inspector = new GPUCommandGraphInspector();
    const common = { device, adapter, columns: { v }, rows: ROWS, predicate: parseExpr('v > {{cut}}'), params: { cut: 0.5 }, inspector };
    const a = new LumaFilter(common);
    const b = new LumaFilter(common);
    const group = new LumaGroupBy({
      device, adapter, key: { name: 'bin', buffer: bin }, groupCount: 8, columns: { v }, rows: ROWS,
      aggregates: { n: 'count' }, inspector,
    });
    expect(new Set([a, b, group].map((q) => q.commandGraph.id)).size).toBe(3);

    await expectNoGpuError(device, async () => {
      for (let i = 0; i < 3; i++) { a.run({ cut: 0.2 }); b.run({ cut: 0.8 }); group.run(); }
      await device.queue.onSubmittedWorkDone();
    });

    for (const q of [a, b, group]) {
      const snapshot = inspector.getSnapshot().graphs.find((g) => g.id === q.commandGraph.id);
      expect(snapshot?.encodingCount, q.commandGraph.id).toBe(3);
      const d = describeCommandGraph(q.commandGraph, { snapshot });
      expect(d.metrics?.encodings?.value).toBe(3);
      const timed = d.nodes.filter((n) => n.role !== 'data' && n.metrics?.cpu);
      expect(timed.length).toBe(q.commandGraph.stats.nodeOrder.length);
    }
    for (const q of [a, b, group]) q.destroy();
  });
});
