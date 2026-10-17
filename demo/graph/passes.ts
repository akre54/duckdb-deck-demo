/**
 * Hand-written luma command-graph passes for the demo graphs: a compute pass and a render pass,
 * each a WGSL module whose bindings are the declared resources in order.
 *
 * They record with raw WebGPU (`computePass.handle`, `renderPass.handle`) rather than luma's
 * pipelines, since the bindings are fixed and few. The pass still declares every buffer and
 * texture it touches to luma, which is what orders it and what the viewer draws. Bind groups are
 * rebuilt only when a resolved buffer, range or view changes.
 *
 * Fragment shaders read textures with `textureLoad` at the pixel being shaded, so no sampler is
 * bound: every texture here is the same size as the target that reads it, or read at explicit
 * integer coordinates.
 */

import type { Device } from '@luma.gl/core';
import type { WebGPUDevice } from '@luma.gl/webgpu';
import type {
  GPUCommandGraphEncodeContext, GraphBufferHandle, GraphDataView, GraphTextureHandle, GraphTextureView,
} from '@luma.gl/gpgpu/gpu-core';

export type Bindable = GraphBufferHandle | GraphDataView | GraphTextureHandle | GraphTextureView;
type Context<P> = GPUCommandGraphEncodeContext<P>;

/** A resource as a bind-group entry, with the GPU object it resolved to for the cache key. */
function resolve<P>(context: Context<P>, r: Bindable): { key: unknown; resource: GPUBindingResource } {
  if ('byteStride' in r) {
    // A typed view into a larger buffer: bind just its range.
    const buffer = context.getBuffer(r).handle as GPUBuffer;
    const size = Math.max(0, r.length - 1) * r.byteStride + r.rowByteLength;
    return { key: `${uid(buffer)}:${r.byteOffset}:${size}`, resource: { buffer, offset: r.byteOffset, size } };
  }
  if ('byteLength' in r) {
    const buffer = context.getBuffer(r).handle as GPUBuffer;
    return { key: buffer, resource: { buffer } };
  }
  const view = context.getTextureView(r).handle as GPUTextureView;
  return { key: view, resource: view };
}

const ids = new WeakMap<object, number>();
let next = 0;
function uid(o: object): number {
  if (!ids.has(o)) ids.set(o, ++next);
  return ids.get(o)!;
}

function bindGroups<P>(gpu: GPUDevice, layout: () => GPUBindGroupLayout, bindings: Bindable[]) {
  let cached: { keys: unknown[]; group: GPUBindGroup } | undefined;
  return (context: Context<P>): GPUBindGroup => {
    const resolved = bindings.map((b) => resolve(context, b));
    if (!cached || cached.keys.some((k, i) => k !== resolved[i].key)) {
      cached = {
        keys: resolved.map((r) => r.key),
        group: gpu.createBindGroup({ layout: layout(), entries: resolved.map((r, binding) => ({ binding, resource: r.resource })) }),
      };
    }
    return cached.group;
  };
}

/**
 * One compute pass over `groups` workgroups. `before` runs at encode time, ahead of the dispatch,
 * for uniform writes. `auto` layout is safe: every binding is fixed and used, which is what makes
 * it unsafe for the planner's generated kernels (AGENTS.md).
 */
export function computeKernel<P>(
  device: Device, code: string, bindings: Bindable[], groups: number | [number, number],
  before?: (context: Context<P>) => void,
) {
  const gpu = (device as WebGPUDevice).handle;
  const pipeline = gpu.createComputePipeline({ layout: 'auto', compute: { module: gpu.createShaderModule({ code }), entryPoint: 'main' } });
  const group = bindGroups<P>(gpu, () => pipeline.getBindGroupLayout(0), bindings);
  return {
    encode(context: Context<P> & { computePass: unknown }) {
      before?.(context);
      const pass = (context.computePass as { handle: GPUComputePassEncoder }).handle;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group(context));
      const [x, y] = typeof groups === 'number' ? [groups, 1] : groups;
      pass.dispatchWorkgroups(x, y);
    },
  };
}

export interface RenderKernel<P> {
  /** WGSL with `vs` and `fs` entry points. */
  code: string;
  /** The color attachment's format; the graph owns the attachment and declares it. */
  format: GPUTextureFormat;
  blend?: GPUBlendState;
  topology?: GPUPrimitiveTopology;
  bindings: Bindable[];
  /** Record the draw: `pass.draw(3)` for a full-screen triangle, `drawIndirect` for a GPU count. */
  draw: (pass: GPURenderPassEncoder, context: Context<P>) => void;
}

/** One render pass into a graph-owned color attachment, cleared to transparent black first. */
export function renderKernel<P>(device: Device, kernel: RenderKernel<P>) {
  const gpu = (device as WebGPUDevice).handle;
  const module = gpu.createShaderModule({ code: kernel.code });
  const pipeline = gpu.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: kernel.format, ...(kernel.blend ? { blend: kernel.blend } : {}) }] },
    primitive: { topology: kernel.topology ?? 'triangle-list' },
  });
  const group = bindGroups<P>(gpu, () => pipeline.getBindGroupLayout(0), kernel.bindings);
  return {
    getRenderPassProps: () => ({ clearColor: [0, 0, 0, 0] as [number, number, number, number] }),
    encode(context: Context<P> & { renderPass: unknown }) {
      const pass = (context.renderPass as { handle: GPURenderPassEncoder }).handle;
      pass.setPipeline(pipeline);
      if (kernel.bindings.length) pass.setBindGroup(0, group(context));
      kernel.draw(pass, context);
    },
  };
}

/** Additive blending: every fragment adds to the target, for accumulating counts. */
export const ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

/** Ordinary "over" blending with premultiplied color. */
export const OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/** A vertex shader that covers the target with one triangle; `uv` runs 0..1 down and right. */
export const FULLSCREEN = /* wgsl */ `
struct Full { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Full {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var out: Full;
  out.position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2(p.x, 1.0 - p.y);
  return out;
}`;
