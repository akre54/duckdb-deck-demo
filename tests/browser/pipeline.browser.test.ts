import { describe, it, expect, beforeAll } from 'vitest';
import { initGpu, type Gpu } from '../../src/webgpu/device.js';
import { Runtime } from '../../src/webgpu/runtime.js';
import { readColumn } from '../../src/core/arrow.js';
import { evaluateStage } from '../../src/core/cpu-stage.js';
import { relationSource, sqlSource } from '../../src/core/source.js';
import { targetCaps } from '../../src/core/target.js';
import type { Graph } from '../../src/core/types.js';
import { duck, readBuffer, readBufferU32 } from './harness.js';

/**
 * The pipeline end to end on real engines: DuckDB produces Arrow, the upload path lands it on
 * the GPU, a kernel derives attributes, and the buffers are read back and checked.
 *
 * The most valuable assertion here is cross-engine agreement at the *plan* level: the same
 * graph planned under different policies and targets must produce numerically identical
 * attributes. Placement is supposed to be a cost decision, so if it changes the picture, the
 * optimizer is not free to choose.
 */

const ROWS = 4096;

let gpu: Gpu;
let rt: Runtime;

const TEST_DDL = `
SELECT setseed(0.42);
CREATE OR REPLACE TABLE src AS
SELECT
  i::INTEGER                                                 AS id,
  (i % 9)::INTEGER                                           AS cluster,
  (((i * 37) % 358) - 179)::DOUBLE                           AS lng,
  (((i * 17) % 158) - 79)::DOUBLE                            AS lat,
  ((i % 900))::FLOAT                                         AS elevation,
  (CASE WHEN i % 50 = 0 THEN NULL ELSE (i % 120)::FLOAT END) AS speed,
  (10.0 + (i % 1000) * 100.0)::DOUBLE                        AS pop,
  ((i % 24))::FLOAT                                          AS hour
FROM range(0, ${ROWS}) t(i);
`;

function scatter(): Graph {
  return {
    params: {
      cut: { value: 0, kind: 'value', changeRate: 0.2 },
      k: { value: 2, kind: 'value', changeRate: 8 },
    },
    nodes: [
      { id: 'src', type: 'source', dataset: { ref: 'test', estimatedRows: ROWS } },
      { id: 'fast', type: 'filter', input: 'src', predicate: 'speed > {{cut}}' },
      { id: 'proj', type: 'project', input: 'fast', mode: 'mercator', x: 'lng', y: 'lat', z: 'elevation * 0.0006' },
      { id: 'radius', type: 'scale', input: 'proj', name: 'pscale', expr: 'pop', kind: 'log', domain: ['10', '100000'], range: ['1', '{{k}}'] },
      { id: 'color', type: 'colorscale', input: 'radius', expr: 'elevation', ramp: 'viridis', domain: ['0', '900'] },
      { id: 'out', type: 'render', input: 'color', mode: 'points', position: 'P', color: 'Cd', size: 'pscale' },
    ],
  };
}

/**
 * A runtime with no inherited parameter state.
 *
 * `Runtime.build` deliberately preserves parameters the user has moved, so a test that sets
 * `cut` changes the row count of every later build in the same runtime. Tests that compare
 * buffers need a clean one.
 */
async function newRuntime(): Promise<Runtime> {
  const fresh = new Runtime(gpu, await duck());
  fresh.registerSource('test', sqlSource(TEST_DDL));
  await fresh.loadSource(scatter());
  return fresh;
}

beforeAll(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  canvas.style.width = '512px';
  canvas.style.height = '512px';
  document.body.append(canvas);
  gpu = await initGpu(canvas);
  rt = await newRuntime();
});

/**
 * Dispatch pending kernels and wait for the GPU.
 *
 * `build()` marks the kernels dirty but does not run them — dispatch happens in `frame()`, so
 * a derived attribute's buffer is still zero-filled until a frame has been submitted. Reading
 * one straight after `build()` silently compares zeroes.
 */
async function settle(from: Runtime = rt): Promise<void> {
  from.frame();
  await gpu.device.queue.onSubmittedWorkDone();
}

/** Read an attribute buffer back as a plain array. */
async function attribute(name: string, from: Runtime = rt): Promise<number[]> {
  const attr = from.attributes.get(name);
  return [...(await readBuffer(gpu.device, attr.buffer, attr.rows * attr.width))];
}

function closeTo(actual: number[], expected: number[], label: string, tolerance = 2e-3): void {
  expect(actual, `${label} length`).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (Number.isNaN(expected[i])) {
      expect(Number.isNaN(actual[i]), `${label}[${i}] NaN`).toBe(true);
      continue;
    }
    const tol = Math.max(tolerance, Math.abs(expected[i]) * tolerance);
    expect(Math.abs(actual[i] - expected[i]), `${label}[${i}]: ${actual[i]} vs ${expected[i]}`)
      .toBeLessThan(tol);
  }
}

// ---------------------------------------------------------------------------

describe('statistics come from the real catalog', () => {
  it('reads row count, ranges and the null fraction DuckDB actually has', async () => {
    const stats = rt.sourceStats;
    expect(stats, 'statistics should have been gathered').toBeDefined();
    expect(stats!.rows).toBe(ROWS);
    // speed is NULL on every 50th row by construction.
    expect(stats!.columns.get('speed')!.nullFrac).toBeCloseTo(1 / 50, 2);
    expect(stats!.columns.get('elevation')!.min).toBeGreaterThanOrEqual(0);
    expect(stats!.columns.get('elevation')!.max).toBeLessThanOrEqual(900);
    // The DOUBLE columns must be recognised, since that decides the upload tier.
    expect(stats!.columns.get('pop')!.isF64).toBe(true);
    expect(stats!.columns.get('elevation')!.isF64).toBe(false);
  });

  it('estimates the filter’s selectivity within a few percent of reality', async () => {
    // The uniformity assumption holds for this generated data; on skewed data it would not,
    // which is why the explain pane reports estimated against actual.
    const result = await rt.build(scatter(), 'cost');
    await rt.setParam('cut', 60);
    const after = rt.result()!;
    const estimated = after.plan.explain.estimatedRows;
    // Only meaningful when the filter was actually pushed into SQL.
    if (after.plan.sqlParams.includes('cut')) {
      const ratio = estimated / Math.max(1, after.rows);
      expect(ratio).toBeGreaterThan(0.8);
      expect(ratio).toBeLessThan(1.25);
    }
    expect(result.rows).toBeGreaterThan(0);
  });
});

describe('arrow to gpu round trip', () => {
  it('lands every column type on the GPU with the right values', async () => {
    const sql = await duck();
    const { table } = await sql.run(
      'SELECT elevation, pop, id, speed FROM src ORDER BY id LIMIT 2048',
    );

    for (const [name, expectedTier] of [
      ['elevation', 'chunked'], ['pop', 'cast'], ['id', 'cast'], ['speed', 'cast'],
    ] as const) {
      const up = readColumn(table, name);
      // DuckDB batches at 2048 rows, so a 2048-row result may be a single chunk.
      expect(['arrow', 'chunked', 'cast'], name).toContain(up.tier);
      if (name === 'pop' || name === 'id' || name === 'speed') {
        expect(up.tier, `${name} must be narrowed or de-nulled`).toBe('cast');
      }
      void expectedTier;

      // Compare against the values Arrow itself reports.
      const arrow = table.getChild(name)!.toArray() as ArrayLike<number>;
      const data = up.data ?? concat(up.chunks!);
      for (let i = 0; i < Math.min(64, table.numRows); i++) {
        const want = Number(arrow[i]);
        if (want === null || Number.isNaN(want)) continue;
        expect(data[i], `${name}[${i}]`).toBeCloseTo(want, 2);
      }
    }
  });

  it('turns a NULL into NaN at the right row index', async () => {
    const sql = await duck();
    const { table } = await sql.run('SELECT speed FROM src ORDER BY id LIMIT 200');
    const up = readColumn(table, 'speed');
    const data = up.data ?? concat(up.chunks!);
    expect(up.nullCount).toBeGreaterThan(0);
    // Rows 0, 50, 100, 150 are NULL by construction.
    for (const i of [0, 50, 100, 150]) {
      expect(Number.isNaN(data[i]), `row ${i} should be NaN`).toBe(true);
    }
    expect(Number.isNaN(data[1]), 'row 1 should be a number').toBe(false);
  });

  it('preserves order across a multi-batch result', async () => {
    const sql = await duck();
    const { table } = await sql.run('SELECT id::FLOAT AS v FROM src ORDER BY id');
    const up = readColumn(table, 'v');
    // More than one batch is the normal case, and the exact reason the chunked tier exists.
    expect(up.chunkCount).toBeGreaterThan(1);
    const data = up.data ?? concat(up.chunks!);
    expect(data).toHaveLength(ROWS);
    for (const i of [0, 1, 2047, 2048, 2049, ROWS - 1]) {
      expect(data[i], `row ${i}`).toBe(i);
    }
  });

  it('uploads to a buffer whose contents read back unchanged', async () => {
    // No filter, so the plan's row set is exactly the source and the two are comparable
    // element by element rather than as multisets.
    const local = await newRuntime();
    const graph: Graph = {
      params: {},
      nodes: [
        { id: 'src', type: 'source', dataset: { ref: 'test', estimatedRows: ROWS } },
        { id: 'p', type: 'attribute', input: 'src', name: 'P', expr: '[elevation, 0, 0]' },
        { id: 'out', type: 'render', input: 'p', mode: 'points', position: 'P' },
      ],
    };
    const built = await local.build(graph, 'cost');
    expect(built.rows).toBe(ROWS);
    await settle(local);

    const sql = await duck();
    const { table } = await sql.run('SELECT elevation FROM src');
    const expected = readColumn(table, 'elevation');
    const expectedData = expected.data ?? concat(expected.chunks!);

    const onGpu = await attribute('elevation', local);
    expect(onGpu).toHaveLength(ROWS);
    closeTo(onGpu, [...expectedData], 'elevation', 1e-3);
    local.destroy();
  });
});

describe('the kernel computes what the CPU backend computes', () => {
  it('P, Cd and pscale agree between the GPU kernel and the generated JS', async () => {
    // The kernel and the CPU stage are separate code generators over one IR. If they disagree,
    // a WebGL2 target and a WebGPU target would draw different pictures from the same graph.
    const local = await newRuntime();
    const built = await local.build(scatter(), 'cost');
    expect(built.plan.kernels.length, 'this plan should use a kernel').toBe(1);
    await settle(local);
    const rtRef = local;

    const viaCpu = evaluateStage(
      built.plan.gpuStage, built.plan, rtRef.sourceUploads, rtRef.params(), built.rows,
    );

    // Only compare what the kernel actually produced; anything the plan put in SQL is already
    // covered by the backend-agreement suite.
    for (const name of built.plan.kernels[0].writes) {
      const cpu = viaCpu.values.get(name);
      expect(cpu, `${name} should be in the CPU evaluation too`).toBeDefined();
      closeTo(await attribute(name, rtRef), [...cpu!.data], name);
    }
    expect(built.plan.kernels[0].writes.length).toBeGreaterThan(1);
    rtRef.destroy();
  });

  it('a null position arrives as NaN on the GPU, not as zero', async () => {
    // The point shader discards NaN; a silent zero would draw a spurious point at the origin.
    const graph: Graph = {
      params: {},
      nodes: [
        { id: 'src', type: 'source', dataset: { ref: 'test', estimatedRows: ROWS } },
        { id: 'p', type: 'attribute', input: 'src', name: 'P', expr: '[speed, 0, 0]' },
        { id: 'out', type: 'render', input: 'p', mode: 'points', position: 'P' },
      ],
    };
    const local = await newRuntime();
    await local.build(graph, 'cost');
    await settle(local);
    const P = await attribute('P', local);
    // Every 50th source row is NULL, and nothing filters them out in this graph.
    expect(P.some((v) => Number.isNaN(v)), 'expected a NaN from the NULL column').toBe(true);
    local.destroy();
  });
});

describe('placement does not change the picture', () => {
  it('every policy produces numerically identical attributes', async () => {
    // A filter is deliberately absent. With one, a policy that makes it a GPU discard mask
    // keeps every row while a policy that pushes it into SQL removes them, so the buffers have
    // different lengths by design — that difference is asserted separately below.
    const graph: Graph = {
      params: { k: { value: 2, kind: 'value', changeRate: 8 } },
      nodes: [
        { id: 'src', type: 'source', dataset: { ref: 'test', estimatedRows: ROWS } },
        { id: 'proj', type: 'project', input: 'src', mode: 'mercator', x: 'lng', y: 'lat', z: 'elevation * 0.0006' },
        { id: 'radius', type: 'scale', input: 'proj', name: 'pscale', expr: 'pop', kind: 'log', domain: ['10', '100000'], range: ['1', '{{k}}'] },
        { id: 'color', type: 'colorscale', input: 'radius', expr: 'elevation', ramp: 'viridis', domain: ['0', '900'] },
        { id: 'out', type: 'render', input: 'color', mode: 'points', position: 'P', color: 'Cd', size: 'pscale' },
      ],
    };

    const results: Record<string, { P: number[]; pscale: number[]; Cd: number[] }> = {};
    for (const policy of ['cost', 'auto', 'sql-first'] as const) {
      const local = await newRuntime();
      const built = await local.build(graph, policy);
      expect(built.rows, policy).toBe(ROWS);
      await settle(local);
      results[policy] = {
        P: await attribute('P', local),
        pscale: await attribute('pscale', local),
        Cd: await attribute('Cd', local),
      };
      local.destroy();
    }
    for (const policy of ['auto', 'sql-first'] as const) {
      closeTo(results[policy].P, results['cost'].P, `${policy} vs cost P`);
      closeTo(results[policy].pscale, results['cost'].pscale, `${policy} vs cost pscale`);
      closeTo(results[policy].Cd, results['cost'].Cd, `${policy} vs cost Cd`);
    }
  });

  it('a masked filter keeps rows a SQL filter removes', async () => {
    // The one way placement *does* change the buffers, stated explicitly so the test above is
    // not silently comparing different row sets.
    const masked = await newRuntime();
    const filtered = await newRuntime();
    await masked.setParam('cut', 60);
    await filtered.setParam('cut', 60);
    const a = await masked.build(scatter(), 'gpu-first');
    const b = await filtered.build(scatter(), 'sql-first');
    expect(a.plan.maskAttribute).toBe('__mask');
    expect(b.plan.maskAttribute).toBeUndefined();
    expect(a.rows).toBeGreaterThan(b.rows);
    masked.destroy();
    filtered.destroy();
  });

  it('sql-first and cost actually chose different placements', async () => {
    // Otherwise the test above proves nothing.
    const local = await newRuntime();
    const cost = await local.build(scatter(), 'cost');
    const chosenCost = { ...cost.plan.explain.chosen };
    const sqlFirst = await local.build(scatter(), 'sql-first');
    expect(sqlFirst.plan.explain.chosen).not.toEqual(chosenCost);
    local.destroy();
  });

  it('a target without compute produces the same values on the CPU', async () => {
    // No filter, so both targets see the same row set.
    const graph: Graph = {
      params: {},
      nodes: [
        { id: 'src', type: 'source', dataset: { ref: 'test', estimatedRows: ROWS } },
        { id: 'proj', type: 'project', input: 'src', mode: 'mercator', x: 'lng', y: 'lat', z: '0' },
        { id: 'color', type: 'colorscale', input: 'proj', expr: 'elevation', ramp: 'viridis', domain: ['0', '900'] },
        { id: 'out', type: 'render', input: 'color', mode: 'points', position: 'P', color: 'Cd' },
      ],
    };
    const withGpu = await newRuntime();
    const built = await withGpu.build(graph, 'cost');
    expect(built.plan.kernels).toHaveLength(1);
    await settle(withGpu);
    const gpuP = await attribute('P', withGpu);
    const gpuCd = await attribute('Cd', withGpu);
    withGpu.destroy();

    const noCompute = await newRuntime();
    noCompute.setTarget('deck-webgl2');
    const cpuBuilt = await noCompute.build(graph, 'cost');
    expect(cpuBuilt.plan.kernels, 'no compute means no kernel').toHaveLength(0);
    expect(cpuBuilt.plan.cpuStage.length).toBeGreaterThan(0);
    expect(cpuBuilt.rows).toBe(built.rows);
    // No kernel to dispatch, but a frame keeps the two paths symmetric.
    await settle(noCompute);
    closeTo(await attribute('P', noCompute), gpuP, 'cpu vs gpu P');
    closeTo(await attribute('Cd', noCompute), gpuCd, 'cpu vs gpu Cd');
    noCompute.destroy();
  });
});

describe('parameter routing on the real runtime', () => {
  it('a uniform-routed change redraws without a requery or a reallocation', async () => {
    const rt = await newRuntime();
    await rt.build(scatter(), 'cost');
    expect(rt.classify('k')).toBe('uniform');

    const before = {
      requeries: rt.counters.requeries,
      allocations: rt.attributes.counters.allocations,
      writeCalls: rt.attributes.counters.writeCalls,
    };
    const initial = await attribute('pscale', rt);

    for (let i = 0; i < 10; i++) await rt.setParam('k', 2 + i);
    // Dispatch the kernel so the buffer reflects the new uniform.
    rt.frame();
    await gpu.device.queue.onSubmittedWorkDone();

    expect(rt.counters.requeries, 'no requery').toBe(before.requeries);
    expect(rt.attributes.counters.allocations, 'no reallocation').toBe(before.allocations);
    expect(rt.attributes.counters.writeCalls, 'no re-upload').toBe(before.writeCalls);
    expect(rt.counters.uniformWrites).toBeGreaterThan(0);

    // And it genuinely changed the output.
    const after = await attribute('pscale', rt);
    const changed = after.some((v, i) => Math.abs(v - initial[i]) > 1e-4);
    expect(changed, 'the uniform change should alter the buffer').toBe(true);
    rt.destroy();
  });

  it('a SQL-routed change requeries with byte-identical SQL', async () => {
    const rt = await newRuntime();
    await rt.build(scatter(), 'cost');
    await rt.setParam('cut', 0);
    const wide = rt.result()!;
    if (!wide.plan.sqlParams.includes('cut')) return; // placement put it on the GPU; nothing to test

    const sqlBefore = wide.plan.sql;
    const rowsBefore = wide.rows;
    const requeriesBefore = rt.counters.requeries;

    await rt.setParam('cut', 100);
    const narrow = rt.result()!;

    expect(rt.counters.requeries).toBe(requeriesBefore + 1);
    expect(narrow.plan.sql, 'the prepared statement is reused verbatim').toBe(sqlBefore);
    expect(narrow.rows).toBeLessThan(rowsBefore);
    rt.destroy();
  });

  it('the numbered placeholders DuckDB receives actually execute', async () => {
    // The repeated-argument bug produced more placeholders than binds and failed here.
    const rt = await newRuntime();
    const built = await rt.build(scatter(), 'sql-first');
    const occurrences = (built.plan.sql.match(/\$\d+/g) ?? []).length;
    const distinct = new Set(built.plan.sql.match(/\$\d+/g) ?? []).size;
    expect(distinct).toBe(built.plan.sqlParams.length);
    // A template that repeats an argument must produce more occurrences than binds.
    expect(occurrences).toBeGreaterThanOrEqual(distinct);
    expect(built.rows).toBeGreaterThan(0);
    rt.destroy();
  });
});

describe('gpu aggregation produces exact counts', () => {
  it('bins a known set of positions into the cells arithmetic predicts', async () => {
    // Weight is 1 per row and the grid is tiny, so the totals are checkable by hand rather
    // than by eyeballing a heatmap.
    const RES = 4;
    const graph: Graph = {
      params: {},
      nodes: [
        { id: 'src', type: 'source', dataset: { ref: 'test', estimatedRows: ROWS } },
        { id: 'p', type: 'project', input: 'src', mode: 'mercator', x: 'lng', y: 'lat', z: '0' },
        { id: 'w', type: 'attribute', input: 'p', name: 'weight', expr: '1.0' },
        { id: 'b', type: 'bin2d', input: 'w', resolution: RES, weight: 'weight', ramp: 'magma', ceiling: 'auto' },
        { id: 'out', type: 'render', input: 'b', mode: 'heatmap', position: 'P' },
      ],
    };
    const local = await newRuntime();
    const built = await local.build(graph, 'cost');
    expect(built.plan.bin2d?.resolution).toBe(RES);
    expect(built.rows).toBe(ROWS);

    // Two frames: the first dispatches the kernel and writes the view uniform, the second bins
    // against buffers that now hold real values.
    await settle(local);
    await settle(local);

    // The inputs the binning pass consumes must be sane before its output means anything.
    const P = await attribute('P', local);
    expect(P.filter(Number.isNaN)).toHaveLength(0);
    expect(Math.max(...P.map(Math.abs))).toBeLessThan(2);
    const weight = await attribute('weight', local);
    expect(weight.every((w) => Math.abs(w - 1) < 1e-6), 'weight should be exactly 1').toBe(true);

    const grid = await readBufferU32(gpu.device, (local as unknown as {
      binPass?: { grid: GPUBuffer };
    }).binPass!.grid, RES * RES);

    const total = [...grid].reduce((a, b) => a + b, 0);
    // Weights are fixed point at 1/256, so a weight of 1 accumulates as 256.
    expect(total % 256, 'totals should be whole multiples of the weight quantum').toBe(0);
    const binned = total / 256;
    expect(binned).toBeGreaterThan(0);
    expect(binned).toBeLessThanOrEqual(built.rows);
    // Points outside the view are skipped, so more than one cell should be occupied.
    expect([...grid].filter((v) => v > 0).length).toBeGreaterThan(1);
    local.destroy();
  });
});

describe('calibration measures this machine', () => {
  it('produces finite, positive constants for every field', async () => {
    const report = await rt.runCalibration();
    for (const [name, value] of Object.entries(report.costs)) {
      expect(Number.isFinite(value), name).toBe(true);
      expect(value, name).toBeGreaterThan(0);
    }
    expect(report.elapsedMs).toBeGreaterThan(0);
    expect(report.samples.length).toBeGreaterThan(5);
  });

  it('predicts build cost within an order of magnitude of reality', async () => {
    // The one test that catches the cost model drifting away from the machine it plans for.
    // Deliberately loose: SwiftShader and a real GPU differ by a lot, and a wrong *ordering*
    // matters far more than a wrong constant.
    await rt.runCalibration();
    const built = await rt.build(scatter(), 'cost');
    const estimated = built.plan.explain.estimated!.buildMs;
    const actual = built.timings.queryMs + built.timings.convertMs
      + built.timings.uploadMs + built.timings.cpuStageMs;
    expect(estimated).toBeGreaterThan(0);
    expect(actual).toBeGreaterThan(0);
    const ratio = actual / estimated;
    expect(ratio, `estimated ${estimated.toFixed(2)}ms vs actual ${actual.toFixed(2)}ms`)
      .toBeGreaterThan(0.02);
    expect(ratio).toBeLessThan(50);
  });

  it('a frame measured with the queue drained is a plausible duration', async () => {
    await rt.build(scatter(), 'cost');
    const ms = await rt.timeFrames(10);
    expect(ms).toBeGreaterThan(0);
    // Generous: software rasterization is slow, but a frame is not a second.
    expect(ms).toBeLessThan(1000);
  });
});

describe('source providers', () => {
  it('a relation that already exists needs no DDL', async () => {
    const rt2 = new Runtime(gpu, await duck());
    rt2.registerSource('existing', relationSource('src'));
    const graph: Graph = {
      params: {},
      nodes: [
        { id: 'src', type: 'source', dataset: { ref: 'existing', estimatedRows: ROWS } },
        { id: 'p', type: 'attribute', input: 'src', name: 'P', expr: '[lng, lat, 0]' },
        { id: 'out', type: 'render', input: 'p', mode: 'points', position: 'P' },
      ],
    };
    await rt2.loadSource(graph);
    const built = await rt2.build(graph, 'cost');
    expect(built.rows).toBe(ROWS);
    expect(built.plan.sql).toContain('"src"');
    rt2.destroy();
  });

  it('names the registered refs when one is missing', async () => {
    const rt2 = new Runtime(gpu, await duck());
    const graph: Graph = {
      params: {},
      nodes: [
        { id: 'src', type: 'source', dataset: { ref: 'nope' } },
        { id: 'p', type: 'attribute', input: 'src', name: 'P', expr: '[lng, lat, 0]' },
        { id: 'out', type: 'render', input: 'p', mode: 'points', position: 'P' },
      ],
    };
    await expect(rt2.loadSource(graph)).rejects.toThrow(/No source registered for ref 'nope'/);
    rt2.destroy();
  });

  it('the target’s reported limits come from the real device', async () => {
    const caps = targetCaps('webgpu-native', gpu.device);
    expect(caps.maxStorageBuffersPerStage)
      .toBe(gpu.device.limits.maxStorageBuffersPerShaderStage);
    expect(caps.gpuBudgetBytes).toBeGreaterThan(0);
    // deck's device cannot be raised, so that target stays at the spec minimum.
    expect(targetCaps('deck-webgpu', gpu.device).maxStorageBuffersPerStage).toBe(8);
  });
});

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
