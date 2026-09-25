/**
 * Document edits, as pure functions on a draft. The UI calls these inside `store.edit`, so
 * every one is an undo step and none of them touch React.
 */

import {
  OPERATOR_INDEX, nameOf, nodePath, setKeyframe, canConnect, resolveRef, isRef, isExpr,
  type EditorDoc, type DocNode, type DocEdge, type ParamValue, type Keyframe, type PortType,
} from '@noodles.gl/planner';

let counter = 0;
export const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

/** A name not yet used in the network, Houdini-style: `filter1`, `filter2`… */
export function uniqueName(doc: EditorDoc, parent: string | undefined, base: string): string {
  const taken = new Set(doc.nodes.filter((n) => n.parent === parent).map(nameOf));
  const stem = base.replace(/\d+$/, '').replace(/[^A-Za-z0-9_]/g, '_') || 'node';
  for (let i = 1; ; i++) if (!taken.has(`${stem}${i}`)) return `${stem}${i}`;
}

export function addNode(doc: EditorDoc, op: string, x: number, y: number, parent?: string): DocNode {
  const def = OPERATOR_INDEX.get(op);
  if (!def) throw new Error(`unknown operator ${op}`);
  const node: DocNode = {
    id: newId('n'), op, name: uniqueName(doc, parent, op.replace(/-/g, '_')), parent, x, y,
    params: {},
  };
  if (op === 'subnet-input' || op === 'subnet-output') node.params.index = 0;
  doc.nodes.push(node);
  return node;
}

export function portType(doc: EditorDoc, nodeId: string, port: string, side: 'in' | 'out'): PortType | 'param' | undefined {
  const node = doc.nodes.find((n) => n.id === nodeId);
  const def = node && OPERATOR_INDEX.get(node.op);
  if (!def) return undefined;
  if (side === 'in' && port.startsWith('par:')) return 'param';
  const spec = (side === 'in' ? def.inputs : def.outputs).find((p) => p.name === port);
  return spec?.type;
}

export function isMulti(doc: EditorDoc, nodeId: string, port: string): boolean {
  const node = doc.nodes.find((n) => n.id === nodeId);
  return !!(node && OPERATOR_INDEX.get(node.op)?.inputs.find((p) => p.name === port)?.multi);
}

export function validConnection(doc: EditorDoc, source: string, sourcePort: string, target: string, targetPort: string): boolean {
  if (source === target) return false;
  const from = portType(doc, source, sourcePort, 'out');
  const to = portType(doc, target, targetPort, 'in');
  if (!from || !to || to === undefined) return false;
  if (!canConnect(from as PortType, to)) return false;
  // No cycles through table and layer edges.
  const downstream = new Set<string>([target]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of doc.edges) {
      if (downstream.has(e.source) && !downstream.has(e.target)) { downstream.add(e.target); grew = true; }
    }
  }
  return !downstream.has(source);
}

export function connect(doc: EditorDoc, source: string, sourcePort: string, target: string, targetPort: string): void {
  if (!validConnection(doc, source, sourcePort, target, targetPort)) return;
  const multi = isMulti(doc, target, targetPort);
  if (!multi) doc.edges = doc.edges.filter((e) => !(e.target === target && e.targetPort === targetPort));
  if (doc.edges.some((e) => e.source === source && e.sourcePort === sourcePort && e.target === target && e.targetPort === targetPort)) return;
  const index = multi ? doc.edges.filter((e) => e.target === target && e.targetPort === targetPort).length : undefined;
  doc.edges.push({ id: newId('e'), source, sourcePort, target, targetPort, index });
}

export function removeNodes(doc: EditorDoc, ids: string[]): void {
  const drop = new Set(ids);
  // Removing a subnet removes what is inside it.
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of doc.nodes) if (n.parent && drop.has(n.parent) && !drop.has(n.id)) { drop.add(n.id); grew = true; }
  }
  doc.nodes = doc.nodes.filter((n) => !drop.has(n.id));
  doc.edges = doc.edges.filter((e) => !drop.has(e.source) && !drop.has(e.target));
  if (doc.timeline) doc.timeline.tracks = doc.timeline.tracks.filter((t) => !drop.has(t.target.split('.')[0]));
}

/** Put a node with one table input and output onto an edge. */
export function insertOnEdge(doc: EditorDoc, edgeId: string, op: string): DocNode | undefined {
  const edge = doc.edges.find((e) => e.id === edgeId);
  const def = OPERATOR_INDEX.get(op);
  if (!edge || !def) return undefined;
  const input = def.inputs.find((p) => p.type === 'table');
  const output = def.outputs.find((p) => p.type === 'table');
  if (!input || !output) return undefined;
  const a = doc.nodes.find((n) => n.id === edge.source)!;
  const b = doc.nodes.find((n) => n.id === edge.target)!;
  const node = addNode(doc, op, (a.x + b.x) / 2, (a.y + b.y) / 2 + 40, a.parent);
  doc.edges = doc.edges.filter((e) => e.id !== edgeId);
  doc.edges.push(
    { id: newId('e'), source: edge.source, sourcePort: edge.sourcePort, target: node.id, targetPort: input.name },
    { id: newId('e'), source: node.id, sourcePort: output.name, target: edge.target, targetPort: edge.targetPort, index: edge.index },
  );
  return node;
}

/**
 * Collapse a selection into a subnet. Edges entering the selection become subnet inputs
 * (at most two tables), the first edge leaving it the subnet output. Children keep their ids,
 * so their parameters, keyframes and relation hashes are unchanged.
 */
export function collapseToSubnet(doc: EditorDoc, ids: string[]): DocNode | undefined {
  const inside = new Set(ids);
  const members = doc.nodes.filter((n) => inside.has(n.id));
  if (members.length === 0) return undefined;
  const parent = members[0].parent;
  const cx = members.reduce((s, n) => s + n.x, 0) / members.length;
  const cy = members.reduce((s, n) => s + n.y, 0) / members.length;
  const sub = addNode(doc, 'subnet', cx, cy, parent);
  const entering = doc.edges.filter((e) => !inside.has(e.source) && inside.has(e.target) && !e.targetPort.startsWith('par:'));
  const leaving = doc.edges.filter((e) => inside.has(e.source) && !inside.has(e.target));
  const tableIn = [...new Map(entering.map((e) => [`${e.source}:${e.sourcePort}`, e])).values()];
  if (tableIn.length > 2) throw new Error('A subnet takes at most two inputs; select fewer entry points');
  const minX = Math.min(...members.map((n) => n.x));
  const maxX = Math.max(...members.map((n) => n.x));
  // Endpoints are copied before any edge is rewired: `tableIn` holds the same objects as
  // `entering`, and rewiring first would point the outer edge at the subnet's own input node.
  const sources = tableIn.map((e) => ({ source: e.source, port: e.sourcePort }));
  sources.forEach(({ source, port }, i) => {
    const inNode = addNode(doc, 'subnet-input', minX - 240, cy + i * 120, sub.id);
    inNode.params.index = i;
    for (const x of entering.filter((x) => x.source === source && x.sourcePort === port)) {
      x.source = inNode.id;
      x.sourcePort = 'out';
    }
    doc.edges.push({ id: newId('e'), source, sourcePort: port, target: sub.id, targetPort: `in${i}` });
  });
  const firstOut = leaving[0] && { source: leaving[0].source, port: leaving[0].sourcePort };
  if (firstOut) {
    const outNode = addNode(doc, 'subnet-output', maxX + 240, cy, sub.id);
    doc.edges.push({ id: newId('e'), source: firstOut.source, sourcePort: firstOut.port, target: outNode.id, targetPort: 'in' });
    for (const x of leaving.filter((x) => x.source === firstOut.source && x.sourcePort === firstOut.port)) {
      x.source = sub.id;
      x.sourcePort = 'out0';
    }
  }
  const before = structuredClone(doc);
  for (const n of members) n.parent = sub.id;
  rebaseReferences(before, doc);
  return sub;
}

/** A path from `from` to parameter key `nodeId.param`: relative within a network, else absolute. */
export function pathTo(doc: EditorDoc, from: DocNode, key: string): string {
  const dot = key.indexOf('.');
  const [id, param] = [key.slice(0, dot), key.slice(dot + 1)];
  const target = doc.nodes.find((n) => n.id === id);
  if (!target) return `#${key}`;
  if (target.id === from.id) return param;
  if (target.parent === from.parent) return `${nameOf(target)}/${param}`;
  return `${nodePath(doc, target)}/${param}`;
}

const CH = /\bch\(\s*(['"])(.*?)\1\s*\)/g;

/**
 * Keep references pointing at the same parameters after nodes moved between networks or were
 * renamed. Every path is resolved against `before`, then rewritten from where its node is now.
 * Houdini does the same when you collapse a subnet or rename a node; without it a relative
 * `ch('ctl/k')` silently stops resolving and the parameter reads NaN.
 */
export function rebaseReferences(before: EditorDoc, after: EditorDoc): void {
  const old = new Map(before.nodes.map((n) => [n.id, n]));
  const rewrite = (node: DocNode, path: string): string => {
    const was = old.get(node.id);
    if (!was || path.startsWith('#')) return path;
    try {
      return pathTo(after, node, resolveRef(before, was, path));
    } catch {
      return path;
    }
  };
  for (const node of after.nodes) {
    for (const [name, value] of Object.entries(node.params)) {
      if (isRef(value)) node.params[name] = { ref: rewrite(node, value.ref) };
      else if (isExpr(value)) node.params[name] = { expr: value.expr.replace(CH, (_m, q, p) => `ch(${q}${rewrite(node, p)}${q})`) };
      else if (typeof value === 'string' && CH.test(value)) node.params[name] = value.replace(CH, (_m, q, p) => `ch(${q}${rewrite(node, p)}${q})`);
      CH.lastIndex = 0;
    }
  }
}

/** Expose a child's parameter on its subnet. The subnet holds the value from now on. */
export function promote(doc: EditorDoc, nodeId: string, param: string, value: ParamValue): void {
  const node = doc.nodes.find((n) => n.id === nodeId);
  const sub = node?.parent ? doc.nodes.find((n) => n.id === node.parent) : undefined;
  if (!node || !sub) return;
  const def = OPERATOR_INDEX.get(node.op)?.params.find((p) => p.name === param);
  const name = `${nameOf(node)}_${param}`;
  sub.promoted = [...(sub.promoted ?? []).filter((p) => p.name !== name), { name, label: `${nameOf(node)} ${def?.label ?? param}`, node: nodeId, param }];
  sub.params[name] = value;
}

export function unpromote(doc: EditorDoc, subId: string, name: string): void {
  const sub = doc.nodes.find((n) => n.id === subId);
  if (!sub) return;
  sub.promoted = (sub.promoted ?? []).filter((p) => p.name !== name);
  delete sub.params[name];
}

// --- keyframes ---------------------------------------------------------------

export function ensureTimeline(doc: EditorDoc): NonNullable<EditorDoc['timeline']> {
  doc.timeline ??= { length: 10, fps: 30, tracks: [] };
  return doc.timeline;
}

export function setKey(doc: EditorDoc, target: string, time: number, value: number): void {
  const tl = ensureTimeline(doc);
  const track = tl.tracks.find((t) => t.target === target) ?? { target, keyframes: [] };
  const existing = track.keyframes.find((k) => Math.abs(k.time - time) < 1e-3);
  const key: Keyframe = existing
    ? { ...existing, value }
    : { id: newId('k'), time, value, interpolation: 'bezier', handles: { left: [0.42, 0], right: [0.58, 1] } };
  const next = setKeyframe(track, key);
  tl.tracks = [...tl.tracks.filter((t) => t.target !== target), next];
}

export function removeKey(doc: EditorDoc, target: string, time: number): void {
  const tl = doc.timeline;
  if (!tl) return;
  tl.tracks = tl.tracks
    .map((t) => (t.target === target ? { ...t, keyframes: t.keyframes.filter((k) => Math.abs(k.time - time) >= 1e-3) } : t))
    .filter((t) => t.keyframes.length > 0);
}

export function removeKeysById(doc: EditorDoc, ids: string[]): void {
  const tl = doc.timeline;
  if (!tl) return;
  const drop = new Set(ids);
  tl.tracks = tl.tracks.map((t) => ({ ...t, keyframes: t.keyframes.filter((k) => !drop.has(k.id)) })).filter((t) => t.keyframes.length > 0);
}

export function updateKey(doc: EditorDoc, id: string, patch: Partial<Keyframe>): void {
  const tl = doc.timeline;
  if (!tl) return;
  tl.tracks = tl.tracks.map((t) => ({
    ...t,
    keyframes: t.keyframes.map((k) => (k.id === id ? { ...k, ...patch } : k)).sort((a, b) => a.time - b.time),
  }));
}

export function clearTrack(doc: EditorDoc, target: string): void {
  if (doc.timeline) doc.timeline.tracks = doc.timeline.tracks.filter((t) => t.target !== target);
}

export function edgesInto(doc: EditorDoc, nodeId: string): DocEdge[] {
  return doc.edges.filter((e) => e.target === nodeId);
}

/** Rename a node, keeping every reference to it working. */
export function renameNode(doc: EditorDoc, id: string, name: string): boolean {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node || doc.nodes.some((n) => n.id !== id && n.parent === node.parent && nameOf(n) === name)) return false;
  const before = structuredClone(doc);
  node.name = name;
  rebaseReferences(before, doc);
  return true;
}
