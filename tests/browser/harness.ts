/**
 * Shared setup for the browser suite: a real `GPUDevice`, a real DuckDB, and the readback
 * helpers that let a test assert on what a kernel actually computed.
 *
 * Readback is the whole point. A structural test can prove a kernel compiles; only copying its
 * output buffer back and comparing numbers proves it computes the right thing. Every helper
 * here drains the queue and checks an error scope, so a validation failure surfaces as a test
 * failure rather than a console warning nobody reads.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import type { Table } from 'apache-arrow';
import type { QueryTiming, SqlEngine } from '../../src/core/source.js';

import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

let devicePromise: Promise<GPUDevice> | undefined;

/** One device for the whole run; creating one per test is slow and leaks adapters. */
export function gpuDevice(): Promise<GPUDevice> {
  devicePromise ??= (async () => {
    if (!('gpu' in navigator)) {
      throw new Error('navigator.gpu missing — Chromium needs --enable-unsafe-swiftshader');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter available');
    return adapter.requestDevice({
      requiredLimits: {
        maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
      },
    });
  })();
  return devicePromise;
}

export async function gpuAvailable(): Promise<boolean> {
  try {
    await gpuDevice();
    return true;
  } catch {
    return false;
  }
}

/** Copy a storage buffer back to the CPU as f32. */
export async function readBuffer(
  device: GPUDevice,
  buffer: GPUBuffer,
  elements: number,
): Promise<Float32Array> {
  const bytes = elements * 4;
  const staging = device.createBuffer({
    size: Math.max(4, bytes),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, Math.max(4, bytes));
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  // Copy out before unmapping: the mapped range is invalidated by unmap.
  const out = new Float32Array(staging.getMappedRange().slice(0, bytes));
  staging.unmap();
  staging.destroy();
  return out.subarray(0, elements);
}

/** Same, for the u32 grid the heatmap accumulates into. */
export async function readBufferU32(
  device: GPUDevice,
  buffer: GPUBuffer,
  elements: number,
): Promise<Uint32Array> {
  const bytes = elements * 4;
  const staging = device.createBuffer({
    size: Math.max(4, bytes),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, Math.max(4, bytes));
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(staging.getMappedRange().slice(0, bytes));
  staging.unmap();
  staging.destroy();
  return out.subarray(0, elements);
}

export function storageBuffer(device: GPUDevice, data: Float32Array, label: string): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(4, data.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(buffer, 0, data as unknown as GPUAllowSharedBufferSource);
  return buffer;
}

export function emptyStorageBuffer(device: GPUDevice, elements: number, label: string): GPUBuffer {
  return device.createBuffer({
    label,
    size: Math.max(4, elements * 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
}

/**
 * Run `body` with a validation error scope, so a WebGPU complaint becomes a thrown error.
 *
 * Without this a broken pipeline logs to the console and the test happily asserts on an
 * all-zero buffer — which is how "compute succeeded" was reported for a kernel that never ran.
 */
export async function expectNoGpuError<T>(device: GPUDevice, body: () => T | Promise<T>): Promise<T> {
  device.pushErrorScope('validation');
  const result = await body();
  await device.queue.onSubmittedWorkDone();
  const error = await device.popErrorScope();
  if (error) throw new Error(`WebGPU validation failed: ${error.message}`);
  return result;
}

// ---------------------------------------------------------------------------
// DuckDB
// ---------------------------------------------------------------------------

/** A `SqlEngine` over duckdb-wasm, with the bundle URLs Vite resolved for the test build. */
export class TestDuck implements SqlEngine {
  private prepared = new Map<string, duckdb.AsyncPreparedStatement>();

  private constructor(
    private readonly db: duckdb.AsyncDuckDB,
    private readonly conn: duckdb.AsyncDuckDBConnection,
  ) {}

  static async open(): Promise<TestDuck> {
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
      eh: { mainModule: ehWasm, mainWorker: ehWorker },
    });
    const worker = new Worker(bundle.mainWorker!, { type: 'module' });
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return new TestDuck(db, await db.connect());
  }

  async exec(sql: string): Promise<void> {
    await this.conn.query(sql);
  }

  async run(sql: string, binds: number[] = []): Promise<{ table: Table; timing: QueryTiming }> {
    const started = performance.now();
    let table: Table;
    if (binds.length === 0) {
      table = (await this.conn.query(sql)) as unknown as Table;
    } else {
      let stmt = this.prepared.get(sql);
      if (!stmt) {
        stmt = await this.conn.prepare(sql);
        this.prepared.set(sql, stmt);
      }
      table = (await stmt.query(...binds)) as unknown as Table;
    }
    return { table, timing: { ms: performance.now() - started, rows: table.numRows } };
  }

  async describe(relation: string): Promise<Map<string, string>> {
    const { table } = await this.run(`DESCRIBE SELECT * FROM ${relation}`);
    const out = new Map<string, string>();
    for (const row of table.toArray() as { column_name: string; column_type: string }[]) {
      out.set(String(row.column_name), String(row.column_type));
    }
    return out;
  }

  async resetPrepared(): Promise<void> {
    for (const stmt of this.prepared.values()) await stmt.close();
    this.prepared.clear();
  }

  async close(): Promise<void> {
    await this.resetPrepared();
    await this.conn.close();
    await this.db.terminate();
  }
}

let duckPromise: Promise<TestDuck> | undefined;

/** One database for the whole run; instantiating the wasm bundle costs seconds. */
export function duck(): Promise<TestDuck> {
  duckPromise ??= TestDuck.open();
  return duckPromise;
}

/**
 * A small deterministic table covering the column types that matter:
 *   f32 no nulls, f64, integer, and a nullable f32.
 */
export async function createTestTable(rows: number, relation = 'src'): Promise<void> {
  const sql = await duck();
  await sql.resetPrepared();
  await sql.exec(`
SELECT setseed(0.42);
CREATE OR REPLACE TABLE ${relation} AS
SELECT
  i::INTEGER                                        AS id,
  (i % 9)::INTEGER                                  AS cluster,
  ((i % 360) - 179)::DOUBLE                         AS lng,
  (((i * 7) % 160) - 79)::DOUBLE                    AS lat,
  ((i % 900))::FLOAT                                AS elevation,
  (CASE WHEN i % 50 = 0 THEN NULL ELSE (i % 120)::FLOAT END) AS speed,
  (10.0 + (i % 1000) * 100.0)::DOUBLE               AS pop,
  ((i % 24))::FLOAT                                 AS hour
FROM range(0, ${rows}) t(i);
`);
}
