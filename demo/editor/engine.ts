/**
 * The engine: the document on one side, DuckDB and the map on the other.
 *
 * It subscribes to the store and decides, on every change, how much work the change is:
 *
 *   - a new document object is lowered (fast, pure) and its graph compared structurally
 *     with the last one. Same structure -> only values moved -> `runtime.setValues`, which
 *     routes each parameter. Different structure -> `runtime.setGraph`, which recompiles
 *     through the memo.
 *   - a new time reuses the lowered document and only re-evaluates the scalar program.
 *
 * So a slider, a keyframe animation and a rewire all go through the same path and pay only
 * for what they change. Nothing here knows about any particular operator.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

import {
  lowerDocument, parameterValues, canonicalJson, targetCaps,
  type EditorDoc, type Lowered, type Graph,
} from '@noodles.gl/planner';
import { DuckDbEngine } from '../../src/duckdb/index.js';
import { ProgramRuntime, type UpdateReport } from '../../src/program/index.js';
import { DeckProgramPane, type ProgramLayerInput } from '../../src/deck/program-pane.js';
import { type Store } from './store.js';

const BASEMAPS: Record<string, string | undefined> = {
  'dark-matter': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  positron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  none: undefined,
};
const EMPTY_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#05060a' } }] } as const;

/** Structure of a graph: everything except parameter values, which route without a recompile. */
function structureKey(graph: Graph): string {
  const specs = Object.fromEntries(Object.entries(graph.params ?? {}).map(([k, s]) => [k, { ...s, value: typeof s.value }]));
  return canonicalJson({ nodes: graph.nodes, functions: graph.functions, specs });
}

export class Engine {
  runtime?: ProgramRuntime;
  duck?: DuckDbEngine;
  map?: maplibregl.Map;
  private pane?: DeckProgramPane;
  private lowered?: Lowered;
  private loweredFor?: EditorDoc;
  private lastStructure?: string;
  private lastTime = -1;
  private basemap?: string;
  /** The load whose camera has been applied: a loaded document frames its camera once. */
  private framedLoad = -1;
  private frame = 0;

  constructor(private readonly store: Store) {}

  async start(): Promise<void> {
    this.store.setRuntime({ status: 'starting duckdb-wasm…', busy: true });
    this.duck = await DuckDbEngine.open({ mvpModule: mvpWasm, mvpWorker, ehModule: ehWasm, ehWorker });
    this.runtime = new ProgramRuntime(this.duck, { caps: targetCaps('deck-webgl2', undefined) });
    this.runtime.onUpdate((r) => this.onUpdate(r));
    Object.assign(window as unknown as Record<string, unknown>, { engine: this, duck: this.duck, runtime: this.runtime });
    this.store.subscribe(() => this.sync());
    this.sync();
  }

  attachMap(container: HTMLElement): void {
    if (this.map) return;
    this.map = new maplibregl.Map({
      container, style: BASEMAPS['dark-matter']!, center: [0, 20], zoom: 1.5,
      attributionControl: { compact: true },
    });
    this.pane = new DeckProgramPane(this.map);
    this.map.on('load', () => this.renderLayers());
  }

  /** Map the current camera into the Deck node's camera parameters, as a new keyframe would. */
  cameraNow(): Record<string, number> | undefined {
    if (!this.map) return undefined;
    const c = this.map.getCenter();
    return {
      longitude: +c.lng.toFixed(4), latitude: +c.lat.toFixed(4), zoom: +this.map.getZoom().toFixed(2),
      pitch: +this.map.getPitch().toFixed(1), bearing: +this.map.getBearing().toFixed(1),
    };
  }

  private sync(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    const s = this.store.get();
    const docChanged = s.doc !== this.loweredFor;
    if (!docChanged && s.time === this.lastTime) return;
    this.lastTime = s.time;

    if (docChanged) {
      const program = runtime.program();
      this.lowered = lowerDocument(s.doc, {
        displayPosition: (nodeId) => {
          const ir = this.lowered?.outputs[nodeId]?.out ?? nodeId;
          const cols = program?.nodes[ir]?.columns.map((c) => c.name) ?? [];
          if (cols.includes('P')) return 'P';
          const lng = cols.find((c) => /^(lng|lon|long|longitude|lon1|o_lng)$/i.test(c));
          const lat = cols.find((c) => /^(lat|latitude|lat1|o_lat)$/i.test(c));
          return lng && lat ? `[${lng}, ${lat}]` : undefined;
        },
      });
      this.loweredFor = s.doc;
    }
    const lowered = this.lowered!;
    const fps = s.doc.timeline?.fps ?? 30;
    const { values, slots, errors } = parameterValues(lowered, { T: s.time, F: Math.round(s.time * fps) });
    this.store.setRuntime({ lowered, slots, slotErrors: errors });

    const key = structureKey(lowered.graph);
    if (key !== this.lastStructure) {
      this.lastStructure = key;
      this.store.setRuntime({ busy: true, status: 'compiling…' });
      void runtime.setGraph(lowered.graph, values).catch((err) => this.fail(err));
    } else {
      void runtime.setValues(values).catch((err) => this.fail(err));
    }
    this.applyDeckSettings(s.doc);
  }

  private fail(err: unknown): void {
    console.error(err);
    this.store.setRuntime({ busy: false, error: (err as Error).message, status: 'error' });
  }

  private onUpdate(report: UpdateReport): void {
    const runtime = this.runtime!;
    const program = runtime.program();
    const heavy = report.requeried.length + report.evaluated.length + report.rematerialized > 0 || report.kind === 'graph';
    const rows = runtime.layers().reduce((n, l) => n + (l.data?.rows ?? 0), 0);
    this.store.setRuntime({
      program,
      layers: runtime.layers(),
      report: heavy ? report : this.store.get().runtime.report,
      counters: { ...runtime.counters },
      catalog: { ...runtime.catalog.counters },
      busy: false,
      error: runtime.error(),
      status: runtime.error() ? 'compile failed'
        : `${program?.layers.length ?? 0} layers · ${rows.toLocaleString()} instances` +
          (heavy ? ` · ${report.ms.toFixed(0)} ms` : ''),
      version: this.store.get().runtime.version + (heavy ? 1 : 0),
    });
    this.renderLayers();
    const load = this.store.get().loadId;
    if (program && load !== this.framedLoad) {
      this.framedLoad = load;
      this.applyCamera(true);
    } else {
      this.applyCamera(false);
    }
  }

  private renderLayers(): void {
    const runtime = this.runtime;
    if (!runtime || !this.pane) return;
    const inputs: ProgramLayerInput[] = runtime.layers().map((l) => ({
      id: l.id,
      kind: l.plan.kind,
      data: l.data,
      bindings: l.plan.plan.layer?.bindings ?? [],
      props: l.props,
    }));
    this.pane.render(inputs);
  }

  private deckNode(doc: EditorDoc) {
    return doc.nodes.find((n) => n.op === 'deck' && !n.flags?.bypass);
  }

  private applyDeckSettings(doc: EditorDoc): void {
    const deck = this.deckNode(doc);
    const basemap = String(deck?.params.basemap ?? 'dark-matter');
    if (this.map && basemap !== this.basemap) {
      this.basemap = basemap;
      this.map.setStyle((BASEMAPS[basemap] ?? EMPTY_STYLE) as string);
    }
  }

  /** Move the map to the Deck node's camera: always on load, every frame when following. */
  applyCamera(force: boolean): void {
    const map = this.map;
    const runtime = this.runtime;
    if (!map || !runtime) return;
    const deck = this.deckNode(this.store.get().doc);
    const follow = deck?.params.follow === true;
    if (!force && !follow) return;
    const v = runtime.view();
    if (![v.longitude, v.latitude, v.zoom].every(Number.isFinite)) return;
    map.jumpTo({ center: [v.longitude, v.latitude], zoom: v.zoom, pitch: v.pitch ?? 0, bearing: v.bearing ?? 0 });
  }

  /** Playback: advance the clock on animation frames while playing. */
  startClock(): void {
    let last = performance.now();
    const tick = (now: number) => {
      const s = this.store.get();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (s.playing) {
        const length = s.doc.timeline?.length ?? 10;
        let t = s.time + dt;
        if (t > length) {
          if (s.loop) t = t % length;
          else { t = length; this.store.set({ playing: false }); }
        }
        this.store.set({ time: t });
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
  }
}
