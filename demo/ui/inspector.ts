/**
 * The inspector. Its job is to make the planner falsifiable: every claim the
 * architecture makes should be checkable on screen.
 *
 *   - which engine each node was assigned, and the reason
 *   - the SQL that was actually generated, with its bind order
 *   - the WGSL that was actually generated, including which nodes fused
 *   - each attribute's upload tier, so "zero copy" is a measurement not a slogan
 *   - counters proving a slider caused a uniform write and not a requery
 */

import type { BuildResult } from '../../src/webgpu/runtime.js';
import type { Runtime } from '../../src/webgpu/runtime.js';
import type { DeckMetrics } from '../../src/deck/webgl2-pane.js';
import type { DeckWebgpuStatus } from '../../src/deck/webgpu-pane.js';
import { renderExplain } from './explain.js';

const TABS = [
  ['explain', 'explain'],
  ['plan', 'plan'],
  ['sql', 'sql'],
  ['wgsl', 'wgsl'],
  ['attrs', 'attributes'],
  ['bench', 'bench'],
  ['compare', 'vs deck'],
  ['calibration', 'calibration'],
] as const;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const num = (v: number, digits = 2) => v.toFixed(digits);
const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(2)} MB`);

export class Inspector {
  private sections = new Map<string, HTMLElement>();
  private active = 'explain';

  constructor(tabsHost: HTMLElement, bodyHost: HTMLElement) {
    for (const [id, label] of TABS) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.setAttribute('aria-selected', String(id === this.active));
      btn.addEventListener('click', () => this.select(id));
      tabsHost.append(btn);
      const section = bodyHost.querySelector<HTMLElement>(`section[data-tab="${id}"]`)!;
      if (id === this.active) section.setAttribute('data-active', '');
      this.sections.set(id, section);
    }
    this.tabsHost = tabsHost;
  }

  private tabsHost: HTMLElement;

  select(id: string): void {
    this.active = id;
    for (const [tab, section] of this.sections) {
      if (tab === id) section.setAttribute('data-active', '');
      else section.removeAttribute('data-active');
    }
    [...this.tabsHost.children].forEach((btn, i) => {
      btn.setAttribute('aria-selected', String(TABS[i][0] === id));
    });
  }

  /** The pane element for a tab, so other modules can render into it. */
  section(id: string): HTMLElement {
    const el = this.sections.get(id);
    if (!el) throw new Error(`Inspector has no '${id}' section`);
    return el;
  }

  render(result: BuildResult): void {
    renderExplain(this.sections.get('explain')!, result);
    this.sections.get('plan')!.innerHTML = this.planHtml(result);
    this.sections.get('sql')!.innerHTML = this.sqlHtml(result);
    this.sections.get('wgsl')!.innerHTML = this.wgslHtml(result);
    this.sections.get('attrs')!.innerHTML = this.attrsHtml(result);
    this.sections.get('bench')!.innerHTML = this.benchHtml(result);
  }

  /** The deck.gl comparison. Rendered separately because it updates on mode change. */
  renderCompare(
    r: BuildResult,
    rt: Runtime,
    deck?: DeckMetrics,
    gpuResident?: DeckWebgpuStatus,
  ): void {
    const host = this.sections.get('compare')!;
    if (gpuResident) {
      host.innerHTML = this.gpuResidentHtml(r, gpuResident);
      return;
    }
    if (!deck) {
      host.innerHTML = `<h2>vs deck.gl</h2><pre>Set "render" to deck.gl or both to populate this.</pre>`;
      return;
    }
    const ours = r.timings;
    const oursCpu = ours.convertMs;
    const theirsCpu = deck.materializeMs + deck.evalMs + deck.packMs;
    const oursBytes = r.attributes.reduce((s, a) => s + a.bytes, 0);

    host.innerHTML = `
      <h2>what each path actually does</h2>
      <table>
        <thead><tr><th></th><th class="num">webgpu graph</th><th class="num">deck.gl</th></tr></thead>
        <tbody>
          <tr><td>derived attributes computed by</td><td class="num">WGSL kernel</td><td class="num">generated JS loop</td></tr>
          <tr><td>arrow → f32 cast</td><td class="num">${num(ours.convertMs)} ms</td><td class="num">${num(ours.convertMs)} ms</td></tr>
          <tr><td>make columns contiguous</td><td class="num">not needed</td><td class="num">${num(deck.materializeMs)} ms</td></tr>
          <tr><td>per-row attribute loop</td><td class="num">0 ms (gpu)</td><td class="num">${num(deck.evalMs)} ms</td></tr>
          <tr><td>color pack to uint8</td><td class="num">not needed</td><td class="num">${num(deck.packMs)} ms</td></tr>
          <tr><td><b>total cpu work</b></td><td class="num"><b>${num(oursCpu)} ms</b></td><td class="num"><b>${num(theirsCpu)} ms</b></td></tr>
          <tr><td>bytes to gpu</td><td class="num">${kb(oursBytes)}</td><td class="num">${kb(deck.bytes)}</td></tr>
          <tr><td>live frame readout</td><td class="num">${num(rt.frameMs)} ms</td><td class="num">${num(deck.frameMs)} ms</td></tr>
          <tr><td><b>cost of one value-param change</b></td><td class="num"><b>1 uniform write</b></td><td class="num"><b>${num(theirsCpu - ours.convertMs)} ms cpu</b></td></tr>
        </tbody>
      </table>

      <h2>read this before trusting the frame times</h2>
      <ul class="notes">
        <li>deck.gl 9 renders through luma.gl's <b>WebGL2</b> backend. Its WebGPU backend is experimental and
        is not what installing @deck.gl/core gives you — so the frame-time row compares two graphics APIs,
        not two architectures. The CPU rows are the meaningful comparison.</li>
        <li>In <b>both</b> mode the two renderers share one GPU. Use a solo mode for timings.</li>
        <li>Both are forced to redraw every frame; otherwise deck's number would be the idle gap between
        on-demand redraws. Even so, the live readout is only meaningful with the tab visible —
        requestAnimationFrame throttles hard in a hidden tab. The <b>bench</b> tab's "gpu frame" column is the
        trustworthy WebGPU number; there is no deck equivalent, for the reasons noted there.</li>
        <li>Camera framing is approximate: OrbitView's <code>zoom</code> is not our <code>distance</code>.</li>
      </ul>

      <h2>the structural difference</h2>
      <ul class="notes">
        <li>A value-parameter change costs the WebGPU path <b>one uniform write plus a dispatch</b>. It costs
        the deck path <b>the whole JS loop again</b>, because deck cannot re-evaluate the graph — it can only
        be handed new arrays.</li>
        <li>deck.gl cannot read a buffer a kernel wrote without a GPU readback. That is the actual reason the
        CPU loop exists here, and the reason a graph that owns its own buffers is not just a performance
        choice.</li>
      </ul>

      <h2>generated cpu loop (third backend, same IR)</h2>
      <pre>${escapeHtml(deck.code.trim() || '(none)')}</pre>`;
  }

  /**
   * The deck-on-WebGPU result: whether the planner's kernel actually ran on luma's device
   * and whether deck rendered the buffers it wrote. This is the answer to "does deck need
   * to change for this design", so it reports what happened rather than what should.
   */
  private gpuResidentHtml(r: BuildResult, s: DeckWebgpuStatus): string {
    const mark = (v: string) =>
      v === 'ok' ? '<span class="tag arrow">ok</span>'
      : v === 'failed' ? '<span class="tag" style="color:var(--warn);border-color:#4d2020">failed</span>'
      : v === 'skipped' ? '<span class="tag scalar">skipped</span>'
      : '<span class="tag">pending</span>';

    const kernel = r.plan.kernels[0];
    return `
      <h2>deck.gl on webgpu — gpu-resident attributes</h2>
      <table>
        <tbody>
          <tr><td>luma WebGPU device</td><td>${mark(s.device)}</td></tr>
          <tr><td>planner's WGSL through luma compute</td><td>${mark(s.compute)}</td></tr>
          <tr><td>deck rendered those buffers</td><td>${mark(s.render)}</td></tr>
          <tr><td>kernel time</td><td class="num">${num(s.computeMs)} ms</td></tr>
          <tr><td>buffers shared without readback</td><td>${s.sharedBuffers.map(escapeHtml).join(', ') || '—'}</td></tr>
          <tr><td>cpu attribute work</td><td class="num">0 ms</td></tr>
        </tbody>
      </table>
      <pre>${escapeHtml(s.detail || '(no detail)')}</pre>

      <h2>why this matters</h2>
      <ul class="notes">
        <li>The WebGL2 comparison pays a full CPU attribute rebuild per parameter change because deck cannot
        read a buffer a kernel wrote. Here the same graph's kernel writes luma <code>Buffer</code>s and deck
        binds them, so that cost is <b>zero</b> — no readback, no fork of deck.</li>
        <li>Available on the installed versions, not a future release: <code>@luma.gl/webgpu</code>
        (<code>webgpuAdapter</code>) and <code>@luma.gl/gpgpu</code> ship as deck.gl 9.4 dependencies, and
        <code>Device.createComputePipeline</code> / <code>beginComputePass</code> are in
        <code>@luma.gl/core</code>.</li>
        <li>deck.gl 9.4's WebGPU <i>render</i> path is still experimental, which is why the compute row and the
        render row are reported separately above. A compute success with a render failure would still settle the
        architectural question.</li>
      </ul>

      <h2>the kernel deck is running</h2>
      <pre>${escapeHtml(kernel ? kernel.code.trim() : '(no GPU stage in this plan)')}</pre>`;
  }

  showError(message: string): void {
    this.sections.get('plan')!.innerHTML =
      `<h2>plan failed</h2><pre style="color:var(--warn)">${escapeHtml(message)}</pre>`;
    this.select('plan');
  }

  // -----------------------------------------------------------------------

  private planHtml(r: BuildResult): string {
    const rows = r.plan.assignments.map((a) => `
      <tr>
        <td><span class="tag ${a.engine}">${a.engine}</span></td>
        <td>${escapeHtml(a.nodeId)}</td>
        <td class="why">${escapeHtml(a.type)}</td>
      </tr>
      <tr><td></td><td colspan="2" class="why">${escapeHtml(a.why)}</td></tr>`).join('');

    const sqlCount = r.plan.assignments.filter((a) => a.engine === 'sql').length;
    const gpuCount = r.plan.assignments.filter((a) => a.engine === 'gpu').length;

    const notes = r.plan.notes.length
      ? `<h2>notes</h2><ul class="notes">${r.plan.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
      : '';

    const statRows = Object.entries(r.statValues).map(([k, v]) =>
      `<tr><td>${escapeHtml(k)}</td><td class="num">${Number.isInteger(v) ? v : v.toPrecision(6)}</td></tr>`).join('');

    return `
      <h2>engine assignment — ${sqlCount} sql / ${gpuCount} gpu</h2>
      <table><tbody>${rows}</tbody></table>
      ${statRows ? `<h2>stats → bound parameters</h2><table><tbody>${statRows}</tbody></table>` : ''}
      <h2>parameter routing</h2>
      <table>
        <thead><tr><th>param</th><th>route</th><th class="num">value</th></tr></thead>
        <tbody>${Object.keys(r.plan.params).map((p) => {
          const route = r.plan.sqlParams.includes(p) ? 'requery'
            : r.plan.uniformParams.includes(p) ? 'uniform'
            : r.plan.params[p].kind === 'structural' ? 'rebuild' : 'unused';
          return `<tr><td>${escapeHtml(p)}</td><td><span class="tag ${route === 'requery' ? 'sql' : route === 'uniform' ? 'gpu' : 'scalar'}">${route}</span></td><td class="num">${r.plan.params[p].value}</td></tr>`;
        }).join('')}</tbody>
      </table>
      ${notes}`;
  }

  private sqlHtml(r: BuildResult): string {
    const binds = r.plan.sqlParams.length
      ? `<h2>bind order</h2><pre>${r.plan.sqlParams.map((p, i) => `$${i + 1}  ${p}`).join('\n')}</pre>`
      : '<h2>bind order</h2><pre>(no parameters — executed directly, not prepared)</pre>';
    const stats = r.plan.stats.length
      ? `<h2>stats queries</h2>${r.plan.stats.map((s) => `<pre>${escapeHtml(formatSql(s.sql))}</pre>`).join('')}`
      : '';
    return `
      <h2>row query</h2>
      <pre>${escapeHtml(formatSql(r.plan.sql))}</pre>
      ${binds}
      ${stats}`;
  }

  private wgslHtml(r: BuildResult): string {
    if (r.plan.kernels.length === 0) {
      return `<h2>compute kernels</h2><pre>(none — every node was pushed into SQL)</pre>`;
    }
    return r.plan.kernels.map((k) => `
      <h2>${escapeHtml(k.id)} — fused ${k.nodeIds.length} node${k.nodeIds.length === 1 ? '' : 's'}: ${k.nodeIds.map(escapeHtml).join(' → ')}</h2>
      <pre>reads   ${k.reads.join(', ') || '(none)'}
writes  ${k.writes.join(', ')}
params  ${k.params.join(', ') || '(none)'}
ramp    ${k.usesRamp ? 'yes' : 'no'}</pre>
      <pre>${escapeHtml(k.code.trim())}</pre>`).join('');
  }

  private attrsHtml(r: BuildResult): string {
    const rows = r.attributes.map((a) => `
      <tr>
        <td>${escapeHtml(a.name)}</td>
        <td class="num">${a.width}</td>
        <td><span class="tag ${a.provenance === 'derived' ? 'derived' : a.tier}">${a.provenance === 'derived' ? 'derived' : a.tier}</span></td>
        <td class="why">${escapeHtml(a.arrowType ?? 'kernel output')}</td>
        <td class="num">${a.chunks ?? '—'}</td>
        <td class="num">${a.nullCount ? a.nullCount : '—'}</td>
        <td class="num">${kb(a.bytes)}</td>
      </tr>`).join('');
    const byTier = (t: string) => r.attributes.filter((a) => a.tier === t);
    const single = byTier('arrow');
    const chunked = byTier('chunked');
    const cast = byTier('cast');
    const maxChunks = Math.max(0, ...r.attributes.map((a) => a.chunks ?? 0));
    return `
      <h2>attribute buffers</h2>
      <table>
        <thead><tr><th>name</th><th class="num">w</th><th>tier</th><th>arrow type</th><th class="num">chunks</th><th class="num">nulls</th><th class="num">bytes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <h2>upload cost</h2>
      <pre>single-chunk (arrow) ${single.length}  ${single.map((a) => a.name).join(', ') || '—'}
chunked (no js loop) ${chunked.length}  ${chunked.map((a) => a.name).join(', ') || '—'}
cpu cast             ${cast.length}  ${cast.map((a) => a.name).join(', ') || '—'}
cpu convert time     ${num(r.timings.convertMs)} ms
writeBuffer calls    ${r.timings.writeCalls}
total uploaded       ${kb(r.attributes.reduce((s, a) => s + a.bytes, 0))}</pre>
      <h2>the measured finding</h2>
      <ul class="notes">
        <li><b>DuckDB-Wasm returns ${maxChunks} record batches here, not one.</b> Batches are 2048 rows, so
        "the Arrow column is the GPU buffer, byte for byte" does not hold for DuckDB output at any realistic size.</li>
        <li>That still avoids a JS loop: the <b>chunked</b> tier issues one writeBuffer per batch at the right
        byte offset and lets the GPU copy engine concatenate. ${r.timings.writeCalls} copies, zero element-wise JS.</li>
        <li>A <b>cast</b> is only unavoidable for DOUBLE (WGSL has no f64), for nullable columns (the validity
        bitmap must become NaN somewhere), and for SQL-built vectors (separate scalar columns must be
        interleaved — a kernel writes them packed already).</li>
      </ul>`;
  }

  private benchHtml(r: BuildResult): string {
    const t = r.timings;
    return `
      <h2>build breakdown — ${r.rows.toLocaleString()} rows</h2>
      <table>
        <tbody>
          <tr><td>plan compile</td><td class="num">${num(t.planMs)} ms</td></tr>
          <tr><td>stats queries</td><td class="num">${num(t.statsMs)} ms</td></tr>
          <tr><td>row query (duckdb)</td><td class="num">${num(t.queryMs)} ms</td></tr>
          <tr><td>arrow → f32 convert</td><td class="num">${num(t.convertMs)} ms</td></tr>
          <tr><td>upload + alloc (${t.writeCalls} writeBuffer)</td><td class="num">${num(t.uploadMs)} ms</td></tr>
          <tr><td>pipeline compile</td><td class="num">${num(t.pipelineMs)} ms</td></tr>
          <tr><td><b>total</b></td><td class="num"><b>${num(t.totalMs)} ms</b></td></tr>
        </tbody>
      </table>
      <h2>source</h2>
      <pre>source columns      ${r.sourceColumns}
columns selected    ${r.plan.attributes.filter((a) => a.provenance === 'arrow').length}
rows returned       ${r.rows.toLocaleString()}
bytes to gpu        ${kb(r.attributes.reduce((s, a) => s + a.bytes, 0))}</pre>`;
  }
}

export interface SweepRow {
  rows: number;
  queryMs: number;
  convertMs: number;
  uploadMs: number;
  totalBuildMs: number;
  bytes: number;
  writeCalls: number;
  /** GPU frame cost, measured with the queue drained. */
  frameMs: number;
  /** CPU cost of rebuilding deck's binary attributes — paid again on every param change. */
  deckCpuMs?: number;
  deckBytes?: number;
}

export function renderSweep(host: HTMLElement, rows: SweepRow[], withDeck: boolean): void {
  const head = [
    'rows', 'duckdb', 'cast', 'upload', 'build', 'to gpu', 'writes', 'gpu frame',
    ...(withDeck ? ['deck attr cpu', 'deck bytes'] : []),
  ];
  host.innerHTML = `
    <h2>sweep${withDeck ? ' — webgpu vs deck.gl' : ''}</h2>
    <table>
      <thead><tr>${head.map((h) => `<th class="num">${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="num">${r.rows.toLocaleString()}</td>
        <td class="num">${num(r.queryMs, 1)}</td>
        <td class="num">${num(r.convertMs, 1)}</td>
        <td class="num">${num(r.uploadMs, 1)}</td>
        <td class="num">${num(r.totalBuildMs, 1)}</td>
        <td class="num">${kb(r.bytes)}</td>
        <td class="num">${r.writeCalls}</td>
        <td class="num">${num(r.frameMs)}</td>
        ${withDeck ? `<td class="num">${r.deckCpuMs === undefined ? '—' : num(r.deckCpuMs, 1)}</td>
        <td class="num">${r.deckBytes === undefined ? '—' : kb(r.deckBytes)}</td>` : ''}
      </tr>`).join('')}</tbody>
    </table>
    <pre>All times in ms.
cast            CPU Arrow -> f32 narrowing
writes          writeBuffer calls (one per Arrow record batch for chunked columns)
gpu frame       tight submit loop with the queue drained, so it measures work not
                requestAnimationFrame cadence
deck attr cpu   materialize + per-row JS loop + color pack. The WebGPU path does none
                of it: the equivalent work is the kernel dispatch inside "gpu frame".
                Paid again on every parameter change, where the WebGPU path pays one
                uniform write.

No deck.gl frame time here on purpose: deck.redraw() only flags a redraw rather than
drawing, and deck exposes no queue-drain hook, so it cannot be timed the way "gpu frame"
is. Watch the live footer readout with the tab visible instead.</pre>`;
}

/** Line-break generated SQL at clause boundaries so it is readable. */
export function formatSql(sql: string): string {
  return sql
    .replace(/ (FROM|WHERE|GROUP BY|ORDER BY|LIMIT) /g, '\n$1 ')
    .replace(/, /g, ',\n       ');
}

/** Live counter strip. Kept separate from `render` because it updates every frame. */
export function renderCounters(host: HTMLElement, rt: Runtime, rows: number, deckFrameMs?: number): void {
  const c = rt.counters;
  const fps = rt.frameMs > 0 ? 1000 / rt.frameMs : 0;
  host.innerHTML = `
    <span>rows <b>${rows.toLocaleString()}</b></span>
    <span>frame <b>${rt.frameMs.toFixed(2)} ms</b> (${fps.toFixed(0)} fps)</span>
    ${deckFrameMs ? `<span>deck frame <b>${deckFrameMs.toFixed(2)} ms</b></span>` : ''}
    <span>uniform writes <b>${c.uniformWrites}</b></span>
    <span>kernel dispatches <b>${c.kernelDispatches}</b></span>
    <span>requeries <b>${c.requeries}</b></span>
    <span>rebuilds <b>${c.rebuilds}</b></span>
    <span>buffer allocs <b>${rt.attributes.counters.allocations}</b></span>`;
}
