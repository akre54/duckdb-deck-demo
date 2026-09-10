/**
 * The named-attribute registry — the Houdini part.
 *
 * Attributes are addressed by name (`P`, `Cd`, `pscale`) rather than by pipeline slot,
 * so a graph node can create one and a render pass can bind it without either knowing
 * about the other. Buffers are reused across frames and only reallocated when the row
 * count outgrows capacity, which is what makes a value-parameter change a uniform write
 * rather than a re-upload.
 */

import type { ColumnUpload } from '../core/arrow.js';
import { gpuData } from './gpu-compat.js';

export interface GpuAttribute {
  name: string;
  /** Components per row: 1 = f32, 3 = vec3<f32>, etc. */
  width: number;
  buffer: GPUBuffer;
  /** Rows the buffer can hold; >= the current row count. */
  capacityRows: number;
  rows: number;
  provenance: 'arrow' | 'derived';
  /** Set for arrow-sourced attributes: how the column got here and what it cost. */
  upload?: ColumnUpload;
}

export class AttributeSet {
  private map = new Map<string, GpuAttribute>();

  readonly counters = {
    allocations: 0,
    /** Columns uploaded. */
    uploads: 0,
    /** Individual writeBuffer calls — higher than `uploads` for chunked columns. */
    writeCalls: 0,
    bytesUploaded: 0,
    /** CPU milliseconds spent in Arrow->Float32 conversion this build. */
    convertMs: 0,
  };

  constructor(private readonly device: GPUDevice) {}

  /** Reset the per-build counters without dropping the buffers. */
  resetCounters(): void {
    this.counters.allocations = 0;
    this.counters.uploads = 0;
    this.counters.writeCalls = 0;
    this.counters.bytesUploaded = 0;
    this.counters.convertMs = 0;
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
  ensure(name: string, width: number, rows: number, provenance: 'arrow' | 'derived'): GpuAttribute {
    const existing = this.map.get(name);
    if (existing && existing.width === width && existing.capacityRows >= rows) {
      existing.rows = rows;
      existing.provenance = provenance;
      return existing;
    }
    existing?.buffer.destroy();

    // Round up so small row-count changes do not thrash allocations.
    const capacityRows = Math.max(1, Math.ceil(rows * 1.25));
    const size = align4(capacityRows * width * 4);
    const buffer = this.device.createBuffer({
      label: `attr:${name}`,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.counters.allocations++;
    const attr: GpuAttribute = { name, width, buffer, capacityRows, rows, provenance };
    this.map.set(name, attr);
    return attr;
  }

  /**
   * Upload a column. For the 'chunked' tier this issues one writeBuffer per Arrow
   * record batch, letting the GPU copy engine do the concatenation instead of JS.
   */
  write(name: string, width: number, rows: number, upload: ColumnUpload): GpuAttribute {
    const attr = this.ensure(name, width, rows, 'arrow');
    const needed = rows * width;

    if (upload.chunks) {
      let element = 0;
      for (const chunk of upload.chunks) {
        if (element + chunk.length > needed) break;
        this.device.queue.writeBuffer(attr.buffer, element * 4, gpuData(chunk), 0, chunk.length);
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
      this.device.queue.writeBuffer(attr.buffer, 0, gpuData(data), 0, needed);
      this.counters.writeCalls++;
    }

    attr.upload = upload;
    this.counters.uploads++;
    this.counters.bytesUploaded += needed * 4;
    this.counters.convertMs += upload.convertMs;
    return attr;
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
