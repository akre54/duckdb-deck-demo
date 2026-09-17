import { bench, describe } from 'vitest';
import { parseExpr, toSql, toWgsl, toJs, analyze, optimize, plan, DEFAULT_COSTS, estimateSelectivity, targetCaps, buildRampLut, evaluateStage, readColumn } from '@noodles.gl/planner';
import { tableFromArrays, Table } from 'apache-arrow';
import { SCHEMA, STATS, scatterGraph, wrangleGraph, sourceUploads } from '@noodles.gl/planner/fixtures';

/**
 * Throughput, reported not asserted — budgets live in `budgets.test.ts` so a slow machine
 * cannot turn the suite red while still showing the numbers here.
 *
 * What is worth watching: planning happens on every rebuild and on every structural parameter
 * change, so it sits on the interactive path. Expression compilation happens once per node per
 * plan. The CPU stage and the Arrow tiers scale with row count and are the numbers the cost
 * model's constants are meant to predict.
 */

const caps = { ...targetCaps('webgpu-native', undefined), maxStorageBuffersPerStage: 10 };
const planOpts = { policy: 'cost' as const, stats: STATS, caps, params: { cut: 60, k: 2 } };

const EXPRESSIONS = [
  'pop',
  'sqrt(pop) * 2',
  'clamp(fit(ln(pop), 2.3, 13.9, 0.0, 1.0), 0.0, 1.0)',
  '[lng / 360.0, ln(tan(0.7853981634 + lat * 0.008726646259971648)) / 6.283185307, elevation * 0.0006]',
];

describe('expression compilation', () => {
  for (const src of EXPRESSIONS) {
    const label = src.length > 40 ? `${src.slice(0, 37)}...` : src;
    bench(`parse ${label}`, () => {
      parseExpr(src);
    });
  }

  const parsed = EXPRESSIONS.map((s) => parseExpr(s));
  const wgslResolver = (n: string) => ({ code: `b_${n}[i]`, width: n === 'P' ? 3 : 1 });
  const jsResolver = () => ({ width: 1, component: () => 'x' });

  bench('compile all to SQL', () => {
    for (const e of parsed) {
      try { toSql(e); } catch { /* not every fixture is SQL-expressible */ }
    }
  });

  bench('compile all to WGSL', () => {
    for (const e of parsed) toWgsl(e, wgslResolver);
  });

  bench('compile all to JS', () => {
    for (const e of parsed) toJs(e, jsResolver);
  });
});

describe('planning', () => {
  const scatter = scatterGraph();
  const wrangle = wrangleGraph();

  bench('analyze scatter', () => {
    analyze(scatter, SCHEMA);
  });

  const analysis = analyze(scatter, SCHEMA);
  bench('optimize scatter (all candidates)', () => {
    optimize(analysis, { costs: DEFAULT_COSTS, caps, stats: STATS, params: { cut: 60, k: 2 }, policy: 'cost' });
  });

  bench('plan scatter end to end', () => {
    plan(scatter, SCHEMA, planOpts);
  });

  bench('plan wrangle end to end', () => {
    plan(wrangle, SCHEMA, planOpts);
  });

  // The rule-based path skips candidate enumeration entirely; worth seeing the difference.
  bench('plan scatter with the auto policy', () => {
    plan(scatter, SCHEMA, { ...planOpts, policy: 'auto' });
  });
});

describe('statistics', () => {
  const predicate = parseExpr('speed > {{cut}}');
  const compound = parseExpr('speed > {{cut}} && pop < 500000 && elevation > 10');

  bench('estimate one predicate', () => {
    estimateSelectivity(predicate, STATS, { cut: 60 });
  });

  bench('estimate a three-way conjunction', () => {
    estimateSelectivity(compound, STATS, { cut: 60 });
  });
});

describe('cpu stage throughput', () => {
  const ROWS = 100_000;
  const cpuCaps = targetCaps('deck-webgl2', undefined);
  const cpuPlan = plan(scatterGraph(), SCHEMA, {
    policy: 'auto', stats: STATS, caps: cpuCaps, params: { cut: 60, k: 2 },
  });
  const uploads = sourceUploads(ROWS);

  bench(`evaluate the cpu stage over ${ROWS.toLocaleString()} rows`, () => {
    evaluateStage(cpuPlan.cpuStage, cpuPlan, uploads, { cut: 60, k: 2, popStats_min: 10, popStats_max: 1e6 }, ROWS);
  });
});

describe('arrow upload tiers', () => {
  const ROWS = 200_000;
  const f32 = tableFromArrays({ a: Float32Array.from({ length: ROWS }, (_, i) => i) });
  const f64 = tableFromArrays({ a: Float64Array.from({ length: ROWS }, (_, i) => i) });
  const batches = Array.from({ length: 100 }, (_, b) =>
    tableFromArrays({ a: Float32Array.from({ length: ROWS / 100 }, (_, i) => b * 2000 + i) }).batches[0]);
  const multi = new Table(batches);

  // The interesting comparison: 'chunked' does zero element-wise JS, 'cast' does one pass.
  bench('single-chunk f32 (arrow tier, no copy)', () => {
    readColumn(f32, 'a');
  });

  bench('multi-chunk f32 (chunked tier, no element loop)', () => {
    readColumn(multi, 'a');
  });

  bench('f64 (cast tier, one narrowing pass)', () => {
    readColumn(f64, 'a');
  });
});

describe('ramp lut', () => {
  bench('build a 256-entry viridis lut', () => {
    buildRampLut('viridis');
  });
});
