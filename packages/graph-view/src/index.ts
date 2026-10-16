/**
 * @noodles.gl/graph-view: a JSON description of a node graph, its layout, and (from
 * `@noodles.gl/graph-view/react`) a viewer.
 *
 * This entry is headless and has no dependencies, so a producer can build and validate a
 * description without React or a DOM.
 */

export {
  GRAPH_DESCRIPTION_VERSION,
  type GraphDescription, type GraphNode, type GraphNodeRole, type GraphEdge,
  type GraphMetric, type GraphMetricUnit,
} from './schema.js';
export { validateGraph } from './validate.js';
export { layoutGraph, type LayoutOptions, type GraphLayout, type NodeSize } from './layout.js';
export { collapseData } from './collapse.js';
export { formatMetric } from './format.js';
