/**
 * Arrow column -> GPU buffer, with the honest cost recorded.
 *
 * The measured finding that shaped this file: **DuckDB-Wasm never returns one
 * contiguous chunk.** A 300k-row result arrives as ~147 record batches of 2048 rows.
 * So the appealing story — "the Arrow column IS the attribute buffer, byte for byte" —
 * is false for DuckDB output in practice, and any design that assumes a single
 * `Float32Array` per column will silently fall back to a full CPU pass.
 *
 * That does not mean a JS loop is unavoidable. It means the concatenation belongs to
 * the GPU copy engine rather than to JS:
 *
 *   'arrow'   single chunk, Float32, no nulls -> one writeBuffer over the column's own
 *             memory. Rare from DuckDB; common if you hand-build the table.
 *   'chunked' many chunks, Float32, no nulls  -> one writeBuffer per chunk at the right
 *             byte offset. N GPU copies, zero JS element loops. This is the realistic
 *             fast path.
 *   'cast'    Float64 / integer / nullable    -> one JS pass into a fresh Float32Array.
 *             Unavoidable: WGSL has no f64, and Arrow's validity bitmap has to be
 *             consumed somewhere. Nulls become NaN and the shaders discard them.
 */

import type { Table, Vector } from 'apache-arrow';

export type Tier = 'arrow' | 'chunked' | 'cast';

export interface ColumnUpload {
  tier: Tier;
  /** Contiguous values for the 'arrow' and 'cast' tiers. */
  data?: Float32Array;
  /** Per-chunk views in row order, for the 'chunked' tier. */
  chunks?: Float32Array[];
  chunkCount: number;
  /** Rows that were null in Arrow and are NaN on the GPU. */
  nullCount: number;
  /** Milliseconds of CPU element-wise work. 0 for 'arrow' and 'chunked'. */
  convertMs: number;
  arrowType: string;
  rows: number;
}

export function readColumn(table: Table, name: string): ColumnUpload {
  const vector = table.getChild(name) as Vector | null;
  if (!vector) {
    throw new Error(
      `Column '${name}' not present in query result. Have: ${table.schema.fields.map((f) => f.name).join(', ')}`,
    );
  }
  const arrowType = String(vector.type);
  const chunkCount = vector.data.length;
  const rows = table.numRows;

  // Can every chunk be handed to the GPU as-is?
  const allFloat32NoNulls =
    vector.nullCount === 0 &&
    vector.data.every((d) => d.values instanceof Float32Array && d.nullCount === 0);

  if (allFloat32NoNulls && chunkCount === 1) {
    const d = vector.data[0];
    const values = d.values as Float32Array;
    return {
      tier: 'arrow',
      // A subarray is a view onto the same ArrayBuffer, not a copy.
      data: values.subarray(d.offset, d.offset + d.length),
      chunkCount,
      nullCount: 0,
      convertMs: 0,
      arrowType,
      rows,
    };
  }

  if (allFloat32NoNulls) {
    return {
      tier: 'chunked',
      chunks: vector.data.map((d) => (d.values as Float32Array).subarray(d.offset, d.offset + d.length)),
      chunkCount,
      nullCount: 0,
      convertMs: 0,
      arrowType,
      rows,
    };
  }

  // --- the genuine CPU pass ------------------------------------------------
  const started = performance.now();
  const out = new Float32Array(rows);
  let nullCount = 0;
  let cursor = 0;

  for (const chunk of vector.data) {
    const values = chunk.values as ArrayLike<number> | BigInt64Array | BigUint64Array;
    const offset = chunk.offset;
    const len = chunk.length;

    // Arrow JS hands back a zero-length Uint8Array rather than undefined when a chunk
    // has no nulls. Testing bits against that reads `undefined`, which looks like
    // "null" for every row — so gate on the null count, not the bitmap's existence.
    const bitmap = chunk.nullCount > 0 && chunk.nullBitmap && chunk.nullBitmap.length > 0
      ? chunk.nullBitmap
      : undefined;

    if (values instanceof BigInt64Array || values instanceof BigUint64Array) {
      // 64-bit integers exceed f32's exact range; the precision loss is real and
      // deliberate, not an oversight.
      for (let i = 0; i < len; i++) {
        if (bitmap && !bitSet(bitmap, offset + i)) { out[cursor + i] = NaN; nullCount++; continue; }
        out[cursor + i] = Number(values[offset + i]);
      }
    } else {
      for (let i = 0; i < len; i++) {
        if (bitmap && !bitSet(bitmap, offset + i)) { out[cursor + i] = NaN; nullCount++; continue; }
        out[cursor + i] = (values as ArrayLike<number>)[offset + i];
      }
    }
    cursor += len;
  }

  return {
    tier: 'cast',
    data: out,
    chunkCount,
    nullCount,
    convertMs: performance.now() - started,
    arrowType,
    rows,
  };
}

/**
 * Interleave several scalar columns into one packed attribute (`P_0,P_1,P_2` -> `P`).
 *
 * This is the price of doing vector math in SQL: SQL columns are scalars, so a vec3
 * always arrives as separate buffers and must be interleaved on the CPU — and there is
 * no chunked shortcut, because the destination stride is not the source stride. A
 * kernel that produces the same vec3 writes it packed in the first place. Worth knowing
 * before deciding to push position math into SQL.
 */
export function readVectorColumns(table: Table, names: string[]): ColumnUpload {
  if (names.length === 1) return readColumn(table, names[0]);
  const started = performance.now();
  const parts = names.map((n) => readColumn(table, n));
  const rows = table.numRows;
  const width = names.length;
  const out = new Float32Array(rows * width);

  for (let c = 0; c < width; c++) {
    const part = parts[c];
    if (part.data) {
      const src = part.data;
      for (let i = 0; i < rows; i++) out[i * width + c] = src[i];
    } else {
      let row = 0;
      for (const chunk of part.chunks!) {
        for (let i = 0; i < chunk.length; i++) out[(row + i) * width + c] = chunk[i];
        row += chunk.length;
      }
    }
  }

  return {
    tier: 'cast',
    data: out,
    chunkCount: Math.max(...parts.map((p) => p.chunkCount)),
    nullCount: parts.reduce((s, p) => s + p.nullCount, 0),
    convertMs: performance.now() - started,
    arrowType: `interleaved(${parts.map((p) => p.arrowType).join(', ')})`,
    rows,
  };
}

function bitSet(bitmap: Uint8Array, index: number): boolean {
  return (bitmap[index >> 3] & (1 << (index & 7))) !== 0;
}
