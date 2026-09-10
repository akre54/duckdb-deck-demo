/**
 * Instanced point pass.
 *
 * Attributes come in as storage buffers indexed by `instance_index`, not vertex
 * buffers. That costs a little fixed-function fetch performance and buys two things
 * this design needs: the same buffer is readable by a compute kernel with no relayout,
 * and the shader is generated per-plan so only the attributes that exist get bound.
 * No dummy buffers, no "is this channel present" uniform flags.
 *
 * There is no vertex buffer at all — the quad comes from `vertex_index`.
 */

import type { GpuAttribute } from '../attributes.js';

export interface PointsBindings {
  position: GpuAttribute;
  color?: GpuAttribute;
  size?: GpuAttribute;
  opacity?: GpuAttribute;
  mask?: GpuAttribute;
}

/** style uniform: [sizeScale, opacity, minPx, maxPx]. */
export const STYLE_UNIFORM_SIZE = 16;

function loadVec(name: string, width: number, want: number): string {
  if (width >= want) {
    return `vec${want}<f32>(${Array.from({ length: want }, (_, c) => `${name}[i * ${width}u + ${c}u]`).join(', ')})`;
  }
  if (width === 1) return `vec${want}<f32>(${name}[i])`;
  const have = Array.from({ length: width }, (_, c) => `${name}[i * ${width}u + ${c}u]`);
  const pad = Array.from({ length: want - width }, () => '0.0');
  return `vec${want}<f32>(${[...have, ...pad].join(', ')})`;
}

export function pointsShader(b: PointsBindings): string {
  let slot = 2;
  const decls: string[] = [];
  const posSlot = slot++;
  decls.push(`@group(0) @binding(${posSlot}) var<storage, read> b_pos: array<f32>;`);
  const colSlot = b.color ? slot++ : -1;
  if (b.color) decls.push(`@group(0) @binding(${colSlot}) var<storage, read> b_col: array<f32>;`);
  const sizSlot = b.size ? slot++ : -1;
  if (b.size) decls.push(`@group(0) @binding(${sizSlot}) var<storage, read> b_siz: array<f32>;`);
  const opaSlot = b.opacity ? slot++ : -1;
  if (b.opacity) decls.push(`@group(0) @binding(${opaSlot}) var<storage, read> b_opa: array<f32>;`);
  const mskSlot = b.mask ? slot++ : -1;
  if (b.mask) decls.push(`@group(0) @binding(${mskSlot}) var<storage, read> b_msk: array<f32>;`);

  const readColor = b.color ? loadVec('b_col', b.color.width, 3) : 'vec3<f32>(0.55, 0.78, 0.95)';
  const readSize = b.size ? 'b_siz[i * SIZEW + 0u]'.replace('SIZEW', `${b.size.width}u`) : '1.0';
  const readOpacity = b.opacity ? `b_opa[i * ${b.opacity.width}u + 0u]` : '1.0';
  const maskTest = b.mask
    ? `if (b_msk[i * ${b.mask.width}u + 0u] < 0.5) { out.clip = vec4<f32>(0.0, 0.0, -2.0, 1.0); return out; }`
    : '';

  return `
struct View {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  viewport: vec4<f32>,
};
@group(0) @binding(0) var<uniform> view: View;
// x: size scale, y: global opacity, z: min radius px, w: max radius px
@group(0) @binding(1) var<uniform> style: vec4<f32>;
${decls.join('\n')}

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) color: vec3<f32>,
  @location(2) alpha: f32,
};

// Unit quad from vertex_index; two triangles, no vertex buffer.
const CORNERS = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
  vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0,  1.0), vec2<f32>(-1.0,  1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  var out: VsOut;
  let i = ii;
  let corner = CORNERS[vi];
  out.local = corner;

  ${maskTest}

  let p = ${loadVec('b_pos', b.position.width, 3)};
  // Arrow nulls arrive as NaN. Push those instances behind the camera rather than
  // letting the rasterizer see undefined geometry.
  if (p.x != p.x || p.y != p.y || p.z != p.z) {
    out.clip = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    return out;
  }

  out.color = ${readColor};
  out.alpha = clamp(${readOpacity} * style.y, 0.0, 1.0);

  let center = view.viewProj * vec4<f32>(p, 1.0);
  if (center.w <= 0.0) {
    out.clip = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    return out;
  }
  let radiusPx = clamp(${readSize} * style.x, style.z, style.w);
  // Offset in clip space: multiply by w to keep the sprite a fixed pixel size.
  let offset = corner * radiusPx / view.viewport.xy * 2.0 * center.w;
  out.clip = vec4<f32>(center.xy + offset, center.zw);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let r2 = dot(in.local, in.local);
  if (r2 > 1.0) { discard; }
  // Cheap normal for a shaded sphere impostor; enough to read depth in an orbit view.
  let n = vec3<f32>(in.local, sqrt(max(0.0, 1.0 - r2)));
  let light = 0.45 + 0.55 * clamp(dot(n, normalize(vec3<f32>(0.4, 0.7, 0.6))), 0.0, 1.0);
  return vec4<f32>(in.color * light, in.alpha);
}
`;
}

export class PointsPass {
  private pipeline: GPURenderPipeline;
  private bindGroup?: GPUBindGroup;
  private bindKey = '';
  readonly styleBuffer: GPUBuffer;

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
    private readonly bindings: PointsBindings,
    private readonly viewBuffer: GPUBuffer,
  ) {
    const code = pointsShader(bindings);
    const module = device.createShaderModule({ label: 'points', code });
    this.pipeline = device.createRenderPipeline({
      label: 'points',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    this.styleBuffer = device.createBuffer({
      label: 'points:style',
      size: STYLE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  setStyle(sizeScale: number, opacity: number, minPx: number, maxPx: number): void {
    this.device.queue.writeBuffer(
      this.styleBuffer, 0, new Float32Array([sizeScale, opacity, minPx, maxPx]),
    );
  }

  private resolveBindGroup(): GPUBindGroup {
    const used = [this.bindings.position, this.bindings.color, this.bindings.size, this.bindings.opacity, this.bindings.mask]
      .filter(Boolean) as GpuAttribute[];
    const key = used.map((a) => `${a.name}:${a.capacityRows}`).join('|');
    if (this.bindGroup && key === this.bindKey) return this.bindGroup;

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.viewBuffer } },
      { binding: 1, resource: { buffer: this.styleBuffer } },
    ];
    let slot = 2;
    for (const a of used) entries.push({ binding: slot++, resource: { buffer: a.buffer } });
    this.bindGroup = this.device.createBindGroup({
      label: 'points:bg',
      layout: this.pipeline.getBindGroupLayout(0),
      entries,
    });
    this.bindKey = key;
    return this.bindGroup;
  }

  draw(pass: GPURenderPassEncoder, instances: number): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.resolveBindGroup());
    pass.draw(6, instances);
  }

  destroy(): void {
    this.styleBuffer.destroy();
  }
}
