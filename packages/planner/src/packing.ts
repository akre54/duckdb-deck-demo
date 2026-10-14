/**
 * Narrow GPU storage for the color channel: RGBA8 packed into one u32 per row.
 *
 * Every attribute is f32 per component by default, which makes a `vec3` color 12 bytes a row
 * for a value the screen shows at 8 bits a channel. CesiumJS's buffer primitives store color
 * as one RGBA8 u32 for that reason, and the same applies here: 5M rows of `Cd` drop from
 * 60 MB to 20 MB. A 4-byte RGBA layout is also what deck's WebGPU path can bind
 * (`unorm8x4`); a 3-component color makes it derive `unorm8x3`, which is not a WebGPU
 * vertex format.
 *
 * Only a color the kernel *writes* is packed. A color that arrives from SQL or the CPU stage
 * would need a JS pass to pack, which is the cost this exists to avoid, and a kernel that
 * reads its color back from a buffer would need to unpack it. The rule is stated once here so
 * the optimizer's byte estimate and the kernel emitter cannot disagree about it.
 */

import type { Analysis } from './analyze.js';

export type AttributeFormat = 'rgba8';

/**
 * The attribute that packs as RGBA8 when the GPU stage writes it, or undefined. The caller
 * still has to check that nothing upstream of the kernel produced the same name; that part
 * depends on the stage assignment.
 */
export function packedColorName(analysis: Pick<Analysis, 'channels' | 'widths' | 'sourceSchema' | 'aggregateNames'>): string | undefined {
  const { channels } = analysis;
  // Only the points renderer reads the channel from a buffer. A heatmap has no color buffer.
  if (channels.mode !== 'points') return undefined;
  const name = channels.color;
  const width = analysis.widths.get(name);
  if (width !== 3 && width !== 4) return undefined;
  // A source column or aggregate of the same name is selected and uploaded as f32.
  if (analysis.sourceSchema.has(name) || analysis.aggregateNames.includes(name)) return undefined;
  return name;
}

/** GPU bytes one row of an attribute occupies. */
export function rowBytes(attr: { width: number; format?: AttributeFormat }): number {
  return attr.format === 'rgba8' ? 4 : attr.width * 4;
}

/**
 * Packed RGBA8 back to f32 components, for readback and tests. Byte 0 is red, matching WGSL's
 * `pack4x8unorm` and a little-endian `unorm8x4` vertex fetch.
 */
export function unpackRgba8(packed: Uint32Array, width: number, rows = packed.length): Float32Array {
  const out = new Float32Array(rows * width);
  for (let i = 0; i < rows; i++) {
    const v = packed[i];
    for (let c = 0; c < width; c++) out[i * width + c] = ((v >>> (c * 8)) & 0xff) / 255;
  }
  return out;
}
