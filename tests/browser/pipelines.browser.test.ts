import { describe, it, expect, beforeAll } from 'vitest';
import { validateGraph, type GraphDescription, type NodePreview } from '@noodles.gl/graph-view';
import { describeCommandGraphs, previewCommandGraphsResource } from '../../src/luma/index.js';
import { HeatmapPipeline, HEATMAP_SIZE } from '../../demo/graph/heatmap.js';
import { HistogramPipeline, CHART } from '../../demo/graph/histogram.js';
import { gpuDevice, storageBuffer, expectNoGpuError } from './harness.js';

/**
 * The demo's two render pipelines on real WebGPU: a GPU Dataframe query's graph followed by a
 * graph of render passes that imports its buffers.
 *
 * What a debugger needs from them is checked directly: the two graphs are drawn joined where they
 * share a buffer, every step's texture can be read back after the run (not overwritten by a later
 * step that shares its memory), and the pictures respect the query: nothing left of the cut.
 */

const ROWS = 20_000;
let device: GPUDevice;
let adapter: GPUAdapter;
let v: GPUBuffer;
let w: GPUBuffer;
let bin: GPUBuffer;

beforeAll(async () => {
  device = await gpuDevice();
  adapter = (await navigator.gpu.requestAdapter())!;
  const vs = new Float32Array(ROWS).map((_, i) => ((i * 7919) % ROWS) / ROWS);
  v = storageBuffer(device, vs, 'v');
  w = storageBuffer(device, vs.map((x) => 50 + 30 * Math.sin(x * Math.PI * 3)), 'w');
  const keys = new Uint32Array(vs.map((x) => Math.floor(x * CHART.bins)));
  bin = device.createBuffer({ size: keys.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  device.queue.writeBuffer(bin, 0, keys);
});

const latest = (d: GraphDescription, resource: string) =>
  d.nodes.filter((n) => n.attributes?.resource === resource).sort((a, b) => Number(b.attributes?.version) - Number(a.attributes?.version))[0];

/**
 * Bright pixels left and right of the middle, skipping `margin` px either side of it. The grid
 * lines sit under the brightness threshold, and the margin covers the blur's reach past the cut.
 */
function lit(p: NodePreview | undefined, margin = 0): { left: number; right: number } {
  if (p?.kind !== 'image') throw new Error('not an image');
  let left = 0;
  let right = 0;
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 4;
      if (p.rgba[i] + p.rgba[i + 1] + p.rgba[i + 2] <= 150) continue;
      if (x < p.width / 2 - margin) left++;
      else if (x >= p.width / 2 + margin) right++;
    }
  }
  return { left, right };
}

describe('render pipelines', () => {
  it('heatmap: the filter and the render passes draw as one graph, and every step can be read back', async () => {
    const heatmap = new HeatmapPipeline({ device, adapter, v, w, rows: ROWS });
    await expectNoGpuError(device, async () => {
      heatmap.run({ cut: 0.5 });
      await device.queue.onSubmittedWorkDone();
    });
    const d = describeCommandGraphs(heatmap.commandGraphs.map((graph) => ({ graph })));
    expect(validateGraph(d)).toEqual([]);

    // Joined where they share data: the filter's row indices and its v column feed the splat.
    const [filterGraph, renderGraph] = heatmap.commandGraphs.map((g) => g.id);
    const splat = d.nodes.find((n) => n.label === 'splat')!;
    const into = (id: string) => d.edges.filter((e) => e.to === id).map((e) => d.nodes.find((n) => n.id === e.from)!);
    const fromFilter = into(splat.id).filter((n) => n.attributes?.graph === filterGraph).map((n) => n.label);
    expect(fromFilter).toEqual(expect.arrayContaining(['row indices', 'input 0']));
    expect(d.nodes.some((n) => n.attributes?.graph === renderGraph && n.label === 'v')).toBe(false);

    const read = (resource: string) => previewCommandGraphsResource(heatmap.commandGraphs, latest(d, resource));
    const density = await read('density');
    const blurred = await read('blur v');
    // Owned targets: the accumulation still holds the splat, not the blur that ran after it.
    expect(density?.kind === 'image' && blurred?.kind === 'image').toBe(true);
    expect(density?.kind === 'image' && blurred?.kind === 'image' && density.note === blurred.note).toBe(false);
    // Only v > 0.5 is drawn; the 13-tap blur reaches 6 px past the cut.
    const picture = await read(HeatmapPipeline.output);
    expect(picture?.kind === 'image' && picture.width).toBe(HEATMAP_SIZE);
    const frame = lit(picture, 8);
    expect(frame.right).toBeGreaterThan(0);
    expect(frame.left).toBe(0);
    heatmap.destroy();
  });

  it('histogram: bars right of the cut only, from the group-by the chart graph imports', async () => {
    const histogram = new HistogramPipeline({ device, adapter, v, w, bin, rows: ROWS });
    await expectNoGpuError(device, async () => {
      histogram.run({ cut: 0.5 });
      await device.queue.onSubmittedWorkDone();
    });
    const d = describeCommandGraphs(histogram.commandGraphs.map((graph) => ({ graph })));
    expect(validateGraph(d)).toEqual([]);
    const bars = d.nodes.find((n) => n.label === 'bars')!;
    const inputs = d.edges.filter((e) => e.to === bars.id).map((e) => d.nodes.find((n) => n.id === e.from)!);
    // n and m are the group-by's own outputs, not new imports.
    expect(inputs.filter((n) => n.attributes?.graph === histogram.commandGraphs[0].id).length).toBe(2);

    const bars_ = lit(await previewCommandGraphsResource(histogram.commandGraphs, latest(d, 'bars')));
    expect(bars_.right).toBeGreaterThan(0);
    expect(bars_.left).toBe(0);
    histogram.destroy();
  });
});
