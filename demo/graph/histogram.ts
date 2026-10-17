/**
 * A histogram of v where v > cut, bars colored by the mean of w in each bin: a GPU Dataframe
 * group-by, then render passes that draw its 64 aggregates as a chart.
 *
 *   group-by    luma GPU Dataframe: filter, then count and mean(w) per bin -> n, m (64 each)
 *   scale       compute: the largest count, so bars fill the chart's height
 *   bars        render: one instanced quad per bin, height n / max, color by mean(w)
 *   mean line   render: a line strip through each bin's mean of w
 *   axes        render: the frame and grid, which depend on nothing
 *   chart       render: axes, bars and the mean line into the chart
 *
 * As with the heatmap, the group-by is its own command graph and the chart graph imports its
 * outputs through `LumaGroupBy.data()`, so `describeCommandGraphs` joins them, and the targets
 * are owned textures so each step stays readable after the run. Nothing here reads the
 * aggregates back: the CPU never learns a count, only the GPU draws them.
 */

import { Buffer as LumaBuffer, Texture } from '@luma.gl/core';
import {
  GPUCommandGraph, type CompiledGPUCommandGraph, type GPUCommandGraphInspector, type GraphTextureHandle,
} from '@luma.gl/gpgpu/gpu-core';
import { parseExpr } from '@noodles.gl/planner';
import { CommandGraphRunner, LumaGroupBy } from '../../src/luma/index.js';
import { graphId, lumaDeviceFor } from '../../src/luma/dataframe.js';
import { FULLSCREEN, OVER, computeKernel, renderKernel } from './passes.js';

export const CHART = { width: 512, height: 256, bins: 64 } as const;
const { width: W, height: H, bins: B } = CHART;
type Params = Record<string, never>;

export interface HistogramProps {
  device: GPUDevice;
  adapter: GPUAdapter;
  /** f32 columns, `rows` long. */
  v: GPUBuffer;
  w: GPUBuffer;
  /** u32, `floor(v * 64)`: the dense group key luma's group-by needs. */
  bin: GPUBuffer;
  rows: number;
  inspector?: GPUCommandGraphInspector;
}

export class HistogramPipeline {
  static readonly output = 'chart';
  private readonly group: LumaGroupBy;
  private readonly runner: CommandGraphRunner<Params>;
  private readonly targets: Texture[] = [];

  constructor({ device, adapter, v, w, bin, rows, inspector }: HistogramProps) {
    this.group = new LumaGroupBy({
      device, adapter, key: { name: 'bin', buffer: bin }, groupCount: B, columns: { v, w }, rows,
      aggregates: { n: 'count', m: { mean: 'w' } }, predicate: parseExpr('v > {{cut}}'), params: { cut: 0.5 }, inspector,
    });
    const { outputs } = this.group.data();
    const luma = lumaDeviceFor(device, adapter);
    const graph = new GPUCommandGraph<Params>(luma, { id: graphId('histogram') });

    const n = graph.importGPUData('n', outputs.n);
    const m = graph.importGPUData('m', outputs.m);
    const scale = graph.createTransientBuffer({ id: 'scale', byteLength: 16, usage: LumaBuffer.STORAGE });
    const target = (id: string): GraphTextureHandle => {
      const descriptor = { id, format: 'rgba8unorm' as const, width: W, height: H, usage: Texture.RENDER | Texture.SAMPLE | Texture.COPY_SRC };
      const texture = luma.createTexture(descriptor);
      this.targets.push(texture);
      return graph.importTexture(descriptor, texture);
    };
    const bars = target('bars');
    const means = target('mean line');
    const axes = target('axes');
    const chart = target(HistogramPipeline.output);
    const into = (t: GraphTextureHandle) => ({ colorAttachments: [graph.createTextureView(t)] });
    const sampled = (t: GraphTextureHandle) => ({ texture: t, usage: 'sampled' as const });
    const full = { commandCount: 1, maximumInvocationCount: W * H };

    graph.addComputePass({
      id: 'scale',
      resources: [{ buffer: n, usage: 'storage-read' }, { buffer: scale, usage: 'storage-write' }],
      workload: { operation: 'Reduce', commandCount: 1, maximumInvocationCount: B, readByteLength: B * 4, writeByteLength: 4 },
      compile: ({ device: d }) => computeKernel<Params>(d, SCALE, [n, scale], 1),
    });
    graph.addRenderPass({
      id: 'bars',
      resources: [{ buffer: n, usage: 'storage-read' }, { buffer: m, usage: 'storage-read' }, { buffer: scale, usage: 'storage-read' }],
      attachments: into(bars),
      workload: { operation: 'Bars', commandCount: 1, maximumInvocationCount: B * 6 },
      compile: ({ device: d }) => renderKernel<Params>(d, { code: BARS, format: 'rgba8unorm', bindings: [n, m, scale], draw: (p) => p.draw(6, B) }),
    });
    graph.addRenderPass({
      id: 'mean line',
      resources: [{ buffer: n, usage: 'storage-read' }, { buffer: m, usage: 'storage-read' }],
      attachments: into(means),
      workload: { operation: 'Line', commandCount: 1, maximumInvocationCount: B * 6 },
      compile: ({ device: d }) => renderKernel<Params>(d, { code: MEAN_LINE, format: 'rgba8unorm', blend: OVER, bindings: [n, m], draw: (p) => p.draw(6, B - 1) }),
    });
    graph.addRenderPass({
      id: 'axes', resources: [], attachments: into(axes), workload: { operation: 'Axes', ...full },
      compile: ({ device: d }) => renderKernel<Params>(d, { code: AXES, format: 'rgba8unorm', bindings: [], draw: (p) => p.draw(3) }),
    });
    graph.addRenderPass({
      id: 'chart', resources: [sampled(axes), sampled(bars), sampled(means)], attachments: into(chart), workload: { operation: 'Composite', ...full },
      compile: ({ device: d }) => renderKernel<Params>(d, { code: COMPOSITE, format: 'rgba8unorm', bindings: [axes, bars, means], draw: (p) => p.draw(3) }),
    });

    this.runner = new CommandGraphRunner(luma, graph.compile(), inspector);
  }

  get commandGraphs(): CompiledGPUCommandGraph<never>[] {
    return [this.group.commandGraph, this.runner.graph] as CompiledGPUCommandGraph<never>[];
  }

  run(params: Record<string, number> = {}): void {
    this.group.run(params);
    this.runner.run({});
  }

  destroy(): void {
    this.runner.destroy();
    this.runner.graph.destroy();
    for (const t of this.targets) t.destroy();
    this.group.destroy();
  }
}

// The plot area inside a margin, in clip space: x from -0.9 to 0.94, y from -0.84 to 0.88.
const PLOT = /* wgsl */ `
const LEFT = -0.9; const RIGHT = 0.94; const BOTTOM = -0.84; const TOP = 0.88;
fn plot(u: vec2<f32>) -> vec2<f32> { return vec2(mix(LEFT, RIGHT, u.x), mix(BOTTOM, TOP, u.y)); }`;

const SCALE = /* wgsl */ `
@group(0) @binding(0) var<storage, read> n: array<u32>;
@group(0) @binding(1) var<storage, read_write> scale: array<u32>;
var<workgroup> top: atomic<u32>;
@compute @workgroup_size(${B}) fn main(@builtin(local_invocation_index) i: u32) {
  atomicMax(&top, n[i]);
  workgroupBarrier();
  if (i == 0u) { scale[0] = max(atomicLoad(&top), 1u); }
}`;

const BARS = /* wgsl */ `${PLOT}
@group(0) @binding(0) var<storage, read> n: array<u32>;
@group(0) @binding(1) var<storage, read> m: array<f32>;
@group(0) @binding(2) var<storage, read> scale: array<u32>;
struct Bar { @builtin(position) position: vec4<f32>, @location(0) color: vec3<f32> };
@vertex fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) b: u32) -> Bar {
  var unit = array(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
  let height = f32(n[b]) / f32(scale[0]);
  // A small gap between bars.
  let x = (f32(b) + 0.12 + unit[corner].x * 0.76) / ${B}.0;
  var out: Bar;
  out.position = vec4(plot(vec2(x, unit[corner].y * height)), 0.0, 1.0);
  // Low means teal, high means orange; an empty bin has no mean and draws nothing.
  let t = clamp(m[b] / 100.0, 0.0, 1.0);
  out.color = mix(vec3(0.15, 0.55, 0.62), vec3(0.98, 0.58, 0.2), t);
  return out;
}
@fragment fn fs(bar: Bar) -> @location(0) vec4<f32> { return vec4(bar.color, 1.0); }`;

// A strip of quads 2px thick from each bin's mean to the next: WebGPU lines are 1px only.
const MEAN_LINE = /* wgsl */ `${PLOT}
@group(0) @binding(0) var<storage, read> n: array<u32>;
@group(0) @binding(1) var<storage, read> m: array<f32>;
@vertex fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) b: u32) -> @builtin(position) vec4<f32> {
  let a = plot(vec2((f32(b) + 0.5) / ${B}.0, m[b] / 100.0));
  let c = plot(vec2((f32(b) + 1.5) / ${B}.0, m[b + 1u] / 100.0));
  // Skip segments that touch an empty bin: its mean is not a number to plot.
  if (n[b] == 0u || n[b + 1u] == 0u) { return vec4(2.0, 2.0, 0.0, 1.0); }
  let along = c - a;
  let across = normalize(vec2(-along.y * ${H}.0, along.x * ${W}.0)) * vec2(2.0 / ${W}.0, 2.0 / ${H}.0);
  var ends = array(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
  var sides = array(-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);
  return vec4(a + along * ends[corner] + across * sides[corner], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4(0.95, 0.95, 0.98, 1.0); }`;

const AXES = /* wgsl */ `${FULLSCREEN}
${PLOT}
@fragment fn fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
  let clip = vec2(at.x / ${W}.0 * 2.0 - 1.0, 1.0 - at.y / ${H}.0 * 2.0);
  let px = vec2(2.0 / ${W}.0, 2.0 / ${H}.0);
  let inside = clip.x >= LEFT && clip.x <= RIGHT && clip.y >= BOTTOM && clip.y <= TOP;
  // Axis lines on the left and bottom, and a horizontal grid line every quarter of the height.
  let axis = (abs(clip.x - LEFT) < px.x && clip.y >= BOTTOM && clip.y <= TOP) || (abs(clip.y - BOTTOM) < px.y && clip.x >= LEFT && clip.x <= RIGHT);
  let q = (clip.y - BOTTOM) / (TOP - BOTTOM) * 4.0;
  let grid = inside && abs(q - round(q)) * (TOP - BOTTOM) / 4.0 < px.y * 0.5 && round(q) > 0.0;
  // Ticks under the x axis at v = 0, 0.25, 0.5, 0.75, 1.
  let t = (clip.x - LEFT) / (RIGHT - LEFT) * 4.0;
  let tick = abs(t - round(t)) * (RIGHT - LEFT) / 4.0 < px.x && clip.y < BOTTOM && clip.y > BOTTOM - 6.0 * px.y;
  if (axis || tick) { return vec4(0.62, 0.66, 0.74, 1.0); }
  if (grid) { return vec4(0.16, 0.18, 0.23, 1.0); }
  return vec4(0.0);
}`;

const COMPOSITE = /* wgsl */ `${FULLSCREEN}
@group(0) @binding(0) var axes: texture_2d<f32>;
@group(0) @binding(1) var bars: texture_2d<f32>;
@group(0) @binding(2) var means: texture_2d<f32>;
@fragment fn fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(at.xy);
  var color = vec3(0.035, 0.04, 0.06);
  let a = textureLoad(axes, p, 0);
  color = mix(color, a.rgb, a.a);
  let b = textureLoad(bars, p, 0);
  color = mix(color, b.rgb, b.a * 0.92);
  let l = textureLoad(means, p, 0);
  color = mix(color, l.rgb, l.a);
  return vec4(color, 1.0);
}`;
