/**
 * A layered heatmap of (v, w) where v > cut: a GPU Dataframe filter, then render passes that
 * draw what it selected. Each step leaves a texture the viewer can show.
 *
 *   filter          luma GPU Dataframe: predicate, scan, scatter -> row indices, selected count
 *   draw args       compute: the GPU-resident count into indirect draw arguments
 *   splat           render: one additive quad per selected row into a float accumulation texture,
 *                   an indirect draw, so the CPU never learns how many rows passed
 *   blur h, blur v  render: a separable Gaussian over the accumulation
 *   colormap        render: log-scaled density through a color ramp
 *   points          render: every 64th selected row as a dot, for the overlay
 *   composite       render: heatmap, points and a grid into the frame
 *
 * The filter is its own command graph, as a GPU Dataframe query has to be (`compile` freezes the
 * graph it is given). The render graph imports the filter's buffers through the luma `GPUData`
 * the filter exposes, so both graphs name the same luma buffers and `describeCommandGraphs`
 * draws them as one pipeline.
 *
 * The render targets are textures this class creates and imports, not graph transients. luma
 * lets transients whose lifetimes do not overlap share an allocation, and here it would: once
 * `blur h` has read `density`, `blur v` can reuse its memory, and a preview of `density` after
 * the run would show the blur. Owning them costs 9 MB and keeps every step's picture readable.
 */

import { Buffer as LumaBuffer, Texture } from '@luma.gl/core';
import {
  GPUCommandGraph, type CompiledGPUCommandGraph, type GPUCommandGraphInspector, type GraphTextureHandle,
} from '@luma.gl/gpgpu/gpu-core';
import { parseExpr } from '@noodles.gl/planner';
import { CommandGraphRunner, LumaFilter } from '../../src/luma/index.js';
import { graphId, lumaDeviceFor } from '../../src/luma/dataframe.js';
import { ADD, FULLSCREEN, OVER, computeKernel, renderKernel } from './passes.js';

export const HEATMAP_SIZE = 512;
const N = HEATMAP_SIZE;
type Params = Record<string, never>;

export interface HeatmapProps {
  device: GPUDevice;
  adapter: GPUAdapter;
  /** f32 columns, `rows` long: v in [0, 1) across, w in [0, 100) up. */
  v: GPUBuffer;
  w: GPUBuffer;
  rows: number;
  inspector?: GPUCommandGraphInspector;
}

export class HeatmapPipeline {
  /** The resource the last pass writes: what to show as the picture. */
  static readonly output = 'frame';
  private readonly filter: LumaFilter;
  private readonly runner: CommandGraphRunner<Params>;
  private readonly targets: Texture[] = [];

  constructor({ device, adapter, v, w, rows, inspector }: HeatmapProps) {
    this.filter = new LumaFilter({
      device, adapter, columns: { v, w }, rows, predicate: parseExpr('v > {{cut}}'), params: { cut: 0.5 }, inspector,
    });
    const data = this.filter.data();
    const luma = lumaDeviceFor(device, adapter);
    const graph = new GPUCommandGraph<Params>(luma, { id: graphId('heatmap') });

    // The filter's buffers, imported as the views it exposes: same luma buffers, same formats.
    const vIn = graph.importGPUData('v', data.columns.v);
    const wIn = graph.importGPUData('w', data.columns.w);
    const ids = graph.importGPUData('row indices', data.rowIndices);
    const count = graph.importGPUData('selected count', data.selectedCount);
    // Two sets of indirect arguments: every selected row for the splat, every 64th for the points.
    const args = graph.createTransientBuffer({ id: 'draw args', byteLength: 32, usage: LumaBuffer.INDIRECT | LumaBuffer.STORAGE });

    const target = (id: string, format: 'rgba16float' | 'rgba8unorm'): GraphTextureHandle => {
      const descriptor = { id, format, width: N, height: N, usage: Texture.RENDER | Texture.SAMPLE | Texture.COPY_SRC };
      const texture = luma.createTexture(descriptor);
      this.targets.push(texture);
      return graph.importTexture(descriptor, texture);
    };
    const density = target('density', 'rgba16float');
    const blurH = target('blur h', 'rgba16float');
    const blurV = target('blur v', 'rgba16float');
    const heat = target('heat', 'rgba8unorm');
    const points = target('points', 'rgba8unorm');
    const frame = target(HeatmapPipeline.output, 'rgba8unorm');
    const into = (t: GraphTextureHandle) => ({ colorAttachments: [graph.createTextureView(t)] });
    const sampled = (t: GraphTextureHandle) => ({ texture: t, usage: 'sampled' as const });
    const full = { commandCount: 1, maximumInvocationCount: N * N };

    graph.addComputePass({
      id: 'draw args',
      resources: [{ buffer: count, usage: 'storage-read' }, { buffer: args, usage: 'storage-write' }],
      workload: { operation: 'IndirectArgs', commandCount: 1, maximumInvocationCount: 1, writeByteLength: 32 },
      compile: ({ device: d }) => computeKernel<Params>(d, DRAW_ARGS, [count, args], 1),
    });
    for (const [id, out, code, blend, offset] of [
      ['splat', density, splat(1.5, 1, 'vec4(1.0, 0.0, 0.0, 1.0)'), ADD, 0],
      ['points', points, splat(1.0, 64, 'vec4(0.22, 0.4, 0.46, 0.6)'), OVER, 16],
    ] as const) {
      graph.addRenderPass({
        id,
        resources: [
          { buffer: vIn, usage: 'storage-read' }, { buffer: wIn, usage: 'storage-read' },
          { buffer: ids, usage: 'storage-read' }, { buffer: args, usage: 'indirect' },
        ],
        attachments: into(out),
        workload: { operation: 'Splat', commandCount: 1, maximumInvocationCount: rows * 6, readByteLength: rows * 12 },
        compile: ({ device: d }) => renderKernel<Params>(d, {
          code, format: id === 'splat' ? 'rgba16float' : 'rgba8unorm', blend, bindings: [vIn, wIn, ids],
          draw: (pass, context) => pass.drawIndirect(context.getBuffer(args).handle as GPUBuffer, offset),
        }),
      });
    }
    for (const [id, from, to, axis] of [['blur h', density, blurH, 'vec2(1, 0)'], ['blur v', blurH, blurV, 'vec2(0, 1)']] as const) {
      graph.addRenderPass({
        id, resources: [sampled(from)], attachments: into(to), workload: { operation: 'Blur', ...full },
        compile: ({ device: d }) => renderKernel<Params>(d, { code: blur(axis), format: 'rgba16float', bindings: [from], draw: (p) => p.draw(3) }),
      });
    }
    graph.addRenderPass({
      id: 'colormap', resources: [sampled(blurV)], attachments: into(heat), workload: { operation: 'Colormap', ...full },
      compile: ({ device: d }) => renderKernel<Params>(d, { code: COLORMAP, format: 'rgba8unorm', bindings: [blurV], draw: (p) => p.draw(3) }),
    });
    graph.addRenderPass({
      id: 'composite', resources: [sampled(heat), sampled(points)], attachments: into(frame), workload: { operation: 'Composite', ...full },
      compile: ({ device: d }) => renderKernel<Params>(d, { code: COMPOSITE, format: 'rgba8unorm', bindings: [heat, points], draw: (p) => p.draw(3) }),
    });

    this.runner = new CommandGraphRunner(luma, graph.compile(), inspector);
  }

  /** Both graphs, in the order they run: the filter, then the render passes. */
  get commandGraphs(): CompiledGPUCommandGraph<never>[] {
    return [this.filter.commandGraph, this.runner.graph] as CompiledGPUCommandGraph<never>[];
  }

  run(params: Record<string, number> = {}): void {
    this.filter.run(params);
    // A separate submission after the filter's: queue order keeps the reads after its writes.
    this.runner.run({});
  }

  destroy(): void {
    this.runner.destroy();
    this.runner.graph.destroy();
    for (const t of this.targets) t.destroy();
    this.filter.destroy();
  }
}

const DRAW_ARGS = /* wgsl */ `
@group(0) @binding(0) var<storage, read> count: array<u32>;
@group(0) @binding(1) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(1) fn main() {
  // vertexCount, instanceCount, firstVertex, firstInstance: a six-vertex quad per selected row,
  // then the same for every 64th one.
  args[0] = 6u; args[1] = count[0]; args[2] = 0u; args[3] = 0u;
  args[4] = 6u; args[5] = count[0] / 64u; args[6] = 0u; args[7] = 0u;
}`;

/** A quad of `px` pixels at (v, w / 100) for every `stride`th selected row, drawing `color`. */
function splat(px: number, stride: number, color: string): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> v: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> ids: array<u32>;
@vertex fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) k: u32) -> @builtin(position) vec4<f32> {
  let row = ids[k * ${stride}u];
  let center = vec2(v[row], w[row] / 100.0) * 2.0 - 1.0;
  var quad = array(vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0));
  return vec4(center + quad[corner] * (${px} / ${N}.0), 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return ${color}; }`;
}

/** A 13-tap Gaussian (sigma 3 px) along `axis`. */
function blur(axis: string): string {
  return /* wgsl */ `${FULLSCREEN}
@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(at.xy);
  var sum = vec4(0.0);
  var total = 0.0;
  for (var i = -6; i <= 6; i++) {
    let weight = exp(-f32(i * i) / 18.0);
    let q = clamp(p + ${axis.replace('vec2', 'vec2<i32>')} * i, vec2(0), vec2(${N - 1}));
    sum += textureLoad(source, q, 0) * weight;
    total += weight;
  }
  return sum / total;
}`;
}

const COLORMAP = /* wgsl */ `${FULLSCREEN}
@group(0) @binding(0) var density: texture_2d<f32>;
@fragment fn fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
  let d = textureLoad(density, vec2<i32>(at.xy), 0).r;
  // Log scale: a few rows per pixel at the band's edges, a couple of hundred at its center.
  let t = clamp(log(1.0 + d) / log(1.0 + 240.0), 0.0, 1.0);
  let low = vec3(0.05, 0.03, 0.18);
  let mid = vec3(0.72, 0.16, 0.45);
  let high = vec3(1.0, 0.92, 0.6);
  let color = mix(mix(low, mid, smoothstep(0.0, 0.5, t)), high, smoothstep(0.5, 1.0, t));
  return vec4(color * step(0.002, d), step(0.002, d));
}`;

const COMPOSITE = /* wgsl */ `${FULLSCREEN}
@group(0) @binding(0) var heat: texture_2d<f32>;
@group(0) @binding(1) var points: texture_2d<f32>;
@fragment fn fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(at.xy);
  let h = textureLoad(heat, p, 0);
  let d = textureLoad(points, p, 0);
  // A grid every 64 px under everything, then the heatmap, then the points over it.
  let grid = select(0.0, 0.10, (p.x % 64) == 0 || (p.y % 64) == 0);
  var color = vec3(0.035, 0.04, 0.06) + grid;
  color = mix(color, h.rgb, h.a);
  color = color * (1.0 - d.a) + d.rgb;
  return vec4(color, 1.0);
}`;
