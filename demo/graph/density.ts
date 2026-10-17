/**
 * A 2D density map of (v, w) as a luma command graph: clear a grid of counts, accumulate every
 * row with `v > cut` into it, then color the counts into a texture.
 *
 * It is here to give the viewer a texture to show. The GPU Dataframe queries only touch buffers,
 * and the texture preview needs a graph that writes one. Three hand-written compute passes are
 * enough, and because they declare their buffer and texture uses to luma like any contributor,
 * luma orders them and the viewer draws them with nothing special-cased.
 *
 * The passes are `computeKernel`s (`./passes.ts`): raw WGSL, with every buffer and texture they
 * touch declared to luma.
 */

import { Buffer as LumaBuffer, Texture } from '@luma.gl/core';
import type { WebGPUDevice } from '@luma.gl/webgpu';
import { GPUCommandGraph, type CompiledGPUCommandGraph, type GPUCommandGraphInspector } from '@luma.gl/gpgpu/gpu-core';
import { CommandGraphRunner } from '../../src/luma/index.js';
import { graphId, lumaDeviceFor } from '../../src/luma/dataframe.js';
import { computeKernel } from './passes.js';

export const DENSITY_SIZE = 256;
const N = DENSITY_SIZE;

type Params = { cut: number };

export interface DensityProps {
  device: GPUDevice;
  adapter: GPUAdapter;
  /** f32 columns, `rows` long: v in [0, 1) across, w in [0, 100) up. */
  v: GPUBuffer;
  w: GPUBuffer;
  rows: number;
  inspector?: GPUCommandGraphInspector;
}

export class DensityGraph {
  private readonly runner: CommandGraphRunner<Params>;
  private readonly uniforms: LumaBuffer;

  constructor({ device, adapter, v, w, rows, inspector }: DensityProps) {
    const luma = lumaDeviceFor(device, adapter);
    const graph = new GPUCommandGraph<Params>(luma, { id: graphId('density') });
    // Wrappers over the caller's buffers. Never destroyed: luma's destroy would destroy the handle.
    const borrow = (id: string, handle: GPUBuffer) =>
      luma.createBuffer({ id, handle, byteLength: handle.size, usage: LumaBuffer.STORAGE | LumaBuffer.COPY_SRC | LumaBuffer.COPY_DST });
    const vIn = graph.importBuffer({ id: 'v', byteLength: v.size, usage: LumaBuffer.STORAGE }, borrow('v', v));
    const wIn = graph.importBuffer({ id: 'w', byteLength: w.size, usage: LumaBuffer.STORAGE }, borrow('w', w));
    const uniforms = luma.createBuffer({ id: 'density-params', byteLength: 16, usage: LumaBuffer.UNIFORM | LumaBuffer.COPY_DST });
    this.uniforms = uniforms;
    const params = graph.importBuffer({ id: 'params', byteLength: 16, usage: LumaBuffer.UNIFORM }, uniforms);
    const bins = graph.createTransientBuffer({ id: 'bins', byteLength: N * N * 4, usage: LumaBuffer.STORAGE | LumaBuffer.COPY_SRC });
    const image = graph.createTransientTexture({
      id: 'density', format: 'rgba8unorm', width: N, height: N, usage: Texture.STORAGE | Texture.COPY_SRC | Texture.SAMPLE,
    });

    graph.addComputePass({
      id: 'clear-bins',
      resources: [{ buffer: bins, usage: 'storage-write' }],
      workload: { operation: 'Density', commandCount: 1, maximumInvocationCount: N * N, writeByteLength: N * N * 4 },
      compile: ({ device: d }) => computeKernel<Params>(d, CLEAR, [bins], (N * N) / 256),
    });
    graph.addComputePass({
      id: 'accumulate',
      resources: [
        { buffer: vIn, usage: 'storage-read' }, { buffer: wIn, usage: 'storage-read' },
        { buffer: params, usage: 'uniform' }, { buffer: bins, usage: 'storage-read-write' },
      ],
      workload: { operation: 'Density', commandCount: 1, maximumInvocationCount: rows, readByteLength: rows * 8, writeByteLength: N * N * 4 },
      compile: ({ device: d }) => computeKernel<Params>(d, ACCUMULATE, [vIn, wIn, params, bins], Math.ceil(rows / 256), ({ parameters }) => {
        // Before this command buffer is submitted, so the pass sees this run's `cut`.
        (d as WebGPUDevice).handle.queue.writeBuffer(uniforms.handle as GPUBuffer, 0, new Float32Array([parameters.cut, rows, 0, 0]));
      }),
    });
    graph.addComputePass({
      id: 'colorize',
      resources: [{ buffer: bins, usage: 'storage-read' }, { texture: image, usage: 'storage-write' }],
      workload: { operation: 'Density', commandCount: 1, maximumInvocationCount: N * N, readByteLength: N * N * 4, writeByteLength: N * N * 4 },
      compile: ({ device: d }) => computeKernel<Params>(d, COLORIZE, [bins, image], [N / 16, N / 16]),
    });

    this.runner = new CommandGraphRunner(luma, graph.compile(), inspector);
  }

  get commandGraph(): CompiledGPUCommandGraph<Params> {
    return this.runner.graph;
  }

  run(params: Record<string, number> = {}): void {
    this.runner.run({ cut: params.cut ?? 0 });
  }

  destroy(): void {
    this.runner.destroy();
    this.runner.graph.destroy();
    this.uniforms.destroy();
  }
}

const CLEAR = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> bins: array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < arrayLength(&bins)) { bins[id.x] = 0u; }
}`;

const ACCUMULATE = /* wgsl */ `
@group(0) @binding(0) var<storage, read> v: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<uniform> params: vec4<f32>; // cut, rows
@group(0) @binding(3) var<storage, read_write> bins: array<atomic<u32>>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= u32(params.y) || v[i] <= params.x) { return; }
  let x = min(u32(v[i] * ${N}.0), ${N - 1}u);
  let y = min(u32(clamp(w[i], 0.0, 99.999) / 100.0 * ${N}.0), ${N - 1}u);
  atomicAdd(&bins[y * ${N}u + x], 1u);
}`;

const COLORIZE = /* wgsl */ `
@group(0) @binding(0) var<storage, read> bins: array<u32>;
@group(0) @binding(1) var image: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ${N}u || id.y >= ${N}u) { return; }
  let count = f32(bins[id.y * ${N}u + id.x]);
  // Log scale: a few hundred rows per bin at the band's center, one at its edges.
  let t = clamp(log(1.0 + count) / log(1.0 + 400.0), 0.0, 1.0);
  let low = vec3(0.10, 0.06, 0.28);
  let mid = vec3(0.80, 0.22, 0.42);
  let high = vec3(0.99, 0.90, 0.55);
  var color = mix(mix(low, mid, smoothstep(0.0, 0.55, t)), high, smoothstep(0.55, 1.0, t));
  if (count == 0.0) { color = vec3(0.04, 0.05, 0.08); }
  // w grows upward; texture rows grow downward.
  textureStore(image, vec2<i32>(i32(id.x), i32(${N - 1}u - id.y)), vec4(color, 1.0));
}`;
