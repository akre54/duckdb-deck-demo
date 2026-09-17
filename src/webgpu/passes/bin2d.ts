/**
 * GPU aggregation: bin points into a screen-space grid with atomics, then draw the grid
 * through the colorscale LUT.
 *
 * Three passes per frame:
 *   1. clearBuffer on the grid + the max accumulator (encoder-level, no shader)
 *   2. binning compute: project P, atomicAdd a fixed-point weight into its cell
 *   3. fullscreen raster: read the cell, normalize by the max, sample the ramp
 *
 * Weights are quantized to 1/256 and accumulated as u32 because WebGPU has no float
 * atomics. That is a real precision limit, not an implementation shortcut: a weight
 * below ~0.004 contributes nothing.
 */

import type { AttributeSet, GpuAttribute } from '../attributes.js';

export const WEIGHT_FIXED_POINT = 256;
const WORKGROUP = 256;

/** Widths only, for shader generation. See `PointsBindings`. */
export interface Bin2dBindings {
  position: GpuAttribute;
  /** Per-point weight. Omitted means a plain count. */
  weight?: GpuAttribute;
  mask?: GpuAttribute;
}

/** Which named attribute feeds each channel; resolved to a buffer per frame. */
export interface Bin2dChannels {
  position: string;
  weight?: string;
  mask?: string;
}

function binShader(b: Bin2dBindings): string {
  let slot = 3;
  const decls: string[] = [];
  const wSlot = b.weight ? slot++ : -1;
  if (b.weight) decls.push(`@group(0) @binding(${wSlot}) var<storage, read> b_w: array<f32>;`);
  const mSlot = b.mask ? slot++ : -1;
  if (b.mask) decls.push(`@group(0) @binding(${mSlot}) var<storage, read> b_msk: array<f32>;`);

  const readW = b.weight ? `b_w[i * ${b.weight.width}u + 0u]` : '1.0';
  const maskTest = b.mask ? `if (b_msk[i * ${b.mask.width}u + 0u] < 0.5) { return; }` : '';
  const pw = b.position.width;
  const readP = `vec3<f32>(${[0, 1, 2].map((c) => (c < pw ? `b_pos[i * ${pw}u + ${c}u]` : '0.0')).join(', ')})`;

  return `
struct View {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  viewport: vec4<f32>,
};
@group(0) @binding(0) var<uniform> view: View;
// x: row count, y: grid resolution
@group(0) @binding(1) var<uniform> rowInfo: vec4<u32>;
@group(0) @binding(2) var<storage, read> b_pos: array<f32>;
${decls.join('\n')}
@group(1) @binding(0) var<storage, read_write> grid: array<atomic<u32>>;
@group(1) @binding(1) var<storage, read_write> gmax: array<atomic<u32>>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= rowInfo.x) { return; }
  ${maskTest}

  let p = ${readP};
  if (p.x != p.x || p.y != p.y || p.z != p.z) { return; }

  let clip = view.viewProj * vec4<f32>(p, 1.0);
  if (clip.w <= 0.0) { return; }
  let ndc = clip.xy / clip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0) { return; }

  let res = rowInfo.y;
  let fx = (ndc.x * 0.5 + 0.5) * f32(res);
  // NDC y is up, texture rows go down.
  let fy = (0.5 - ndc.y * 0.5) * f32(res);
  let bx = min(u32(fx), res - 1u);
  let by = min(u32(fy), res - 1u);
  let cell = by * res + bx;

  let w = ${readW};
  if (w != w || w <= 0.0) { return; }
  let q = u32(w * ${WEIGHT_FIXED_POINT}.0);
  if (q == 0u) { return; }
  let total = atomicAdd(&grid[cell], q) + q;
  atomicMax(&gmax[0], total);
}
`;
}

const RASTER_SHADER = `
// x: resolution, y: 0 = auto ceiling from gmax, 1 = fixed ceiling in ceilingFixed
@group(0) @binding(0) var<uniform> cfg: vec4<u32>;
@group(0) @binding(1) var<storage, read> grid: array<u32>;
@group(0) @binding(2) var<storage, read> gmax: array<u32>;
@group(0) @binding(3) var<storage, read> ramp_lut: array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  // Fullscreen triangle.
  var xy = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  var out: VsOut;
  let p = xy[vi];
  out.clip = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

fn sampleRamp(t: f32) -> vec3<f32> {
  let n = f32(arrayLength(&ramp_lut) - 1u);
  let x = clamp(t, 0.0, 1.0) * n;
  let i0 = u32(floor(x));
  let i1 = min(i0 + 1u, u32(n));
  return mix(ramp_lut[i0].rgb, ramp_lut[i1].rgb, x - floor(x));
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let res = cfg.x;
  let bx = min(u32(in.uv.x * f32(res)), res - 1u);
  let by = min(u32(in.uv.y * f32(res)), res - 1u);
  let v = f32(grid[by * res + bx]);
  if (v <= 0.0) { discard; }

  let ceiling = select(f32(cfg.z), f32(max(gmax[0], 1u)), cfg.y == 0u);
  // Log scaling: count distributions are heavy-tailed, and a linear ramp shows one hot
  // cell and nothing else.
  let t = log(1.0 + v) / log(1.0 + max(ceiling, 1.0));
  return vec4<f32>(sampleRamp(clamp(t, 0.0, 1.0)), 1.0);
}
`;

export class Bin2dPass {
  private binPipeline: GPUComputePipeline;
  private rasterPipeline: GPURenderPipeline;
  private metaBuffer: GPUBuffer;
  private cfgBuffer: GPUBuffer;
  readonly grid: GPUBuffer;
  readonly gmax: GPUBuffer;
  private binBg0?: GPUBindGroup;
  private binBg1: GPUBindGroup;
  private rasterBg: GPUBindGroup;
  private bindKey = '';

  /** Channel order must match the shader's binding order in `binShader`. */
  private readonly order: (string | undefined)[];

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
    readonly resolution: number,
    private readonly attrs: AttributeSet,
    channels: Bin2dChannels,
    private readonly viewBuffer: GPUBuffer,
    rampBuffer: GPUBuffer,
  ) {
    this.order = [channels.position, channels.weight, channels.mask];
    const bindings: Bin2dBindings = {
      position: attrs.get(channels.position),
      weight: channels.weight ? attrs.get(channels.weight) : undefined,
      mask: channels.mask ? attrs.get(channels.mask) : undefined,
    };
    const cells = resolution * resolution;
    // COPY_SRC so the accumulated bins can be read back. Not needed to render, but a grid
    // that cannot be inspected can only be checked by looking at it, and "the heatmap looks
    // plausible" is not an assertion.
    this.grid = device.createBuffer({
      label: 'bin2d:grid',
      size: cells * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.gmax = device.createBuffer({
      label: 'bin2d:max',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.metaBuffer = device.createBuffer({
      label: 'bin2d:meta', size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cfgBuffer = device.createBuffer({
      label: 'bin2d:cfg', size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const binModule = device.createShaderModule({ label: 'bin2d', code: binShader(bindings) });
    this.binPipeline = device.createComputePipeline({
      label: 'bin2d', layout: 'auto', compute: { module: binModule, entryPoint: 'main' },
    });
    this.binBg1 = device.createBindGroup({
      label: 'bin2d:grid-bg',
      layout: this.binPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: this.grid } },
        { binding: 1, resource: { buffer: this.gmax } },
      ],
    });

    const rasterModule = device.createShaderModule({ label: 'bin2d:raster', code: RASTER_SHADER });
    this.rasterPipeline = device.createRenderPipeline({
      label: 'bin2d:raster',
      layout: 'auto',
      vertex: { module: rasterModule, entryPoint: 'vs' },
      fragment: { module: rasterModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      // The raster covers the screen and owns the frame; no depth interaction needed.
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    });
    this.rasterBg = device.createBindGroup({
      label: 'bin2d:raster-bg',
      layout: this.rasterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cfgBuffer } },
        { binding: 1, resource: { buffer: this.grid } },
        { binding: 2, resource: { buffer: this.gmax } },
        { binding: 3, resource: { buffer: rampBuffer } },
      ],
    });
  }

  /** `ceiling` of 0 means auto (normalize by the hottest cell). */
  setCeiling(ceiling: number): void {
    const fixed = ceiling > 0 ? Math.round(ceiling * WEIGHT_FIXED_POINT) : 0;
    this.device.queue.writeBuffer(
      this.cfgBuffer, 0, new Uint32Array([this.resolution, ceiling > 0 ? 1 : 0, fixed, 0]),
    );
  }

  private resolveBinBg0(): GPUBindGroup {
    const used = this.order.filter((n): n is string => Boolean(n));
    const key = this.attrs.bindingKey(used);
    if (this.binBg0 && key === this.bindKey) return this.binBg0;
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.viewBuffer } },
      { binding: 1, resource: { buffer: this.metaBuffer } },
    ];
    let slot = 2;
    for (const name of used) {
      entries.push({ binding: slot++, resource: { buffer: this.attrs.get(name).buffer } });
    }
    this.binBg0 = this.device.createBindGroup({
      label: 'bin2d:data-bg',
      layout: this.binPipeline.getBindGroupLayout(0),
      entries,
    });
    this.bindKey = key;
    return this.binBg0;
  }

  /** Clear + bin. Must run before the render pass that rasterizes the grid. */
  bin(encoder: GPUCommandEncoder, rows: number): void {
    encoder.clearBuffer(this.grid);
    encoder.clearBuffer(this.gmax);
    this.device.queue.writeBuffer(this.metaBuffer, 0, new Uint32Array([rows, this.resolution, 0, 0]));
    const pass = encoder.beginComputePass({ label: 'bin2d' });
    pass.setPipeline(this.binPipeline);
    pass.setBindGroup(0, this.resolveBinBg0());
    pass.setBindGroup(1, this.binBg1);
    pass.dispatchWorkgroups(Math.ceil(rows / WORKGROUP));
    pass.end();
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.rasterPipeline);
    pass.setBindGroup(0, this.rasterBg);
    pass.draw(3);
  }

  destroy(): void {
    this.grid.destroy();
    this.gmax.destroy();
    this.metaBuffer.destroy();
    this.cfgBuffer.destroy();
  }
}
