import { describe, it, expect, beforeAll } from 'vitest';
import { commands } from '@vitest/browser/context';
import { parseExpr, compactable, relationSource, type Graph, type Policy } from '@noodles.gl/planner';
import { initGpu, type Gpu } from '../../src/webgpu/device.js';
import { Runtime } from '../../src/webgpu/runtime.js';
import { AttributeSet } from '../../src/webgpu/attributes.js';
import { OrbitCamera, VIEW_UNIFORM_SIZE } from '../../src/webgpu/camera.js';
import { PointsPass } from '../../src/webgpu/passes/points.js';
import { LumaFilter, lumaCompactor, toLumaExpr, type LumaTopology } from '../../src/luma/index.js';
import { duck, readBufferU32, expectNoGpuError } from './harness.js';

/**
 * One filter, five engines, measured on the same device over the same DuckDB table.
 *
 * The workload is the one FINDINGS §4 argues about: `v > {{cut}}` feeding a point layer, with
 * `cut` a slider. What differs is where the filter runs and what it leaves behind.
 *
 *   sql        our planner, sql-first: requery DuckDB, re-upload survivors, draw K rows
 *   gpu-mask   our planner, gpu-first: uniform write + kernel, draw all N with a discard mask
 *   cost       our planner, cost-based: whichever of the two it prices lower
 *   cost+luma  our planner, cost-based, with luma as its compaction engine (TargetCaps.compaction)
 *   luma       luma GPU Dataframe over our buffers: compact ids on the GPU, drawIndirect K
 *   js         a CPU loop that compacts and re-uploads, which is what deck's path amounts to
 *
 * Two numbers per engine. `update` is a slider tick to pixels: parameter change, whatever
 * work it triggers, one frame, queue drained. `frame` is the steady state afterwards: 30
 * frames drained, no change — which is where a discard mask pays for the rows it kept.
 *
 * Every engine's selected count is checked against a CPU count first. A fast wrong answer
 * is not a data point.
 *
 * `npm run test:gpu` runs a small correctness pass. `npm run perf:gpu` runs the sweep and
 * writes `tests/browser/__perf__/engines.json`.
 */

const PERF = import.meta.env.VITE_PERF === '1';
const SIZES = PERF ? [100_000, 1_000_000, 4_000_000] : [20_000];
const SELECTIVITIES = PERF ? [0.9, 0.5, 0.05] : [0.5];
const REPS = PERF ? 9 : 3;
const FRAMES = PERF ? 30 : 5;
/** DuckDB-Wasm's record batch size, for the batched luma topology. */
const DUCK_BATCH = 2048;

type Engine = 'sql' | 'gpu-mask' | 'cost' | 'cost+luma' | 'luma' | 'luma-batched' | 'js';

interface Row {
  engine: Engine;
  rows: number;
  selectivity: number;
  /** Instances the draw call processed. */
  drawn: number;
  buildMs: number;
  updateMs: number;
  frameMs: number;
  /** Filter work alone, where the engine can separate it from drawing. */
  filterMs?: number;
  note?: string;
}

let gpu: Gpu;
let camera: OrbitCamera;
let viewBuffer: GPUBuffer;
const results: Row[] = [];

beforeAll(async () => {
  const canvas = document.createElement('canvas');
  canvas.style.width = '1024px';
  canvas.style.height = '768px';
  document.body.append(canvas);
  gpu = await initGpu(canvas);
  camera = new OrbitCamera();
  viewBuffer = gpu.device.createBuffer({
    label: 'bench:view',
    size: VIEW_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function drain(): Promise<void> {
  await gpu.device.queue.onSubmittedWorkDone();
}

/** Thresholds that alternate by a hair, so every rep is a real change of the same size. */
function cuts(selectivity: number): number[] {
  const base = 100 * (1 - selectivity);
  return Array.from({ length: REPS + 1 }, (_, i) => base + (i % 2) * 0.001);
}

interface Source {
  rows: number;
  x: Float32Array;
  y: Float32Array;
  v: Float32Array;
}

async function makeSource(rows: number): Promise<Source> {
  const sql = await duck();
  await sql.resetPrepared();
  await sql.exec(`
SELECT setseed(0.42);
CREATE OR REPLACE TABLE eng AS
SELECT (random() * 2 - 1)::FLOAT AS x, (random() * 2 - 1)::FLOAT AS y, (random() * 100)::FLOAT AS v
FROM range(0, ${rows}) t(i);
`);
  const { table } = await sql.run('SELECT x, y, v FROM eng');
  const col = (name: string) => table.getChild(name)!.toArray() as Float32Array;
  return { rows, x: col('x'), y: col('y'), v: col('v') };
}

function expected(src: Source, cut: number): number {
  let n = 0;
  for (let i = 0; i < src.rows; i++) if (src.v[i] > cut) n++;
  return n;
}

function graph(rows: number, cut: number): Graph {
  return {
    params: { cut: { value: cut, kind: 'value', changeRate: 8 } },
    nodes: [
      { id: 'src', type: 'source', dataset: { ref: 'eng', estimatedRows: rows } },
      { id: 'f', type: 'filter', input: 'src', predicate: 'v > {{cut}}' },
      { id: 'p', type: 'attribute', input: 'f', name: 'P', expr: '[x, y, 0]' },
      { id: 'out', type: 'render', input: 'p', mode: 'points', position: 'P' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Our planner
// ---------------------------------------------------------------------------

async function runPlanner(src: Source, selectivity: number, policy: Policy, engine: Engine): Promise<Row> {
  const cs = cuts(selectivity);
  const rt = new Runtime(gpu, await duck(), engine === 'cost+luma' ? { compactor: lumaCompactor } : {});
  rt.registerSource('eng', relationSource('eng'));
  const g = graph(src.rows, cs[0]);
  await rt.loadSource(g);
  const built = await rt.build(g, policy);
  rt.frame();
  await drain();

  const mask = built.plan.maskAttribute;
  const compacted = Boolean(built.plan.compaction);
  const route = rt.classify('cut');
  const check = async (cut: number) => {
    const want = expected(src, cut);
    if (compacted) {
      expect(await rt.compactedCount(), `${engine} compacted count`).toBe(want);
    } else if (mask) {
      const attr = rt.attributes.get(mask);
      const bits = await readFloat(attr.buffer, rt.result()!.rows);
      expect(bits.filter((b) => b >= 0.5).length, `${engine} mask count`).toBe(want);
    } else {
      expect(rt.result()!.rows, `${engine} row count`).toBe(want);
    }
  };
  await check(cs[0]);

  const updates: number[] = [];
  for (const cut of cs.slice(1)) {
    const t0 = performance.now();
    await rt.setParam('cut', cut);
    rt.frame();
    await drain();
    updates.push(performance.now() - t0);
  }
  await check(cs[cs.length - 1]);

  const frameMs = await rt.timeFrames(FRAMES);
  const row: Row = {
    engine, rows: src.rows, selectivity,
    drawn: compacted ? expected(src, cs[cs.length - 1]) : rt.result()!.rows,
    buildMs: built.timings.totalMs,
    updateMs: median(updates),
    frameMs,
    note: `filter in ${built.plan.explain.placement.find((p) => p.nodeId === 'f')?.stage ?? '?'}, route=${route}${mask ? ', mask' : ''}${compacted ? ', compacted' : ''}`,
  };
  rt.destroy();
  return row;
}

async function readFloat(buffer: GPUBuffer, n: number): Promise<Float32Array> {
  const u = await readBufferU32(gpu.device, buffer, n);
  return new Float32Array(u.buffer, u.byteOffset, n);
}

// ---------------------------------------------------------------------------
// Standalone engines: same PointsPass, same camera, own buffers
// ---------------------------------------------------------------------------

function uploadSource(attrs: AttributeSet, src: Source): void {
  const P = new Float32Array(src.rows * 3);
  for (let i = 0; i < src.rows; i++) {
    P[i * 3] = src.x[i];
    P[i * 3 + 1] = src.y[i];
  }
  attrs.write('P', 3, src.rows, { tier: 'cast', data: P, chunkCount: 1, nullCount: 0, convertMs: 0, arrowType: 'Float32', rows: src.rows });
  attrs.write('v', 1, src.rows, { tier: 'arrow', data: src.v, chunkCount: 1, nullCount: 0, convertMs: 0, arrowType: 'Float32', rows: src.rows });
}

function renderFrame(draw: (pass: GPURenderPassEncoder) => void, before?: (enc: GPUCommandEncoder) => void): void {
  const { width, height, depth } = gpu.sync();
  gpu.device.queue.writeBuffer(viewBuffer, 0, camera.pack(width, height) as unknown as GPUAllowSharedBufferSource);
  const encoder = gpu.device.createCommandEncoder({ label: 'bench:frame' });
  before?.(encoder);
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: gpu.context.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store',
    }],
    depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  draw(pass);
  pass.end();
  gpu.device.queue.submit([encoder.finish()]);
}

async function timeFrames(draw: (pass: GPURenderPassEncoder) => void): Promise<number> {
  renderFrame(draw);
  await drain();
  const t0 = performance.now();
  for (let i = 0; i < FRAMES; i++) renderFrame(draw);
  await drain();
  return (performance.now() - t0) / FRAMES;
}

async function runLuma(src: Source, selectivity: number, topology: LumaTopology): Promise<Row> {
  const engine: Engine = topology.kind === 'packed' ? 'luma' : 'luma-batched';
  const cs = cuts(selectivity);
  const t0 = performance.now();
  const attrs = new AttributeSet(gpu.device);
  uploadSource(attrs, src);
  const filter = new LumaFilter({
    device: gpu.device,
    adapter: gpu.adapter,
    columns: { v: attrs.get('v').buffer },
    rows: src.rows,
    predicate: parseExpr('v > {{cut}}'),
    params: { cut: cs[0] },
    topology,
  });
  const indirect = gpu.device.createBuffer({
    label: 'bench:indirect',
    size: 16,
    usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });
  gpu.device.queue.writeBuffer(indirect, 0, new Uint32Array([6, 0, 0, 0]));
  const pass = new PointsPass(gpu.device, gpu.format, attrs, { position: 'P' }, viewBuffer, filter.rowIndices());
  pass.setStyle(1, 1, 0.5, 64);
  const packed = topology.kind === 'packed';
  const draw = (p: GPURenderPassEncoder) => pass.drawIndirect(p, indirect);

  await expectNoGpuError(gpu.device, () => {
    filter.run({ cut: cs[0] });
    if (packed) renderFrame(draw, (enc) => filter.writeIndirectCount(enc, indirect));
  });
  const buildMs = performance.now() - t0;

  const selected = async (): Promise<number> => {
    let n = 0;
    for (let b = 0; b < filter.batches; b++) n += (await readBufferU32(gpu.device, filter.selectedCount(b), 1))[0];
    return n;
  };
  expect(await selected(), `${engine} count`).toBe(expected(src, cs[0]));
  if (packed) {
    // The ids themselves, not just how many: the first few must be rows that pass.
    const k = Math.min(64, expected(src, cs[0]));
    const ids = await readBufferU32(gpu.device, filter.rowIndices(), k);
    for (const id of ids) expect(src.v[id]).toBeGreaterThan(cs[0]);
  }

  // Filter alone: encode, submit, drain.
  const filterTimes: number[] = [];
  for (const cut of cs.slice(1)) {
    const s = performance.now();
    filter.run({ cut });
    await drain();
    filterTimes.push(performance.now() - s);
  }

  // A slider tick to pixels. The batched topology has one id list per 2048-row batch, so
  // drawing it would take a draw call per batch; it is measured for filtering only.
  const updates: number[] = [];
  let frameMs = NaN;
  if (packed) {
    for (const cut of cs.slice(1)) {
      const s = performance.now();
      filter.run({ cut });
      renderFrame(draw, (enc) => filter.writeIndirectCount(enc, indirect));
      await drain();
      updates.push(performance.now() - s);
    }
    frameMs = await timeFrames(draw);
  }
  const last = cs[cs.length - 1];
  expect(await selected(), `${engine} count after updates`).toBe(expected(src, last));

  const row: Row = {
    engine, rows: src.rows, selectivity,
    drawn: packed ? expected(src, last) : NaN,
    buildMs,
    updateMs: packed ? median(updates) : NaN,
    frameMs,
    filterMs: median(filterTimes),
    note: `${filter.batches} batch${filter.batches === 1 ? '' : 'es'}`,
  };
  filter.destroy();
  pass.destroy();
  attrs.destroy();
  indirect.destroy();
  return row;
}

async function runJs(src: Source, selectivity: number): Promise<Row> {
  const cs = cuts(selectivity);
  const t0 = performance.now();
  const attrs = new AttributeSet(gpu.device);
  attrs.ensure('P', 3, src.rows, 'derived');
  const scratch = new Float32Array(src.rows * 3);
  const pass = new PointsPass(gpu.device, gpu.format, attrs, { position: 'P' }, viewBuffer);
  pass.setStyle(1, 1, 0.5, 64);
  let k = 0;
  const filter = (cut: number) => {
    k = 0;
    for (let i = 0; i < src.rows; i++) {
      if (src.v[i] > cut) {
        scratch[k * 3] = src.x[i];
        scratch[k * 3 + 1] = src.y[i];
        scratch[k * 3 + 2] = 0;
        k++;
      }
    }
    gpu.device.queue.writeBuffer(attrs.get('P').buffer, 0, scratch, 0, k * 3);
  };
  const draw = (p: GPURenderPassEncoder) => pass.draw(p, k);
  filter(cs[0]);
  renderFrame(draw);
  await drain();
  const buildMs = performance.now() - t0;
  expect(k, 'js count').toBe(expected(src, cs[0]));

  const filterTimes: number[] = [];
  const updates: number[] = [];
  for (const cut of cs.slice(1)) {
    const s = performance.now();
    filter(cut);
    filterTimes.push(performance.now() - s);
    renderFrame(draw);
    await drain();
    updates.push(performance.now() - s);
  }
  const frameMs = await timeFrames(draw);
  const row: Row = {
    engine: 'js', rows: src.rows, selectivity, drawn: k, buildMs,
    updateMs: median(updates), frameMs, filterMs: median(filterTimes),
  };
  pass.destroy();
  attrs.destroy();
  return row;
}

// ---------------------------------------------------------------------------

describe('luma expression lowering', () => {
  it('lowers comparisons, arithmetic and boolean logic, and refuses the rest', () => {
    for (const ok of ['v > {{cut}}', 'v * 2 + 1 >= x', '!(v < 3) && (x != 0 || y == 1)', '-x > y / 2']) {
      expect(toLumaExpr(parseExpr(ok)), ok).not.toBeNull();
    }
    // Functions, modulo, conditionals and non-boolean roots have no luma form.
    for (const no of ['sqrt(v) > 2', 'v % 2 == 0', '(v > 1 ? x : y) > 0', 'v + 1']) {
      expect(toLumaExpr(parseExpr(no)), no).toBeNull();
    }
  });

  it('agrees with the planner’s compactable rule', () => {
    // Two implementations of one rule (AGENTS.md): the planner decides a filter can compact,
    // the luma backend has to lower it. If they drift, the optimizer picks a plan that
    // cannot be built.
    const cases = [
      'v > {{cut}}', 'v * 2 + 1 >= x', '!(v < 3) && (x != 0 || y == 1)', '-x > y / 2', 'v == 3 || !(x > y)',
      'sqrt(v) > 2', 'v % 2 == 0', '(v > 1 ? x : y) > 0', 'v + 1', 'x', '!v', 'v > 1 > 0', "v == 'a'",
      '[x, y] > 0', 'min(x, y) < 0',
    ];
    for (const src of cases) {
      const e = parseExpr(src);
      expect(toLumaExpr(e) !== null, src).toBe(compactable(e));
    }
  });
});

describe('runtime compaction', () => {
  it('compacts, draws indirectly, and services the slider without re-running the kernel', async () => {
    const src = await makeSource(20_000);
    const rt = new Runtime(gpu, await duck(), { compactor: lumaCompactor });
    // Free compile, so a small table still plans a compaction and the route is exercised in
    // the default run rather than only in the perf sweep.
    rt.costs = { ...rt.costs, compactCompileMs: 0 };
    rt.registerSource('eng', relationSource('eng'));
    const g = graph(src.rows, 95);
    await rt.loadSource(g);
    const built = await rt.build(g, 'cost');
    expect(built.plan.compaction, built.plan.explain.candidates[0].label).toBeDefined();
    expect(built.plan.maskAttribute).toBeUndefined();
    expect(rt.classify('cut')).toBe('compact');

    await expectNoGpuError(gpu.device, async () => {
      rt.frame();
      await drain();
    });
    expect(await rt.compactedCount()).toBe(expected(src, 95));

    const dispatches = rt.counters.kernelDispatches;
    for (const cut of [90, 50, 99.5]) {
      await rt.setParam('cut', cut);
      rt.frame();
      await drain();
      expect(await rt.compactedCount(), `cut ${cut}`).toBe(expected(src, cut));
    }
    // The kernel computes P, which does not depend on `cut`: three ticks, zero dispatches.
    expect(rt.counters.kernelDispatches).toBe(dispatches);
    expect(rt.counters.compactions).toBe(4);
    rt.destroy();
  });
});

describe('engines agree, then race', () => {
  for (const rows of SIZES) {
    describe(`${rows.toLocaleString()} rows`, () => {
      let src: Source;
      beforeAll(async () => {
        src = await makeSource(rows);
      });
      for (const s of SELECTIVITIES) {
        it(`selectivity ${s}`, async () => {
          results.push(await runPlanner(src, s, 'sql-first', 'sql'));
          results.push(await runPlanner(src, s, 'gpu-first', 'gpu-mask'));
          results.push(await runPlanner(src, s, 'cost', 'cost'));
          results.push(await runPlanner(src, s, 'cost', 'cost+luma'));
          results.push(await runLuma(src, s, { kind: 'packed' }));
          results.push(await runLuma(src, s, { kind: 'batched', rows: DUCK_BATCH }));
          results.push(await runJs(src, s));
        });
      }
    });
  }

  it('reports', async () => {
    const fmt = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? '—' : n < 10 ? n.toFixed(2) : n.toFixed(1));
    const lines = [
      '| rows | sel | engine | drawn | build ms | update ms | frame ms | filter ms | note |',
      '|---:|---:|---|---:|---:|---:|---:|---:|---|',
      ...results.map((r) =>
        `| ${r.rows.toLocaleString()} | ${r.selectivity} | ${r.engine} | ${Number.isNaN(r.drawn) ? '—' : r.drawn.toLocaleString()} | ${fmt(r.buildMs)} | ${fmt(r.updateMs)} | ${fmt(r.frameMs)} | ${fmt(r.filterMs)} | ${r.note ?? ''} |`),
    ];
    console.log(`\n${lines.join('\n')}\n`);
    if (PERF) {
      const adapter = gpu.adapter.info;
      await commands.writeFile('./__perf__/engines.json', JSON.stringify({
        date: new Date().toISOString(),
        adapter: { vendor: adapter.vendor, architecture: adapter.architecture, description: adapter.description },
        results,
      }, null, 2));
      await commands.writeFile('./__perf__/engines.md', `${lines.join('\n')}\n`);
    }
    expect(results.length).toBeGreaterThan(0);
  });
});
