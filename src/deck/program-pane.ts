/**
 * A compiled program's layers, drawn by deck.gl over a MapLibre map.
 *
 * One factory per layer kind, each fed deck's binary-attribute fast path: typed arrays the
 * program runtime produced, never a per-row accessor inside deck. Vertex layers (path, trips)
 * use deck's binary path format — flat vertex arrays plus `startIndices` — which is exactly
 * the row model the planner emits: one row per vertex, ordered by path id.
 *
 * The one thing this module is careful about is identity. A layer's binary `data` object is
 * built once per `LayerData` and reused, so when only a prop changes — the trips layer's
 * `currentTime` on every frame of an animation, a keyframed camera — deck sees the same data
 * and re-uploads nothing. Rebuilding it per frame would turn a uniform write into a full
 * attribute upload and throw away the point of routing that parameter as `prop`.
 */

import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer } from '@deck.gl/core';
import { ScatterplotLayer, ArcLayer, PathLayer, ColumnLayer, TextLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';

import { toUint8Color, type LayerKind, type ResolvedProp } from '@noodles.gl/planner';
import type { LayerData } from '../program/execute.js';
import type { MapLike } from './maplibre-pane.js';

export interface ProgramLayerInput {
  id: string;
  kind: LayerKind;
  data?: LayerData;
  /** Channel -> attribute, from the plan's resolved layer bindings. */
  bindings: { channel: string; attribute: string }[];
  props: Record<string, ResolvedProp>;
}

export interface ProgramPaneMetrics {
  layers: number;
  instances: number;
  /** Binary data objects built on the last render; 0 when only props changed. */
  rebuilt: number;
  buildMs: number;
}

type Binary = { length: number; startIndices?: Uint32Array; attributes: Record<string, unknown>; texts?: { position: number[]; text: string }[] };

export class DeckProgramPane {
  private readonly overlay: MapboxOverlay;
  private readonly built = new WeakMap<LayerData, Binary>();
  private metricsValue: ProgramPaneMetrics = { layers: 0, instances: 0, rebuilt: 0, buildMs: 0 };

  constructor(private readonly map: MapLike) {
    this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(this.overlay);
  }

  metrics(): ProgramPaneMetrics {
    return this.metricsValue;
  }

  render(inputs: ProgramLayerInput[]): void {
    const started = performance.now();
    let rebuilt = 0;
    let instances = 0;
    const layers: Layer[] = [];
    for (const input of inputs) {
      if (!input.data || input.data.rows === 0) continue;
      let binary = this.built.get(input.data);
      if (!binary) {
        binary = toBinary(input);
        this.built.set(input.data, binary);
        rebuilt++;
      }
      instances += input.data.rows;
      const layer = buildLayer(input, binary);
      if (layer) layers.push(layer);
    }
    this.overlay.setProps({ layers });
    this.metricsValue = { layers: layers.length, instances, rebuilt, buildMs: performance.now() - started };
  }

  destroy(): void {
    this.map.removeControl(this.overlay);
    this.overlay.finalize();
  }
}

// ---------------------------------------------------------------------------

const attr = (input: ProgramLayerInput, channel: string) => {
  const name = input.bindings.find((b) => b.channel === channel)?.attribute;
  return name ? input.data!.attributes.get(name) : undefined;
};

/** Positions as `[lng, lat, metres]`: deck's position attributes are three-wide. */
function positions(a: { data: Float32Array; width: number }, rows: number): Float32Array {
  if (a.width === 3) return a.data;
  const out = new Float32Array(rows * 3);
  for (let i = 0; i < rows; i++) {
    out[i * 3] = a.data[i * a.width];
    out[i * 3 + 1] = a.data[i * a.width + 1];
  }
  return out;
}

function colors(a: { data: Float32Array; width: number } | undefined, rows: number, alpha = 255): Uint8Array | undefined {
  return a ? toUint8Color(a.data, a.width, rows, alpha) : undefined;
}

function toBinary(input: ProgramLayerInput): Binary {
  const d = input.data!;
  const n = d.rows;
  const at: Record<string, unknown> = {};
  const put = (deckName: string, value: Float32Array | Uint8Array | undefined, size: number, normalized = false) => {
    if (value) at[deckName] = { value, size, ...(normalized ? { normalized: true } : {}) };
  };
  const pos = (channel: string) => {
    const a = attr(input, channel);
    return a ? positions(a, n) : undefined;
  };
  const scalar = (channel: string) => attr(input, channel)?.data;

  switch (input.kind) {
    case 'scatter':
      put('getPosition', pos('position'), 3);
      put('getFillColor', colors(attr(input, 'color'), n), 4, true);
      put('getRadius', scalar('radius'), 1);
      return { length: n, attributes: at };
    case 'arc':
      put('getSourcePosition', pos('sourcePosition'), 3);
      put('getTargetPosition', pos('targetPosition'), 3);
      put('getSourceColor', colors(attr(input, 'sourceColor'), n), 4, true);
      put('getTargetColor', colors(attr(input, 'targetColor'), n), 4, true);
      put('getWidth', scalar('width'), 1);
      return { length: n, attributes: at };
    case 'column':
      put('getPosition', pos('position'), 3);
      put('getElevation', scalar('elevation'), 1);
      put('getFillColor', colors(attr(input, 'color'), n), 4, true);
      return { length: n, attributes: at };
    case 'path':
    case 'trips': {
      const starts = d.starts ?? new Uint32Array([0]);
      put('getPath', pos('position'), 3);
      put('getColor', colors(attr(input, 'color'), n), 4, true);
      if (input.kind === 'path') put('getWidth', scalar('width'), 1);
      else put('getTimestamps', scalar('timestamp'), 1);
      return { length: starts.length, startIndices: starts, attributes: at };
    }
    case 'text': {
      // Text has no binary path worth taking at label counts: deck lays out glyphs per string
      // on the CPU regardless. Capped, because thousands of labels are unreadable anyway.
      const p = attr(input, 'position');
      const textName = input.bindings.find((b) => b.channel === 'text')?.attribute;
      const strings = textName ? d.strings.get(textName) ?? [] : [];
      const count = Math.min(n, 5000);
      const texts = Array.from({ length: count }, (_, i) => ({
        position: p ? [p.data[i * p.width], p.data[i * p.width + 1], p.width > 2 ? p.data[i * p.width + 2] : 0] : [0, 0, 0],
        text: strings[i] ?? '',
      }));
      return { length: count, attributes: {}, texts };
    }
  }
}

const num = (v: ResolvedProp | undefined, fallback: number): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};
const rgb = (v: ResolvedProp | undefined, fallback: [number, number, number]): [number, number, number, number] => {
  if (Array.isArray(v) && v.length >= 3) return [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2]), 255];
  return [...fallback, 255];
};

function buildLayer(input: ProgramLayerInput, binary: Binary): Layer | undefined {
  const p = input.props;
  const has = (deckName: string) => deckName in binary.attributes;
  const opacity = num(p.opacity, 1);
  const common = { id: input.id, opacity, pickable: false };
  // A constant color is an accessor too; its trigger is its value, so deck re-reads it only
  // when the color actually changes.
  const constant = (deckName: string, value: [number, number, number, number]) =>
    has(deckName) ? {} : { [deckName]: value, updateTriggers: { [deckName]: value.join(',') } };

  switch (input.kind) {
    case 'scatter':
      return new ScatterplotLayer({
        ...common,
        data: binary as never,
        radiusScale: num(p.radiusScale, 1),
        radiusUnits: p.radiusUnits === 'meters' ? 'meters' : 'pixels',
        radiusMinPixels: 0.5,
        getRadius: has('getRadius') ? undefined : 1,
        ...constant('getFillColor', rgb(p.fillColor, [255, 140, 0])),
        // Points on the ground plane only z-fight at pitch with depth testing; see maplibre-pane.
        parameters: { depthCompare: 'always' },
      } as never);
    case 'arc':
      return new ArcLayer({
        ...common,
        data: binary as never,
        widthScale: num(p.widthScale, 1),
        widthUnits: 'pixels',
        getWidth: has('getWidth') ? undefined : 1,
        getHeight: num(p.height, 1),
        greatCircle: p.greatCircle === true,
        ...constant('getSourceColor', rgb(p.sourceColor, [0, 180, 255])),
        ...constant('getTargetColor', rgb(p.targetColor, [255, 60, 120])),
      } as never);
    case 'column':
      return new ColumnLayer({
        ...common,
        data: binary as never,
        radius: num(p.radius, 100),
        elevationScale: num(p.elevationScale, 1),
        extruded: true,
        diskResolution: 12,
        getElevation: has('getElevation') ? undefined : 1,
        ...constant('getFillColor', rgb(p.fillColor, [255, 170, 60])),
      } as never);
    case 'path':
      return new PathLayer({
        ...common,
        data: binary as never,
        _pathType: 'open',
        widthScale: num(p.widthScale, 1),
        widthMinPixels: num(p.widthMinPixels, 1),
        widthUnits: 'pixels',
        getWidth: has('getWidth') ? undefined : 1,
        jointRounded: true,
        capRounded: true,
        ...constant('getColor', rgb(p.color, [120, 200, 255])),
      } as never);
    case 'trips':
      return new TripsLayer({
        ...common,
        data: binary as never,
        _pathType: 'open',
        currentTime: num(p.currentTime, 0),
        trailLength: num(p.trailLength, 180),
        fadeTrail: true,
        widthMinPixels: num(p.widthMinPixels, 2),
        jointRounded: true,
        capRounded: true,
        ...constant('getColor', rgb(p.color, [253, 128, 93])),
      } as never);
    case 'text':
      return new TextLayer({
        ...common,
        data: binary.texts ?? [],
        getPosition: (d: { position: number[] }) => d.position,
        getText: (d: { text: string }) => d.text,
        getSize: num(p.size, 12),
        getColor: rgb(p.color, [230, 230, 230]),
        getPixelOffset: [0, num(p.offsetY, 0)],
        updateTriggers: { getColor: String(p.color), getSize: String(p.size), getPixelOffset: String(p.offsetY) },
        fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
        outlineWidth: 2,
        outlineColor: [8, 9, 13, 220],
        fontSettings: { sdf: true },
      } as never);
  }
}
