import type { GraphDescription, GraphEdge } from './schema.js';

/**
 * A pass-only view of a description: each data node between two pieces of work becomes an edge
 * from its writer to its reader, labelled with the resource.
 *
 * Data with no writer (an imported buffer) or no reader (a result) stays a node. Those are the
 * graph's inputs and outputs, and dropping them would leave the first and last passes with
 * nothing to say about where their data comes from or goes.
 *
 * Several resources between the same two passes become one edge listing all of them, not
 * parallel edges the layout would draw on top of each other.
 */
export function collapseData(description: GraphDescription): GraphDescription {
  const role = new Map(description.nodes.map((n) => [n.id, n.role ?? 'work']));
  const label = new Map(description.nodes.map((n) => [n.id, n.label ?? n.id]));
  const into = new Map<string, string[]>();
  const outOf = new Map<string, string[]>();
  for (const e of description.edges) {
    if (role.get(e.to) === 'data') (into.get(e.to) ?? into.set(e.to, []).get(e.to)!).push(e.from);
    if (role.get(e.from) === 'data') (outOf.get(e.from) ?? outOf.set(e.from, []).get(e.from)!).push(e.to);
  }
  const collapsed = new Set(
    description.nodes
      .filter((n) => n.role === 'data' && into.has(n.id) && outOf.has(n.id))
      .map((n) => n.id),
  );

  const kept: GraphEdge[] = description.edges.filter((e) => !collapsed.has(e.from) && !collapsed.has(e.to));
  const bridged = new Map<string, { from: string; to: string; labels: string[] }>();
  for (const id of collapsed) {
    for (const from of into.get(id)!) {
      for (const to of outOf.get(id)!) {
        if (from === to) continue;
        const key = `${from}\u0000${to}`;
        const edge = bridged.get(key) ?? bridged.set(key, { from, to, labels: [] }).get(key)!;
        if (!edge.labels.includes(label.get(id)!)) edge.labels.push(label.get(id)!);
      }
    }
  }
  return {
    ...description,
    nodes: description.nodes.filter((n) => !collapsed.has(n.id)),
    edges: [
      ...kept,
      ...[...bridged.values()].map(({ from, to, labels }) => ({ from, to, kind: 'data', label: labels.join(', ') })),
    ],
  };
}
