/**
 * DuckDB-Wasm adapter: a `SqlEngine` implementation.
 *
 * The bundle URLs are **passed in** rather than imported. The previous version used Vite's
 * `?url` import suffix, which is a bundler feature — it works in the demo and breaks the
 * moment the library is consumed anywhere else, or built with plain `tsc`. Taking them as
 * arguments is what keeps this file (and therefore the whole library) bundler-agnostic.
 *
 * Two behaviors matter beyond "run a query":
 *
 * 1. Prepared statements are cached by SQL text, so a *value* parameter change rebinds and
 *    re-executes without DuckDB re-planning. That is the SQL half of the cheap
 *    reparameterization the planner amortizes.
 * 2. Results stay as Arrow. Nothing is converted to JS objects on the way to the GPU.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import type { Table } from 'apache-arrow';

import type { QueryTiming, SqlEngine } from '@noodles.gl/planner';

export type { QueryTiming, SqlEngine };

/**
 * URLs for the wasm modules and workers, resolved by the host.
 *
 * With Vite that is `import url from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'`; with
 * a CDN it is a plain string. The library does not care which.
 */
export interface DuckDbBundleUrls {
  mvpModule: string;
  mvpWorker: string;
  ehModule: string;
  ehWorker: string;
}

export interface DuckDbOptions {
  /** Silence DuckDB's own logging. Defaults to true. */
  quiet?: boolean;
}

export class DuckDbEngine implements SqlEngine {
  private prepared = new Map<string, duckdb.AsyncPreparedStatement>();

  /** Counts plan reuse vs recompilation — surfaced in the demo's inspector. */
  readonly counters = { prepares: 0, executions: 0 };

  private constructor(
    private readonly db: duckdb.AsyncDuckDB,
    private readonly conn: duckdb.AsyncDuckDBConnection,
  ) {}

  static async open(urls: DuckDbBundleUrls, options: DuckDbOptions = {}): Promise<DuckDbEngine> {
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: urls.mvpModule, mainWorker: urls.mvpWorker },
      eh: { mainModule: urls.ehModule, mainWorker: urls.ehWorker },
    });
    const worker = new Worker(bundle.mainWorker!, { type: 'module' });
    const logger = options.quiet === false ? new duckdb.ConsoleLogger() : new duckdb.VoidLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();
    return new DuckDbEngine(db, conn);
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
        this.counters.prepares++;
      }
      table = (await stmt.query(...binds)) as unknown as Table;
    }
    this.counters.executions++;
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
