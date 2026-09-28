/**
 * Tests for opt-in row ID preservation through SQL WHERE and GPU/CPU masking.
 *
 * After filtering, deck's picked instance index is the position in the *result*, not the
 * original source row. This suite verifies that when `preserveRowId` is enabled, the source row
 * identity survives every placement of the filter, on real DuckDB and a real GPU.
 *
 * `Runtime` does not compact a masked filter: rows the mask rejects stay in every buffer and the
 * pass discards them. So under a mask the check is "the ids of the rows the mask keeps", read
 * back from the GPU, rather than "the id array is shorter".
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initGpu, type Gpu } from '../../src/webgpu/device.js';
import { Runtime, type BuildResult } from '../../src/webgpu/runtime.js';
import { plan, readColumn, relationSource, type Graph, type SourceNode } from '@noodles.gl/planner';
import { createTestTable, closeTo, duck, readBuffer } from './harness.js';

const ROWS = 100;

/** Source, optional filter on `id`, a position, a points render. */
function graph(preserveRowId: SourceNode['preserveRowId'], cut?: number): Graph {
  return {
    params: cut === undefined ? {} : { cut: { value: cut, kind: 'value' } },
    nodes: [
      { id: 'src', type: 'source', dataset: { ref: 'test', estimatedRows: ROWS }, preserveRowId },
      ...(cut === undefined
        ? []
        : [{ id: 'filter', type: 'filter' as const, input: 'src', predicate: 'id > {{cut}}' }]),
      { id: 'P', type: 'attribute', input: cut === undefined ? 'src' : 'filter', name: 'P', expr: '[lng, lat, 0]' },
      { id: 'out', type: 'render', input: 'P', mode: 'points', position: 'P' },
    ],
  };
}

async function expectedIds(sql: string): Promise<number[]> {
  const { table } = await (await duck()).run(sql);
  return [...readColumn(table, 'rowid').data!];
}

describe('row id preservation', () => {
  let gpu: Gpu;
  let rt: Runtime;

  /** A runtime with no inherited parameter state, its source schema described. */
  async function newRuntime(): Promise<Runtime> {
    const fresh = new Runtime(gpu, await duck());
    fresh.registerSource('test', relationSource('src'));
    // Without this the planner sees an empty schema and every column is "unknown".
    await fresh.loadSource(graph(true));
    return fresh;
  }

  /**
   * The ids of the rows the build actually draws. A mask, if the plan has one, is read back
   * from the GPU after a frame has dispatched the kernels that write it.
   */
  async function visibleIds(built: BuildResult, name: string, from: Runtime): Promise<number[]> {
    const ids = built.raw?.get(name) as number[] | undefined;
    expect(ids, `${name} raw column`).toBeDefined();
    const maskName = built.plan.maskAttribute;
    if (!maskName || !from.attributes.has(maskName)) return [...ids!];
    from.frame();
    await gpu.device.queue.onSubmittedWorkDone();
    const attr = from.attributes.get(maskName);
    const mask = await readBuffer(gpu.device, attr.buffer, attr.rows);
    return ids!.filter((_, i) => mask[i] !== 0);
  }

  beforeAll(async () => {
    await createTestTable(ROWS);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    document.body.append(canvas);
    gpu = await initGpu(canvas);
    rt = await newRuntime();
  });

  it('preserves source ROWID through SQL WHERE filtering', async () => {
    const built = await (await newRuntime()).build(graph(true, 50), 'sql-first');

    expect(built.plan.attributes.some((a) => a.name === '__rowid' && a.type === 'raw')).toBe(true);
    expect(built.plan.sql).toMatch(/WHERE/);
    expect(built.plan.maskAttribute).toBeUndefined();

    const rowIds = built.raw!.get('__rowid') as number[];
    const expected = await expectedIds('SELECT CAST(ROWID AS INTEGER) AS rowid FROM src WHERE id > 50');
    expect(rowIds.length).toBe(ROWS - 51);
    closeTo([...rowIds], expected, '__rowid SQL filter', 0);
  });

  it('preserves ROWID through a mask filter', async () => {
    const fresh = await newRuntime();
    const built = await fresh.build(graph(true, 50), 'gpu-first');

    // The filter did not reach SQL: every row came back and a mask decides visibility.
    expect(built.plan.maskAttribute).toBe('__mask');
    const all = built.raw!.get('__rowid') as number[];
    closeTo([...all], await expectedIds('SELECT CAST(ROWID AS INTEGER) AS rowid FROM src'), '__rowid unfiltered', 0);

    const kept = await visibleIds(built, '__rowid', fresh);
    const expected = await expectedIds('SELECT CAST(ROWID AS INTEGER) AS rowid FROM src WHERE id > 50');
    closeTo(kept, expected, '__rowid under mask', 0);
  });

  it('id values agree across sql-first and gpu-first', async () => {
    const sqlRt = await newRuntime();
    const gpuRt = await newRuntime();
    const sqlFirst = await sqlRt.build(graph(true, 30), 'sql-first');
    const gpuFirst = await gpuRt.build(graph(true, 30), 'gpu-first');
    expect(sqlFirst.plan.maskAttribute).toBeUndefined();
    expect(gpuFirst.plan.maskAttribute).toBe('__mask');

    const sqlIds = await visibleIds(sqlFirst, '__rowid', sqlRt);
    const gpuIds = await visibleIds(gpuFirst, '__rowid', gpuRt);
    expect(sqlIds.length).toBe(ROWS - 31);
    closeTo(gpuIds, sqlIds, 'cross-policy agreement', 0);
  });

  it('uses declared key column instead of ROWID', async () => {
    const built = await rt.build(graph('id'), 'cost');

    // The key is selected even though nothing in the graph reads it, and read raw.
    expect(built.plan.attributes.some((a) => a.name === 'id' && a.type === 'raw')).toBe(true);
    expect(built.plan.attributes.some((a) => a.name === '__rowid')).toBe(false);

    const { table } = await (await duck()).run('SELECT id FROM src');
    const expected = [...readColumn(table, 'id').data!];
    const ids = built.raw?.get('id') as number[] | undefined;
    expect(ids).toBeDefined();
    closeTo([...ids!], expected, 'declared key column', 0);
  });

  it('rejects string column as preserveRowId', () => {
    // The runtime drops non-numeric columns before planning, so the string check is reachable
    // only through the column types a program host passes. Exercise it there, headlessly.
    const schema = new Map([['id', 1], ['lng', 1], ['lat', 1]]);
    const columnTypes = new Map([['name', 'str' as const]]);
    expect(() => plan(graph('name'), schema, { columnTypes })).toThrow(/is a string column/i);
  });

  it('rejects unknown column as preserveRowId', async () => {
    await expect(rt.build(graph('nonexistent'), 'cost')).rejects.toThrow(/not found in schema/i);
  });

  it('preserves id through CPU-only evaluation', async () => {
    const fresh = await newRuntime();
    // WebGL2 has no compute shaders, so nothing may be placed on the GPU.
    fresh.setTarget('deck-webgl2');

    const built = await fresh.build(graph(true, 50), 'cost');

    expect(built.plan.kernels.length).toBe(0);
    expect(built.plan.cpuStage.length).toBeGreaterThan(0);

    const ids = await visibleIds(built, '__rowid', fresh);
    const expected = await expectedIds('SELECT CAST(ROWID AS INTEGER) AS rowid FROM src WHERE id > 50');
    closeTo(ids, expected, 'CPU-only path', 0);
  });
});
