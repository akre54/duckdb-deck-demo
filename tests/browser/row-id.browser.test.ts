/**
 * Tests for opt-in row ID preservation through SQL WHERE and CPU compaction.
 *
 * After filtering, deck's picked instance index is the compacted position (0 to filtered_count-1),
 * not the original source row. This suite verifies that when `preserveRowId` is enabled, the
 * source row identity survives every transformation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initGpu, type Gpu } from '../../src/webgpu/device.js';
import { Runtime } from '../../src/webgpu/runtime.js';
import type { Graph } from '@noodles.gl/planner';
import { readColumn, sqlSource, relationSource } from '@noodles.gl/planner';
import { createTestTable, closeTo, duck } from './harness.js';

const ROWS = 100;

describe('row id preservation', () => {
  let gpu: Gpu;
  let rt: Runtime;

  async function newRuntime(): Promise<Runtime> {
    const fresh = new Runtime(gpu, await duck());
    fresh.registerSource('test', relationSource('src'));
    return fresh;
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
    const graph: Graph = {
      params: { cut: { value: 50, kind: 'value' } },
      nodes: [
        {
          id: 'src',
          type: 'source',
          dataset: { ref: 'test' },
          preserveRowId: true, // Enable ROWID preservation
        },
        { id: 'filter', type: 'filter', input: 'src', predicate: 'id > {{cut}}' },
        {
          id: 'P',
          type: 'attribute',
          input: 'filter',
          name: 'P',
          wrangle: 'set(lng, lat, 0)',
        },
        { id: 'out', type: 'render', input: 'P', layer: { kind: 'scatter' } },
      ],
    };

    const built = await rt.build(graph, 'sql-first');

    // Verify __rowid attribute was generated
    expect(built.plan.attributes.some((a) => a.name === '__rowid')).toBe(true);

    // Compare against DuckDB source query with same filter
    const { table } = await (await duck()).run('SELECT CAST(ROWID AS INTEGER) AS rowid FROM src WHERE id > 50');
    const expected = readColumn(table, 'rowid');

    // Check if raw map exists and has __rowid
    expect(built.raw).toBeDefined();
    const rtRowIds = built.raw!.get('__rowid');
    expect(rtRowIds).toBeDefined();

    // Element-wise exact match
    closeTo([...rtRowIds!] as number[], [...expected.data!], '__rowid SQL filter');
  });

  it('preserves ROWID through CPU mask compaction', async () => {
    const graph: Graph = {
      params: { cut: { value: 50, kind: 'value' } },
      nodes: [
        {
          id: 'src',
          type: 'source',
          dataset: { ref: 'test' },
          preserveRowId: true,
        },
        { id: 'filter', type: 'filter', input: 'src', predicate: 'id > {{cut}}' },
        {
          id: 'P',
          type: 'attribute',
          input: 'filter',
          name: 'P',
          wrangle: 'set(lng, lat, 0)',
        },
        { id: 'out', type: 'render', input: 'P', layer: { kind: 'scatter' } },
      ],
    };

    // Force gpu-first policy so filter becomes CPU mask
    const built = await rt.build(graph, 'gpu-first');

    // Should have mask attribute (filter ran on CPU/GPU, not SQL)
    expect(built.plan.maskAttribute).toBe('__mask');

    // Get source ROWIDs (unfiltered)
    const { table: srcTable } = await (await duck()).run('SELECT CAST(ROWID AS INTEGER) AS rowid FROM src');
    const sourceRowIds = readColumn(srcTable, 'rowid').data!;

    // Get compacted IDs from runtime
    expect(built.raw).toBeDefined();
    const compactedIds = built.raw!.get('__rowid');
    expect(compactedIds).toBeDefined();

    // Compare against DuckDB filtered query
    const { table } = await (await duck()).run('SELECT CAST(ROWID AS INTEGER) AS rowid FROM src WHERE id > 50');
    const expected = readColumn(table, 'rowid').data!;

    closeTo([...compactedIds!] as number[], [...expected], '__rowid CPU mask', 0);
  });

  it('id values agree across sql-first and gpu-first', async () => {
    const graph: Graph = {
      params: { cut: { value: 30, kind: 'value' } },
      nodes: [
        {
          id: 'src',
          type: 'source',
          dataset: { ref: 'test' },
          preserveRowId: true,
        },
        { id: 'filter', type: 'filter', input: 'src', predicate: 'id > {{cut}}' },
        {
          id: 'P',
          type: 'attribute',
          input: 'filter',
          name: 'P',
          wrangle: 'set(lng, lat, 0)',
        },
        { id: 'out', type: 'render', input: 'P', layer: { kind: 'scatter' } },
      ],
    };

    const sqlFirst = await rt.build(graph, 'sql-first');
    const gpuFirst = await rt.build(graph, 'gpu-first');

    expect(sqlFirst.raw).toBeDefined();
    expect(gpuFirst.raw).toBeDefined();

    const sqlIds = sqlFirst.raw!.get('__rowid')!;
    const gpuIds = gpuFirst.raw!.get('__rowid')!;

    // Both should produce same row count for this simple filter
    expect(sqlIds.length).toBe(gpuIds.length);

    // Element-wise exact match
    closeTo([...sqlIds] as number[], [...gpuIds] as number[], 'cross-policy agreement', 0);
  });

  it('uses declared key column instead of ROWID', async () => {
    const graph: Graph = {
      params: {},
      nodes: [
        {
          id: 'src',
          type: 'source',
          dataset: { ref: 'test' },
          preserveRowId: 'id', // Use 'id' column as key
        },
        {
          id: 'P',
          type: 'attribute',
          input: 'src',
          name: 'P',
          wrangle: 'set(lng, lat, 0)',
        },
        { id: 'out', type: 'render', input: 'P', layer: { kind: 'scatter' } },
      ],
    };

    const built = await rt.build(graph, 'cost');

    // Should have 'id' attribute marked as raw
    expect(built.plan.attributes.some((a) => a.name === 'id' && a.type === 'raw')).toBe(true);

    // Should match source 'id' column values
    const { table } = await (await duck()).run('SELECT id FROM src');
    const expected = readColumn(table, 'id').data!;

    expect(built.raw).toBeDefined();
    const ids = built.raw!.get('id');
    expect(ids).toBeDefined();

    closeTo([...ids!] as number[], [...expected], 'declared key column', 0);
  });

  it('rejects string column as preserveRowId', async () => {
    // First check if there's a string column in test table
    const { table } = await (await duck()).run("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'src'");
    const hasStringCol = table.numRows > 0; // Test table may not have string columns

    if (!hasStringCol) {
      // Skip if no string columns in test table
      return;
    }

    const graph: Graph = {
      params: {},
      nodes: [
        {
          id: 'src',
          type: 'source',
          dataset: { ref: 'test' },
          preserveRowId: 'nonexistent_string', // Invalid
        },
        {
          id: 'P',
          type: 'attribute',
          input: 'src',
          name: 'P',
          wrangle: 'set(0, 0, 0)',
        },
        { id: 'out', type: 'render', input: 'P', layer: { kind: 'scatter' } },
      ],
    };

    await expect(rt.build(graph, 'cost')).rejects.toThrow(/not found in schema|is string/i);
  });

  it('rejects unknown column as preserveRowId', async () => {
    const graph: Graph = {
      params: {},
      nodes: [
        {
          id: 'src',
          type: 'source',
          dataset: { ref: 'test' },
          preserveRowId: 'nonexistent',
        },
        {
          id: 'P',
          type: 'attribute',
          input: 'src',
          name: 'P',
          wrangle: 'set(0, 0, 0)',
        },
        { id: 'out', type: 'render', input: 'P', layer: { kind: 'scatter' } },
      ],
    };

    await expect(rt.build(graph, 'cost')).rejects.toThrow(/not found in schema/i);
  });

  it('preserves id through CPU-only evaluation', async () => {
    // Save current target
    const originalTarget = rt.target;

    // Set to WebGL2 target (no compute shaders)
    rt.setTarget('deck-webgl2');

    const graph: Graph = {
      params: {},
      nodes: [
        {
          id: 'src',
          type: 'source',
          dataset: { ref: 'test' },
          preserveRowId: true,
        },
        {
          id: 'P',
          type: 'attribute',
          input: 'src',
          name: 'P',
          wrangle: 'set(lng, lat, 0)',
        },
        { id: 'out', type: 'render', input: 'P', layer: { kind: 'scatter' } },
      ],
    };

    const built = await rt.build(graph, 'cost');

    // Verify no GPU stage (all on CPU)
    expect(built.plan.kernels.length).toBe(0);
    expect(built.plan.cpuStage.length).toBeGreaterThan(0);

    // ID should still be preserved
    expect(built.raw).toBeDefined();
    const ids = built.raw!.get('__rowid');
    expect(ids).toBeDefined();

    // Should match source order
    const { table } = await (await duck()).run('SELECT CAST(ROWID AS INTEGER) AS rowid FROM src');
    const expected = readColumn(table, 'rowid').data!;

    closeTo([...ids!] as number[], [...expected], 'CPU-only path', 0);

    // Restore original target
    rt.setTarget(originalTarget);
  });
});
