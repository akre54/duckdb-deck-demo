/**
 * The named-attribute registry — the Houdini part.
 *
 * Attributes are addressed by name (`P`, `Cd`, `pscale`) rather than by pipeline slot,
 * so a graph node can create one and a render pass can bind it without either knowing
 * about the other. Buffers are reused across frames and only reallocated when the row
 * count outgrows capacity, which is what makes a value-parameter change a uniform write
 * rather than a re-upload.
 */

import { rowBytes, unpackRgba8, type AttributeFormat, type ColumnUpload } from '@noodles.gl/planner';
import { gpuData } from './gpu-compat.js';

export interface GpuAttribute {
  name: string;
  /** Components per row: 1 = f32, 3 = vec3<f32>, etc. Logical, whatever the storage format. */
  width: number;
  /** Absent for f32 components. `rgba8` is one packed u32 per row; see planner `packing.ts`. */
  format?: AttributeFormat;
  buffer: GPUBuffer;
  /** Rows the buffer can hold; >= the current row count. */
  capacityRows: number;
  rows: number;
  /**
   * Bumped every time `buffer` is replaced. Consumers cache bind groups, and a bind group
   * holding a destroyed buffer is only detected at submit time — so the cache key has to
   * change on reallocation. Neither the label (not unique) nor `capacityRows` (can repeat)
   * is sufficient on its own.
   */
  generation: number;
  provenance: 'arrow' | 'derived';
  /** Set for arrow-sourced attributes: how the column got here and what it cost. */
  upload?: ColumnUpload;
}

export class AttributeSet {
  private map = new Map<string, GpuAttribute>();
  private nextGeneration = 1;

  readonly counters = {
    allocations: 0,
    /** Columns uploaded. */
    uploads: 0,
    /** Individual writeBuffer calls — higher than `uploads` for chunked columns. */
    writeCalls: 0,
    bytesUploaded: 0,
    /** CPU milliseconds spent in Arrow->Float32 conversion this build. */
    convertMs: 0,
    /** GPU-to-GPU copies that carried old rows into a grown buffer, and their bytes. */
    gpuCopies: 0,
    bytesCopied: 0,
  };

  constructor(private readonly device: GPUDevice) {}

  /** Reset the per-build counters without dropping the buffers. */
  resetCounters(): void {
    this.counters.allocations = 0;
    this.counters.uploads = 0;
    this.counters.writeCalls = 0;
    this.counters.bytesUploaded = 0;
    this.counters.convertMs = 0;
    this.counters.gpuCopies = 0;
    this.counters.bytesCopied = 0;
  }

  list(): GpuAttribute[] {
    return [...this.map.values()];
  }

  get(name: string): GpuAttribute {
    const a = this.map.get(name);
    if (!a) throw new Error(`Attribute '${name}' is not bound. Have: ${[...this.map.keys()].join(', ') || '(none)'}`);
    return a;
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  /**
   * Get or allocate an attribute buffer. Reuses the existing buffer when the width
   * matches and capacity is sufficient — the case that keeps parameter tweaks cheap.
   */
  ensure(
    name: string, width: number, rows: number, provenance: 'arrow' | 'derived', format?: AttributeFormat,
  ): GpuAttribute {
    const existing = this.map.get(name);
    if (existing && existing.width === width && existing.format === format && existing.capacityRows >= rows) {
      existing.rows = rows;
      existing.provenance = provenance;
      return existing;
    }
    existing?.buffer.destroy();

    // Round up so small row-count changes do not thrash allocations.
    const capacityRows = Math.max(1, Math.ceil(rows * 1.25));
    const size = align4(capacityRows * rowBytes({ width, format }));
    const buffer = this.device.createBuffer({
      label: `attr:${name}`,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.counters.allocations++;
    const attr: GpuAttribute = {
      name, width, buffer, capacityRows, rows, provenance,
      ...(format ? { format } : {}),
      generation: this.nextGeneration++,
    };
    this.map.set(name, attr);
    return attr;
  }

  /**
   * A cache key over a set of attributes that changes whenever any of their buffers is
   * replaced. Bind-group caches must key on this, not on the `GpuAttribute` objects they
   * captured — those go stale when `ensure` reallocates, and a stale bind group fails as
   * "buffer used in submit while destroyed" on a later frame rather than at the point of
   * the mistake.
   */
  bindingKey(names: readonly (string | undefined)[]): string {
    return names
      .filter((n): n is string => Boolean(n))
      .map((n) => `${n}:${this.get(n).generation}`)
      .join('|');
  }

  /**
   * Upload a column. For the 'chunked' tier this issues one writeBuffer per Arrow
   * record batch, letting the GPU copy engine do the concatenation instead of JS.
   */
  write(name: string, width: number, rows: number, upload: ColumnUpload): GpuAttribute {
    const attr = this.ensure(name, width, rows, 'arrow');
    this.upload(attr, 0, rows, upload);
    attr.upload = upload;
    return attr;
  }

  /**
   * Write rows `fromRow .. fromRow + upload.rows` and leave the rows before them alone: an
   * append, when `fromRow` is the current row count. Only the new rows cross the bus.
   *
   * CesiumJS's buffer primitives upload only a dirty range for the same reason. The cases
   * here are narrower, because a requery replaces a whole column; this is for a source that
   * only ever adds rows. Within capacity it is one writeBuffer per chunk. Past capacity the
   * buffer is reallocated and the old rows are copied GPU to GPU, so they are still not
   * re-uploaded, and `generation` changes so bind groups rebuild.
   */
  writeRows(name: string, width: number, fromRow: number, upload: ColumnUpload): GpuAttribute {
    const existing = this.map.get(name);
    if (!existing) {
      if (fromRow !== 0) throw new Error(`Attribute '${name}': cannot write from row ${fromRow} of an attribute that does not exist`);
      return this.write(name, width, upload.rows, upload);
    }
    if (existing.width !== width || existing.format) {
      throw new Error(`Attribute '${name}': a row write must match the existing f32 width ${existing.width}`);
    }
    if (fromRow > existing.rows) {
      throw new Error(`Attribute '${name}': row ${fromRow} would leave a gap after row ${existing.rows}`);
    }
    const rows = fromRow + upload.rows;
    let attr = existing;
    if (rows > existing.capacityRows) {
      const old = existing.buffer;
      const keepBytes = fromRow * rowBytes(existing);
      // Detach first so `ensure` allocates rather than destroying the rows we still need.
      this.map.delete(name);
      attr = this.ensure(name, width, rows, 'arrow');
      if (keepBytes > 0) {
        const encoder = this.device.createCommandEncoder({ label: `grow:${name}` });
        encoder.copyBufferToBuffer(old, 0, attr.buffer, 0, keepBytes);
        this.device.queue.submit([encoder.finish()]);
        this.counters.gpuCopies++;
        this.counters.bytesCopied += keepBytes;
      }
      // Safe after submit: the copy already queued still completes.
      old.destroy();
    }
    attr.rows = rows;
    this.upload(attr, fromRow, upload.rows, upload);
    return attr;
  }

  /** writeBuffer `rows` rows of `upload` into `attr` starting at `fromRow`. */
  private upload(attr: GpuAttribute, fromRow: number, rows: number, upload: ColumnUpload): void {
    const { name, width } = attr;
    const needed = rows * width;
    const base = fromRow * width * 4;

    if (upload.chunks) {
      let element = 0;
      for (const chunk of upload.chunks) {
        if (element + chunk.length > needed) break;
        this.device.queue.writeBuffer(attr.buffer, base + element * 4, gpuData(chunk), 0, chunk.length);
        this.counters.writeCalls++;
        element += chunk.length;
      }
      if (element !== needed) {
        throw new Error(`Attribute '${name}': chunks covered ${element} of ${needed} values`);
      }
    } else {
      const data = upload.data!;
      if (data.length < needed) {
        throw new Error(`Attribute '${name}': got ${data.length} values, need ${needed}`);
      }
      this.device.queue.writeBuffer(attr.buffer, base, gpuData(data), 0, needed);
      this.counters.writeCalls++;
    }

    this.counters.uploads++;
    this.counters.bytesUploaded += needed * 4;
    this.counters.convertMs += upload.convertMs;
  }

  /**
   * Copy an attribute back as f32 components, unpacking a packed format. A diagnostic for
   * tests and the inspector: it waits for the GPU, and nothing on the draw path calls it.
   */
  async read(name: string): Promise<Float32Array> {
    const attr = this.get(name);
    const bytes = align4(Math.max(4, attr.rows * rowBytes(attr)));
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder({ label: `read:${name}` });
    encoder.copyBufferToBuffer(attr.buffer, 0, staging, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    // Copy out before unmapping: the mapped range is invalidated by unmap.
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return attr.format === 'rgba8'
      ? unpackRgba8(new Uint32Array(copy), attr.width, attr.rows)
      : new Float32Array(copy, 0, attr.rows * attr.width);
  }

  /** Drop attributes not present in `keep`, freeing their buffers. */
  prune(keep: Set<string>): void {
    for (const [name, attr] of [...this.map]) {
      if (!keep.has(name)) {
        attr.buffer.destroy();
        this.map.delete(name);
      }
    }
  }

  destroy(): void {
    for (const a of this.map.values()) a.buffer.destroy();
    this.map.clear();
  }
}

export function align4(n: number): number {
  return (n + 3) & ~3;
}
