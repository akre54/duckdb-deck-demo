/**
 * Measure this machine's cost constants at boot.
 *
 * A planner with hardcoded constants makes portable-looking decisions that are wrong on
 * any GPU but the author's. This runs ~200 ms of micro-benchmarks and derives the
 * constants in `graph/cost.ts` from them, so the EXPLAIN pane can honestly report
 * estimated against actual instead of against a number baked in on a different laptop.
 *
 * Each constant is separated into a fixed and a marginal part by measuring at two sizes
 * and taking the slope, rather than dividing one measurement by its size — which would
 * fold per-call overhead into the per-row term and badly misprice small plans.
 */

import { DEFAULT_COSTS, type SqlEngine, type CostConstants } from '@noodles.gl/planner';
import { gpuData } from './gpu-compat.js';

export interface CalibrationReport {
  costs: CostConstants;
  /** Wall time the calibration itself took. */
  elapsedMs: number;
  /** Raw measurements, for display. */
  samples: { label: string; ms: number; detail: string }[];
}

const SQL_ROWS = 200_000;
const GPU_ROWS_SMALL = 100_000;
const GPU_ROWS_LARGE = 2_000_000;
const CPU_ROWS = 500_000;

export async function calibrate(device: GPUDevice, duck: SqlEngine): Promise<CalibrationReport> {
  const started = performance.now();
  const samples: CalibrationReport['samples'] = [];
  const costs: CostConstants = { ...DEFAULT_COSTS };

  const note = (label: string, ms: number, detail: string) => {
    samples.push({ label, ms, detail });
    return ms;
  };

  // --- DuckDB -------------------------------------------------------------
  try {
    await duck.exec(`CREATE OR REPLACE TEMP TABLE __cal AS
      SELECT i::INTEGER AS c1, (i * 2)::FLOAT AS c2, (i * 3)::FLOAT AS c3, (i % 7)::FLOAT AS c4
      FROM range(0, ${SQL_ROWS}) t(i)`);

    const tiny = await timeQuery(duck, 'SELECT 1 AS one', 5);
    const oneCol = await timeQuery(duck, 'SELECT c1 FROM __cal', 3);
    const fourCol = await timeQuery(duck, 'SELECT c1, c2, c3, c4 FROM __cal', 3);
    // Six scalar ops per row, one column read.
    const withOps = await timeQuery(
      duck,
      'SELECT ((c2 * 2.0 + 1.0) / 3.0 - 0.5) * 1.5 + 2.0 AS v FROM __cal',
      3,
    );

    note('sql fixed', tiny, 'SELECT 1');
    note('sql 1 column', oneCol, `${SQL_ROWS.toLocaleString()} rows`);
    note('sql 4 columns', fourCol, `${SQL_ROWS.toLocaleString()} rows`);
    note('sql 6 ops', withOps, `${SQL_ROWS.toLocaleString()} rows`);

    costs.sqlFixedMs = clampPositive(tiny, DEFAULT_COSTS.sqlFixedMs);
    // Slope across column count isolates the per-column term from fixed overhead.
    costs.sqlPerRowPerColMs = clampPositive(
      (fourCol - oneCol) / (3 * SQL_ROWS),
      DEFAULT_COSTS.sqlPerRowPerColMs,
    );
    costs.sqlPerRowPerOpMs = clampPositive(
      (withOps - oneCol) / (6 * SQL_ROWS),
      DEFAULT_COSTS.sqlPerRowPerOpMs,
    );

    await duck.exec('DROP TABLE IF EXISTS __cal');
  } catch (err) {
    console.warn('[calibrate] DuckDB calibration failed, keeping defaults:', err);
  }

  // --- upload -------------------------------------------------------------
  {
    const bytes = GPU_ROWS_LARGE * 4;
    const buffer = device.createBuffer({
      label: 'cal:upload',
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const block = new Float32Array(GPU_ROWS_LARGE);

    // One big write: dominated by bandwidth.
    const big = await timeGpu(device, 1, () => {
      device.queue.writeBuffer(buffer, 0, gpuData(block));
    });
    // Many small writes of the same total size: isolates per-call overhead. The chunk must
    // divide the row count exactly, or the byte offsets stop being 4-aligned and every
    // write is rejected.
    const calls = 512;
    const chunk = Math.floor(GPU_ROWS_LARGE / calls);
    const covered = chunk * calls;
    const many = await timeGpu(device, 1, () => {
      for (let i = 0; i < calls; i++) {
        device.queue.writeBuffer(buffer, i * chunk * 4, gpuData(block), i * chunk, chunk);
      }
    });

    note('upload 1 call', big, `${(bytes / 1048576).toFixed(1)} MB`);
    note(`upload ${calls} calls`, many, `${((covered * 4) / 1048576).toFixed(1)} MB`);

    costs.uploadPerByteMs = clampPositive(big / bytes, DEFAULT_COSTS.uploadPerByteMs);
    costs.uploadPerCallMs = clampPositive(
      (many - big) / (calls - 1),
      DEFAULT_COSTS.uploadPerCallMs,
    );

    const uniform = device.createBuffer({
      label: 'cal:uniform',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const small = new Float32Array(4);
    const reps = 200;
    const uniformTotal = await timeGpu(device, 1, () => {
      for (let i = 0; i < reps; i++) device.queue.writeBuffer(uniform, 0, gpuData(small));
    });
    costs.uniformWriteMs = clampPositive(uniformTotal / reps, DEFAULT_COSTS.uniformWriteMs);
    note('uniform write', costs.uniformWriteMs, `mean of ${reps}`);

    buffer.destroy();
    uniform.destroy();
  }

  // --- compute kernel -----------------------------------------------------
  try {
    const { small, large, ops } = await timeKernel(device);
    note('kernel small', small, `${GPU_ROWS_SMALL.toLocaleString()} rows`);
    note('kernel large', large, `${GPU_ROWS_LARGE.toLocaleString()} rows`);
    costs.kernelPerRowPerOpMs = clampPositive(
      (large - small) / ((GPU_ROWS_LARGE - GPU_ROWS_SMALL) * ops),
      DEFAULT_COSTS.kernelPerRowPerOpMs,
    );
    // Extrapolate back to zero rows for the fixed term.
    costs.kernelFixedMs = clampPositive(
      small - GPU_ROWS_SMALL * ops * costs.kernelPerRowPerOpMs,
      DEFAULT_COSTS.kernelFixedMs,
    );
  } catch (err) {
    console.warn('[calibrate] kernel calibration failed, keeping defaults:', err);
  }

  // --- instanced rendering ------------------------------------------------
  try {
    const { small, large } = await timeRender(device);
    note('render small', small, `${GPU_ROWS_SMALL.toLocaleString()} instances`);
    note('render large', large, `${GPU_ROWS_LARGE.toLocaleString()} instances`);
    costs.renderPerInstanceMs = clampPositive(
      (large - small) / (GPU_ROWS_LARGE - GPU_ROWS_SMALL),
      DEFAULT_COSTS.renderPerInstanceMs,
    );
    costs.renderFixedMs = clampPositive(
      small - GPU_ROWS_SMALL * costs.renderPerInstanceMs,
      DEFAULT_COSTS.renderFixedMs,
    );
  } catch (err) {
    console.warn('[calibrate] render calibration failed, keeping defaults:', err);
  }

  // --- CPU loops ----------------------------------------------------------
  {
    // f64 -> f32 narrowing, the shape of the 'cast' upload tier.
    const src = new Float64Array(CPU_ROWS);
    for (let i = 0; i < CPU_ROWS; i++) src[i] = i * 0.5;
    const dst = new Float32Array(CPU_ROWS);
    const cast = timeSync(3, () => {
      for (let i = 0; i < CPU_ROWS; i++) dst[i] = src[i];
    });
    costs.castPerElemMs = clampPositive(cast / CPU_ROWS, DEFAULT_COSTS.castPerElemMs);
    note('cast f64->f32', cast, `${CPU_ROWS.toLocaleString()} elements`);

    // Strided write, the shape of interleaving three SQL columns into one vec3.
    const packed = new Float32Array(CPU_ROWS * 3);
    const interleave = timeSync(3, () => {
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < CPU_ROWS; i++) packed[i * 3 + c] = dst[i];
      }
    });
    costs.interleavePerElemMs = clampPositive(
      interleave / (CPU_ROWS * 3),
      DEFAULT_COSTS.interleavePerElemMs,
    );
    note('interleave', interleave, `${(CPU_ROWS * 3).toLocaleString()} writes`);

    // A generated arithmetic loop, matching what backends/js.ts produces. Six ops.
    const jsOps = 6;
    const out = new Float32Array(CPU_ROWS);
    const fn = new Function(
      'src',
      'out',
      'n',
      'for (let i = 0; i < n; i++) { out[i] = ((src[i] * 2.0 + 1.0) / 3.0 - 0.5) * 1.5 + 2.0; }',
    ) as (s: Float32Array, o: Float32Array, n: number) => void;
    const jsLoop = timeSync(3, () => fn(dst, out, CPU_ROWS));
    costs.cpuPerRowPerOpMs = clampPositive(
      jsLoop / (CPU_ROWS * jsOps),
      DEFAULT_COSTS.cpuPerRowPerOpMs,
    );
    note('generated js loop', jsLoop, `${CPU_ROWS.toLocaleString()} rows x ${jsOps} ops`);
  }

  return { costs, elapsedMs: performance.now() - started, samples };
}

// ---------------------------------------------------------------------------

async function timeQuery(duck: SqlEngine, sql: string, reps: number): Promise<number> {
  await duck.run(sql); // warm up: first execution includes plan construction
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const started = performance.now();
    await duck.run(sql);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** Time GPU work with the queue drained, so it measures work rather than submission. */
async function timeGpu(device: GPUDevice, reps: number, body: () => void): Promise<number> {
  body();
  await device.queue.onSubmittedWorkDone();
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const started = performance.now();
    body();
    await device.queue.onSubmittedWorkDone();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** Best-of-N wall time for synchronous CPU work. */
function timeSync(reps: number, body: () => void): number {
  body();
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const started = performance.now();
    body();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** Dispatch a known-op-count kernel at two row counts. */
async function timeKernel(
  device: GPUDevice,
): Promise<{ small: number; large: number; ops: number }> {
  const ops = 6;
  const code = `
@group(0) @binding(0) var<uniform> rowInfo: vec4<u32>;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= rowInfo.x) { return; }
  dst[i] = ((src[i] * 2.0 + 1.0) / 3.0 - 0.5) * 1.5 + 2.0;
}
`;
  const module = device.createShaderModule({ label: 'cal:kernel', code });
  const pipeline = device.createComputePipeline({
    label: 'cal:kernel',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  const bytes = GPU_ROWS_LARGE * 4;
  const mk = (label: string) =>
    device.createBuffer({
      label,
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  const src = mk('cal:src');
  const dst = mk('cal:dst');
  const info = device.createBuffer({
    label: 'cal:info',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: info } },
      { binding: 1, resource: { buffer: src } },
      { binding: 2, resource: { buffer: dst } },
    ],
  });

  const run = (rows: number) => {
    device.queue.writeBuffer(info, 0, new Uint32Array([rows, 0, 0, 0]));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(rows / 256));
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  // Several dispatches per sample: one dispatch of this size is below timer resolution.
  const reps = 20;
  const small = (await timeGpu(device, 2, () => { for (let i = 0; i < reps; i++) run(GPU_ROWS_SMALL); })) / reps;
  const large = (await timeGpu(device, 2, () => { for (let i = 0; i < reps; i++) run(GPU_ROWS_LARGE); })) / reps;

  src.destroy();
  dst.destroy();
  info.destroy();
  return { small, large, ops };
}

/**
 * Time an instanced point draw at two instance counts.
 *
 * The planner needs a marginal per-instance render cost because that is what a filter's
 * placement changes: a discard mask draws every row, every frame. Rendering to an offscreen
 * texture rather than the canvas keeps this out of the presentation path, and the quad is
 * kept small so the measurement reflects instance overhead rather than pixel fill.
 */
async function timeRender(device: GPUDevice): Promise<{ small: number; large: number }> {
  const format: GPUTextureFormat = 'rgba8unorm';
  const size = 256;
  const target = device.createTexture({
    label: 'cal:target',
    size: [size, size],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const code = `
@group(0) @binding(0) var<uniform> cfg: vec4<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  // Deterministic scatter across the target, two triangles per instance.
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
  );
  let f = f32(ii);
  let jitter = vec2<f32>(fract(f * 0.6180339887), fract(f * 0.4142135624)) * 2.0 - 1.0;
  let px = cfg.x;
  return vec4<f32>(jitter + corners[vi] * px, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.2, 0.4, 0.8, 1.0);
}
`;
  const module = device.createShaderModule({ label: 'cal:render', code });
  const pipeline = device.createRenderPipeline({
    label: 'cal:render',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const cfg = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // ~1.5 pixels wide, so fill cost stays small relative to per-instance overhead.
  device.queue.writeBuffer(cfg, 0, new Float32Array([1.5 / size, 0, 0, 0]));
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: cfg } }],
  });
  const view = target.createView();

  const run = (instances: number) => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6, instances);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  const reps = 10;
  const small = (await timeGpu(device, 2, () => { for (let i = 0; i < reps; i++) run(GPU_ROWS_SMALL); })) / reps;
  const large = (await timeGpu(device, 2, () => { for (let i = 0; i < reps; i++) run(GPU_ROWS_LARGE); })) / reps;

  cfg.destroy();
  target.destroy();
  return { small, large };
}

/**
 * Micro-benchmarks occasionally produce a zero or negative slope when two measurements
 * land within timer noise. Falling back to the default is better than letting a negative
 * cost make the optimizer prefer more work.
 */
function clampPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
