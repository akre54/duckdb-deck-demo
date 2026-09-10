/**
 * The EXPLAIN pane.
 *
 * A planner that cannot show its work is indistinguishable from a heuristic with good PR.
 * This renders the whole decision: every legal stage boundary and its estimated cost,
 * every rejected one and why, where the estimate came from, and — after the build — how
 * wrong the estimate was. If the model is badly calibrated, this is where it shows.
 */

import type { BuildResult } from '../../src/webgpu/runtime.js';
import type { Candidate } from '../../src/core/planner.js';
import { escapeHtml } from './inspector.js';

const ms = (v: number, digits = 2) => `${v.toFixed(digits)} ms`;
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MB`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function renderExplain(host: HTMLElement, r: BuildResult): void {
  const x = r.plan.explain;
  const chosenLabel = candidateLabel(x.candidates.find(isChosen(x)) ?? undefined);

  host.innerHTML = `
    ${targetHtml(r)}
    ${placementHtml(r)}
    ${estimateHtml(r, chosenLabel)}
    ${candidatesHtml(x.candidates, x)}
    ${statsHtml(r)}
    ${constantsHtml(r)}`;
}

// ---------------------------------------------------------------------------

function targetHtml(r: BuildResult): string {
  const { caps, method } = r.plan.explain;
  return `
    <h2>target and method</h2>
    <pre>target     ${escapeHtml(caps.id)} — ${escapeHtml(caps.note)}
compute    ${caps.compute ? 'yes' : 'no (GPU stage unavailable)'}
gpu budget ${mb(caps.gpuBudgetBytes)}
chosen by  ${method === 'cost' ? 'cost model over all legal plans' : 'rule-based policy (no statistics, or a policy override)'}</pre>`;
}

function placementHtml(r: BuildResult): string {
  const rows = r.plan.explain.placement
    .map((p) => `
      <tr>
        <td><span class="tag ${p.stage}">${p.stage}</span></td>
        <td>${escapeHtml(p.nodeId)}</td>
        <td class="why">${escapeHtml(p.kind)}</td>
        <td class="num">${p.ops}</td>
      </tr>
      <tr><td></td><td colspan="3" class="why">${escapeHtml(p.why)}</td></tr>`)
    .join('');
  return `
    <h2>placement</h2>
    <table>
      <thead><tr><th>stage</th><th>node</th><th>kind</th><th class="num">ops</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function estimateHtml(r: BuildResult, chosenLabel: string): string {
  const est = r.plan.explain.estimated;
  if (!est) return '';
  const t = r.timings;
  // Compare like with like: the estimate covers query, cast, upload, CPU stage and the
  // kernel — not plan compilation or pipeline creation, which the model does not model.
  const actualBuild = t.queryMs + t.convertMs + t.uploadMs + t.cpuStageMs;
  const ratio = actualBuild > 0 && est.buildMs > 0 ? actualBuild / est.buildMs : 0;

  const terms = est.terms
    .map((term) => `<tr><td>${escapeHtml(term.label)}</td><td class="num">${ms(term.ms)}</td></tr>`)
    .join('');

  return `
    <h2>estimated cost of the chosen plan — ${escapeHtml(chosenLabel)}</h2>
    <table><tbody>${terms}
      <tr><td><b>build</b></td><td class="num"><b>${ms(est.buildMs)}</b></td></tr>
      <tr><td>amortized interaction</td><td class="num">${ms(est.interactMs)}</td></tr>
      <tr><td><b>objective</b></td><td class="num"><b>${ms(est.totalMs)}</b></td></tr>
      <tr><td>gpu resident</td><td class="num">${mb(est.gpuBytes)}</td></tr>
    </tbody></table>

    <h2>estimated vs actual</h2>
    <table>
      <thead><tr><th></th><th class="num">estimated</th><th class="num">actual</th></tr></thead>
      <tbody>
        <tr><td>rows out of SQL</td><td class="num">${r.plan.explain.estimatedRows.toLocaleString()}</td><td class="num">${r.rows.toLocaleString()}</td></tr>
        <tr><td>build (query+cast+upload+cpu)</td><td class="num">${ms(est.buildMs)}</td><td class="num">${ms(actualBuild)}</td></tr>
      </tbody>
    </table>
    <pre>${ratio > 0
      ? `model error ${ratio >= 1 ? `${ratio.toFixed(2)}x under` : `${(1 / ratio).toFixed(2)}x over`}-estimated`
      : 'no comparison available'}
Row-count error is cardinality estimation (uniformity and independence assumptions).
Time error is calibration. They fail independently and are worth reading separately.</pre>`;
}

function candidatesHtml(candidates: Candidate[], x: BuildResult['plan']['explain']): string {
  const legal = candidates.filter((c) => c.legal);
  const illegal = candidates.filter((c) => !c.legal);
  const best = legal[0];

  const legalRows = legal
    .map((c) => {
      const chosen = isChosen(x)(c);
      const delta = best?.cost && c.cost ? c.cost.totalMs - best.cost.totalMs : 0;
      return `<tr${chosen ? ' style="color:var(--render)"' : ''}>
        <td>${chosen ? '▸ ' : ''}${escapeHtml(c.label)}</td>
        <td class="num">${c.cost ? ms(c.cost.buildMs) : '—'}</td>
        <td class="num">${c.cost ? ms(c.cost.interactMs) : '—'}</td>
        <td class="num">${c.cost ? ms(c.cost.totalMs) : '—'}</td>
        <td class="num">${delta === 0 ? '—' : `+${ms(delta)}`}</td>
        <td class="num">${c.cost ? mb(c.cost.gpuBytes) : '—'}</td>
        <td class="num">${(c.sqlRows ?? 0).toLocaleString()}</td>
      </tr>`;
    })
    .join('');

  const illegalRows = illegal
    .map((c) => `<tr><td>${escapeHtml(c.label)}</td><td colspan="6" class="why">${escapeHtml(c.reason ?? '')}</td></tr>`)
    .join('');

  return `
    <h2>candidate plans — ${legal.length} legal, ${illegal.length} rejected</h2>
    <table>
      <thead><tr><th>boundaries</th><th class="num">build</th><th class="num">interact</th><th class="num">objective</th><th class="num">vs best</th><th class="num">gpu</th><th class="num">rows</th></tr></thead>
      <tbody>${legalRows}</tbody>
    </table>
    <pre>Search is exhaustive, not heuristic. SQL cannot read a GPU buffer and GPU output cannot
return to the CPU without a readback, so stages must appear as SQL* CPU* GPU* in
topological order — an assignment is two boundary indices, and every one is priced above.</pre>
    ${illegal.length ? `<h2>rejected</h2><table><tbody>${illegalRows}</tbody></table>` : ''}`;
}

function statsHtml(r: BuildResult): string {
  const x = r.plan.explain;
  if (!r.stats) {
    return `<h2>statistics</h2><pre>none available — the planner fell back to rules.
Cost-based planning needs a catalog; see Runtime.loadStats.</pre>`;
  }

  const sel = x.estimatedSelectivity
    .map((s) => `<tr><td>${escapeHtml(s.nodeId)}</td><td class="num">${pct(s.selectivity)}</td><td>${s.pushedToSql ? '<span class="tag sql">sql</span>' : '<span class="tag gpu">mask</span>'}</td></tr>`)
    .join('');

  const cols = [...r.stats.columns.values()]
    .map((c) => `<tr>
      <td>${escapeHtml(c.name)}</td>
      <td class="why">${escapeHtml(c.duckType)}</td>
      <td class="num">${c.ndv.toLocaleString()}</td>
      <td class="num">${fmt(c.min)}</td>
      <td class="num">${fmt(c.max)}</td>
      <td class="num">${c.nullFrac > 0 ? pct(c.nullFrac) : '—'}</td>
    </tr>`)
    .join('');

  return `
    ${sel ? `<h2>estimated selectivity</h2><table>
      <thead><tr><th>filter</th><th class="num">rows kept</th><th>placement</th></tr></thead>
      <tbody>${sel}</tbody></table>` : ''}
    <h2>catalog — ${r.stats.rows.toLocaleString()} rows, gathered in ${ms(r.statsCatalogMs, 1)}</h2>
    <table>
      <thead><tr><th>column</th><th>type</th><th class="num">ndv</th><th class="num">min</th><th class="num">max</th><th class="num">null</th></tr></thead>
      <tbody>${cols}</tbody>
    </table>`;
}

function constantsHtml(r: BuildResult): string {
  const c = r.plan.explain.costs;
  const rows: [string, string][] = [
    ['sql fixed', ms(c.sqlFixedMs)],
    ['sql per row per column', `${(c.sqlPerRowPerColMs * 1e6).toFixed(2)} ns`],
    ['sql per row per op', `${(c.sqlPerRowPerOpMs * 1e6).toFixed(2)} ns`],
    ['upload per MB', ms(c.uploadPerByteMs * 1048576)],
    ['upload per call', ms(c.uploadPerCallMs, 4)],
    ['cast per element', `${(c.castPerElemMs * 1e6).toFixed(2)} ns`],
    ['interleave per element', `${(c.interleavePerElemMs * 1e6).toFixed(2)} ns`],
    ['kernel fixed', ms(c.kernelFixedMs, 4)],
    ['kernel per row per op', `${(c.kernelPerRowPerOpMs * 1e6).toFixed(3)} ns`],
    ['cpu per row per op', `${(c.cpuPerRowPerOpMs * 1e6).toFixed(2)} ns`],
    ['uniform write', ms(c.uniformWriteMs, 4)],
    ['render fixed per frame', ms(c.renderFixedMs, 4)],
    ['render per instance', `${(c.renderPerInstanceMs * 1e6).toFixed(3)} ns`],
    ['amortization horizon', `${c.horizonSec} s @ ${c.frameRateHz} Hz`],
  ];
  return `
    <h2>cost constants</h2>
    <table><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table>
    <pre>Measured on this device at startup, not hardcoded. A planner carrying another machine's
constants makes confident, portable-looking, wrong decisions.</pre>`;
}

// ---------------------------------------------------------------------------

function isChosen(x: BuildResult['plan']['explain']) {
  return (c: Candidate) =>
    c.assignment.sqlEnd === x.chosen.sqlEnd && c.assignment.cpuEnd === x.chosen.cpuEnd;
}

function candidateLabel(c?: Candidate): string {
  return c?.label ?? 'unknown';
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3)) return v.toExponential(2);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

/** Calibration detail, shown once at startup. */
export function renderCalibration(host: HTMLElement, samples: { label: string; ms: number; detail: string }[], elapsedMs: number): void {
  host.innerHTML = `
    <h2>calibration — ${ms(elapsedMs, 0)}</h2>
    <table>
      <thead><tr><th>measurement</th><th class="num">ms</th><th>detail</th></tr></thead>
      <tbody>${samples.map((s) => `<tr><td>${escapeHtml(s.label)}</td><td class="num">${ms(s.ms, 3)}</td><td class="why">${escapeHtml(s.detail)}</td></tr>`).join('')}</tbody>
    </table>`;
}
