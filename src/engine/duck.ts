/**
 * DuckDB-Wasm host. Two things matter here beyond "run a query":
 *
 * 1. Prepared statements are cached by SQL text, so a *value* parameter change
 *    rebinds and re-executes without DuckDB re-planning. That is the SQL half of
 *    the "prepared statement" idea the graph is built around.
 * 2. Results stay as Arrow. Nothing is converted to JS objects on the way to the GPU.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import type { Table } from 'apache-arrow';

import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

export interface QueryTiming {
  /** Milliseconds spent inside DuckDB, wall clock from the JS side. */
  ms: number;
  rows: number;
}

export class Duck {
  private constructor(
    private readonly db: duckdb.AsyncDuckDB,
    private readonly conn: duckdb.AsyncDuckDBConnection,
  ) {}

  private prepared = new Map<string, duckdb.AsyncPreparedStatement>();
  /** Counts how often a plan was reused vs recompiled — surfaced in the inspector. */
  readonly counters = { prepares: 0, executions: 0 };

  static async open(): Promise<Duck> {
    const bundle = await duckdb.selectBundle(BUNDLES);
    const worker = new Worker(bundle.mainWorker!, { type: 'module' });
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();
    return new Duck(db, conn);
  }

  /** Fire-and-forget DDL. */
  async exec(sql: string): Promise<void> {
    await this.conn.query(sql);
  }

  /**
   * Run a statement, preparing and caching it on first sight. Returns Arrow.
   * `binds` must match the `?` order the SQL backend produced.
   */
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

  /** Column name -> DuckDB type name, for the source relation. */
  async describe(relation: string): Promise<Map<string, string>> {
    const { table } = await this.run(`DESCRIBE SELECT * FROM ${relation}`);
    const out = new Map<string, string>();
    for (const row of table.toArray() as { column_name: string; column_type: string }[]) {
      out.set(String(row.column_name), String(row.column_type));
    }
    return out;
  }

  /** Drop cached plans. Call after DDL that invalidates them (e.g. regenerating src). */
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
