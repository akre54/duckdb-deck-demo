/**
 * The runtime: physical plan -> pixels, and the parameter-rebinding path.
 *
 * The distinction the whole prototype exists to demonstrate lives in `setParam`:
 *
 *   value param, GPU-bound  -> writeBuffer(uniform) + redispatch.  No requery.
 *   value param, SQL-bound  -> rebind the prepared statement, re-upload attributes.
 *   structural param        -> rebuild(). New plan, new SQL, new kernels.
 *
 * Every one of those paths bumps a counter, so the inspector can prove which happened
 * rather than asking you to trust it.
 */

import type { Gpu } from './device.js';
import type { Duck } from './duck.js';
import { AttributeSet } from './attributes.js';
import { readColumn, readVectorColumns, type ColumnUpload } from './arrow-gpu.js';
import { Kernel } from './compute.js';
import { OrbitCamera, VIEW_UNIFORM_SIZE } from './camera.js';
import { PointsPass } from './passes/points.js';
import { Bin2dPass } from './passes/bin2d.js';
import { plan as buildPlan, type PhysicalPlan, type Policy, type Schema, WORKGROUP, PlanError } from '../graph/planner.js';
import { parseExpr } from '../graph/expr.js';
import { buildRampLut, type Graph } from '../graph/types.js';
import { SOURCE_TABLE, syntheticSql } from '../data/synthetic.js';
import { gpuData } from './gpu-compat.js';
import { statsSql, parseStatsRow, type SourceStats } from '../graph/stats.js';
import { type CostConstants, DEFAULT_COSTS } from '../graph/cost.js';
import { calibrate, type CalibrationReport } from './calibrate.js';
import { type TargetCaps, type TargetId, targetCaps } from '../graph/target.js';
import { evaluateStage } from '../compare/cpu-attributes.js';

export interface BuildTimings {
  planMs: number;
  statsMs: number;
  queryMs: number;
  convertMs: number;
  uploadMs: number;
  /** Time in the generated JS loop, when the plan placed nodes on the CPU. */
  cpuStageMs: number;
  pipelineMs: number;
  totalMs: number;
  /** writeBuffer calls issued for this build. */
  writeCalls: number;
}

export interface AttributeReport {
  name: string;
  width: number;
  provenance: 'arrow' | 'cpu' | 'derived';
  tier?: ColumnUpload['tier'];
  arrowType?: string;
  nullCount?: number;
  chunks?: number;
  bytes: number;
  internal?: boolean;
}

export interface BuildResult {
  plan: PhysicalPlan;
  rows: number;
  timings: BuildTimings;
  attributes: AttributeReport[];
  statValues: Record<string, number>;
  sourceColumns: number;
  /** Statistics the optimizer planned against, for the explain pane. */
  stats?: SourceStats;
  /** Milliseconds the statistics query itself cost. */
  statsCatalogMs: number;
}

/** Does a stage node's expression reference this parameter? */
function exprUsesParam(node: { expr: unknown }, name: string): boolean {
  const walk = (e: unknown): boolean => {
    if (!e || typeof e !== 'object') return false;
    const n = e as { kind?: string; name?: string } & Record<string, unknown>;
    if (n.kind === 'param') return n.name === name;
    return Object.values(n).some((v) =>
      Array.isArray(v) ? v.some(walk) : typeof v === 'object' && walk(v),
    );
  };
  return walk(node.expr);
}

/** DuckDB type name -> whether a column can reach the GPU at all. */
const NUMERIC_DUCKDB_TYPES =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|REAL|DECIMAL)/i;

export class Runtime {
  readonly camera = new OrbitCamera();
  readonly attributes: AttributeSet;

  private viewBuffer: GPUBuffer;
  private rampBuffer?: GPUBuffer;
  private kernels: Kernel[] = [];
  private pointsPass?: PointsPass;
  private binPass?: Bin2dPass;

  private current?: BuildResult;
  private graph?: Graph;
  private policy: Policy = 'cost';
  private paramValues: Record<string, number> = {};
  private sourceSchema: Schema = new Map();
  private rows = 0;

  /** Cost constants for this machine. Replaced by `runCalibration()`. */
  costs: CostConstants = DEFAULT_COSTS;
  calibration?: CalibrationReport;
  /** Catalog statistics for the current source, computed once per source load. */
  sourceStats?: SourceStats;
  private statsCatalogMs = 0;
  /** Render target capabilities the optimizer plans against. */
  target: TargetCaps;
  /**
   * The raw uploads from the last query, kept so the CPU backend can evaluate the same
   * graph for the deck.gl comparison. Not used by the WebGPU path.
   */
  readonly sourceUploads = new Map<string, ColumnUpload>();
  private lastViewVersion = -1;
  /** Set when a kernel needs to re-run before the next draw. */
  private kernelsDirty = true;

  readonly counters = {
    uniformWrites: 0,
    kernelDispatches: 0,
    /** Times the generated JS loop re-ran for a parameter change. */
    cpuStageRuns: 0,
    requeries: 0,
    rebuilds: 0,
    frames: 0,
  };

  /** Rolling GPU-submit-to-submit frame time, milliseconds. */
  frameMs = 0;
  private lastFrameStamp = 0;

  constructor(private readonly gpu: Gpu, private readonly duck: Duck) {
    this.attributes = new AttributeSet(gpu.device);
    this.target = targetCaps('webgpu-native', gpu.device);
    this.viewBuffer = gpu.device.createBuffer({
      label: 'view',
      size: VIEW_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Measure this machine's cost constants. Worth doing once at boot: a planner with
   * constants baked in on someone else's GPU makes confident, wrong decisions.
   */
  async runCalibration(): Promise<CalibrationReport> {
    const report = await calibrate(this.gpu.device, this.duck);
    this.costs = report.costs;
    this.calibration = report;
    return report;
  }

  setTarget(id: TargetId): void {
    this.target = targetCaps(id, this.gpu.device);
  }

  // -------------------------------------------------------------------------
  // Source
  // -------------------------------------------------------------------------

  /** Materialize the source relation and read back its schema. */
  async loadSource(graph: Graph): Promise<void> {
    const source = graph.nodes.find((n) => n.type === 'source');
    if (!source || source.type !== 'source') throw new PlanError('Graph has no source node');

    if (source.dataset.kind === 'synthetic') {
      await this.duck.resetPrepared();
      await this.duck.exec(syntheticSql(source.dataset.rows, source.dataset.seed ?? 0.42));
    } else {
      await this.duck.resetPrepared();
      // DuckDB reads the URL directly, so projection and row-group pruning happen
      // one layer below this planner rather than being reimplemented here.
      await this.duck.exec(
        `CREATE OR REPLACE VIEW ${SOURCE_TABLE} AS SELECT * FROM '${source.dataset.url.replace(/'/g, "''")}'`,
      );
    }

    const described = await this.duck.describe(SOURCE_TABLE);
    this.sourceSchema = new Map();
    const skipped: string[] = [];
    for (const [name, type] of described) {
      if (NUMERIC_DUCKDB_TYPES.test(type)) this.sourceSchema.set(name, 1);
      else skipped.push(`${name}:${type}`);
    }
    if (skipped.length) {
      console.info(`[runtime] non-numeric columns are not GPU-bindable and were skipped: ${skipped.join(', ')}`);
    }

    await this.loadStats(described);
  }

  /**
   * Catalog statistics: row count, distinct counts, ranges and null fractions.
   *
   * Computed once per source rather than per build, because it is the source that changes
   * them — a parameter move does not. Without these the optimizer has nothing to cost, and
   * `plan()` falls back to the rule-based policy and says so.
   */
  private async loadStats(described: Map<string, string>): Promise<void> {
    const columns = [...this.sourceSchema.keys()];
    const started = performance.now();
    this.sourceStats = undefined;
    try {
      const { table } = await this.duck.run(statsSql(SOURCE_TABLE, columns));
      const row = table.get(0) as Record<string, unknown> | null;
      if (row) this.sourceStats = parseStatsRow(row, columns, described);
    } catch (err) {
      // approx_count_distinct may be missing in some builds; exact DISTINCT still works.
      console.warn('[runtime] approximate statistics failed, retrying exactly:', err);
      try {
        const { table } = await this.duck.run(statsSql(SOURCE_TABLE, columns, false));
        const row = table.get(0) as Record<string, unknown> | null;
        if (row) this.sourceStats = parseStatsRow(row, columns, described);
      } catch (err2) {
        console.warn('[runtime] statistics unavailable; the planner will fall back to rules:', err2);
      }
    }
    this.statsCatalogMs = performance.now() - started;
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  async build(graph: Graph, policy: Policy = this.policy): Promise<BuildResult> {
    this.graph = graph;
    this.policy = policy;
    this.counters.rebuilds++;
    const t0 = performance.now();

    // Seed declared defaults *before* planning, keeping any the user has already moved.
    // The optimizer estimates a filter's selectivity from where its threshold currently
    // sits, so planning against an empty parameter map makes every predicate fall back to
    // the 0.33 default and the cardinality estimate is meaningless.
    const seeded: Record<string, number> = { ...this.paramValues };
    for (const [name, spec] of Object.entries(graph.params ?? {})) {
      if (seeded[name] === undefined) seeded[name] = spec.value;
    }
    this.paramValues = seeded;

    const plan = buildPlan(graph, this.sourceSchema, {
      policy,
      costs: this.costs,
      caps: this.target,
      stats: this.sourceStats,
      params: this.paramValues,
    });
    const planMs = performance.now() - t0;

    // Statistics nodes publish parameters the graph never declared, so top up afterwards.
    const next: Record<string, number> = {};
    for (const [name, spec] of Object.entries(plan.params)) {
      next[name] = this.paramValues[name] ?? spec.value;
    }
    this.paramValues = next;

    // --- stats first: their results become bindable parameters ---------------
    const tStats = performance.now();
    const statValues: Record<string, number> = {};
    for (const s of plan.stats) {
      const statBinds = s.params.map((p) => this.paramValues[p] ?? 0);
      const { table } = await this.duck.run(s.sql, statBinds);
      const row = table.get(0) as Record<string, unknown> | null;
      for (const o of s.outputs) {
        const v = Number(row?.[o.column]);
        statValues[o.param] = Number.isFinite(v) ? v : 0;
        this.paramValues[o.param] = statValues[o.param];
      }
    }
    const statsMs = performance.now() - tStats;

    // --- row query ----------------------------------------------------------
    const binds = plan.sqlParams.map((p) => {
      const v = this.paramValues[p];
      if (v === undefined) throw new PlanError(`No value for SQL parameter '${p}'`);
      return v;
    });
    const { table, timing } = await this.duck.run(plan.sql, binds);
    this.rows = table.numRows;

    // --- upload arrow-sourced attributes ------------------------------------
    const tUpload = performance.now();
    this.attributes.resetCounters();
    this.sourceUploads.clear();
    const reports: AttributeReport[] = [];
    for (const decl of plan.attributes) {
      if (decl.provenance === 'arrow') {
        const upload = decl.sourceColumns && decl.sourceColumns.length > 1
          ? readVectorColumns(table, decl.sourceColumns)
          : readColumn(table, decl.sourceColumns?.[0] ?? decl.name);
        this.attributes.write(decl.name, decl.width, this.rows, upload);
        this.sourceUploads.set(decl.name, upload);
        reports.push({
          name: decl.name, width: decl.width, provenance: 'arrow', tier: upload.tier,
          arrowType: upload.arrowType, nullCount: upload.nullCount, chunks: upload.chunkCount,
          bytes: this.rows * decl.width * 4,
        });
      } else {
        this.attributes.ensure(decl.name, decl.width, this.rows, 'derived');
        reports.push({
          name: decl.name, width: decl.width, provenance: decl.provenance,
          bytes: this.rows * decl.width * 4, internal: decl.internal,
        });
      }
    }
    this.attributes.prune(new Set(plan.attributes.map((a) => a.name)));
    const uploadMs = performance.now() - tUpload;

    // --- CPU stage, when the plan placed nodes there -------------------------
    const cpuStageMs = this.runCpuStage(plan);

    // --- pipelines ----------------------------------------------------------
    const tPipe = performance.now();
    this.disposePipelines();

    if (plan.ramp) {
      const lut = buildRampLut(plan.ramp);
      this.rampBuffer?.destroy();
      this.rampBuffer = this.gpu.device.createBuffer({
        label: `ramp:${plan.ramp}`,
        size: lut.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.gpu.device.queue.writeBuffer(this.rampBuffer, 0, gpuData(lut));
    }

    this.kernels = plan.kernels.map((k) => new Kernel(this.gpu.device, k, this.rampBuffer));
    for (const k of this.kernels) k.writeParams(this.paramValues);

    const attr = (name?: string) => (name && this.attributes.has(name) ? this.attributes.get(name) : undefined);
    const mask = attr(plan.maskAttribute);

    if (plan.render.mode === 'points') {
      this.pointsPass = new PointsPass(
        this.gpu.device,
        this.gpu.format,
        {
          position: this.attributes.get(plan.render.position ?? 'P'),
          color: attr(plan.render.color ?? 'Cd'),
          size: attr(plan.render.size ?? 'pscale'),
          opacity: attr(plan.render.opacity ?? 'Alpha'),
          mask,
        },
        this.viewBuffer,
      );
      this.pointsPass.setStyle(1, 1, 0.5, 64);
    } else if (plan.bin2d) {
      const weightAttr = plan.bin2d.weight ? this.resolveWeightAttribute(plan.bin2d.weight) : undefined;
      this.binPass = new Bin2dPass(
        this.gpu.device,
        this.gpu.format,
        plan.bin2d.resolution,
        { position: this.attributes.get(plan.render.position ?? 'P'), weight: weightAttr, mask },
        this.viewBuffer,
        this.rampBuffer!,
      );
      const ceiling = plan.bin2d.ceiling && plan.bin2d.ceiling !== 'auto'
        ? this.evalScalar(plan.bin2d.ceiling)
        : 0;
      this.binPass.setCeiling(ceiling);
    }
    const pipelineMs = performance.now() - tPipe;

    this.kernelsDirty = true;
    this.lastViewVersion = -1;

    const result: BuildResult = {
      plan,
      rows: this.rows,
      timings: {
        planMs, statsMs, queryMs: timing.ms,
        convertMs: this.attributes.counters.convertMs,
        uploadMs, cpuStageMs, pipelineMs,
        totalMs: performance.now() - t0,
        writeCalls: this.attributes.counters.writeCalls,
      },
      attributes: reports,
      statValues,
      sourceColumns: this.sourceSchema.size,
      stats: this.sourceStats,
      statsCatalogMs: this.statsCatalogMs,
    };
    this.current = result;
    return result;
  }

  /**
   * Run the plan's CPU stage and upload its results.
   *
   * The optimizer puts nodes here for one of two reasons: the CPU was priced cheapest, or
   * the target has no compute shaders and it was the only legal place. Either way the work
   * is the same generated JS the deck comparison uses, so there is one implementation
   * rather than two that could disagree.
   */
  private runCpuStage(plan: PhysicalPlan): number {
    if (plan.cpuStage.length === 0) return 0;
    const started = performance.now();
    const evaluated = evaluateStage(plan.cpuStage, plan, this.sourceUploads, this.paramValues, this.rows);
    for (const [name, { data, width }] of evaluated.values) {
      const decl = plan.attributes.find((a) => a.name === name);
      if (decl?.provenance !== 'cpu') continue;
      this.attributes.write(name, width, this.rows, {
        tier: 'cast',
        data,
        chunkCount: 1,
        nullCount: 0,
        convertMs: 0,
        arrowType: 'cpu stage',
        rows: this.rows,
      });
    }
    return performance.now() - started;
  }

  /**
   * A bin2d weight is an expression, but the binning shader wants a buffer. Only a bare
   * attribute reference is supported; anything else should be an explicit attribute node
   * upstream, so the cost stays visible in the graph.
   */
  private resolveWeightAttribute(src: string) {
    const e = parseExpr(src);
    if (e.kind !== 'col') {
      throw new PlanError(
        `bin2d weight must name an attribute (got '${src}'). Add an attribute node for the expression first.`,
      );
    }
    return this.attributes.get(e.name);
  }

  private evalScalar(src: string): number {
    const e = parseExpr(src);
    if (e.kind === 'num') return e.value;
    if (e.kind === 'param') return this.paramValues[e.name] ?? 0;
    throw new PlanError(`Expected a literal or {{param}}, got '${src}'`);
  }

  // -------------------------------------------------------------------------
  // Parameters
  // -------------------------------------------------------------------------

  params(): Record<string, number> {
    return { ...this.paramValues };
  }

  /**
   * How a parameter change will be serviced, without changing anything.
   *
   * The order is the cost order: a SQL-bound parameter is the most expensive because it
   * forces a requery, so it wins even if the parameter also appears in a kernel. The
   * routes are exactly the terms the optimizer amortized when it chose the placement.
   */
  classify(name: string): 'uniform' | 'cpu' | 'requery' | 'rebuild' | 'unused' {
    const plan = this.current?.plan;
    if (!plan) return 'unused';
    if (plan.params[name]?.kind === 'structural') return 'rebuild';
    if (plan.sqlParams.includes(name)) return 'requery';
    if (plan.cpuStage.some((s) => exprUsesParam(s, name))) return 'cpu';
    if (plan.uniformParams.includes(name)) return 'uniform';
    return 'unused';
  }

  /**
   * Apply a parameter change by the cheapest route available. Returns which route
   * was taken so the caller can display it.
   */
  async setParam(
    name: string,
    value: number,
  ): Promise<'uniform' | 'cpu' | 'requery' | 'rebuild' | 'unused'> {
    this.paramValues[name] = value;
    const route = this.classify(name);
    switch (route) {
      case 'uniform':
        for (const k of this.kernels) k.writeParams(this.paramValues);
        this.counters.uniformWrites++;
        this.kernelsDirty = true;
        break;
      case 'cpu': {
        // No requery, but the whole generated loop runs again and its outputs re-upload.
        // That asymmetry with the uniform path is what the optimizer prices.
        const plan = this.current?.plan;
        if (plan) {
          this.counters.cpuStageRuns++;
          this.runCpuStage(plan);
          for (const k of this.kernels) k.writeParams(this.paramValues);
          this.kernelsDirty = true;
        }
        break;
      }
      case 'requery':
        this.counters.requeries++;
        await this.requery();
        break;
      case 'rebuild':
        if (this.graph) await this.build(this.graph, this.policy);
        break;
      case 'unused':
        break;
    }
    return route;
  }

  /**
   * Re-run the row query with new binds and re-upload, without recompiling the plan or
   * rebuilding pipelines. Buffers are reused when the row count fits.
   */
  private async requery(): Promise<void> {
    const plan = this.current?.plan;
    if (!plan) return;

    // Stats sit behind the same WHERE clause, so a filter change moves the scale
    // domains too. Recompute them and push the new values into the kernel uniforms —
    // otherwise the colors stay keyed to the old, unfiltered domain.
    for (const s of plan.stats) {
      const { table } = await this.duck.run(s.sql, s.params.map((p) => this.paramValues[p] ?? 0));
      const row = table.get(0) as Record<string, unknown> | null;
      for (const o of s.outputs) {
        const v = Number(row?.[o.column]);
        this.paramValues[o.param] = Number.isFinite(v) ? v : 0;
        if (this.current) this.current.statValues[o.param] = this.paramValues[o.param];
      }
    }
    for (const k of this.kernels) k.writeParams(this.paramValues);

    const binds = plan.sqlParams.map((p) => this.paramValues[p] ?? 0);
    const { table } = await this.duck.run(plan.sql, binds);
    this.rows = table.numRows;
    for (const decl of plan.attributes) {
      if (decl.provenance !== 'arrow') {
        this.attributes.ensure(decl.name, decl.width, this.rows, 'derived');
        continue;
      }
      const upload = decl.sourceColumns && decl.sourceColumns.length > 1
        ? readVectorColumns(table, decl.sourceColumns)
        : readColumn(table, decl.sourceColumns?.[0] ?? decl.name);
      this.attributes.write(decl.name, decl.width, this.rows, upload);
      this.sourceUploads.set(decl.name, upload);
    }
    // A requery changes the row count, so anything the CPU stage produced is now the wrong
    // length and has to be recomputed before the kernel or the renderer reads it.
    this.runCpuStage(plan);
    if (this.current) this.current.rows = this.rows;
    this.kernelsDirty = true;
  }

  setPointStyle(sizeScale: number, opacity: number, minPx: number, maxPx: number): void {
    this.pointsPass?.setStyle(sizeScale, opacity, minPx, maxPx);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  frame(): void {
    if (!this.current) return;
    const { device, context } = this.gpu;
    const { width, height, depth } = this.gpu.sync();

    if (this.camera.version !== this.lastViewVersion) {
      device.queue.writeBuffer(this.viewBuffer, 0, gpuData(this.camera.pack(width, height)));
      this.lastViewVersion = this.camera.version;
      this.counters.uniformWrites++;
    }

    const encoder = device.createCommandEncoder({ label: 'frame' });

    if (this.kernelsDirty && this.rows > 0) {
      for (const k of this.kernels) {
        k.dispatch(encoder, this.attributes, this.rows, WORKGROUP);
        this.counters.kernelDispatches++;
      }
      this.kernelsDirty = false;
    }

    // The heatmap re-bins every frame because the bins are screen-space: moving the
    // camera changes which cell a point lands in.
    if (this.binPass && this.rows > 0) this.binPass.bin(encoder, this.rows);

    const bg = this.current.plan.render.background ?? [0.043, 0.047, 0.063];
    const pass = encoder.beginRenderPass({
      label: 'main',
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: bg[0], g: bg[1], b: bg[2], a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depth,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    if (this.binPass) this.binPass.draw(pass);
    else if (this.pointsPass && this.rows > 0) this.pointsPass.draw(pass, this.rows);

    pass.end();
    device.queue.submit([encoder.finish()]);

    const now = performance.now();
    if (this.lastFrameStamp) {
      // Exponential smoothing; raw deltas are too noisy to read off a label.
      this.frameMs = this.frameMs * 0.9 + (now - this.lastFrameStamp) * 0.1;
    }
    this.lastFrameStamp = now;
    this.counters.frames++;
  }

  /** Force the kernels to re-run on the next frame. */
  invalidate(): void {
    this.kernelsDirty = true;
  }

  /**
   * Real GPU cost per frame, measured by submitting `count` frames back to back and
   * waiting for the queue to drain.
   *
   * `frameMs` cannot be used for benchmarking: it is a submit-to-submit interval inside
   * a requestAnimationFrame loop, so it reports the browser's presentation cadence — and
   * goes to ~640 ms if the tab is not visible, because rAF throttles. This measures work
   * instead of cadence.
   */
  async timeFrames(count = 60): Promise<number> {
    if (!this.current) return 0;
    // One warm-up frame so shader compilation and first-use allocation are excluded.
    this.frame();
    await this.gpu.device.queue.onSubmittedWorkDone();
    const started = performance.now();
    for (let i = 0; i < count; i++) {
      // Bump the camera so the view uniform is rewritten each frame, matching the cost
      // of an actually-interactive frame rather than a static one.
      this.camera.version++;
      this.frame();
    }
    await this.gpu.device.queue.onSubmittedWorkDone();
    return (performance.now() - started) / count;
  }

  result(): BuildResult | undefined {
    return this.current;
  }

  private disposePipelines(): void {
    for (const k of this.kernels) k.destroy();
    this.kernels = [];
    this.pointsPass?.destroy();
    this.pointsPass = undefined;
    this.binPass?.destroy();
    this.binPass = undefined;
  }

  destroy(): void {
    this.disposePipelines();
    this.rampBuffer?.destroy();
    this.viewBuffer.destroy();
    this.attributes.destroy();
  }
}
