/**
 * Wiring. Nothing architectural lives here — it picks a graph, builds it, and runs a
 * frame loop. The interesting code is graph/planner.ts and graph/backends/.
 */

import { initGpu, GpuUnavailable, type Gpu } from '../src/webgpu/device.js';
import { DuckDbEngine } from '../src/duckdb/index.js';
import { syntheticSource } from './data/synthetic.js';

// Bundler-resolved URLs for the DuckDB wasm bundles. These `?url` imports are the one
// Vite-specific thing left, and they live here rather than in the library on purpose.
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { Runtime } from '../src/webgpu/runtime.js';
import { Inspector, renderCounters, renderSweep, type SweepRow } from './ui/inspector.js';
import { renderCalibration } from './ui/explain.js';
import { DeckPane } from '../src/deck/webgl2-pane.js';
import { DeckWebgpuPane } from '../src/deck/webgpu-pane.js';
import { type TargetId, type Graph, type ParamSpec, type Policy } from '@noodles.gl/planner';
import { WrangleEditor } from './ui/editor.js';

import scatterGraph from './graphs/scatter.json';
import heatmapGraph from './graphs/heatmap.json';
import wrangleGraph from './graphs/wrangle.json';

const GRAPHS: Record<string, Graph> = {
  scatter: scatterGraph as Graph,
  heatmap: heatmapGraph as Graph,
  wrangle: wrangleGraph as Graph,
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
const targetSel = $<HTMLSelectElement>('#target');
const rebuildBtn = $<HTMLButtonElement>('#rebuild');
const benchBtn = $<HTMLButtonElement>('#bench');
const deckCanvas = $<HTMLCanvasElement>('#deck-canvas');
const deckGpuCanvas = $<HTMLCanvasElement>('#deck-gpu-canvas');
const webgpuPane = $<HTMLElement>('.pane[data-pane="webgpu"]');
const deckPaneEl = $<HTMLElement>('.pane[data-pane="deck"]');
const deckGpuPaneEl = $<HTMLElement>('.pane[data-pane="deck-gpu"]');

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
  let gpu: Gpu;
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
  const duck = await DuckDbEngine.open({
    mvpModule: mvpWasm, mvpWorker, ehModule: ehWasm, ehWorker,
  });
  const rt = new Runtime(gpu, duck);
  // The graph's `source.dataset.ref` is 'synthetic'; the row count comes from the header.
  rt.registerSource('synthetic', syntheticSource(() => Number(rowsSel.value)));
  // Attached to the pane container so orbiting works in every render mode.
  rt.camera.attach($<HTMLElement>('#panes'));

  // Debug handle. Reading an attribute buffer back is the only way to tell "the kernel
  // wrote nothing" apart from "the camera is looking the wrong way".
  Object.assign(window as unknown as Record<string, unknown>, { rt, duck, gpu });

  /** Currently loaded graph, with the row count from the header applied. */
  let graph: Graph = structuredClone(GRAPHS[graphSel.value]);
  let generating = false;
  /**
   * Two deck panes, one per capability story, created lazily and never both at once —
   * they share a canvas, and only one graphics context can own it.
   *
   *   deck-webgl2  no compute: attributes computed by the generated JS loop
   *   deck-webgpu  compute available: the planner's kernel runs on luma's WebGPU device
   *                and deck binds the resulting buffers directly
   */
  let deckPane: DeckPane | undefined;
  let deckGpuPane: DeckWebgpuPane | undefined;

  const deckWanted = () => modeSel.value !== 'webgpu';
  const deckUsesCompute = () => targetSel.value === 'deck-webgpu';

  function syncPanes(): void {
    const showDeck = modeSel.value !== 'webgpu';
    webgpuPane.hidden = modeSel.value === 'deck';
    // Each deck backend owns its own canvas, so only the one matching the target shows.
    deckPaneEl.hidden = !showDeck || deckUsesCompute();
    deckGpuPaneEl.hidden = !showDeck || !deckUsesCompute();
  }

  /** Rebuild the deck layer, by whichever route the target's capabilities allow. */
  async function refreshDeck(): Promise<void> {
    const result = rt.result();
    if (!deckWanted() || !result) return;

    try {
      if (deckUsesCompute()) {
        deckGpuPane ??= new DeckWebgpuPane(deckGpuCanvas);
        await deckGpuPane.update(result.plan, rt.sourceUploads, rt.params(), result.rows);
        deckGpuPane.syncCamera(rt.camera, deckGpuCanvas.clientHeight || 600);
        inspector.renderCompare(result, rt, undefined, deckGpuPane.status);
      } else {
        deckPane ??= new DeckPane(deckCanvas);
        deckPane.update(result.plan, rt.sourceUploads, rt.params(), result.rows);
        // Sync immediately: the frame loop only syncs on camera *changes*, so a pane
        // created after the last camera move would otherwise never get a view state.
        deckPane.syncCamera(rt.camera, deckCanvas.clientHeight || 600);
        inspector.renderCompare(result, rt, deckPane.metrics());
      }
    } catch (err) {
      console.error('[deck]', err);
      inspector.showError(`deck.gl comparison failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The provider reads the row count from the selector, so only the planner's estimate hint
   * needs updating here.
   */
  const applyRowCount = (g: Graph) => {
    const source = g.nodes.find((n) => n.type === 'source');
    if (source?.type === 'source') source.dataset.estimatedRows = Number(rowsSel.value);
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
      editor.sync();
      inspector.renderCompare(result, rt, deckWanted() ? deckPane?.metrics() : undefined);
      buildParamControls(result.plan.params);
      void refreshDeck();
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
        void refreshDeck();
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

  /**
   * The wrangle editor plans a candidate graph on every keystroke (headless, single-digit ms)
   * and rebuilds only when applied. Its `apply` writes the edited body back into the live
   * graph, so the edit persists across policy and target changes.
   */
  const editor = new WrangleEditor(inspector.section('edit'), {
    graph: () => graph,
    runtime: () => rt,
    policy: () => policySel.value as Policy,
    apply: (body) => {
      const node = graph.nodes.find((n) => n.type === 'wrangle');
      if (node?.type !== 'wrangle') return;
      node.body = body;
      void rebuild(false);
    },
  });
  editor.sync();

  graphSel.addEventListener('change', () => {
    graph = structuredClone(GRAPHS[graphSel.value]);
    const source = graph.nodes.find((n) => n.type === 'source');
    const rows = source?.type === 'source' ? source.dataset.rows : undefined;
    if (typeof rows === 'number') rowsSel.value = String(rows);
    void rebuild(true);
  });
  policySel.addEventListener('change', () => void rebuild(false));
  targetSel.addEventListener('change', () => {
    rt.setTarget(targetSel.value as TargetId);
    // The target picks which deck backend (and so which canvas) is on screen.
    syncPanes();
    // A capability change can make the current plan illegal, so this is a replan, not a
    // render-mode switch: on deck-webgl2 the GPU stage disappears entirely.
    void rebuild(false);
  });
  modeSel.addEventListener('change', () => {
    syncPanes();
    void refreshDeck();
  });
  rowsSel.addEventListener('change', () => void rebuild(true));
  rebuildBtn.addEventListener('click', () => void rebuild(true));

  // Match the header control to whatever the default graph asks for.
  const initialSource = graph.nodes.find((n) => n.type === 'source');
  const initialRows = initialSource?.type === 'source' ? initialSource.dataset.rows : undefined;
  if (typeof initialRows === 'number') rowsSel.value = String(initialRows);
  syncPanes();

  // Calibrate before the first plan: the optimizer's decisions are only as portable as
  // its constants, and defaults measured on another machine would silently mislead it.
  setStatus('calibrating cost model…');
  try {
    const report = await rt.runCalibration();
    renderCalibration(inspector.section('calibration'), report.samples, report.elapsedMs);
  } catch (err) {
    console.warn('[calibrate] failed; using default constants:', err);
    inspector.section('calibration').innerHTML =
      `<h2>calibration failed</h2><pre>${String(err)}\n\nFalling back to the constants in graph/cost.ts.</pre>`;
  }

  await rebuild(true);

  let counterTick = 0;
  let lastCameraVersion = -1;
  const loop = () => {
    if (!webgpuPane.hidden) rt.frame();
    const activeDeck = deckUsesCompute() ? deckGpuPane : deckPane;
    const activeCanvas = deckUsesCompute() ? deckGpuCanvas : deckCanvas;
    const activePaneEl = deckUsesCompute() ? deckGpuPaneEl : deckPaneEl;
    if (activeDeck && !activePaneEl.hidden) {
      if (rt.camera.version !== lastCameraVersion) {
        activeDeck.syncCamera(rt.camera, activeCanvas.clientHeight);
        lastCameraVersion = rt.camera.version;
      }
      // Both renderers must draw every frame or their frame times mean different things.
      activeDeck.tick();
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
