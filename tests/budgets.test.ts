import { describe, it, expect } from 'vitest';
import { plan } from '../src/core/planner.js';
import { analyze } from '../src/core/analyze.js';
import { optimize } from '../src/core/optimizer.js';
import { DEFAULT_COSTS } from '../src/core/cost.js';
import { targetCaps } from '../src/core/target.js';
import { evaluateStage } from '../src/core/cpu-stage.js';
import { readColumn } from '../src/core/arrow.js';
import { parseExpr } from '../src/core/expr.js';
import { toWgsl } from '../src/core/backends/wgsl.js';
import { tableFromArrays, Table } from 'apache-arrow';
import {
  SCHEMA, STATS, scatterGraph, wrangleGraph, heatmapGraph, sourceUploads,
} from './fixtures.js';

/**
 * Performance *assertions*, as opposed to the benchmarks in `*.bench.ts` which only report.
 *
 * Two deliberately different kinds:
 *
 *   Structural — properties that are true or false regardless of machine speed. These are the
 *   valuable ones: "the chunked upload path performs no element-wise JS work" is the actual
 *   architectural claim, and it cannot be flaky.
 *
 *   Wall-clock — order-of-magnitude guards with generous ceilings, so a busy or throttled
 *   machine does not turn the suite red. They exist to catch a 100x regression, not a 20%
 *   one; the benchmark output is where small changes should be read.
 */

const caps = { ...targetCaps('webgpu-native', undefined), maxStorageBuffersPerStage: 10 };
const planOpts = { policy: 'cost' as const, stats: STATS, caps, params: { cut: 60, k: 1.6, exag: 0.4 } };

/** Best of N, so one unlucky GC pause cannot fail a build. */
function bestOf(reps: number, body: () => void): number {
  body();
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const started = performance.now();
    body();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Structural: no timing involved
// ---------------------------------------------------------------------------

describe('structural: the upload tiers do what they claim', () => {
  const ROWS = 50_000;

  it('a single-chunk f32 column is handed over with no conversion and no copy', () => {
    const table = tableFromArrays({ a: Float32Array.from({ length: ROWS }, (_, i) => i) });
    const up = readColumn(table, 'a');
    expect(up.tier).toBe('arrow');
    expect(up.convertMs).toBe(0);
    // Aliases the column's own memory rather than duplicating it.
    expect(up.data!.buffer).toBe((table.getChild('a')!.data[0].values as Float32Array).buffer);
  });

  it('a multi-chunk f32 column performs no element-wise JS work', () => {
    // This is the claim that matters: DuckDB always returns many batches, and the alternative
    // to this path is a JS loop over every row of every column.
    const batches = Array.from({ length: 25 }, (_, b) =>
      tableFromArrays({ a: Float32Array.from({ length: ROWS / 25 }, (_, i) => b * 2000 + i) }).batches[0]);
    const up = readColumn(new Table(batches), 'a');
    expect(up.tier).toBe('chunked');
    expect(up.convertMs).toBe(0);
    expect(up.data).toBeUndefined();
    expect(up.chunks).toHaveLength(25);
  });

  it('only f64, integer and nullable columns take the cast path', () => {
    const f64 = tableFromArrays({ a: Float64Array.from({ length: 100 }, (_, i) => i) });
    const i32 = tableFromArrays({ a: Int32Array.from({ length: 100 }, (_, i) => i) });
    expect(readColumn(f64, 'a').tier).toBe('cast');
    expect(readColumn(i32, 'a').tier).toBe('cast');
  });
});

describe('structural: projection pushdown selects nothing unnecessary', () => {
  it('omits every column no downstream node reads', () => {
    const p = plan(scatterGraph(), SCHEMA, planOpts);
    // The synthetic source has 8 columns; this graph reads 4.
    for (const unread of ['id', 'cluster', 'hour']) {
      expect(p.sql, unread).not.toContain(`"${unread}"`);
    }
    const selected = p.attributes.filter((a) => a.provenance === 'arrow');
    expect(selected.length).toBeLessThan(SCHEMA.size);
  });

  it('the heatmap graph selects only what binning needs', () => {
    const p = plan(heatmapGraph(), SCHEMA, { ...planOpts, params: { cut: 0 } });
    expect(p.sql).not.toContain('"hour"');
    expect(p.sql).not.toContain('"id"');
  });
});

describe('structural: a fused kernel is one dispatch, not one per node', () => {
  it('the scatter graph compiles to a single kernel', () => {
    const p = plan(scatterGraph(), SCHEMA, planOpts);
    expect(p.kernels).toHaveLength(1);
    expect(p.kernels[0].nodeIds.length).toBeGreaterThan(1);
  });

  it('a four-statement wrangle is still a single kernel', () => {
    const p = plan(wrangleGraph(), SCHEMA, planOpts);
    expect(p.kernels).toHaveLength(1);
    expect(p.kernels[0].nodeIds).toHaveLength(4);
  });

  it('a wrangle local consumes no buffer and no binding slot', () => {
    const p = plan(wrangleGraph(), SCHEMA, planOpts);
    const internal = p.attributes.filter((a) => a.internal);
    expect(internal).toHaveLength(0);
    // Only the three render channels are written.
    expect(p.kernels[0].writes.sort()).toEqual(['Cd', 'P', 'pscale']);
  });
});

describe('structural: a value parameter does not force a requery', () => {
  it('a kernel-only parameter is a uniform, never a SQL bind', () => {
    // The whole reparameterization claim in one assertion.
    const p = plan(scatterGraph(), SCHEMA, planOpts);
    expect(p.uniformParams).toContain('k');
    expect(p.sqlParams).not.toContain('k');
  });

  it('placement is stable while a uniform-routed parameter moves', () => {
    // If the chosen plan changed as `k` moved, every slider drag would recompile.
    const base = plan(scatterGraph(), SCHEMA, planOpts);
    for (const k of [0.5, 2, 8, 12]) {
      const p = plan(scatterGraph(), SCHEMA, { ...planOpts, params: { ...planOpts.params, k } });
      expect(p.explain.chosen, `k=${k}`).toEqual(base.explain.chosen);
      expect(p.sql, `k=${k}`).toBe(base.sql);
    }
  });
});

describe('structural: the optimizer explores the whole space', () => {
  it('enumerates every boundary pair', () => {
    const analysis = analyze(scatterGraph(), SCHEMA);
    const result = optimize(analysis, {
      costs: DEFAULT_COSTS, caps, stats: STATS, params: planOpts.params, policy: 'cost',
    });
    const n = analysis.order.length;
    expect(result.candidates).toHaveLength(((n + 1) * (n + 2)) / 2);
  });

  it('chooses a minimum, not merely a legal plan', () => {
    const analysis = analyze(scatterGraph(), SCHEMA);
    const result = optimize(analysis, {
      costs: DEFAULT_COSTS, caps, stats: STATS, params: planOpts.params, policy: 'cost',
    });
    const legal = result.candidates.filter((c) => c.legal);
    const chosen = legal.find(
      (c) => c.assignment.sqlEnd === result.chosen.sqlEnd && c.assignment.cpuEnd === result.chosen.cpuEnd,
    )!;
    for (const other of legal) {
      expect(chosen.cost!.totalMs).toBeLessThanOrEqual(other.cost!.totalMs + 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// Wall-clock: generous, order-of-magnitude guards
// ---------------------------------------------------------------------------

describe('wall-clock guards', () => {
  it('parsing and compiling one expression stays under a millisecond', () => {
    const src = '[lng / 360.0, ln(tan(0.7853981634 + lat * 0.008726646259971648)) / 6.283185307, elevation * {{exag}} * 0.0006]';
    const resolver = (n: string) => ({ code: `b_${n}[i]`, width: 1 });
    const ms = bestOf(200, () => {
      toWgsl(parseExpr(src), resolver);
    });
    expect(ms).toBeLessThan(1);
  });

  it('planning a graph stays well inside an interaction budget', () => {
    // Planning runs on every rebuild and every structural parameter change, so it is on the
    // interactive path. Measured around 0.1 ms; 25 ms is a 250x guard.
    const graph = scatterGraph();
    const ms = bestOf(50, () => {
      plan(graph, SCHEMA, planOpts);
    });
    expect(ms).toBeLessThan(25);
  });

  it('planning every example graph stays inside the same budget', () => {
    for (const [name, graph] of [
      ['scatter', scatterGraph()], ['wrangle', wrangleGraph()], ['heatmap', heatmapGraph()],
    ] as const) {
      const ms = bestOf(20, () => {
        plan(graph, SCHEMA, { ...planOpts, params: { ...planOpts.params, cut: 0 } });
      });
      expect(ms, name).toBeLessThan(25);
    }
  });

  it('the cpu stage keeps up at 100k rows', () => {
    // The fallback path for a target without compute. Measured around 4 ms; 400 ms is a 100x
    // guard that still catches an accidental O(n^2).
    const ROWS = 100_000;
    const cpuPlan = plan(scatterGraph(), SCHEMA, {
      ...planOpts, caps: targetCaps('deck-webgl2', undefined), policy: 'auto',
    });
    const uploads = sourceUploads(ROWS);
    const params = { ...planOpts.params, popStats_min: 10, popStats_max: 1e6 };
    const ms = bestOf(3, () => {
      evaluateStage(cpuPlan.cpuStage, cpuPlan, uploads, params, ROWS);
    });
    expect(ms).toBeLessThan(400);
  });

  it('the cpu stage scales roughly linearly, not quadratically', () => {
    // A superlinear jump here would mean the generated loop is doing per-row allocation.
    const cpuPlan = plan(scatterGraph(), SCHEMA, {
      ...planOpts, caps: targetCaps('deck-webgl2', undefined), policy: 'auto',
    });
    const params = { ...planOpts.params, popStats_min: 10, popStats_max: 1e6 };
    const time = (rows: number) => {
      const uploads = sourceUploads(rows);
      return bestOf(3, () => evaluateStage(cpuPlan.cpuStage, cpuPlan, uploads, params, rows));
    };
    const small = Math.max(time(25_000), 0.05);
    const large = time(200_000);
    // 8x the rows must cost well under 32x the time.
    expect(large / small).toBeLessThan(32);
  });

  it('reading a chunked column beats casting an f64 one', () => {
    // The ordering is the architectural claim; the ratio is machine-dependent and only the
    // direction is asserted. Measured around 27x on this machine.
    const ROWS = 200_000;
    const chunks = Array.from({ length: 100 }, (_, b) =>
      tableFromArrays({ a: Float32Array.from({ length: ROWS / 100 }, (_, i) => b + i) }).batches[0]);
    const chunked = new Table(chunks);
    const f64 = tableFromArrays({ a: Float64Array.from({ length: ROWS }, (_, i) => i) });

    const chunkedMs = bestOf(10, () => { readColumn(chunked, 'a'); });
    const castMs = bestOf(10, () => { readColumn(f64, 'a'); });
    expect(chunkedMs).toBeLessThan(castMs);
  });
});
