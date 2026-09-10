/**
 * WebGPU runtime: executes a physical plan produced by the core entry.
 *
 * Needs a `GPUDevice` and a `SqlEngine`. No dependency on deck.gl or on any particular
 * database driver — the engine arrives through the interface in `core/source.ts`.
 */

export { initGpu, GpuUnavailable, type Gpu } from './device.js';
export { AttributeSet, align4, type GpuAttribute } from './attributes.js';
export { Kernel } from './compute.js';
export {
  OrbitCamera, perspective, lookAt, multiply, VIEW_UNIFORM_SIZE, type OrbitState,
} from './camera.js';
export { calibrate, type CalibrationReport } from './calibrate.js';
export { gpuData } from './gpu-compat.js';
export {
  PointsPass, pointsShader, STYLE_UNIFORM_SIZE, type PointsBindings,
} from './passes/points.js';
export { Bin2dPass, WEIGHT_FIXED_POINT, type Bin2dBindings } from './passes/bin2d.js';
export {
  Runtime,
  type BuildResult, type BuildTimings, type AttributeReport,
} from './runtime.js';
