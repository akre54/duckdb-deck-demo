/**
 * Headless core: everything from a JSON graph to a physical plan, with no GPU, no DOM and
 * no database driver.
 *
 * The only runtime dependency is `apache-arrow`. Import this entry to use the expression IR,
 * the planner and the cost model on their own — a build step, a server, or a test can plan a
 * graph and inspect the generated SQL and WGSL without ever creating a device.
 */

// --- expression IR ---------------------------------------------------------
export {
  parseExpr, walk, columnsOf, paramsOf, enginesFor, isAggregate, widthOf,
  FUNCTIONS, ExprError,
  type Expr, type UnaryOp, type BinaryOp, type Engine, type FnSpec, type WidthEnv,
} from './expr.js';

// --- backends --------------------------------------------------------------
export { toSql, toSqlColumns, quoteIdent, type SqlEmit } from './backends/sql.js';
export { toWgsl, wgslType, type Resolver, type WgslEmit } from './backends/wgsl.js';
export { toJs, type JsResolver, type JsEmit } from './backends/js.js';

// --- graph schema and sugar ------------------------------------------------
export {
  desugar, statExpr, statParamName, buildRampLut, RAMP_STOPS,
  type Graph, type GraphNode, type CoreNode, type ParamSpec, type RampName,
  type SourceNode, type FilterNode, type AggregateNode, type StatsNode, type StatOp,
  type AttributeNode, type ScaleNode, type ColorScaleNode, type ProjectNode,
  type WrangleNode, type Bin2dNode, type RenderNode,
} from './types.js';
export {
  parseWrangle, expandWrangle, localName, renameColumns, WrangleError,
  type WrangleStatement,
} from './wrangle.js';

// --- planning --------------------------------------------------------------
export {
  analyze, opCount, PlanError,
  type Analysis, type AnalyzedNode, type Schema, type Stage,
} from './analyze.js';
export {
  optimize, stageOf,
  type Policy, type Assignment, type Candidate, type OptimizeContext, type OptimizeResult,
} from './optimizer.js';
export {
  plan, WORKGROUP, DEFAULT_RELATION, bufName,
  type PhysicalPlan, type PlanOptions, type AttributeDecl, type KernelPlan,
  type StatsPlan, type StageNode, type Explain,
} from './planner.js';

// --- cost model and statistics --------------------------------------------
export {
  DEFAULT_COSTS, CostAccumulator, emptyBreakdown,
  sqlScanMs, uploadMs, castMs, interleaveMs, kernelMs, cpuEvalMs, renderFrameMs,
  estimateChunks, DUCKDB_BATCH_ROWS,
  type CostConstants, type CostBreakdown, type CostTerm,
} from './cost.js';
export {
  statsSql, parseStatsRow, estimateSelectivity, attributeBytes, referencedColumns,
  DEFAULT_SELECTIVITY,
  type ColumnStats, type SourceStats,
} from './stats.js';

// --- targets ---------------------------------------------------------------
export { targetCaps, TARGET_IDS, type TargetId, type TargetCaps } from './target.js';

// --- data sources ----------------------------------------------------------
export {
  SourceRegistry, relationSource, parquetUrlSource, sqlSource,
  quoteRelation, escapeLiteral,
  type SqlEngine, type SourceProvider, type QueryTiming,
} from './source.js';

// --- Arrow -> f32 and the CPU stage ---------------------------------------
export {
  readColumn, readVectorColumns, type Tier, type ColumnUpload,
} from './arrow.js';
export {
  evaluateStage, materialize, toUint8Color, type CpuAttributes,
} from './cpu-stage.js';
