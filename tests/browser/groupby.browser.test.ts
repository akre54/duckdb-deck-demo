import { describe, it, expect, beforeAll } from 'vitest';
import { commands } from '@vitest/browser/context';
import { parseExpr } from '@noodles.gl/planner';
import { LumaGroupBy } from '../../src/luma/index.js';
import { duck, gpuDevice, expectNoGpuError, readBufferU32 } from './harness.js';

/**
 * One linked histogram, four engines: `SELECT bin, count(*), avg(v) WHERE v > {{cut}} GROUP BY bin`.
 *
 * This is the crossfilter case: a brush on one view (`cut`) re-aggregates another view's bins.
 * The filter race (`engines.browser.test.ts`) showed luma winning where rows are removed; this
 * asks whether the same holds when the output is a handful of aggregates rather than points.
 *
 *   duckdb          prepared statement, `$1` rebind, result scattered into dense CPU arrays
 *   luma            luma's dense group-by over GPU buffers; the result stays on the GPU, which
 *                   is all a GPU-drawn histogram needs
 *   luma+readback   the same, then one mapAsync of both outputs — what an SVG/DOM chart needs
 *   luma count-only `count(*)` alone, GPU-resident. Counts accumulate in workgroup memory and
 *                   float sums do not, so the gap between this and `luma` is the CAS loop's cost
 *   js              a CPU loop over typed arrays, crossfilter-style
 *
 * The bin is computed once by DuckDB at load (`floor(...)::UINTEGER`). luma's group-by takes
 * only dense u32 keys so that it never sizes an output on the CPU; making the key dense is a
 * load-time job, not a per-tick one.
 *
 * Two bin counts, because luma accumulates float sums with a global compare-and-swap loop:
 * 16 bins puts every row of a 4M table on 16 contended words, 1024 spreads them out.
 *
 * Every engine's counts must equal a CPU reference exactly, and its means must agree to 1e-3
 * relative. The max error and whether luma repeats itself bit-for-bit are reported, since an
 * order-dependent float sum is a visible wobble in a tooltip.
 *
 * `npm run test:gpu` runs a small correctness pass. `npm run perf:gpu` runs the sweep and
 * writes `tests/browser/__perf__/groupby.json`.
 */

const PERF = import.meta.env.VITE_PERF === '1';
const SIZES = PERF ? [100_000, 1_000_000, 4_000_000] : [20_000];
const BINS = PERF ? [16, 1024] : [16];
const SELECTIVITIES = PERF ? [0.5, 0.05] : [0.5];
const REPS = PERF ? 9 : 3;
const MEAN_TOLERANCE = 1e-3;

type Engine = 'duckdb' | 'luma' | 'luma+readback' | 'luma count-only' | 'js';

interface Row {
  engine: Engine;
  rows: number;
  bins: number;
  selectivity: number;
  buildMs: number;
  updateMs: number;
  /** Largest relative error of any bin's mean against the f64 CPU reference. */
  meanError: number;
  note?: string;
}

/** A dense histogram: count and mean per bin. Empty bins have count 0 and an unread mean. */
interface Bins {
  n: Uint32Array;
  m: Float64Array | Float32Array;
}

let device: GPUDevice;
let adapter: GPUAdapter;
const results: Row[] = [];

beforeAll(async () => {
  device = await gpuDevice();
  // luma's device wrapper wants an adapter for its info; any adapter of this device will do.
  adapter = (await navigator.gpu.requestAdapter())!;
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Thresholds that alternate by 2^-10, so every rep is a real change of the same size. Both
 * values are exact in f32: luma compares in f32 and DuckDB in f64, and a cut that rounds
 * differently in the two would move a boundary row between engines.
 */
function cuts(selectivity: number): number[] {
  const base = 100 * (1 - selectivity);
  return Array.from({ length: REPS + 1 }, (_, i) => base + (i % 2) / 1024);
}

interface Source {
  rows: number;
  bins: number;
  bin: Uint32Array;
  v: Float32Array;
  binBuffer: GPUBuffer;
  vBuffer: GPUBuffer;
}

async function makeSource(rows: number, bins: number): Promise<Source> {
  const sql = await duck();
  await sql.resetPrepared();
  await sql.exec(`
SELECT setseed(0.42);
CREATE OR REPLACE TABLE grp AS
SELECT least(floor(random() * ${bins}), ${bins - 1})::UINTEGER AS bin, (random() * 100)::FLOAT AS v
FROM range(0, ${rows}) t(i);
`);
  const { table } = await sql.run('SELECT bin, v FROM grp');
  const bin = table.getChild('bin')!.toArray() as Uint32Array;
  const v = table.getChild('v')!.toArray() as Float32Array;
  const upload = (label: string, data: Uint32Array | Float32Array) => {
    const buffer = device.createBuffer({
      label, size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data as unknown as GPUAllowSharedBufferSource);
    return buffer;
  };
  return { rows, bins, bin, v, binBuffer: upload('grp:bin', bin), vBuffer: upload('grp:v', v) };
}

function destroySource(src: Source): void {
  src.binBuffer.destroy();
  src.vBuffer.destroy();
}

/** The f64 reference every engine is checked against, and also the `js` engine. */
function cpuBins(src: Source, cut: number): Bins {
  const n = new Uint32Array(src.bins);
  const s = new Float64Array(src.bins);
  for (let i = 0; i < src.rows; i++) {
    if (src.v[i] > cut) {
      n[src.bin[i]]++;
      s[src.bin[i]] += src.v[i];
    }
  }
  for (let b = 0; b < src.bins; b++) s[b] = n[b] ? s[b] / n[b] : 0;
  return { n, m: s };
}

/** Counts exactly, means to tolerance; returns the max relative mean error. */
function check(engine: Engine, got: Bins, want: Bins): number {
  expect(Array.from(got.n), `${engine} counts`).toEqual(Array.from(want.n));
  let worst = 0;
  for (let b = 0; b < want.n.length; b++) {
    if (!want.n[b]) continue;
    worst = Math.max(worst, Math.abs(got.m[b] - want.m[b]) / Math.abs(want.m[b]));
  }
  expect(worst, `${engine} mean error`).toBeLessThan(MEAN_TOLERANCE);
  return worst;
}

// ---------------------------------------------------------------------------

async function runDuckDb(src: Source, selectivity: number): Promise<Row> {
  const cs = cuts(selectivity);
  const sql = await duck();
  await sql.resetPrepared();
  const query = 'SELECT bin, count(*)::UINTEGER AS n, avg(v)::DOUBLE AS m FROM grp WHERE v > $1 GROUP BY bin';
  const dense = async (cut: number): Promise<Bins> => {
    const { table } = await sql.run(query, [cut]);
    const bin = table.getChild('bin')!.toArray() as Uint32Array;
    const n = table.getChild('n')!.toArray() as Uint32Array;
    const m = table.getChild('m')!.toArray() as Float64Array;
    // GROUP BY returns only non-empty bins, in no particular order; a chart wants them dense.
    const out: Bins = { n: new Uint32Array(src.bins), m: new Float64Array(src.bins) };
    for (let i = 0; i < bin.length; i++) {
      out.n[bin[i]] = n[i];
      out.m[bin[i]] = m[i];
    }
    return out;
  };

  const t0 = performance.now();
  const first = await dense(cs[0]);
  const buildMs = performance.now() - t0;
  let meanError = check('duckdb', first, cpuBins(src, cs[0]));

  const updates: number[] = [];
  let last = first;
  for (const cut of cs.slice(1)) {
    const s = performance.now();
    last = await dense(cut);
    updates.push(performance.now() - s);
  }
  meanError = Math.max(meanError, check('duckdb', last, cpuBins(src, cs[cs.length - 1])));
  return { engine: 'duckdb', rows: src.rows, bins: src.bins, selectivity, buildMs, updateMs: median(updates), meanError };
}

/** Copy both outputs into one staging buffer and map it once: the cheapest honest readback. */
async function readBins(group: LumaGroupBy): Promise<Bins> {
  const bytes = group.groupCount * 4;
  const staging = device.createBuffer({ size: bytes * 2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: 'groupby:readback' });
  encoder.copyBufferToBuffer(group.output('n'), 0, staging, 0, bytes);
  encoder.copyBufferToBuffer(group.output('m'), 0, staging, bytes, bytes);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return { n: new Uint32Array(copy, 0, group.groupCount), m: new Float32Array(copy, bytes, group.groupCount) };
}

async function runLuma(src: Source, selectivity: number): Promise<Row[]> {
  const cs = cuts(selectivity);
  const t0 = performance.now();
  let group!: LumaGroupBy;
  await expectNoGpuError(device, async () => {
    group = new LumaGroupBy({
      device, adapter,
      key: { name: 'bin', buffer: src.binBuffer },
      groupCount: src.bins,
      columns: { v: src.vBuffer },
      rows: src.rows,
      aggregates: { n: 'count', m: { mean: 'v' } },
      predicate: parseExpr('v > {{cut}}'),
      params: { cut: cs[0] },
    });
    group.run({ cut: cs[0] });
    await device.queue.onSubmittedWorkDone();
  });
  const buildMs = performance.now() - t0;

  const first = await readBins(group);
  let meanError = check('luma', first, cpuBins(src, cs[0]));

  // Same parameters again: does the float sum come back bit-identical?
  group.run({ cut: cs[0] });
  const again = await readBins(group);
  const deterministic = first.m.every((x, b) => !first.n[b] || Object.is(x, again.m[b]));

  // GPU-resident: a brush tick to a drained queue. A GPU-drawn histogram reads `n` in place.
  const resident: number[] = [];
  for (const cut of cs.slice(1)) {
    const s = performance.now();
    group.run({ cut });
    await device.queue.onSubmittedWorkDone();
    resident.push(performance.now() - s);
  }

  // DOM-bound: the same tick, plus getting the numbers into JS.
  const readback: number[] = [];
  let last = first;
  for (const cut of cs.slice(1)) {
    const s = performance.now();
    group.run({ cut });
    last = await readBins(group);
    readback.push(performance.now() - s);
  }
  meanError = Math.max(meanError, check('luma+readback', last, cpuBins(src, cs[cs.length - 1])));
  group.destroy();

  const note = deterministic ? 'means repeat bit-for-bit' : 'means differ run to run';
  const base = { rows: src.rows, bins: src.bins, selectivity, buildMs, meanError, note };
  return [
    { engine: 'luma', ...base, updateMs: median(resident) },
    { engine: 'luma+readback', ...base, updateMs: median(readback) },
  ];
}

/** `count(*)` alone: isolates the float-sum accumulation from the rest of the graph. */
async function runLumaCountOnly(src: Source, selectivity: number): Promise<Row> {
  const cs = cuts(selectivity);
  const t0 = performance.now();
  const group = new LumaGroupBy({
    device, adapter,
    key: { name: 'bin', buffer: src.binBuffer },
    groupCount: src.bins,
    columns: { v: src.vBuffer },
    rows: src.rows,
    aggregates: { n: 'count' },
    predicate: parseExpr('v > {{cut}}'),
    params: { cut: cs[0] },
  });
  group.run({ cut: cs[0] });
  await device.queue.onSubmittedWorkDone();
  const buildMs = performance.now() - t0;
  const want = cpuBins(src, cs[0]).n;
  expect(Array.from(await readBufferU32(device, group.output('n'), src.bins)), 'luma count-only counts').toEqual(Array.from(want));

  const updates: number[] = [];
  for (const cut of cs.slice(1)) {
    const s = performance.now();
    group.run({ cut });
    await device.queue.onSubmittedWorkDone();
    updates.push(performance.now() - s);
  }
  group.destroy();
  return { engine: 'luma count-only', rows: src.rows, bins: src.bins, selectivity, buildMs, updateMs: median(updates), meanError: NaN };
}

async function runJs(src: Source, selectivity: number): Promise<Row> {
  const cs = cuts(selectivity);
  const t0 = performance.now();
  const first = cpuBins(src, cs[0]);
  const buildMs = performance.now() - t0;
  const updates: number[] = [];
  for (const cut of cs.slice(1)) {
    const s = performance.now();
    cpuBins(src, cut);
    updates.push(performance.now() - s);
  }
  // `js` is the reference, so it has no error to report against itself.
  expect(first.n.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  return { engine: 'js', rows: src.rows, bins: src.bins, selectivity, buildMs, updateMs: median(updates), meanError: 0, note: 'f64 reference' };
}

// ---------------------------------------------------------------------------

describe('group-by engines agree, then race', () => {
  for (const rows of SIZES) {
    for (const bins of BINS) {
      describe(`${rows.toLocaleString()} rows, ${bins} bins`, () => {
        let src: Source;
        beforeAll(async () => {
          src = await makeSource(rows, bins);
        });
        for (const s of SELECTIVITIES) {
          it(`selectivity ${s}`, async () => {
            results.push(await runDuckDb(src, s));
            results.push(...await runLuma(src, s));
            results.push(await runLumaCountOnly(src, s));
            results.push(await runJs(src, s));
          });
        }
        it('releases its buffers', () => destroySource(src));
      });
    }
  }

  it('reports', async () => {
    const fmt = (n: number) => (Number.isNaN(n) ? '—' : n < 10 ? n.toFixed(2) : n.toFixed(1));
    const lines = [
      '| rows | bins | sel | engine | build ms | update ms | max mean rel err | note |',
      '|---:|---:|---:|---|---:|---:|---:|---|',
      ...results.map((r) =>
        `| ${r.rows.toLocaleString()} | ${r.bins} | ${r.selectivity} | ${r.engine} | ${fmt(r.buildMs)} | ${fmt(r.updateMs)} | ${Number.isNaN(r.meanError) ? '—' : r.meanError.toExponential(1)} | ${r.note ?? ''} |`),
    ];
    console.log(`\n${lines.join('\n')}\n`);
    if (PERF) {
      const info = adapter.info;
      await commands.writeFile('./__perf__/groupby.json', JSON.stringify({
        date: new Date().toISOString(),
        adapter: { vendor: info.vendor, architecture: info.architecture, description: info.description },
        results,
      }, null, 2));
      await commands.writeFile('./__perf__/groupby.md', `${lines.join('\n')}\n`);
    }
    expect(results.length).toBeGreaterThan(0);
  });
});
