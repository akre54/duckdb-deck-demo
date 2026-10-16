import { describe, it, expect } from 'vitest';
import { decodeRows, elementOf, texelBytes, toRgba } from './graph-preview.js';

describe('elementOf', () => {
  it('parses luma vector formats', () => {
    expect(elementOf('float32')).toEqual({ type: 'float', bits: 32, components: 1, bytes: 4 });
    expect(elementOf('uint16x2')).toEqual({ type: 'uint', bits: 16, components: 2, bytes: 4 });
    expect(elementOf('unorm8x4')).toEqual({ type: 'unorm', bits: 8, components: 4, bytes: 4 });
  });

  it('declines formats it cannot decode', () => {
    expect(elementOf('float8')).toBeUndefined();
    expect(elementOf('rgba8unorm')).toBeUndefined();
  });
});

describe('decodeRows', () => {
  it('reads scalars at a stride, little-endian', () => {
    const f = new Float32Array([1.5, 99, -2, 99, 0.25, 99]);
    const t = decodeRows(new Uint8Array(f.buffer), 'float32', 8, 3);
    expect(t.columns).toEqual(['row', 'float32']);
    expect(t.rows).toEqual([[0, 1.5], [1, -2], [2, 0.25]]);
  });

  it('splits vectors into x, y, z, w', () => {
    const u = new Uint32Array([1, 2, 3, 4]);
    const t = decodeRows(new Uint8Array(u.buffer), 'uint32x2', 8, 2);
    expect(t.columns).toEqual(['row', 'x', 'y']);
    expect(t.rows).toEqual([[0, 1, 2], [1, 3, 4]]);
  });

  it('decodes half floats and normalized integers', () => {
    // 0x3c00 is 1.0 and 0xc000 is -2.0 in IEEE half precision.
    const h = new Uint16Array([0x3c00, 0xc000]);
    expect(decodeRows(new Uint8Array(h.buffer), 'float16', 2, 2).rows).toEqual([[0, 1], [1, -2]]);
    expect(decodeRows(new Uint8Array([255, 0]), 'unorm8', 1, 2).rows).toEqual([[0, 1], [1, 0]]);
  });

  it('reads from a view that does not start at its buffer’s first byte', () => {
    const backing = new Uint8Array(12);
    new DataView(backing.buffer).setUint32(8, 7, true);
    expect(decodeRows(backing.subarray(8), 'uint32', 4, 1).rows).toEqual([[0, 7]]);
  });
});

describe('toRgba', () => {
  it('drops the 256-byte row padding and swaps red and blue for BGRA', () => {
    const bytesPerRow = 256;
    const raw = new Uint8Array(bytesPerRow * 2);
    raw.set([10, 20, 30, 255], 0); // row 0, x 0
    raw.set([40, 50, 60, 255], bytesPerRow); // row 1, x 0
    expect([...toRgba(raw, 'rgba8unorm', 1, 2, bytesPerRow)]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect([...toRgba(raw, 'bgra8unorm', 1, 2, bytesPerRow)]).toEqual([30, 20, 10, 255, 60, 50, 40, 255]);
  });

  it('sizes the formats it draws', () => {
    expect(texelBytes('rgba8unorm')).toBe(4);
    expect(texelBytes('rgba32float')).toBe(16);
    expect(texelBytes('depth24plus')).toBeUndefined();
  });
});
