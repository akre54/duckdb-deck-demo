/**
 * Read a command graph's buffers and textures back for `GraphView`'s hover preview.
 *
 * The description says where a resource's bytes are and how they are laid out (`format`, `rows`,
 * `byteStride`, `byteOffset` for a buffer view; `format`, `width`, `height` for a texture). This
 * module finds the physical buffer or texture behind the resource and decodes the first rows, or
 * the image, into a `NodePreview`.
 *
 * Like `describeCommandGraph`, it reads luma internals: the compiled graph's `buffers` and
 * `textures` maps (resource id to handle) and its `transientBuffers` and `transientTextures`
 * (handle to allocation). Imported resources are the handle's `defaultBuffer`/`defaultTexture`.
 *
 * What it reads is the resource's contents now, after the graph last ran, not at the version the
 * hovered node stands for. A transient may also share its allocation with other transients whose
 * lifetimes do not overlap, so its bytes can be whatever the last pass using the allocation wrote.
 * Both are said in the preview's note rather than hidden.
 */

import type { CompiledGPUCommandGraph } from '@luma.gl/gpgpu/gpu-core';
import type { GraphNode, NodePreview } from '@noodles.gl/graph-view';

export interface PreviewOptions {
  /** Rows of a buffer to show. Defaults to 16. */
  rows?: number;
}

export async function previewCommandGraphResource<P>(
  graph: CompiledGPUCommandGraph<P>, node: GraphNode, options: PreviewOptions = {},
): Promise<NodePreview | undefined> {
  if (node.role !== 'data') return undefined;
  const id = String(node.attributes?.resource ?? '');
  const a = node.attributes ?? {};
  const internals = graph as unknown as GraphInternals;
  const note = (transient: boolean) =>
    transient
      ? 'Contents after the last run. Transient: the allocation may be shared with other transients.'
      : 'Contents after the last run.';

  const bufferHandle = internals.buffers?.get(id);
  if (bufferHandle) {
    const buffer = bufferHandle.transient ? internals.transientBuffers?.get(bufferHandle) : coreOf(bufferHandle.defaultBuffer);
    if (!buffer) return { kind: 'text', text: 'Supplied per encoding; no default buffer to read.' };
    // An imported buffer with no view says nothing about its elements. Guessing one type would
    // print a float column as large integers, so show the 32-bit words both ways and say so.
    const declared = typeof a.format === 'string' ? a.format : undefined;
    const format = declared ?? 'uint32';
    const element = elementOf(format);
    if (!element) return { kind: 'text', text: `Format ${format} is not decoded.` };
    const stride = Number(a.byteStride) || element.bytes;
    const total = Number(a.rows) || Math.floor((bufferHandle.byteLength ?? 0) / stride);
    const rows = Math.min(options.rows ?? 16, total);
    const byteOffset = Number(a.byteOffset) || 0;
    if (rows <= 0) return { kind: 'text', text: 'Empty.' };
    const bytes = await buffer.readAsync(byteOffset, (rows - 1) * stride + element.bytes);
    if (!declared) {
      const asU32 = decodeRows(bytes, 'uint32', stride, rows);
      const asF32 = decodeRows(bytes, 'float32', stride, rows);
      return {
        kind: 'table', columns: ['row', 'as u32', 'as f32'], rows: asU32.rows.map((r, i) => [...r, asF32.rows[i][1]]), total,
        note: `No element format declared. ${note(!!bufferHandle.transient)}`,
      };
    }
    return { ...decodeRows(bytes, format, stride, rows), total, note: note(!!bufferHandle.transient) };
  }

  const textureHandle = internals.textures?.get(id);
  if (textureHandle) {
    const texture = textureHandle.transient ? internals.transientTextures?.get(textureHandle) : coreOf(textureHandle.defaultTexture);
    if (!texture) return { kind: 'text', text: 'Supplied per encoding; no default texture to read.' };
    const { width, height, format } = textureHandle;
    const bpp = texelBytes(format);
    if (!bpp || !RGBA_FORMATS.has(format)) return { kind: 'text', text: `${format} ${width}×${height}; only 8-bit RGBA formats are drawn.` };
    const bytesPerRow = Math.ceil((width * bpp) / 256) * 256;
    const raw = await readTexture(internals.device.handle, texture.handle, width, height, bytesPerRow);
    return { kind: 'image', width, height, rgba: toRgba(raw, format, width, height, bytesPerRow), note: note(!!textureHandle.transient) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// decoding: pure, so the node suite can test it

type Element = { type: 'float' | 'uint' | 'sint' | 'unorm' | 'snorm'; bits: 8 | 16 | 32; components: number; bytes: number };

/** `float32x2` as type, bits and component count. Undefined for a format this does not decode. */
export function elementOf(format: string): Element | undefined {
  const m = /^(float|uint|sint|unorm|snorm)(8|16|32)(?:x([234]))?$/.exec(format);
  if (!m) return undefined;
  const bits = Number(m[2]) as Element['bits'];
  if (m[1] === 'float' && bits === 8) return undefined;
  const components = Number(m[3] ?? 1);
  return { type: m[1] as Element['type'], bits, components, bytes: (bits / 8) * components };
}

/** The first `rows` elements of a buffer as a table: row index, then one column per component. */
export function decodeRows(bytes: Uint8Array, format: string, stride: number, rows: number): Extract<NodePreview, { kind: 'table' }> {
  const element = elementOf(format)!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (offset: number): number => {
    switch (`${element.type}${element.bits}`) {
      case 'float32': return view.getFloat32(offset, true);
      case 'float16': return half(view.getUint16(offset, true));
      case 'uint32': return view.getUint32(offset, true);
      case 'sint32': return view.getInt32(offset, true);
      case 'uint16': return view.getUint16(offset, true);
      case 'sint16': return view.getInt16(offset, true);
      case 'uint8': return view.getUint8(offset);
      case 'sint8': return view.getInt8(offset);
      case 'unorm8': return view.getUint8(offset) / 255;
      case 'snorm8': return Math.max(-1, view.getInt8(offset) / 127);
      case 'unorm16': return view.getUint16(offset, true) / 65535;
      case 'snorm16': return Math.max(-1, view.getInt16(offset, true) / 32767);
      default: return NaN;
    }
  };
  const show = (v: number) => (element.type === 'uint' || element.type === 'sint' ? v : Number(v.toPrecision(6)));
  const columns = ['row', ...(element.components === 1 ? [format] : ['x', 'y', 'z', 'w'].slice(0, element.components))];
  const out: (string | number)[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: (string | number)[] = [r];
    for (let c = 0; c < element.components; c++) row.push(show(read(r * stride + c * (element.bits / 8))));
    out.push(row);
  }
  return { kind: 'table', columns, rows: out };
}

/** Bytes per texel for the formats a preview can size; undefined for the rest. */
export function texelBytes(format: string): number | undefined {
  return TEXEL_BYTES[format];
}

/** Padded texture rows to tight RGBA, swapping red and blue for a BGRA format. */
export function toRgba(raw: Uint8Array, format: string, width: number, height: number, bytesPerRow: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const bgra = format.startsWith('bgra');
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * bytesPerRow + x * 4;
      const o = (y * width + x) * 4;
      out[o] = raw[i + (bgra ? 2 : 0)];
      out[o + 1] = raw[i + 1];
      out[o + 2] = raw[i + (bgra ? 0 : 2)];
      out[o + 3] = raw[i + 3];
    }
  }
  return out;
}

const TEXEL_BYTES: Record<string, number> = {
  rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4, rgba8uint: 4, rgba8snorm: 4,
  r32float: 4, r32uint: 4, rg32float: 8, rgba16float: 8, rgba32float: 16, r8unorm: 1,
};
const RGBA_FORMATS = new Set(['rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm', 'bgra8unorm-srgb', 'rgba8uint']);

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

// ---------------------------------------------------------------------------
// luma internals and the texture copy

type Readable = { readAsync(byteOffset?: number, byteLength?: number): Promise<Uint8Array> };
type BufferHandle = { transient?: boolean; byteLength?: number; defaultBuffer?: Readable | { buffer: Readable } };
type TextureHandle = { transient?: boolean; width: number; height: number; format: string; defaultTexture?: { handle: GPUTexture } | { texture: { handle: GPUTexture } } };
interface GraphInternals {
  device: { handle: GPUDevice };
  buffers?: Map<string, BufferHandle>;
  textures?: Map<string, TextureHandle>;
  transientBuffers?: Map<BufferHandle, Readable>;
  transientTextures?: Map<TextureHandle, { handle: GPUTexture }>;
}

/** A dynamic import wraps the concrete resource; luma unwraps it the same way (`getCoreBuffer`). */
function coreOf<T extends object>(resource: T | { buffer: T } | { texture: T } | undefined): T | undefined {
  if (!resource) return undefined;
  if ('readAsync' in resource || 'handle' in resource) return resource as T;
  return ('buffer' in resource ? resource.buffer : 'texture' in resource ? resource.texture : undefined) as T | undefined;
}

async function readTexture(device: GPUDevice, texture: GPUTexture, width: number, height: number, bytesPerRow: number): Promise<Uint8Array> {
  const staging = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: 'graph-preview:texture' });
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, { width, height });
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return bytes;
}
