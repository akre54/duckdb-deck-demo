/**
 * The decisive experiment for the original question: can deck.gl render attributes that a
 * compute kernel wrote, without a GPU readback and without forking deck?
 *
 * The answer from the type definitions alone is yes, and it is available on the *installed*
 * version rather than some future one:
 *
 *   @deck.gl/core 9.4  BinaryAttribute = { value?: TypedArray; buffer?: Buffer }
 *                      Deck props: device?: Device
 *   @luma.gl/core 9.4  Device.createComputePipeline(), Device.beginComputePass()
 *   @luma.gl/webgpu    webgpuAdapter, WebGPUDevice, WebGPUBuffer   (a deck 9.4 dependency)
 *
 * "The API exists" and "I ran it" are different claims, though, and the whole point of this
 * prototype is to make the second kind. So this module actually does it: it creates a luma
 * WebGPU device, allocates luma Buffers, runs the planner's generated WGSL through
 * luma's compute pipeline, and hands the resulting buffers to a ScatterplotLayer.
 *
 * Whatever happens is reported through `status()` rather than thrown away — deck 9.4's
 * WebGPU *render* path is experimental, so a compute success with a render failure is a
 * genuinely useful result and is recorded as such.
 */

import { Deck, OrbitView } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { luma, Buffer as LumaBuffer, type Device, type ComputePipeline } from '@luma.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';

import { WORKGROUP, materialize, buildRampLut, type PhysicalPlan, type ColumnUpload } from '@noodles.gl/planner';
import type { OrbitCamera } from '../webgpu/camera.js';

export interface DeckWebgpuStatus {
  /** Whether a luma WebGPU device was obtained. */
  device: 'pending' | 'ok' | 'failed';
  /** Whether the planner's WGSL compiled and dispatched through luma. */
  compute: 'pending' | 'ok' | 'skipped' | 'failed';
  /** Whether deck rendered a layer bound to those buffers. */
  render: 'pending' | 'ok' | 'failed';
  /** Buffers handed to deck without a readback. */
  sharedBuffers: string[];
  computeMs: number;
  detail: string;
}

export class DeckWebgpuPane {
  private device?: Device;
  private deck?: Deck<OrbitView>;
  private pipeline?: ComputePipeline;
  private pipelineKey = '';
  private buffers = new Map<string, LumaBuffer>();

  readonly status: DeckWebgpuStatus = {
    device: 'pending',
    compute: 'pending',
    render: 'pending',
    sharedBuffers: [],
    computeMs: 0,
    detail: '',
  };

  /** luma's own device. See `init` for why it is not our shared one. */
  private gpuDevice?: GPUDevice;
  /** First uncaptured error from deck's drawing, which happens after `update` returns. */
  private firstRenderError?: string;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /**
   * Create luma's WebGPU device and a Deck that shares it. Idempotent.
   *
   * Two things had to be worked around here, both worth recording:
   *
   *   - `luma.attachDevice(existingGPUDevice, …)` throws "WebGPUAdapter.attach() not
   *     implemented" in luma 9.4, so deck cannot be pointed at a device the application
   *     already owns. It has to create its own.
   *   - luma 9.4's `DeviceProps` has no `requiredLimits`, so that device runs at WebGPU's
   *     defaults — notably 8 storage buffers per compute stage, where our own device asked
   *     the adapter for 10.
   *
   * The consequence is a genuine capability difference between targets rather than a bug to
   * hide, which is why `targetCaps('deck-webgpu')` reports 8. The optimizer then has to find
   * a plan whose fused kernel fits in 8 bindings — a constraint doing real work.
   */
  async init(): Promise<void> {
    if (this.device) return;
    try {
      this.device = await luma.createDevice({
        type: 'webgpu',
        adapters: [webgpuAdapter],
        createCanvasContext: { canvas: this.canvas },
      });
      // The underlying GPUDevice, so validation can be checked with an error scope rather
      // than inferred from luma's console output.
      this.gpuDevice = (this.device as unknown as { handle: GPUDevice }).handle;
      // deck draws on later frames, outside any error scope this module could open, so a
      // render failure has to be caught here or it will be silently reported as success.
      this.gpuDevice?.addEventListener('uncapturederror', (e) => {
        const msg = (e as GPUUncapturedErrorEvent).error.message;
        if (!this.firstRenderError) this.firstRenderError = msg;
      });
      this.status.device = 'ok';
      this.status.detail = `luma ${this.device.type} device`
        + (this.gpuDevice
          ? ` (${this.gpuDevice.limits.maxStorageBuffersPerShaderStage} storage buffers/stage)`
          : '');
    } catch (err) {
      this.status.device = 'failed';
      this.status.detail = `luma WebGPU device unavailable: ${message(err)}`;
      return;
    }

    try {
      this.deck = new Deck<OrbitView>({
        // Share the device rather than letting deck create its own: the buffers the
        // kernel writes have to belong to the same device deck renders with.
        device: this.device,
        canvas: this.canvas,
        views: new OrbitView({ id: 'orbit', orbitAxis: 'Y', fovy: 50, near: 0.01, far: 100 }),
        initialViewState: { target: [0, 0, 0], zoom: 8, rotationX: 30, rotationOrbit: 0 },
        controller: false,
        layers: [],
      });
    } catch (err) {
      this.status.render = 'failed';
      this.status.detail = `deck construction failed: ${message(err)}`;
    }
  }

  /**
   * Upload the source columns, run the plan's kernel on the luma device, and bind the
   * resulting buffers to a layer. No `readPixels`, no `readBuffer`, no CPU round trip.
   */
  async update(
    plan: PhysicalPlan,
    sources: Map<string, ColumnUpload>,
    params: Record<string, number>,
    rows: number,
  ): Promise<void> {
    await this.init();
    const device = this.device;
    if (!device || rows === 0) return;

    if (plan.render.mode !== 'points') {
      this.status.compute = 'skipped';
      this.status.detail = 'heatmap mode has no deck.gl layer equivalent here';
      this.deck?.setProps({ layers: [] });
      return;
    }

    try {
      // --- source columns -> luma buffers ----------------------------------
      for (const decl of plan.attributes) {
        if (decl.provenance !== 'arrow') continue;
        const upload = sources.get(decl.name);
        if (!upload) continue;
        const data = materialize(upload);
        this.ensureBuffer(device, decl.name, rows * decl.width * 4, data);
      }

      // --- destinations for what the kernel writes --------------------------
      const kernel = plan.kernels[0];
      if (!kernel) {
        this.status.compute = 'skipped';
        this.status.detail = 'plan has no GPU stage; nothing to run through luma compute';
      } else {
        for (const name of kernel.writes) {
          const decl = plan.attributes.find((a) => a.name === name);
          if (!decl) continue;
          this.ensureBuffer(device, name, rows * decl.width * 4);
        }

        // Verify, do not assume. luma reports WebGPU validation failures by logging them,
        // so a try/catch around the dispatch stays silent while the pipeline is invalid and
        // nothing is computed. An error scope on the underlying device gives a real answer.
        this.gpuDevice?.pushErrorScope('validation');
        const started = performance.now();
        this.dispatch(device, plan, kernel, params, rows);
        await device.submit?.();
        await this.gpuDevice?.queue.onSubmittedWorkDone();
        this.status.computeMs = performance.now() - started;
        const computeError = await this.gpuDevice?.popErrorScope();
        if (computeError) {
          this.status.compute = 'failed';
          this.status.detail = `compute validation failed: ${computeError.message}`;
          this.deck?.setProps({ layers: [] });
          return;
        }
        this.status.compute = 'ok';
      }

      // --- bind the app-owned buffers to a deck layer ------------------------
      const posName = plan.channels.position;
      const colName = plan.channels.color;
      const sizeName = plan.channels.size;
      const width = (n: string) => plan.attributes.find((a) => a.name === n)?.width ?? 1;

      const position = this.buffers.get(posName);
      if (!position) throw new Error(`no buffer for position attribute '${posName}'`);
      const size = this.buffers.get(sizeName);

      // Colour is deliberately left as a layer constant rather than a bound buffer.
      // deck.gl 9.4's WebGPU path derives a `unorm8x3` vertex format for a 3-component
      // fill colour, and `unorm8x3` is not a valid GPUVertexFormat — WebGPU only defines
      // unorm8x2 and unorm8x4 — so binding a colour buffer makes render pipeline creation
      // throw. That is a deck bug, not something to paper over, so it is reported instead.
      this.status.sharedBuffers = [posName, size ? sizeName : ''].filter(Boolean);
      const colorBufferExists = this.buffers.has(colName);

      const layer = new ScatterplotLayer({
        id: 'deck-webgpu',
        data: {
          length: rows,
          attributes: {
            // The load-bearing lines: buffers this application allocated and a compute
            // shader filled, handed to deck with no readback.
            //
            // `type` is not optional here. ScatterplotLayer declares `getPosition` as
            // float64 for precision, so deck derives a 24-byte stride and rejects a
            // float32x3 buffer as half the size it expects. Saying float32 explicitly is
            // what makes a kernel-written buffer bindable at all.
            getPosition: { buffer: position, size: width(posName), type: 'float32' },
            ...(size ? { getRadius: { buffer: size, size: 1, type: 'float32' } } : {}),
          },
        },
        coordinateSystem: 'cartesian',
        radiusUnits: 'pixels',
        radiusMinPixels: 0.5,
        radiusMaxPixels: 64,
        getFillColor: [140, 200, 242],
        getRadius: size ? undefined : 2,
        pickable: false,
      });

      this.firstRenderError = undefined;
      this.deck?.setProps({ layers: [layer] });
      this.deck?.redraw('verify');
      // Two presented frames: deck builds its pipeline on the first and draws on the
      // second, and the interesting failures happen at draw time.
      await nextFrames(2);
      await this.gpuDevice?.queue.onSubmittedWorkDone();

      this.status.render = this.firstRenderError ? 'failed' : 'ok';
      this.status.detail = this.firstRenderError
        ? `compute succeeded and the buffers bound, but deck's WebGPU draw failed: ${this.firstRenderError}`
        : `kernel ran on luma's device; ${this.status.sharedBuffers.length} app-owned buffer(s) bound to a ScatterplotLayer with no readback${colorBufferExists ? '. Cd was computed on the GPU but left unbound: deck 9.4 derives an invalid unorm8x3 vertex format for 3-component colours.' : ''}`;
    } catch (err) {
      // Which half failed matters, so do not collapse them into one flag.
      if (this.status.compute === 'pending') this.status.compute = 'failed';
      else this.status.render = 'failed';
      this.status.detail = message(err);
      console.warn('[deck-webgpu]', err);
    }
  }

  syncCamera(camera: OrbitCamera, heightPx: number): void {
    const s = camera.state;
    const worldHeight = 2 * Math.max(s.distance, 1e-4) * Math.tan(s.fovY / 2);
    this.deck?.setProps({
      viewState: {
        target: [...s.target],
        zoom: Math.log2(Math.max(heightPx, 1) / worldHeight),
        rotationX: (s.pitch * 180) / Math.PI,
        rotationOrbit: (-s.yaw * 180) / Math.PI,
      },
    });
  }

  tick(): void {
    this.deck?.redraw('comparison-continuous');
  }

  destroy(): void {
    this.deck?.finalize();
    for (const b of this.buffers.values()) b.destroy();
    this.buffers.clear();
    this.pipeline?.destroy();
    this.device?.destroy();
    this.device = undefined;
  }

  // -------------------------------------------------------------------------

  private ensureBuffer(
    device: Device,
    name: string,
    byteLength: number,
    data?: Float32Array,
  ): LumaBuffer {
    const existing = this.buffers.get(name);
    if (existing && existing.byteLength >= byteLength) {
      if (data) existing.write(data.subarray(0, byteLength / 4));
      return existing;
    }
    existing?.destroy();
    const buffer = device.createBuffer({
      id: `shared:${name}`,
      byteLength,
      // Both, deliberately: the compute pass writes it and the render pipeline reads it as
      // a vertex attribute. That dual usage is what makes the handoff possible.
      usage: LumaBuffer.STORAGE | LumaBuffer.VERTEX | LumaBuffer.COPY_DST,
    });
    if (data) buffer.write(data.subarray(0, byteLength / 4));
    this.buffers.set(name, buffer);
    return buffer;
  }

  private dispatch(
    device: Device,
    plan: PhysicalPlan,
    kernel: NonNullable<PhysicalPlan['kernels'][number]>,
    params: Record<string, number>,
    rows: number,
  ): void {
    if (this.pipelineKey !== kernel.code) {
      this.pipeline?.destroy();
      const shader = device.createShader({ id: kernel.id, stage: 'compute', source: kernel.code });
      this.pipeline = device.createComputePipeline({ id: kernel.id, shader, entryPoint: 'main' });
      this.pipelineKey = kernel.code;
    }
    const pipeline = this.pipeline!;

    // Uniforms, matching the layout `buildKernel` generated.
    const paramData = new Float32Array(Math.max(4, kernel.params.length));
    kernel.params.forEach((p, i) => { paramData[i] = Number.isFinite(params[p]) ? params[p] : 0; });
    const paramBuffer = this.ensureUniform(device, 'params', paramData);
    const rowInfoBuffer = this.ensureUniform(device, 'rowInfo', new Uint32Array([rows, 0, 0, 0]));

    const bindings: Record<string, LumaBuffer> = {
      params: paramBuffer,
      rowInfo: rowInfoBuffer,
    };
    if (kernel.usesRamp && plan.ramp) {
      bindings.ramp_lut = this.ensureUniform(device, 'ramp_lut', buildRampLut(plan.ramp), true);
    }
    for (const name of [...kernel.reads, ...kernel.writes]) {
      const buffer = this.buffers.get(name);
      if (!buffer) throw new Error(`kernel binding '${name}' has no buffer`);
      bindings[`b_${name.replace(/[^A-Za-z0-9_]/g, '_')}`] = buffer;
    }
    pipeline.setBindings(bindings);

    const pass = device.beginComputePass({ id: 'deck-webgpu-kernel' });
    pass.setPipeline(pipeline);
    pass.dispatch(Math.ceil(rows / WORKGROUP));
    pass.end();
  }

  private ensureUniform(
    device: Device,
    name: string,
    data: Float32Array | Uint32Array,
    storage = false,
  ): LumaBuffer {
    const key = `__uniform_${name}`;
    const byteLength = Math.max(16, data.byteLength);
    let buffer = this.buffers.get(key);
    if (!buffer || buffer.byteLength < byteLength) {
      buffer?.destroy();
      buffer = device.createBuffer({
        id: key,
        byteLength,
        usage: (storage ? LumaBuffer.STORAGE : LumaBuffer.UNIFORM) | LumaBuffer.COPY_DST,
      });
      this.buffers.set(key, buffer);
    }
    buffer.write(data);
    return buffer;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}
