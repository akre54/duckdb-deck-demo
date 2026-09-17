/**
 * Render targets described by capability, not by product name.
 *
 * The planner should not know whether it is feeding "our renderer" or "deck.gl". What
 * changes its decisions is whether compute shaders exist and whether the renderer will
 * accept a buffer the application allocated. Naming the input that way collapses what
 * looked like three separate integrations into one axis with two bits.
 *
 * The distinction that matters here is *not* deck vs not-deck. deck.gl 9.4 already ships
 * `@luma.gl/webgpu` (`webgpuAdapter`, `WebGPUDevice`) and `@luma.gl/gpgpu`, and
 * `@luma.gl/core`'s `Device` declares `createComputePipeline` and `beginComputePass`. So
 * deck under a WebGPU device has the same capabilities as our own renderer; deck under
 * WebGL2 differs only by lacking compute.
 */

export type TargetId = 'webgpu-native' | 'deck-webgpu' | 'deck-webgl2';

export interface TargetCaps {
  id: TargetId;
  label: string;
  /** Compute shaders available, so a GPU stage exists at all. */
  compute: boolean;
  /** The renderer will bind buffers it did not allocate. */
  appOwnedBuffers: boolean;
  /** Attribute bytes that may be resident. A plan needing more is infeasible. */
  gpuBudgetBytes: number;
  /**
   * Storage buffers bindable in one compute stage.
   *
   * A fused kernel binds one per attribute it reads or writes, plus one for the color LUT,
   * so this is reached quickly: four source columns, four derived attributes and a ramp is
   * nine, and the WebGPU default is eight. It is a hard constraint, not a cost, so the
   * optimizer rejects candidates that exceed it rather than pricing them.
   */
  maxStorageBuffersPerStage: number;
  /** Shown in the EXPLAIN pane when a capability, not a cost, forced a placement. */
  note: string;
}

/** Fraction of the device's buffer limit left for render targets and scratch. */
const RENDER_RESERVE = 0.25;

/** WebGPU's guaranteed minimum for `maxStorageBuffersPerShaderStage`. */
const WEBGPU_DEFAULT_STORAGE_BUFFERS = 8;

/**
 * The four limits the planner reads off a device, described structurally.
 *
 * A real `GPUDevice` satisfies this, but naming that type here would make `@webgpu/types` a
 * requirement for anyone importing the planner — including a consumer planning on a server,
 * where there is no device at all. Structural typing means `targetCaps(id, device)` still
 * accepts a `GPUDevice` without the planner ever depending on WebGPU's type declarations.
 */
export interface DeviceLimits {
  limits: {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxStorageBuffersPerShaderStage: number;
  };
}

export function targetCaps(id: TargetId, device: DeviceLimits | undefined): TargetCaps {
  // Without a device (unit tests) assume a modest budget so tests are deterministic.
  const limit = device
    ? Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize * 4)
    : 512 * 1024 * 1024;
  const budget = Math.floor(limit * (1 - RENDER_RESERVE));
  const storageBuffers = device?.limits.maxStorageBuffersPerShaderStage ?? 8;

  switch (id) {
    case 'webgpu-native':
      return {
        id,
        label: 'webgpu (this graph)',
        compute: true,
        appOwnedBuffers: true,
        gpuBudgetBytes: budget,
        maxStorageBuffersPerStage: storageBuffers,
        note: 'compute + app-owned buffers',
      };
    case 'deck-webgpu':
      return {
        id,
        label: 'deck.gl on webgpu',
        compute: true,
        appOwnedBuffers: true,
        gpuBudgetBytes: budget,
        // Not `storageBuffers`. luma 9.4 exposes no `requiredLimits` on device creation and
        // its WebGPU adapter has no `attach()`, so deck's device cannot be raised above the
        // WebGPU defaults or pointed at ours. 8 is a real constraint for this target, and
        // the optimizer has to plan within it.
        maxStorageBuffersPerStage: WEBGPU_DEFAULT_STORAGE_BUFFERS,
        note: 'luma webgpuAdapter: compute + app-owned buffers, but capped at WebGPU default limits',
      };
    case 'deck-webgl2':
      return {
        id,
        label: 'deck.gl on webgl2',
        compute: false,
        appOwnedBuffers: true,
        gpuBudgetBytes: budget,
        maxStorageBuffersPerStage: storageBuffers,
        note: 'no compute shaders on WebGL2, so the GPU stage is unavailable',
      };
  }
}

export const TARGET_IDS: TargetId[] = ['webgpu-native', 'deck-webgpu', 'deck-webgl2'];
