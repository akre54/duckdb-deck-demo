import { describe, it, expect, beforeAll } from 'vitest';
import type { ColumnUpload } from '@noodles.gl/planner';
import { AttributeSet } from '../../src/webgpu/attributes.js';
import { gpuDevice, expectNoGpuError } from './harness.js';

/**
 * Row-range writes on real buffers. The claim is about bytes, so the assertions are the
 * counters and the contents read back, not the absence of a throw.
 */

let device: GPUDevice;

beforeAll(async () => {
  device = await gpuDevice();
});

/** `rows` rows of `width` components, value = row * 10 + component, in `chunks` pieces. */
function column(fromRow: number, rows: number, width: number, chunks = 1): ColumnUpload {
  const data = new Float32Array(rows * width);
  for (let r = 0; r < rows; r++) for (let c = 0; c < width; c++) data[r * width + c] = (fromRow + r) * 10 + c;
  const size = Math.ceil(rows / chunks) * width;
  const pieces = Array.from({ length: chunks }, (_, k) => data.subarray(k * size, Math.min(data.length, (k + 1) * size)));
  return {
    tier: chunks > 1 ? 'chunked' : 'arrow',
    ...(chunks > 1 ? { chunks: pieces } : { data }),
    chunkCount: chunks, nullCount: 0, convertMs: 0, arrowType: 'Float32', rows,
  };
}

function expected(rows: number, width: number): number[] {
  return Array.from(column(0, rows, width).data!);
}

describe('appending rows uploads only the new rows', () => {
  it('within capacity: same buffer, one write of the new rows', async () => {
    const attrs = new AttributeSet(device);
    await expectNoGpuError(device, async () => {
      attrs.write('P', 3, 1000, column(0, 1000, 3));
      const before = attrs.get('P');
      expect(before.capacityRows).toBe(1250);
      attrs.resetCounters();

      attrs.writeRows('P', 3, 1000, column(1000, 200, 3));
      const after = attrs.get('P');
      expect(after.generation, 'no reallocation').toBe(before.generation);
      expect(after.rows).toBe(1200);
      expect(attrs.counters.bytesUploaded).toBe(200 * 3 * 4);
      expect(attrs.counters.gpuCopies).toBe(0);
    });
    expect(Array.from(await attrs.read('P'))).toEqual(expected(1200, 3));
    attrs.destroy();
  });

  it('past capacity: a GPU copy carries the old rows, and only the new ones upload', async () => {
    const attrs = new AttributeSet(device);
    await expectNoGpuError(device, async () => {
      attrs.write('pscale', 1, 1000, column(0, 1000, 1));
      const before = attrs.get('pscale');
      attrs.resetCounters();

      // Chunked, as DuckDB delivers it, so the per-chunk offsets are exercised too.
      attrs.writeRows('pscale', 1, 1000, column(1000, 2000, 1, 7));
      const after = attrs.get('pscale');
      expect(after.generation, 'grown buffer, new generation').toBeGreaterThan(before.generation);
      expect(after.capacityRows).toBeGreaterThanOrEqual(3000);
      expect(attrs.counters.bytesUploaded).toBe(2000 * 4);
      expect(attrs.counters.gpuCopies).toBe(1);
      expect(attrs.counters.bytesCopied).toBe(1000 * 4);
      expect(attrs.counters.writeCalls).toBe(7);
    });
    expect(Array.from(await attrs.read('pscale'))).toEqual(expected(3000, 1));
    attrs.destroy();
  });

  it('overwriting a tail range keeps the rows before it', async () => {
    const attrs = new AttributeSet(device);
    attrs.write('a', 1, 100, column(0, 100, 1));
    const tail = column(0, 10, 1);
    tail.data!.fill(-1);
    attrs.writeRows('a', 1, 95, tail);
    const got = Array.from(await attrs.read('a'));
    expect(got).toHaveLength(105);
    expect(got.slice(0, 95)).toEqual(expected(95, 1));
    expect(got.slice(95)).toEqual(new Array(10).fill(-1));
    attrs.destroy();
  });

  it('refuses a gap or a width change rather than writing garbage', () => {
    const attrs = new AttributeSet(device);
    attrs.write('a', 1, 10, column(0, 10, 1));
    expect(() => attrs.writeRows('a', 1, 11, column(11, 1, 1))).toThrow(/gap/);
    expect(() => attrs.writeRows('a', 3, 10, column(10, 1, 3))).toThrow(/width/);
    attrs.destroy();
  });
});
