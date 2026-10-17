/**
 * A luma.gl command graph as a `@noodles.gl/graph-view` description: passes as work nodes, the
 * buffers and textures they touch as data nodes, and reads and writes as edges.
 *
 * Most of what this needs, luma does not publish. `CompiledGPUCommandGraph` exposes the schedule
 * (`stats.nodeOrder`), per-node workload bounds (`preflight`) and timings (through
 * `GPUCommandGraphInspector`), but not what each node reads and writes. That lives in each node
 * definition's `resources`, which luma uses to infer dependencies and then keeps in a private
 * `compiledNodes` field (9.4.2 and master as of 2026-10-16). `resourceUsesOf` reads it there and
 * is the only function here that touches luma internals; it is what a public topology accessor
 * on the compiled graph would replace.
 *
 * Resources are versioned the way a frame graph versions them: every write produces a new data
 * node (`ids@2`), so a pass that reads and writes one buffer is an edge in and an edge out of two
 * nodes, not a cycle. Read-after-write is then visible as data flow. Write-after-read and
 * write-after-write ordering, which luma also infers, is implied by the versions and not drawn.
 */

import type { CompiledGPUCommandGraph, GPUCommandGraphInspectorGraphSnapshot } from '@luma.gl/gpgpu/gpu-core';
import type { GraphDescription, GraphEdge, GraphMetric, GraphNode } from '@noodles.gl/graph-view';
import { texelBytes } from './graph-preview.js';

export interface DescribeCommandGraphOptions {
  /** The graph's entry in `GPUCommandGraphInspector.getSnapshot()`, for CPU and GPU timings. */
  snapshot?: GPUCommandGraphInspectorGraphSnapshot;
  label?: string;
}

export function describeCommandGraph<P>(
  graph: CompiledGPUCommandGraph<P>, options: DescribeCommandGraphOptions = {},
): GraphDescription {
  return describeOne(graph, options).description;
}

export interface DescribedGraph<P = unknown> {
  graph: CompiledGPUCommandGraph<P>;
  snapshot?: GPUCommandGraphInspectorGraphSnapshot;
}

/**
 * Several command graphs that run in order, as one description: a GPU Dataframe query's graph,
 * then a graph that renders what it selected, say.
 *
 * Each graph is described on its own, then joined where they share data. A resource a later
 * graph imports and reads before writing is the same buffer or texture an earlier graph produced
 * when both name one physical luma resource, so it becomes that earlier node rather than a new
 * input: the query's `row indices` flows straight into the render passes that read it. Node ids
 * are prefixed with their graph's id, and every node records its graph in `attributes.graph`,
 * which is how `previewCommandGraphsResource` knows where to read.
 *
 * Whole-graph metrics add up per graph: the sum of medians, which is not the median of the sum
 * but is the cost of running them all.
 */
export function describeCommandGraphs(graphs: DescribedGraph[], options: { id?: string; label?: string } = {}): GraphDescription {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const latest = new Map<object, { id: string; version: number }>();
  const totals: Record<string, GraphMetric> = {};
  let order = 0;
  for (const { graph, snapshot } of graphs) {
    const { description, physicalOf } = describeOne(graph, { snapshot });
    const rename = new Map<string, string>();
    for (const n of description.nodes) {
      const physical = physicalOf.get(n.id);
      const upstream = physical && n.attributes?.version === 0 ? latest.get(physical) : undefined;
      if (upstream) { rename.set(n.id, upstream.id); continue; }
      const id = `${graph.id}:${n.id}`;
      rename.set(n.id, id);
      nodes.push({
        ...n, id,
        ...(n.order !== undefined ? { order: order + n.order } : {}),
        attributes: { ...n.attributes, graph: graph.id },
      });
    }
    for (const e of description.edges) edges.push({ ...e, from: rename.get(e.from)!, to: rename.get(e.to)! });
    // What this graph leaves in each shared resource is what the next graph reads. That includes
    // a resource it only read: the filter's input column is the render graph's input too.
    for (const n of description.nodes) {
      const physical = physicalOf.get(n.id);
      const version = Number(n.attributes?.version ?? 0);
      if (physical && version >= (latest.get(physical)?.version ?? -1)) latest.set(physical, { id: rename.get(n.id)!, version });
    }
    order += graph.stats.nodeOrder.length;
    for (const [k, m] of Object.entries(description.metrics ?? {})) {
      const t = totals[k];
      // Each run encodes every graph once, so encodings are the fewest any graph saw, not a sum.
      const value = !t ? m.value : k === 'encodings' ? Math.min(t.value, m.value) : t.value + m.value;
      totals[k] = { value, unit: m.unit };
    }
  }
  const id = options.id ?? graphs.map((g) => g.graph.id).join('+');
  return { version: 1, id, label: options.label ?? id, nodes, edges, metrics: totals };
}

/** One graph's description, and the physical buffer or texture behind each of its data nodes. */
function describeOne<P>(
  graph: CompiledGPUCommandGraph<P>, options: DescribeCommandGraphOptions,
): { description: GraphDescription; physicalOf: Map<string, object> } {
  const { snapshot } = options;
  const physicalOf = new Map<string, object>();
  const uses = resourceUsesOf(graph);
  const preflight = new Map(graph.preflight.nodes.map((n) => [n.id, n]));
  const timings = new Map(snapshot?.nodes.map((n) => [n.id, n]) ?? []);

  const prefix = sharedPrefix([...graph.stats.nodeOrder, ...[...uses.values()].flatMap((u) => u.resources.map((r) => r.id))]);
  const short = (id: string) => id.slice(prefix.length) || id;
  const passNames = stepNames(graph.stats.nodeOrder.map(short));
  const resourceNames = stepNames([...new Set([...uses.values()].flatMap((u) => u.resources.map((r) => short(r.id))))]);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const version = new Map<string, number>();
  const resourceNode = (r: ResourceUse, v: number): string => {
    const id = `${r.id}@${v}`;
    if (!nodes.some((n) => n.id === id)) {
      nodes.push({
        id,
        kind: r.kind,
        role: 'data',
        label: `${resourceNames.get(short(r.id)) ?? short(r.id)}${v > 1 ? ` (v${v})` : ''}`,
        metrics: r.byteLength !== undefined ? { bytes: { value: r.byteLength, unit: 'bytes' } } : undefined,
        // The layout of the bytes, which is what a preview needs to show them as values.
        attributes: { resource: r.id, version: v, transient: r.transient, ...r.layout },
      });
      if (r.physical) physicalOf.set(id, r.physical);
    }
    return id;
  };

  graph.stats.nodeOrder.forEach((nodeId, order) => {
    const node = uses.get(nodeId);
    const work = preflight.get(nodeId);
    const timing = timings.get(nodeId);
    const metrics: Record<string, GraphMetric> = {};
    if (timing?.gpu.p50Milliseconds !== undefined) metrics.gpu = sampled(timing.gpu);
    if (timing?.cpu.p50Milliseconds !== undefined) metrics.cpu = sampled(timing.cpu);
    if (work?.readByteLength) metrics.read = { value: work.readByteLength, unit: 'bytes' };
    if (work?.writeByteLength) metrics.write = { value: work.writeByteLength, unit: 'bytes' };
    if (work?.maximumInvocationCount) metrics.invocations = { value: work.maximumInvocationCount, unit: 'count' };
    nodes.push({
      id: nodeId,
      kind: node?.type ?? work?.type ?? 'compute',
      label: passNames.get(short(nodeId)) ?? short(nodeId),
      group: work?.operation ?? timing?.group,
      order,
      metrics,
      attributes: {
        ...(work?.operation ? { operation: work.operation } : {}),
        ...(work?.variant ? { variant: work.variant } : {}),
        ...(work?.commandCount ? { commands: work.commandCount } : {}),
      },
    });

    for (const r of node?.resources ?? []) {
      const current = version.get(r.id);
      // A read of a resource nothing in the graph has written is a read of its imported contents.
      // Color already says read or write; a label is only worth its clutter for the usages that
      // say something more (uniform, indirect, copy), not for a texture's ordinary sampled read or
      // attachment write.
      const label = r.usage.startsWith('storage-') || r.usage === 'sampled' || r.usage === 'render-attachment' ? undefined : r.usage;
      // The tooltip's facts: how the pass touches the resource, and how many bytes of it.
      const moved = r.range?.byteLength ?? r.byteLength;
      const detail = {
        ...(moved !== undefined ? { metrics: { bytes: { value: moved, unit: 'bytes' as const } } } : {}),
        attributes: {
          usage: r.usage, resource: short(r.id),
          ...(r.layout.format ? { format: r.layout.format } : {}),
          ...(r.range?.byteOffset ? { byteOffset: r.range.byteOffset } : {}),
        },
      };
      // luma counts a render attachment as read and written, since the pass may load it. The graph
      // does not record whether it clears or loads, so a texture's first use as an attachment is
      // taken as a clear: otherwise every render target grows an empty "input" twin. A pass that
      // loads an imported texture's contents (drawing over a canvas) loses that read edge.
      const reads = r.reads && !(r.usage === 'render-attachment' && current === undefined);
      if (reads) edges.push({ from: resourceNode(r, current ?? 0), to: nodeId, kind: 'read', label, ...detail });
      if (r.writes) {
        const next = (current ?? 0) + 1;
        version.set(r.id, next);
        edges.push({ from: nodeId, to: resourceNode(r, next), kind: 'write', label, ...detail });
      }
    }
    for (const before of node?.dependsOn ?? []) edges.push({ from: before, to: nodeId, kind: 'dependency' });
  });

  const metrics: Record<string, GraphMetric> = {
    'logical buffers': { value: graph.stats.logicalBufferBytes, unit: 'bytes' },
    'physical transients': { value: graph.stats.physicalTransientBytes, unit: 'bytes' },
    'reused by aliasing': { value: graph.stats.reusedTransientBytes, unit: 'bytes' },
  };
  if (snapshot?.totals.gpu.p50Milliseconds !== undefined) metrics.gpu = sampled(snapshot.totals.gpu);
  if (snapshot?.totals.cpu.p50Milliseconds !== undefined) metrics.cpu = sampled(snapshot.totals.cpu);
  if (snapshot) metrics.encodings = { value: snapshot.encodingCount, unit: 'count' };

  return { description: { version: 1, id: graph.id, label: options.label ?? graph.id, nodes, edges, metrics }, physicalOf };
}

function sampled(d: { p50Milliseconds?: number; p95Milliseconds?: number }): GraphMetric {
  return { value: d.p50Milliseconds!, p95: d.p95Milliseconds, unit: 'ms' };
}

/**
 * A short title for each of a graph's ids: the step it names, plus the numbers that tell it apart.
 *
 * luma builds an id from its scope, outermost first, with indices as `word-N` pairs:
 * `visibility-batch-0-compact-scan-level-1-scan` is the scan step of level 1 of the compaction of
 * batch 0. The step is the last words after the last pair (or before it, for an id that ends on
 * one, like `group-values-0-finite-chunk-0`). A pair is kept as a qualifier only when its word
 * takes more than one value across the graph: every pass of a one-batch filter is `batch 0`, which
 * says nothing, while its scan levels differ. So that pass is `scan · level 1`.
 */
export function stepNames(ids: string[]): Map<string, string> {
  type Parsed = { step: string; pairs: [string, string][] };
  const parse = (id: string): Parsed => {
    const tokens = id.split('-');
    const pairs: [string, string][] = [];
    const segments: string[][] = [[]];
    for (let i = 0; i < tokens.length; i++) {
      if (i + 1 < tokens.length && /^[a-z]+$/.test(tokens[i]) && /^\d+$/.test(tokens[i + 1])) {
        pairs.push([tokens[i], tokens[i + 1]]);
        segments.push([]);
        i++;
      } else {
        segments[segments.length - 1].push(tokens[i]);
      }
    }
    const step = [...segments].reverse().find((seg) => seg.length > 0) ?? tokens;
    return { step: step.join(' '), pairs };
  };
  const parsed = new Map(ids.map((id) => [id, parse(id)]));
  const values = new Map<string, Set<string>>();
  for (const { pairs } of parsed.values()) {
    for (const [word, n] of pairs) (values.get(word) ?? values.set(word, new Set()).get(word)!).add(n);
  }
  return new Map([...parsed].map(([id, { step, pairs }]) => {
    const kept = pairs.filter(([word]) => values.get(word)!.size > 1).map(([word, n]) => `${word} ${n}`);
    return [id, kept.length ? `${step} · ${kept.join(' ')}` : step];
  }));
}

/**
 * The prefix every id shares, cut after a `-`. luma prefixes every node and resource with the
 * graph id and the contributing operation (`noodles-luma-filter-1-gpu-dataframe-query-`), which
 * fills the card before the part that tells two passes apart.
 */
function sharedPrefix(ids: string[]): string {
  if (ids.length < 2) return '';
  let n = 0;
  while (ids.every((id) => id.length > n && id[n] === ids[0][n])) n++;
  return ids[0].slice(0, ids[0].lastIndexOf('-', n - 1) + 1);
}

// ---------------------------------------------------------------------------
// luma internals

interface ResourceUse {
  id: string;
  kind: 'buffer' | 'texture' | 'external-texture';
  usage: string;
  reads: boolean;
  writes: boolean;
  byteLength?: number;
  transient: boolean;
  /** The byte range a buffer view covers, when the use names a view rather than the buffer. */
  range?: { byteOffset: number; byteLength: number };
  /** Element format and extent: `format`, `rows` and `byteStride`, or `format`, `width`, `height`. */
  layout: Record<string, string | number>;
  /**
   * The luma buffer or texture behind the handle, when the graph has one to name: an imported
   * resource's default, or a transient's allocation. Two graphs that touch the same one are
   * sharing data, which is how `describeCommandGraphs` joins them.
   */
  physical?: object;
}

interface NodeUses {
  type: string;
  resources: ResourceUse[];
  dependsOn: string[];
}

type Handle = {
  id: string; byteLength?: number; transient?: boolean; width?: number; height?: number; format?: string;
  defaultBuffer?: object; defaultTexture?: object;
};
type Internals = { transientBuffers?: Map<Handle, object>; transientTextures?: Map<Handle, object> };
type View = { buffer: Handle; format: string; length: number; byteOffset: number; byteStride: number; rowByteLength: number };
type RawUse =
  | { buffer: Handle | View; usage: string }
  | { texture: Handle | { texture: Handle }; usage: string }
  | { externalTexture: Handle; usage: string };
type CompiledNodes = { node: { id: string; type: string; resources?: RawUse[]; dependsOn?: string[] } }[];

/**
 * Each node's declared resource uses, read from luma's private `compiledNodes`.
 *
 * TODO(luma): replace with a public topology accessor on `CompiledGPUCommandGraph` once one
 * exists. The read/write split copies luma's own `isBufferReadUsage` and friends in
 * `gpu-command-graph-compiler`, so an edge here is a hazard luma would also see.
 */
function resourceUsesOf<P>(graph: CompiledGPUCommandGraph<P>): Map<string, NodeUses> {
  const compiled = (graph as unknown as { compiledNodes?: CompiledNodes }).compiledNodes;
  if (!Array.isArray(compiled)) {
    throw new Error('describeCommandGraph: this luma version does not expose compiledNodes; the private-field read needs updating');
  }
  const out = new Map<string, NodeUses>();
  for (const { node } of compiled) {
    out.set(node.id, {
      type: node.type,
      dependsOn: node.dependsOn ?? [],
      resources: (node.resources ?? []).map((use) => toResourceUse(use, graph as unknown as Internals)),
    });
  }
  return out;
}

function toResourceUse(use: RawUse, internals: Internals): ResourceUse {
  // A dynamic import wraps the concrete resource in `buffer`/`texture`; luma unwraps it the same way.
  const unwrap = (r: object | undefined) => (r && 'buffer' in r && !('handle' in r) ? (r as { buffer: object }).buffer : r);
  if ('buffer' in use) {
    const view = 'buffer' in use.buffer ? use.buffer : undefined;
    const handle = view ? view.buffer : (use.buffer as Handle);
    return {
      id: handle.id, kind: 'buffer', usage: use.usage, byteLength: handle.byteLength, transient: !!handle.transient,
      physical: handle.transient ? internals.transientBuffers?.get(handle) : unwrap(handle.defaultBuffer),
      reads: BUFFER_READS.has(use.usage), writes: BUFFER_WRITES.has(use.usage),
      ...(view ? {
        range: { byteOffset: view.byteOffset, byteLength: Math.max(0, view.length - 1) * view.byteStride + view.rowByteLength },
        layout: { format: view.format, rows: view.length, byteStride: view.byteStride, byteOffset: view.byteOffset },
      } : { layout: {} }),
    };
  }
  if ('texture' in use) {
    const handle = 'texture' in use.texture ? use.texture.texture : use.texture;
    return {
      id: handle.id, kind: 'texture', usage: use.usage, transient: !!handle.transient,
      physical: handle.transient ? internals.transientTextures?.get(handle) : unwrap(handle.defaultTexture),
      byteLength: handle.format && texelBytes(handle.format) ? (handle.width ?? 0) * (handle.height ?? 0) * texelBytes(handle.format)! : undefined,
      reads: TEXTURE_READS.has(use.usage), writes: TEXTURE_WRITES.has(use.usage),
      layout: { ...(handle.format ? { format: handle.format } : {}), width: handle.width ?? 0, height: handle.height ?? 0 },
    };
  }
  return {
    id: use.externalTexture.id, kind: 'external-texture', usage: use.usage, transient: false, reads: true, writes: false,
    layout: { width: use.externalTexture.width ?? 0, height: use.externalTexture.height ?? 0 },
  };
}

const BUFFER_READS = new Set(['storage-read', 'storage-read-write', 'uniform', 'copy-source', 'indirect', 'vertex', 'index']);
const BUFFER_WRITES = new Set(['storage-write', 'storage-read-write', 'copy-destination']);
const TEXTURE_READS = new Set(['sampled', 'storage-read', 'storage-read-write', 'render-attachment', 'copy-source']);
const TEXTURE_WRITES = new Set(['storage-write', 'storage-read-write', 'render-attachment', 'copy-destination']);
