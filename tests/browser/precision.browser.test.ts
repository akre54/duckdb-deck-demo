import { describe, it, expect, beforeAll } from 'vitest';
import { splitHiLo } from '@noodles.gl/planner';
import { OrbitCamera, VIEW_UNIFORM_SIZE } from '../../src/webgpu/camera.js';
import { VIEW_STRUCT_WGSL, PROJECT_RTE_WGSL } from '../../src/webgpu/passes/points.js';
import { gpuDevice, expectNoGpuError } from './harness.js';

/**
 * Relative-to-eye projection of `hilo` positions, run on the GPU and compared with f64.
 *
 * The shader function under test is the points pass's own (`PROJECT_RTE_WGSL`), so this is
 * the code that draws, not a copy of it. The scene is a deep zoom far from the origin: points
 * 2e-8 apart near 0.31, the regime where an f32 position has run out of mantissa (its spacing
 * there is 3e-8) and the same points collapse onto a few pixels.
 */

const WIDTH = 800;
const HEIGHT = 600;
const N = 64;

let device: GPUDevice;

beforeAll(async () => {
  device = await gpuDevice();
});

/** Run `projectRte` over `stored` (hilo rows) and return clip coordinates. */
async function project(stored: Float32Array, view: Float32Array): Promise<Float32Array> {
  const code = `${VIEW_STRUCT_WGSL}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> pos: array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<vec4<f32>>;
${PROJECT_RTE_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&out)) { return; }
  let hi = vec3<f32>(pos[i * 6u], pos[i * 6u + 1u], pos[i * 6u + 2u]);
  let lo = vec3<f32>(pos[i * 6u + 3u], pos[i * 6u + 4u], pos[i * 6u + 5u]);
  out[i] = projectRte(hi, lo);
}`;
  const make = (size: number, usage: number) => device.createBuffer({ size, usage });
  const viewBuf = make(VIEW_UNIFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const posBuf = make(stored.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const outBuf = make(N * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const staging = make(N * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  device.queue.writeBuffer(viewBuf, 0, view as unknown as GPUAllowSharedBufferSource);
  device.queue.writeBuffer(posBuf, 0, stored as unknown as GPUAllowSharedBufferSource);

  const module = device.createShaderModule({ code });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: 'main' },
  });
  const bindGroup = device.createBindGroup({
    layout,
    entries: [viewBuf, posBuf, outBuf].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(N / 64));
  pass.end();
  encoder.copyBufferToBuffer(outBuf, 0, staging, 0, N * 16);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const clip = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  for (const b of [viewBuf, posBuf, outBuf, staging]) b.destroy();
  return clip;
}

/** Screen x in pixels from clip coordinates. */
const pixelX = (x: number, w: number) => (x / w) * 0.5 * WIDTH;

describe('hilo positions keep their precision through the points projection', () => {
  it('points 2e-8 apart near 0.31 land within a hundredth of a pixel of f64', async () => {
    const cam = new OrbitCamera();
    const target: [number, number, number] = [0.3123456789012, 0.1987654321098, 0];
    Object.assign(cam.state, { target, distance: 1e-6, near: 1e-9, far: 1, yaw: 0, pitch: 0 });
    const view = cam.pack(WIDTH, HEIGHT).slice();
    const rte = view.slice(24, 40);

    const exact = new Float64Array(N * 3);
    for (let i = 0; i < N; i++) {
      exact[i * 3] = target[0] + (i - N / 2) * 2e-8;
      exact[i * 3 + 1] = target[1];
      exact[i * 3 + 2] = 0;
    }
    const stored = splitHiLo(exact, 3, N);
    // The same points with the low halves dropped: an f32 position buffer.
    const f32Only = stored.slice();
    for (let i = 0; i < N; i++) f32Only.fill(0, i * 6 + 3, i * 6 + 6);

    const [withLo, withoutLo] = await expectNoGpuError(device, async () =>
      [await project(stored, view), await project(f32Only, view)]);

    // Reference: the same matrix, applied in f64 to the f64 offset from the target.
    const reference = (i: number) => {
      const rel = [exact[i * 3] - target[0], exact[i * 3 + 1] - target[1], exact[i * 3 + 2] - target[2], 1];
      const row = (r: number) => rel.reduce((sum, v, k) => sum + rte[k * 4 + r] * v, 0);
      return pixelX(row(0), row(3));
    };

    let hiloErr = 0;
    let f32Err = 0;
    for (let i = 0; i < N; i++) {
      const want = reference(i);
      hiloErr = Math.max(hiloErr, Math.abs(pixelX(withLo[i * 4], withLo[i * 4 + 3]) - want));
      f32Err = Math.max(f32Err, Math.abs(pixelX(withoutLo[i * 4], withoutLo[i * 4 + 3]) - want));
    }
    // Neighbouring points are ~13 px apart here, and f32 misplaces them by up to ~10 px.
    expect(Math.abs(reference(1) - reference(0))).toBeGreaterThan(10);
    expect(hiloErr, 'hilo max error, px').toBeLessThan(0.01);
    expect(f32Err, 'f32 max error, px').toBeGreaterThan(1);
  });
});
