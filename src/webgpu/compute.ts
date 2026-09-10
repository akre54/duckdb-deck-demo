/**
 * Kernel host: turns a KernelPlan's generated WGSL into a pipeline, binds the
 * attributes it named, and dispatches it.
 *
 * Binding order is a contract with `buildKernel` in graph/planner.ts:
 *   0 params uniform, 1 meta uniform, [2 ramp LUT], then reads, then writes.
 */

import type { KernelPlan } from '../core/planner.js';
import type { AttributeSet } from './attributes.js';
import { align4 } from './attributes.js';
import { gpuData } from './gpu-compat.js';

export class Kernel {
  private pipeline: GPUComputePipeline;
  private paramBuffer: GPUBuffer;
  private metaBuffer: GPUBuffer;
  private paramScratch: Float32Array;
  private bindGroup?: GPUBindGroup;
  private bindKey = '';

  constructor(
    private readonly device: GPUDevice,
    readonly plan: KernelPlan,
    private readonly rampBuffer?: GPUBuffer,
  ) {
    const module = device.createShaderModule({ label: plan.id, code: plan.code });
    this.pipeline = device.createComputePipeline({
      label: plan.id,
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    // Uniform buffers must be at least 16 bytes and a multiple of 4.
    const paramFloats = Math.max(4, align4(plan.params.length * 4) / 4);
    this.paramScratch = new Float32Array(paramFloats);
    this.paramBuffer = device.createBuffer({
      label: `${plan.id}:params`,
      size: paramFloats * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.metaBuffer = device.createBuffer({
      label: `${plan.id}:meta`,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    if (plan.usesRamp && !rampBuffer) {
      throw new Error(`Kernel ${plan.id} calls ramp() but no LUT buffer was supplied`);
    }
  }

  /**
   * Write the uniform block. This is the cheap path: a value-parameter change is
   * this call plus a dispatch, with no buffer reallocation and no requery.
   */
  writeParams(values: Record<string, number>): void {
    this.paramScratch.fill(0);
    this.plan.params.forEach((name, i) => {
      const v = values[name];
      this.paramScratch[i] = Number.isFinite(v) ? v : 0;
    });
    this.device.queue.writeBuffer(this.paramBuffer, 0, gpuData(this.paramScratch));
  }

  /** (Re)build the bind group if any attribute buffer identity changed. */
  private resolveBindGroup(attrs: AttributeSet): GPUBindGroup {
    const names = [...this.plan.reads, ...this.plan.writes];
    const key = names.map((n) => `${n}:${attrs.get(n).buffer.label}:${attrs.get(n).capacityRows}`).join('|');
    if (this.bindGroup && key === this.bindKey) return this.bindGroup;

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.paramBuffer } },
      { binding: 1, resource: { buffer: this.metaBuffer } },
    ];
    let slot = 2;
    if (this.plan.usesRamp) entries.push({ binding: slot++, resource: { buffer: this.rampBuffer! } });
    for (const name of names) {
      entries.push({ binding: slot++, resource: { buffer: attrs.get(name).buffer } });
    }
    this.bindGroup = this.device.createBindGroup({
      label: `${this.plan.id}:bg`,
      layout: this.pipeline.getBindGroupLayout(0),
      entries,
    });
    this.bindKey = key;
    return this.bindGroup;
  }

  dispatch(encoder: GPUCommandEncoder, attrs: AttributeSet, rows: number, workgroupSize: number): void {
    this.device.queue.writeBuffer(this.metaBuffer, 0, new Uint32Array([rows, 0, 0, 0]));
    const pass = encoder.beginComputePass({ label: this.plan.id });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.resolveBindGroup(attrs));
    pass.dispatchWorkgroups(Math.ceil(rows / workgroupSize));
    pass.end();
  }

  destroy(): void {
    this.paramBuffer.destroy();
    this.metaBuffer.destroy();
  }
}
