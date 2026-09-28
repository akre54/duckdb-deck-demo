/**
 * luma.gl GPU Dataframe integration: an optional filter engine that compacts rows on the GPU.
 *
 * Separate from `./webgpu` so that entry keeps no luma dependency; `@luma.gl/experimental`
 * is an optional peer and only this entry imports it.
 */

export { LumaFilter, lumaCompactor, toLumaExpr, type LumaFilterProps, type LumaTopology } from './dataframe.js';
