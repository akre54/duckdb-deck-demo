/**
 * The graph, drawn.
 *
 * A layered DAG with each node tinted by the stage the optimizer assigned it, and fused nodes
 * drawn inside one kernel bracket. The tabs already report placement as a table; the reason to
 * draw it is that the *shape* of a plan is the thing you actually want to check at a glance —
 * where the SQL/GPU boundary fell, whether a branch was eliminated, whether four nodes became
 * one dispatch. A table makes you reconstruct that; a picture shows it.
 *
 * Deliberately read-only and dependency-free. Layout is longest-path layering, which is exact
 * for a DAG and about fifteen lines; a force simulation or a routing library would be more
 * pixels and less information.
 */

import type { BuildResult } from '../../src/webgpu/runtime.js';
import { escapeHtml } from './inspector.js';

interface Laid {
  id: string;
  label: string;
  detail: string;
  stage: string;
  kernel?: number;
  layer: number;
  index: number;
  x: number;
  y: number;
}

const NODE_W = 150;
const NODE_H = 34;
const GAP_X = 26;
const GAP_Y = 30;
const PAD = 16;

/** Which visual class a node's engine maps to. Matches the `.tag` colors in index.html. */
function stageClass(engine: string): string {
  switch (engine) {
    case 'sql': return 'sql';
    case 'gpu': return 'gpu';
    case 'cpu': return 'cpu';
    case 'source': return 'source';
    default: return 'scalar';
  }
}

export function renderDag(host: HTMLElement, result: BuildResult): void {
  const { plan } = result;

  // Edges come from the *desugared* graph, which is what was actually planned: a wrangle has
  // already become one node per statement, and a dead branch is already gone.
  const assignments = plan.assignments;
  const byId = new Map(assignments.map((a) => [a.nodeId, a]));

  const edges = plan.explain.edges;

  if (edges.length === 0 && assignments.length === 0) {
    host.innerHTML = '<p class="hint">No plan yet.</p>';
    return;
  }

  // --- layering ------------------------------------------------------------
  const ids = assignments.map((a) => a.nodeId);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, to] of edges) {
    if (preds.has(to) && ids.includes(from)) preds.get(to)!.push(from);
  }
  const layerOf = new Map<string, number>();
  const layer = (id: string, seen = new Set<string>()): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const ps = preds.get(id) ?? [];
    const value = ps.length === 0 ? 0 : Math.max(...ps.map((p) => layer(p, seen) + 1));
    layerOf.set(id, value);
    return value;
  };
  for (const id of ids) layer(id);

  const kernelOf = new Map<string, number>();
  plan.kernels.forEach((k, i) => { for (const id of k.nodeIds) kernelOf.set(id, i); });

  const rows = new Map<number, number>();
  const laid: Laid[] = ids.map((id) => {
    const a = byId.get(id)!;
    const l = layerOf.get(id) ?? 0;
    const index = rows.get(l) ?? 0;
    rows.set(l, index + 1);
    return {
      id,
      label: id,
      detail: `${a.type}${a.engine === 'render' || a.engine === 'source' ? '' : ` · ${a.engine}`}`,
      stage: stageClass(a.engine),
      kernel: kernelOf.get(id),
      layer: l,
      index,
      x: 0,
      y: 0,
    };
  });

  const widest = Math.max(1, ...[...rows.values()]);
  for (const n of laid) {
    n.x = PAD + n.index * (NODE_W + GAP_X);
    n.y = PAD + n.layer * (NODE_H + GAP_Y);
  }
  const width = PAD * 2 + widest * (NODE_W + GAP_X) - GAP_X;
  const height = PAD * 2 + (Math.max(...laid.map((n) => n.layer)) + 1) * (NODE_H + GAP_Y) - GAP_Y;

  const pos = new Map(laid.map((n) => [n.id, n]));

  // --- kernel brackets: one rounded box around each fused group ------------
  const brackets = plan.kernels.map((k, i) => {
    const members = k.nodeIds.map((id) => pos.get(id)).filter(Boolean) as Laid[];
    if (members.length === 0) return '';
    const x0 = Math.min(...members.map((m) => m.x)) - 7;
    const y0 = Math.min(...members.map((m) => m.y)) - 7;
    const x1 = Math.max(...members.map((m) => m.x + NODE_W)) + 7;
    const y1 = Math.max(...members.map((m) => m.y + NODE_H)) + 7;
    return `<rect class="kernel-box" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="8"/>`
      + `<text class="kernel-label" x="${x1 - 4}" y="${y0 - 2}" text-anchor="end">kernel ${i} · ${k.nodeIds.length} fused</text>`;
  }).join('');

  const lines = edges.map(([from, to]) => {
    const a = pos.get(from);
    const b = pos.get(to);
    if (!a || !b) return '';
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y;
    const mid = (y1 + y2) / 2;
    return `<path class="edge" d="M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}"/>`;
  }).join('');

  const boxes = laid.map((n) => `
    <g class="dag-node" data-node="${escapeHtml(n.id)}" transform="translate(${n.x} ${n.y})">
      <rect class="box ${n.stage}" width="${NODE_W}" height="${NODE_H}" rx="5"/>
      <text class="id" x="8" y="14">${escapeHtml(truncate(n.label, 20))}</text>
      <text class="detail" x="8" y="26">${escapeHtml(n.detail)}</text>
    </g>`).join('');

  host.innerHTML = `
    <div class="dag-legend">
      ${['sql', 'cpu', 'gpu'].map((s) => `<span class="tag ${s}">${s}</span>`).join('')}
      <span class="hint">${laid.length} nodes · ${plan.kernels.length} kernel(s) · click a node for its code</span>
    </div>
    <svg class="dag" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
      ${brackets}${lines}${boxes}
    </svg>
    <div class="dag-detail hint">Select a node.</div>
  `;

  const detail = host.querySelector<HTMLElement>('.dag-detail')!;
  host.querySelectorAll<SVGGElement>('.dag-node').forEach((g) => {
    g.addEventListener('click', () => {
      host.querySelectorAll('.dag-node').forEach((o) => o.removeAttribute('data-selected'));
      g.setAttribute('data-selected', '');
      detail.innerHTML = nodeDetail(result, g.dataset.node!);
    });
  });
}

/** What one node contributed to the plan: its reason, and the code it produced. */
function nodeDetail(result: BuildResult, id: string): string {
  const { plan } = result;
  const a = plan.assignments.find((x) => x.nodeId === id);
  if (!a) return `<p class="hint">${escapeHtml(id)}</p>`;

  const placement = plan.explain.placement.find((p) => p.nodeId === id);
  const parts: string[] = [
    `<div class="dag-head"><span class="tag ${stageClass(a.engine)}">${a.engine}</span>`
    + `<strong>${escapeHtml(id)}</strong><span class="hint">${escapeHtml(a.type)}</span></div>`,
    `<p class="hint">${escapeHtml(a.why)}${placement ? ` · ${placement.ops} ops` : ''}</p>`,
  ];

  const stage = [...plan.gpuStage, ...plan.cpuStage].find((s) => s.nodeId === id);
  if (stage?.raw) {
    const code = typeof stage.raw.code === 'string'
      ? stage.raw.code
      : Object.entries(stage.raw.code).map(([k, v]) => `${k}: ${v}`).join('\n');
    parts.push(`<p class="hint">raw ${stage.raw.engine}, pinned — reads ${stage.raw.reads.join(', ') || '(none)'}</p>`);
    parts.push(`<pre>${escapeHtml(code)}</pre>`);
  }

  const kernelIndex = plan.kernels.findIndex((k) => k.nodeIds.includes(id));
  if (kernelIndex >= 0) {
    const kernel = plan.kernels[kernelIndex];
    // Just this node's slice of the fused kernel: the whole thing is on the wgsl tab.
    const marker = new RegExp(`^\\s*// ${escapeRegExp(id)}\\b`);
    const lines = kernel.code.split('\n');
    const start = lines.findIndex((l) => marker.test(l));
    if (start >= 0) {
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((l) => /^\s*\/\/ \S+:/.test(l));
      const slice = [lines[start], ...(end === -1 ? rest : rest.slice(0, end))];
      parts.push(`<p class="hint">in kernel ${kernelIndex}</p><pre>${escapeHtml(slice.join('\n').trimEnd())}</pre>`);
    }
  } else if (a.engine === 'sql') {
    parts.push(`<p class="hint">contributes to the query on the sql tab</p>`);
  }

  return parts.join('');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
