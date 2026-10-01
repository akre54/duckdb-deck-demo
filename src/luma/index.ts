/**
 * luma.gl GPU Dataframe integration: an optional filter engine that compacts rows on the GPU,
 * and a dense group-by over the same buffers.
 *
 * Separate from `./webgpu` so that entry keeps no luma dependency; `@luma.gl/experimental`
 * is an optional peer and only this entry imports it.
 */

export {
  LumaFilter, LumaGroupBy, lumaCompactor, toLumaExpr,
  type LumaFilterProps, type LumaGroupByProps, type LumaAggregate, type LumaTopology,
} from './dataframe.js';
