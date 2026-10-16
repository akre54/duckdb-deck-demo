import { GRAPH_DESCRIPTION_VERSION, type GraphDescription } from './schema.js';

/**
 * Problems with a description, as readable strings; empty when it is usable.
 *
 * Returned rather than thrown because a description often comes from another process or a saved
 * file, and a viewer should show what is wrong with it instead of a blank canvas.
 */
export function validateGraph(description: GraphDescription): string[] {
  const errors: string[] = [];
  if (description.version !== GRAPH_DESCRIPTION_VERSION) {
    errors.push(`unsupported version ${String(description.version)}; expected ${GRAPH_DESCRIPTION_VERSION}`);
  }
  const ids = new Set<string>();
  for (const node of description.nodes) {
    if (ids.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
    ids.add(node.id);
  }
  for (const edge of description.edges) {
    if (!ids.has(edge.from)) errors.push(`edge from missing node "${edge.from}"`);
    if (!ids.has(edge.to)) errors.push(`edge to missing node "${edge.to}"`);
  }
  return errors;
}
