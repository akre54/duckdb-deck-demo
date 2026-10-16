/**
 * Layouts with a dependency each, kept out of the main entry so it stays dependency-free:
 * `dagreLayout` needs `@dagrejs/dagre` and `forceLayout` needs `d3-force` (optional peers).
 * Each is a `LayoutFunction`, so `GraphView` takes it as `layout`.
 */

export { dagreLayout } from './dagre.js';
export { forceLayout } from './force.js';
