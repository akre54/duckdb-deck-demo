/** WebGPU device + canvas setup. */

export interface Gpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
  /** Recreates the depth texture on resize. Call before each frame. */
  sync(): { width: number; height: number; depth: GPUTextureView };
}

export class GpuUnavailable extends Error {}

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!('gpu' in navigator)) {
    throw new GpuUnavailable(
      'WebGPU is not available in this browser. Needs Chrome/Edge 113+ or Safari 26+.',
    );
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new GpuUnavailable('No WebGPU adapter. GPU may be blocklisted.');

  const device = await adapter.requestDevice({
    requiredLimits: {
      // 1M points x vec3 f32 is 12 MB; ask for headroom so the 5M bench can run.
      maxStorageBufferBindingSize: Math.min(
        adapter.limits.maxStorageBufferBindingSize,
        512 * 1024 * 1024,
      ),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 * 1024 * 1024),
    },
  });
  device.lost.then((info) => {
    console.error('[gpu] device lost:', info.reason, info.message);
  });
  device.addEventListener('uncapturederror', (e) => {
    console.error('[gpu] uncaptured error:', (e as GPUUncapturedErrorEvent).error.message);
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new GpuUnavailable('Could not get a webgpu canvas context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  let depth: GPUTexture | undefined;
  let dw = 0;
  let dh = 0;

  const maxDim = device.limits.maxTextureDimension2D;

  const sync = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Clamped to the device limit: a CSS mistake that makes the canvas enormous should
    // degrade the resolution, not invalidate every command buffer.
    const width = Math.min(maxDim, Math.max(1, Math.floor(canvas.clientWidth * dpr)));
    const height = Math.min(maxDim, Math.max(1, Math.floor(canvas.clientHeight * dpr)));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (!depth || dw !== width || dh !== height) {
      depth?.destroy();
      depth = device.createTexture({
        size: [width, height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      dw = width;
      dh = height;
    }
    return { width, height, depth: depth.createView() };
  };

  return { device, context, format, canvas, sync };
}
