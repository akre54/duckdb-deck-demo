/**
 * Headless core: everything from a JSON graph to a physical plan, with no GPU, no DOM and
 * no database driver.
 *
 * `apache-arrow` is used for types only, so the built output has no runtime imports at all.
 * Import this entry to use the expression IR,
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
export {
  toSql, toSqlColumns, quoteIdent, castToFloat, SqlParams, type SqlEmit,
} from './backends/sql.js';
export {
  toWgsl, wgslType, wgslParamMember, type Resolver, type WgslEmit,
} from './backends/wgsl.js';
export { toJs, type JsResolver, type JsEmit } from './backends/js.js';

// --- attribute vocabulary --------------------------------------------------
export {
  attributeConventions, isInternal, HOUDINI_CONVENTIONS,
  type AttributeConventions,
} from './conventions.js';

// --- user-defined functions ------------------------------------------------
export {
  buildRegistry, defineFunction, addFunction, inlineFunctions,
  parseFunctionDeclaration, FunctionError,
  type FunctionDef, type FunctionSpec, type FunctionRegistry,
} from './functions.js';

// --- graph schema and sugar ------------------------------------------------
export {
  desugar, statExpr, statParamName, buildRampLut, RAMP_STOPS,
  type Graph, type GraphNode, type CoreNode, type ParamSpec, type RampName,
  type SourceNode, type FilterNode, type AggregateNode, type StatsNode, type StatOp,
  type AttributeNode, type ScaleNode, type ColorScaleNode, type ProjectNode,
  type WrangleNode, type Bin2dNode, type RenderNode, type RawNode, type LayerNode,
} from './types.js';
export {
  LAYER_KINDS, LAYER_SPECS, propParam, resolveProps,
  type LayerKind, type LayerKindSpec, type ChannelSpec, type ChannelType, type LayerPropValue,
} from './layers.js';
export {
  parseWrangle, expandWrangle, localName, renameColumns, WrangleError,
  type WrangleStatement,
} from './wrangle.js';

// --- planning --------------------------------------------------------------
export {
  analyze, opCount, PlanError, externalAttributes,
  type Analysis, type AnalyzedNode, type Schema, type Stage, type RenderChannels,
  type LayerAnalysis, type LayerBinding,
} from './analyze.js';
export {
  optimize, stageOf,
  type Policy, type Assignment, type Candidate, type OptimizeContext, type OptimizeResult,
} from './optimizer.js';
export {
  plan, WORKGROUP, DEFAULT_RELATION, bufName,
  type PhysicalPlan, type PlanOptions, type AttributeDecl, type KernelPlan,
  type StatsPlan, type StageNode, type RawStage, type Explain,
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
export {
  targetCaps, TARGET_IDS, type TargetId, type TargetCaps, type DeviceLimits,
} from './target.js';

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
