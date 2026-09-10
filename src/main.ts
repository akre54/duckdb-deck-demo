/**
 * Wiring. Nothing architectural lives here — it picks a graph, builds it, and runs a
 * frame loop. The interesting code is graph/planner.ts and graph/backends/.
 */

import { initGpu, GpuUnavailable } from './engine/device.js';
import { Duck } from './engine/duck.js';
import { Runtime } from './engine/runtime.js';
import { Inspector, renderCounters, renderSweep, type SweepRow } from './ui/inspector.js';
import { DeckPane } from './compare/deck-pane.js';
import type { Graph, ParamSpec } from './graph/types.js';
import type { Policy } from './graph/planner.js';

import scatterGraph from './graphs/scatter.json';
import heatmapGraph from './graphs/heatmap.json';

const GRAPHS: Record<string, Graph> = {
  scatter: scatterGraph as Graph,
  heatmap: heatmapGraph as Graph,
};

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const canvas = $<HTMLCanvasElement>('#canvas');
const statusEl = $('#status');
const fatalEl = $('#fatal');
const paramsEl = $('#params');
const countersEl = $('#counters');
const graphSel = $<HTMLSelectElement>('#graph');
const policySel = $<HTMLSelectElement>('#policy');
const rowsSel = $<HTMLSelectElement>('#rows');
const modeSel = $<HTMLSelectElement>('#mode');
const rebuildBtn = $<HTMLButtonElement>('#rebuild');
const benchBtn = $<HTMLButtonElement>('#bench');
const deckCanvas = $<HTMLCanvasElement>('#deck-canvas');
const webgpuPane = $<HTMLElement>('.pane[data-pane="webgpu"]');
const deckPaneEl = $<HTMLElement>('.pane[data-pane="deck"]');

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function fatal(message: string): void {
  fatalEl.style.display = 'grid';
  fatalEl.textContent = message;
  setStatus('failed', true);
}

async function main(): Promise<void> {
  const inspector = new Inspector($('#tabs'), $('#body'));

  setStatus('initializing webgpu…');
  let gpu;
  try {
    gpu = await initGpu(canvas);
  } catch (err) {
    fatal(
      err instanceof GpuUnavailable
        ? `${err.message}\n\nThis prototype has no WebGL fallback by design — the point is the WebGPU path.`
        : String(err),
    );
    return;
  }

  setStatus('starting duckdb-wasm…');
  const duck = await Duck.open();
  const rt = new Runtime(gpu, duck);
  // Attached to the pane container so orbiting works in every render mode.
  rt.camera.attach($<HTMLElement>('#panes'));

  // Debug handle. Reading an attribute buffer back is the only way to tell "the kernel
  // wrote nothing" apart from "the camera is looking the wrong way".
  Object.assign(window as unknown as Record<string, unknown>, { rt, duck, gpu });

  /** Currently loaded graph, with the row count from the header applied. */
  let graph: Graph = structuredClone(GRAPHS[graphSel.value]);
  let generating = false;
  /** Created lazily: no reason to spin up a WebGL2 context unless it is asked for. */
  let deckPane: DeckPane | undefined;

  const deckWanted = () => modeSel.value !== 'webgpu';

  function syncPanes(): void {
    webgpuPane.hidden = modeSel.value === 'deck';
    deckPaneEl.hidden = modeSel.value === 'webgpu';
  }

  /** Rebuild the deck layer by evaluating the plan's GPU stage on the CPU. */
  function refreshDeck(): void {
    const result = rt.result();
    if (!deckWanted() || !result) return;
    deckPane ??= new DeckPane(deckCanvas);
    try {
      deckPane.update(result.plan, rt.sourceUploads, rt.params(), result.rows);
      // Sync immediately: the frame loop only syncs on camera *changes*, so a pane
      // created after the last camera move would otherwise never get a view state.
      deckPane.syncCamera(rt.camera, deckCanvas.clientHeight || 600);
      inspector.renderCompare(result, rt, deckPane.metrics());
    } catch (err) {
      console.error('[deck]', err);
      inspector.showError(`deck.gl comparison failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const applyRowCount = (g: Graph) => {
    const source = g.nodes.find((n) => n.type === 'source');
    if (source?.type === 'source' && source.dataset.kind === 'synthetic') {
      source.dataset.rows = Number(rowsSel.value);
    }
  };

  /** Full rebuild: regenerate the source if needed, replan, re-upload, recompile. */
  async function rebuild(reloadSource: boolean): Promise<void> {
    if (generating) return;
    generating = true;
    rebuildBtn.disabled = true;
    try {
      applyRowCount(graph);
      if (reloadSource) {
        setStatus(`generating ${Number(rowsSel.value).toLocaleString()} rows in duckdb…`);
        await rt.loadSource(graph);
      }
      setStatus('planning…');
      const result = await rt.build(graph, policySel.value as Policy);
      inspector.render(result);
      inspector.renderCompare(result, rt, deckWanted() ? deckPane?.metrics() : undefined);
      buildParamControls(result.plan.params);
      refreshDeck();
      setStatus(`${result.rows.toLocaleString()} rows · built in ${result.timings.totalMs.toFixed(0)} ms`);
      fatalEl.style.display = 'none';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      inspector.showError(message);
      setStatus(message, true);
      console.error(err);
    } finally {
      generating = false;
      rebuildBtn.disabled = false;
    }
  }

  /**
   * One slider per parameter, labeled with the route its change will take. Moving a
   * `uniform` slider must not increment the requery counter in the footer — that is the
   * prepared-statement claim, checkable live.
   */
  function buildParamControls(specs: Record<string, ParamSpec>): void {
    paramsEl.innerHTML = '';
    const values = rt.params();
    for (const [name, spec] of Object.entries(specs)) {
      const route = rt.classify(name);
      if (route === 'unused') continue;

      const wrap = document.createElement('div');
      wrap.className = 'param';

      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = spec.label ?? name;

      const badge = document.createElement('span');
      badge.className = `route ${route}`;
      badge.textContent = route;

      const slider = document.createElement('input');
      slider.type = 'range';
      // Stats-published params have no declared range; derive one from the value.
      const min = spec.min ?? Math.min(0, values[name]);
      const max = spec.max ?? Math.max(1, values[name] * 2);
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(spec.step ?? (max - min) / 200);
      slider.value = String(values[name]);

      const readout = document.createElement('span');
      readout.className = 'val';
      readout.textContent = formatValue(values[name]);

      let pending: number | undefined;
      let inFlight = false;
      const flush = async () => {
        if (inFlight || pending === undefined) return;
        inFlight = true;
        const v = pending;
        pending = undefined;
        await rt.setParam(name, v);
        const r = rt.result();
        if (r && route === 'requery') {
          // A requery changes the row count, so the bench pane is stale otherwise.
          inspector.render(r);
        }
        // deck.gl has to redo the whole CPU loop for any parameter change — that
        // asymmetry with the WebGPU path's uniform write is the point of the comparison.
        refreshDeck();
        inFlight = false;
        void flush();
      };

      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        readout.textContent = formatValue(v);
        pending = v;
        void flush();
      });

      wrap.append(label, badge, slider, readout);
      paramsEl.append(wrap);
    }
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * Rebuild at each row count and record what it cost.
   *
   * Frame cost comes from `rt.timeFrames`, not from the rAF loop's `frameMs`: rAF
   * throttles hard when the tab is not visible, which turns an 8 ms frame into a
   * reported 640 ms and makes unattended sweeps worthless.
   */
  async function runSweep(): Promise<void> {
    const counts = [100_000, 1_000_000, 5_000_000];
    const withDeck = deckWanted();
    const results: SweepRow[] = [];
    const originalRows = rowsSel.value;
    benchBtn.disabled = true;
    try {
      // A build may already be in flight (the initial one, or a rebuild); `rebuild`
      // no-ops while that is true, which would silently produce an empty sweep.
      while (generating) await sleep(50);

      for (const count of counts) {
        rowsSel.value = String(count);
        setStatus(`sweep: building ${count.toLocaleString()} rows…`);
        await rebuild(true);
        const r = rt.result();
        if (!r) continue;

        setStatus(`sweep: timing ${r.rows.toLocaleString()} rows…`);
        const frameMs = await rt.timeFrames(60);
        const deck = withDeck ? deckPane?.metrics() : undefined;

        results.push({
          rows: r.rows,
          queryMs: r.timings.queryMs,
          convertMs: r.timings.convertMs,
          uploadMs: r.timings.uploadMs,
          totalBuildMs: r.timings.totalMs,
          bytes: r.attributes.reduce((s, a) => s + a.bytes, 0),
          writeCalls: r.timings.writeCalls,
          frameMs,
          deckCpuMs: deck ? deck.materializeMs + deck.evalMs + deck.packMs : undefined,
          deckBytes: deck?.bytes,
        });
      }
      renderSweep($<HTMLElement>('section[data-tab="bench"]'), results, withDeck);
      inspector.select('bench');
      setStatus(`sweep complete · ${results.length} row counts`);
      console.table(results);
    } finally {
      rowsSel.value = originalRows;
      benchBtn.disabled = false;
    }
  }

  benchBtn.addEventListener('click', () => void runSweep());

  graphSel.addEventListener('change', () => {
    graph = structuredClone(GRAPHS[graphSel.value]);
    const source = graph.nodes.find((n) => n.type === 'source');
    if (source?.type === 'source' && source.dataset.kind === 'synthetic') {
      rowsSel.value = String(source.dataset.rows);
    }
    void rebuild(true);
  });
  policySel.addEventListener('change', () => void rebuild(false));
  modeSel.addEventListener('change', () => {
    syncPanes();
    refreshDeck();
  });
  rowsSel.addEventListener('change', () => void rebuild(true));
  rebuildBtn.addEventListener('click', () => void rebuild(true));

  // Match the header control to whatever the default graph asks for.
  const initialSource = graph.nodes.find((n) => n.type === 'source');
  if (initialSource?.type === 'source' && initialSource.dataset.kind === 'synthetic') {
    rowsSel.value = String(initialSource.dataset.rows);
  }
  syncPanes();
  await rebuild(true);

  let counterTick = 0;
  let lastCameraVersion = -1;
  const loop = () => {
    if (!webgpuPane.hidden) rt.frame();
    if (deckPane && !deckPaneEl.hidden) {
      if (rt.camera.version !== lastCameraVersion) {
        deckPane.syncCamera(rt.camera, deckCanvas.clientHeight);
        lastCameraVersion = rt.camera.version;
      }
      // Both renderers must draw every frame or their frame times mean different things.
      deckPane.tick();
    }
    // The counter strip does not need 60 Hz and re-rendering it every frame shows up
    // in the frame time it is trying to report.
    if (++counterTick % 10 === 0) {
      renderCounters(countersEl, rt, rt.result()?.rows ?? 0, deckPane?.metrics().frameMs);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 10000) return v.toExponential(2);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

void main();
