/**
 * Phase 2 of planning: choose where each node runs, by cost.
 *
 * The search space is small for a provable reason. SQL cannot read a GPU buffer, and GPU
 * output cannot return to the CPU without a readback, so in topological order the stages
 * must appear as `SQL* CPU* GPU*`. An assignment is therefore a pair of boundary indices
 * `(i, j)` — nodes `[0,i)` in SQL, `[i,j)` on the CPU, `[j,n)` on the GPU — and there are
 * only O(n²) of them. So this enumerates *every* candidate and prices it exactly, rather
 * than descending a heuristic and hoping.
 *
 * Two things the cost model gets right that a rule cannot:
 *
 *   1. Only a SQL filter removes rows. A filter placed later becomes a discard mask, so
 *      every downstream stage pays for rows that will never be drawn, and the upload pays
 *      for them too. That makes filter placement depend on *selectivity*, which is a
 *      statistic, not a rule.
 *   2. A parameter has a change rate. Where its consumers live decides whether moving a
 *      slider costs a 16-byte uniform write or a requery plus a re-upload. Minimising
 *      build cost alone would push nearly everything into SQL; minimising build plus
 *      amortised interaction is what makes the answer interesting.
 */

import type { Analysis, Stage } from './analyze.js';
import { PlanError } from './analyze.js';
import {
  type CostConstants, CostAccumulator, type CostBreakdown,
  sqlScanMs, uploadMs, castMs, interleaveMs, kernelMs, cpuEvalMs, renderFrameMs, estimateChunks,
} from './cost.js';
import { type SourceStats, estimateSelectivity, DEFAULT_SELECTIVITY } from './stats.js';
import type { TargetCaps } from './target.js';

export type Policy = 'cost' | 'auto' | 'sql-first' | 'gpu-first';

export interface Assignment {
  /** Nodes [0, sqlEnd) run in SQL. */
  sqlEnd: number;
  /** Nodes [sqlEnd, cpuEnd) run on the CPU; [cpuEnd, n) on the GPU. */
  cpuEnd: number;
}

export interface Candidate {
  assignment: Assignment;
  legal: boolean;
  /** Why it was rejected, when illegal. */
  reason?: string;
  cost?: CostBreakdown;
  /** Estimated rows leaving the SQL stage. */
  sqlRows?: number;
  label: string;
}

export interface OptimizeContext {
  costs: CostConstants;
  caps: TargetCaps;
  stats?: SourceStats;
  params: Record<string, number>;
  policy: Policy;
}

export interface OptimizeResult {
  chosen: Assignment;
  candidates: Candidate[];
  /** How the choice was made, for the EXPLAIN pane. */
  method: 'cost' | 'policy';
  /** Estimated rows leaving SQL, used downstream for reporting. */
  sqlRows: number;
  estimatedSelectivity: { nodeId: string; selectivity: number; pushedToSql: boolean }[];
  notes: string[];
}

export function optimize(analysis: Analysis, ctx: OptimizeContext): OptimizeResult {
  const n = analysis.order.length;
  const notes: string[] = [];

  // Cost-based planning needs statistics. Without them, fall back to the rule-based
  // policy rather than pricing plans against invented numbers.
  const useCost = ctx.policy === 'cost' && ctx.stats !== undefined;
  if (ctx.policy === 'cost' && !ctx.stats) {
    notes.push('no source statistics available; fell back to the rule-based auto policy');
  }

  const candidates: Candidate[] = [];
  for (let sqlEnd = 0; sqlEnd <= n; sqlEnd++) {
    for (let cpuEnd = sqlEnd; cpuEnd <= n; cpuEnd++) {
      candidates.push(evaluate(analysis, { sqlEnd, cpuEnd }, ctx));
    }
  }

  const legal = candidates.filter((c) => c.legal);
  if (legal.length === 0) {
    const why = candidates.map((c) => `  ${c.label}: ${c.reason}`).join('\n');
    throw new PlanError(`No legal plan for target '${ctx.caps.id}'.\n${why}`);
  }

  let chosen: Assignment;
  let method: OptimizeResult['method'];
  if (useCost) {
    const best = legal.reduce((a, b) => (a.cost!.totalMs <= b.cost!.totalMs ? a : b));
    chosen = best.assignment;
    method = 'cost';
  } else {
    chosen = policyAssignment(analysis, ctx, notes);
    const match = candidates.find(
      (c) => c.assignment.sqlEnd === chosen.sqlEnd && c.assignment.cpuEnd === chosen.cpuEnd,
    );
    if (!match?.legal) {
      throw new PlanError(
        `Policy '${ctx.policy}' produced an illegal plan (${label(chosen, n)}): ${match?.reason ?? 'unknown'}`,
      );
    }
    method = 'policy';
  }

  const chosenCandidate = candidates.find(
    (c) => c.assignment.sqlEnd === chosen.sqlEnd && c.assignment.cpuEnd === chosen.cpuEnd,
  )!;

  const estimatedSelectivity = analysis.order
    .filter((node) => node.kind === 'filter')
    .map((node, _i) => {
      const index = analysis.order.indexOf(node);
      return {
        nodeId: node.id,
        selectivity: ctx.stats ? estimateSelectivity(node.expr!, ctx.stats, ctx.params) : DEFAULT_SELECTIVITY,
        pushedToSql: index < chosen.sqlEnd,
      };
    });

  // Sort for display: legal plans by cost, then illegal ones.
  candidates.sort((a, b) => {
    if (a.legal !== b.legal) return a.legal ? -1 : 1;
    return (a.cost?.totalMs ?? Infinity) - (b.cost?.totalMs ?? Infinity);
  });

  return {
    chosen,
    candidates,
    method,
    sqlRows: chosenCandidate.sqlRows ?? 0,
    estimatedSelectivity,
    notes,
  };
}

export function stageOf(assignment: Assignment, index: number): Stage {
  if (index < assignment.sqlEnd) return 'sql';
  if (index < assignment.cpuEnd) return 'cpu';
  return 'gpu';
}

// ---------------------------------------------------------------------------
// Pricing one candidate
// ---------------------------------------------------------------------------

function evaluate(analysis: Analysis, assignment: Assignment, ctx: OptimizeContext): Candidate {
  const { costs, caps, stats } = ctx;
  const n = analysis.order.length;
  const text = label(assignment, n);

  // --- legality -----------------------------------------------------------
  for (let i = 0; i < n; i++) {
    const node = analysis.order[i];
    const stage = stageOf(assignment, i);
    if (!node.feasible.has(stage)) {
      const reason =
        node.kind === 'aggregate'
          ? `aggregate '${node.id}' cannot run after the SQL stage has closed`
          : stage === 'sql'
            ? `'${node.id}' is not SQL-expressible (ramp/swizzle)`
            : `'${node.id}' has no ${stage.toUpperCase()} form`;
      return { assignment, legal: false, reason, label: text };
    }
    if (stage === 'gpu' && !caps.compute) {
      return {
        assignment,
        legal: false,
        reason: `target '${caps.id}' has no compute shaders, so '${node.id}' cannot run on the GPU`,
        label: text,
      };
    }
  }

  // --- cardinality --------------------------------------------------------
  const sourceRows = stats?.rows ?? fallbackRows(analysis);
  let sqlRows = sourceRows;
  const acc = new CostAccumulator();

  let sqlSelectivity = 1;
  for (let i = 0; i < assignment.sqlEnd; i++) {
    const node = analysis.order[i];
    if (node.kind === 'filter' && stats) {
      sqlSelectivity *= estimateSelectivity(node.expr!, stats, ctx.params);
    } else if (node.kind === 'filter') {
      sqlSelectivity *= DEFAULT_SELECTIVITY;
    }
  }
  sqlRows = Math.max(1, Math.round(sourceRows * sqlSelectivity));

  // An aggregate inside the SQL stage replaces the row count with the group count.
  const aggregateIndex = analysis.order.findIndex((node) => node.kind === 'aggregate');
  if (aggregateIndex >= 0 && aggregateIndex < assignment.sqlEnd) {
    sqlRows = estimateGroups(analysis.groupBy, stats, sqlRows);
  }

  // --- SQL stage ----------------------------------------------------------
  const sqlOps = sum(analysis.order.slice(0, assignment.sqlEnd).map((node) => node.ops));
  // Columns scanned: source columns any surviving node reads.
  const downstreamReads = new Set<string>();
  for (let i = assignment.sqlEnd; i < n; i++) {
    for (const r of analysis.order[i].reads) downstreamReads.add(r);
  }
  for (const s of analysis.statsNodes) downstreamReads.add(s.column);
  for (let i = 0; i < assignment.sqlEnd; i++) {
    for (const r of analysis.order[i].reads) downstreamReads.add(r);
  }
  const scannedColumns = Math.max(1, [...downstreamReads].filter((c) => analysis.sourceSchema.has(c)).length);
  acc.addBuild('duckdb scan', sqlScanMs(costs, sourceRows, scannedColumns, sqlOps));

  // --- attributes crossing into the GPU -----------------------------------
  // Passthrough source columns the later stages read.
  const passthrough = [...downstreamReads].filter((c) => analysis.sourceSchema.has(c));
  const chunks = estimateChunks(sqlRows);
  for (const col of passthrough) {
    const bytes = sqlRows * 4;
    acc.addBuild('upload arrow columns', uploadMs(costs, bytes, chunks));
    acc.addGpuBytes(bytes);
    const colStats = stats?.columns.get(col);
    // f64 or nullable columns cannot be handed to the GPU as-is.
    if (!colStats || colStats.isF64 || colStats.nullFrac > 0) {
      acc.addBuild('arrow -> f32 cast', castMs(costs, sqlRows));
    }
  }

  // Attributes produced by the SQL stage: uploaded, and interleaved if they are vectors.
  for (let i = 0; i < assignment.sqlEnd; i++) {
    const node = analysis.order[i];
    if (node.kind !== 'attribute') continue;
    const bytes = sqlRows * node.width * 4;
    acc.addBuild('upload arrow columns', uploadMs(costs, bytes, chunks * node.width));
    acc.addGpuBytes(bytes);
    if (node.width > 1) {
      // SQL columns are scalars, so a vec3 arrives as three columns and must be packed.
      acc.addBuild('interleave sql vectors', interleaveMs(costs, sqlRows * node.width));
    }
  }

  // --- CPU stage ----------------------------------------------------------
  const cpuOps = sum(analysis.order.slice(assignment.sqlEnd, assignment.cpuEnd).map((node) => node.ops));
  if (cpuOps > 0) acc.addBuild('cpu js loop', cpuEvalMs(costs, sqlRows, cpuOps));
  for (let i = assignment.sqlEnd; i < assignment.cpuEnd; i++) {
    const node = analysis.order[i];
    if (node.kind !== 'attribute') continue;
    const bytes = sqlRows * node.width * 4;
    acc.addBuild('upload cpu results', uploadMs(costs, bytes, 1));
    acc.addGpuBytes(bytes);
  }

  // --- GPU stage ----------------------------------------------------------
  const gpuOps = sum(analysis.order.slice(assignment.cpuEnd).map((node) => node.ops));
  if (gpuOps > 0) acc.addBuild('gpu kernel', kernelMs(costs, sqlRows, gpuOps));
  for (let i = assignment.cpuEnd; i < n; i++) {
    const node = analysis.order[i];
    if (node.kind !== 'attribute') continue;
    acc.addGpuBytes(sqlRows * node.width * 4);
  }

  // --- memory constraint --------------------------------------------------
  const gpuBytes = acc.result().gpuBytes;
  if (gpuBytes > caps.gpuBudgetBytes) {
    return {
      assignment,
      legal: false,
      reason: `needs ${mb(gpuBytes)} of attribute buffers, over the ${mb(caps.gpuBudgetBytes)} budget`,
      label: text,
      sqlRows,
    };
  }

  // --- binding constraint -------------------------------------------------
  // The fused kernel binds one storage buffer per attribute it touches, plus the ramp LUT.
  // Exceeding the per-stage limit is a hard failure at pipeline creation, so it has to be
  // caught here rather than discovered as a WebGPU validation error at first draw.
  const bindings = countStorageBindings(analysis, assignment);
  if (bindings.total > caps.maxStorageBuffersPerStage) {
    return {
      assignment,
      legal: false,
      reason: `fused kernel needs ${bindings.total} storage buffers (${bindings.reads} read + ${bindings.writes} written${bindings.ramp ? ' + ramp LUT' : ''}), over the per-stage limit of ${caps.maxStorageBuffersPerStage}`,
      label: text,
      sqlRows,
    };
  }

  // --- amortised interaction ----------------------------------------------
  // Suffix costs: what re-running from a given stage would cost.
  const castElements = passthrough.length * sqlRows;
  const totalBytes = gpuBytes;
  const suffix = {
    sql: sqlScanMs(costs, sourceRows, scannedColumns, sqlOps)
      + castMs(costs, castElements)
      + uploadMs(costs, totalBytes, chunks)
      + cpuEvalMs(costs, sqlRows, cpuOps)
      + kernelMs(costs, sqlRows, gpuOps),
    cpu: cpuEvalMs(costs, sqlRows, cpuOps)
      + uploadMs(costs, totalBytes, 1)
      + kernelMs(costs, sqlRows, gpuOps),
    gpu: costs.uniformWriteMs + (gpuOps > 0 ? kernelMs(costs, sqlRows, gpuOps) : 0),
  };

  // Drawing is a recurring cost, and the number of instances is what a filter's placement
  // decides. A discard mask keeps every row and re-rasterizes it every frame; a SQL filter
  // removes it once. Omitting this term made masked plans look cheaper than filtered ones.
  const frames = costs.horizonSec * costs.frameRateHz;
  acc.addInteract(
    `render ${sqlRows.toLocaleString()} instances x ${frames.toFixed(0)} frames`,
    frames * renderFrameMs(costs, sqlRows),
  );

  for (const [name, spec] of Object.entries(analysis.params)) {
    const rate = changeRate(spec);
    if (rate <= 0) continue;
    // A change to a parameter invalidates from the most upstream node that reads it, so
    // that node's stage sets the price.
    let earliest: Stage | undefined;
    for (let i = 0; i < n; i++) {
      if (!analysis.order[i].params.includes(name)) continue;
      const stage = stageOf(assignment, i);
      earliest = earliest === undefined ? stage : earlier(earliest, stage);
    }
    if (!earliest) continue;
    acc.addInteract(`rebind ${name} (${earliest}, ${rate}/s)`, rate * costs.horizonSec * suffix[earliest]);
  }

  return { assignment, legal: true, cost: acc.result(), sqlRows, label: text };
}

// ---------------------------------------------------------------------------
// Rule-based policies, expressed as boundaries
// ---------------------------------------------------------------------------

/**
 * The legacy rules, restated as a choice of boundary so every policy goes through the
 * same pricing and codegen path. Kept so the cost model can be measured against them
 * rather than merely replacing them.
 */
function policyAssignment(analysis: Analysis, ctx: OptimizeContext, notes: string[]): Assignment {
  const n = analysis.order.length;

  switch (ctx.policy) {
    case 'gpu-first': {
      // Everything on the GPU; a filter becomes a discard mask.
      notes.push('policy gpu-first: no SQL stage, filters become discard masks');
      return { sqlEnd: 0, cpuEnd: 0 };
    }

    case 'sql-first': {
      // Longest legal SQL prefix, no CPU stage.
      let sqlEnd = 0;
      while (sqlEnd < n && analysis.order[sqlEnd].feasible.has('sql')) sqlEnd++;
      notes.push(`policy sql-first: ${sqlEnd} of ${n} nodes pushed into SQL`);
      return { sqlEnd, cpuEnd: sqlEnd };
    }

    case 'auto':
    case 'cost':
    default: {
      // The original heuristic: keep taking nodes into SQL while they either reduce
      // volume (filter, aggregate) or have no GPU form. Stop at the first
      // volume-preserving per-row node, because those are cheaper to reparameterise on
      // the GPU.
      let sqlEnd = 0;
      while (sqlEnd < n) {
        const node = analysis.order[sqlEnd];
        const reduces = node.kind === 'filter' || node.kind === 'aggregate';
        const gpuCapable = node.feasible.has('gpu');
        if (!node.feasible.has('sql')) break;
        if (!reduces && gpuCapable) break;
        sqlEnd++;
      }
      // If a GPU stage is impossible, everything after the SQL prefix must go to the CPU.
      const cpuEnd = ctx.caps.compute ? sqlEnd : n;
      if (!ctx.caps.compute) {
        notes.push(`target '${ctx.caps.id}' has no compute, so the remaining ${n - sqlEnd} node(s) run on the CPU`);
      }
      return { sqlEnd, cpuEnd };
    }
  }
}

// ---------------------------------------------------------------------------

function changeRate(spec: { changeRate?: number; kind?: 'value' | 'structural' }): number {
  if (spec.changeRate !== undefined) return Math.max(0, spec.changeRate);
  // A structural parameter recompiles the plan, so amortising it here would double count.
  return spec.kind === 'structural' ? 0 : 2;
}

const STAGE_ORDER: Record<Stage, number> = { sql: 0, cpu: 1, gpu: 2 };

function earlier(a: Stage, b: Stage): Stage {
  return STAGE_ORDER[a] <= STAGE_ORDER[b] ? a : b;
}

/**
 * Storage buffers the fused GPU kernel will bind, mirroring `buildKernel`'s bookkeeping:
 * one per attribute written, one per attribute read that the kernel does not itself write,
 * and one for the color LUT if any node calls `ramp()`.
 */
function countStorageBindings(
  analysis: Analysis,
  assignment: Assignment,
): { reads: number; writes: number; ramp: boolean; total: number } {
  const gpuNodes = analysis.order.slice(assignment.cpuEnd);
  if (gpuNodes.length === 0) return { reads: 0, writes: 0, ramp: false, total: 0 };

  // Must match `buildKernel`: a temporary nothing outside the kernel reads stays in a
  // register and is never bound. Render channels and the mask are the external names.
  const external = new Set<string>([
    analysis.render.position ?? 'P',
    analysis.render.color ?? 'Cd',
    analysis.render.size ?? 'pscale',
    analysis.render.opacity ?? 'Alpha',
    '__mask',
  ]);
  if (analysis.bin2d?.weight) external.add(analysis.bin2d.weight);

  const written = new Set<string>();
  const registerOnly = new Set<string>();
  const read = new Set<string>();
  let ramp = false;
  for (const node of gpuNodes) {
    for (const r of node.reads) if (!written.has(r) && !registerOnly.has(r)) read.add(r);
    if (node.kind === 'attribute' && node.name) {
      if (external.has(node.name)) written.add(node.name);
      else registerOnly.add(node.name);
    }
    if (node.kind === 'filter') written.add('__mask');
    if (node.expr && usesRamp(node)) ramp = true;
  }
  for (const t of registerOnly) read.delete(t);
  // A name both read and written needs one read_write binding, not two.
  for (const w of written) read.delete(w);
  const total = read.size + written.size + (ramp ? 1 : 0);
  return { reads: read.size, writes: written.size, ramp, total };
}

function usesRamp(node: { expr?: { kind: string } }): boolean {
  const walk = (e: unknown): boolean => {
    if (!e || typeof e !== 'object') return false;
    const n = e as { kind?: string; fn?: string } & Record<string, unknown>;
    if (n.kind === 'call' && n.fn === 'ramp') return true;
    return Object.values(n).some((v) =>
      Array.isArray(v) ? v.some(walk) : typeof v === 'object' && walk(v),
    );
  };
  return walk(node.expr);
}

/**
 * Estimated group count for a GROUP BY: the product of the key columns' distinct counts,
 * capped at the input row count. Standard, and standardly an overestimate when the keys
 * are correlated.
 */
function estimateGroups(groupBy: string[], stats: SourceStats | undefined, inputRows: number): number {
  if (groupBy.length === 0) return 1;
  if (!stats) return Math.max(1, Math.min(inputRows, 100));
  let product = 1;
  for (const key of groupBy) {
    product *= stats.columns.get(key)?.ndv ?? 10;
  }
  return Math.max(1, Math.min(inputRows, Math.round(product)));
}

/** Row count when no statistics exist, so costs stay finite and comparable. */
function fallbackRows(analysis: Analysis): number {
  return analysis.source.dataset.estimatedRows ?? 1_000_000;
}

function label(a: Assignment, n: number): string {
  const parts = [`sql[0,${a.sqlEnd})`];
  if (a.cpuEnd > a.sqlEnd) parts.push(`cpu[${a.sqlEnd},${a.cpuEnd})`);
  if (n > a.cpuEnd) parts.push(`gpu[${a.cpuEnd},${n})`);
  return parts.join(' ');
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
