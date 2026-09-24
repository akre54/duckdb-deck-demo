/**
 * A plan rendered as a deck.gl layer on a MapLibre basemap.
 *
 * The integration goes through `@deck.gl/mapbox`'s `MapboxOverlay`, which is deck's own
 * adapter for both mapbox-gl and maplibre-gl: it is an `IControl` the map owns, and it keeps
 * deck's `MapView` in lockstep with the map's camera. That is why this module takes a map
 * the caller created rather than creating one — the application owns the basemap, its
 * style and its controls, and `maplibre-gl` never becomes an import of this library.
 *
 * The attribute path is the WebGL2 one: MapLibre renders through WebGL2, so there is no
 * compute stage to write buffers, and the plan's GPU stage is evaluated by the generated JS
 * loop exactly as `DeckWebgl2Pane` does. What changes is the coordinate system — positions
 * are geographic here, not the orbit camera's normalized world.
 */

import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer } from '@deck.gl/layers';

import { evaluateStage, toUint8Color, type PhysicalPlan, type ColumnUpload } from '@noodles.gl/planner';
import type { DeckMetrics } from './webgl2-pane.js';

/**
 * The slice of a maplibre-gl (or mapbox-gl) `Map` this pane touches. Structural, so the
 * library does not depend on either package's types.
 */
export interface MapLike {
  addControl(control: MapboxOverlay): unknown;
  removeControl(control: MapboxOverlay): unknown;
}

export interface DeckMaplibreOptions {
  /**
   * What the plan's position attribute holds.
   *
   *   `lnglat`               `[lng, lat, metres]`, bound directly. What a graph written for
   *                          a map should produce (`project` with `mode: 'identity'`).
   *   `normalized-mercator`  the output of `project` with `mode: 'mercator'` and
   *                          `worldScale: 1` — Web Mercator scaled to [-0.5, 0.5]. Inverted
   *                          back to degrees on the CPU so the orbit-camera example graphs
   *                          render on a map unchanged. Z is dropped: it is exaggerated for
   *                          the orbit view and would put points thousands of km up.
   */
  coordinates?: 'lnglat' | 'normalized-mercator';
  /**
   * Draw inside MapLibre's WebGL2 context, between basemap layers, rather than on a canvas
   * stacked above it. Off by default: overlaid is the mode that works with every style.
   */
  interleaved?: boolean;
}

export class DeckMaplibrePane {
  private readonly overlay: MapboxOverlay;
  private readonly coordinates: NonNullable<DeckMaplibreOptions['coordinates']>;
  private metricsValue: DeckMetrics = {
    rows: 0, materializeMs: 0, evalMs: 0, packMs: 0, bytes: 0, frameMs: 0, code: '',
  };
  private lastStamp = 0;

  constructor(private readonly map: MapLike, options: DeckMaplibreOptions = {}) {
    this.coordinates = options.coordinates ?? 'lnglat';
    this.overlay = new MapboxOverlay({
      interleaved: options.interleaved ?? false,
      layers: [],
      onAfterRender: () => {
        // The map redraws only on camera or data changes, so this is a per-redraw interval,
        // not a continuous frame time. Reported for parity with the other panes, not timed.
        const now = performance.now();
        if (this.lastStamp) {
          this.metricsValue.frameMs = this.metricsValue.frameMs * 0.9 + (now - this.lastStamp) * 0.1;
        }
        this.lastStamp = now;
      },
    });
    map.addControl(this.overlay);
  }

  metrics(): DeckMetrics {
    return this.metricsValue;
  }

  update(
    plan: PhysicalPlan,
    sources: Map<string, ColumnUpload>,
    params: Record<string, number>,
    rows: number,
  ): void {
    if (rows === 0 || plan.render.mode !== 'points') {
      this.overlay.setProps({ layers: [] });
      this.metricsValue = {
        ...this.metricsValue, rows, materializeMs: 0, evalMs: 0, packMs: 0, bytes: 0,
        code: plan.render.mode !== 'points' ? '(heatmap mode has no map layer here)' : '',
      };
      return;
    }

    // Both stages on the CPU, for the same reason as the WebGL2 pane: there is no compute
    // on a WebGL2 context, so a GPU-stage attribute has to be recomputed here.
    const attrs = evaluateStage([...plan.cpuStage, ...plan.gpuStage], plan, sources, params, rows);

    const pos = attrs.values.get(plan.channels.position);
    if (!pos) throw new Error(`maplibre pane: no '${plan.channels.position}' attribute after CPU evaluation`);
    const colorSrc = attrs.values.get(plan.channels.color);
    const sizeSrc = attrs.values.get(plan.channels.size);

    const tPack = performance.now();
    // A filter the planner left on the GPU is a discard mask, not a WHERE clause. deck has
    // no per-instance discard, so masked rows are dropped here — otherwise the map would
    // show rows the graph filtered out.
    const mask = plan.maskAttribute ? attrs.values.get(plan.maskAttribute) : undefined;
    const keep = mask ? keptRows(mask.data, mask.width, rows) : undefined;
    const n = keep ? keep.length : rows;

    const positions = this.coordinates === 'normalized-mercator'
      ? inverseMercator(pos.data, pos.width, rows, keep)
      : pick(widen(pos.data, pos.width, rows), 3, keep);
    const colors = colorSrc
      ? pick(toUint8Color(colorSrc.data, colorSrc.width, rows), 4, keep)
      : undefined;
    const sizes = sizeSrc ? pick(sizeSrc.data, 1, keep) : undefined;
    const packMs = performance.now() - tPack;

    const layer = new ScatterplotLayer({
      id: 'maplibre',
      data: {
        length: n,
        attributes: {
          getPosition: { value: positions, size: 3 },
          ...(colors ? { getFillColor: { value: colors, size: 4 } } : {}),
          ...(sizes ? { getRadius: { value: sizes, size: 1 } } : {}),
        },
      },
      coordinateSystem: 'lnglat',
      radiusUnits: 'pixels',
      radiusMinPixels: 0.5,
      radiusMaxPixels: 64,
      getFillColor: colors ? undefined : [140, 200, 242],
      getRadius: sizes ? undefined : 2,
      pickable: false,
      // Every circle lies on the ground plane, so depth testing only makes them z-fight at
      // nonzero pitch. Jittering altitude was the alternative, but depth precision at world
      // zoom is kilometres, and an offset that large lifts points visibly at street zoom.
      // Without the test, overlapping points draw in row order at every zoom and pitch.
      parameters: { depthCompare: 'always' },
    });
    this.overlay.setProps({ layers: [layer] });

    this.metricsValue = {
      rows: n,
      materializeMs: attrs.materializeMs,
      evalMs: attrs.evalMs,
      packMs,
      bytes: positions.byteLength + (colors?.byteLength ?? 0) + (sizes?.byteLength ?? 0),
      frameMs: this.metricsValue.frameMs,
      code: attrs.code,
    };
  }

  destroy(): void {
    this.map.removeControl(this.overlay);
    this.overlay.finalize();
  }
}

/** Row indices whose mask value passes, matching the WebGPU pass's `< 0.5` discard test. */
function keptRows(mask: Float32Array, width: number, rows: number): Uint32Array {
  const out = new Uint32Array(rows);
  let n = 0;
  for (let i = 0; i < rows; i++) if (mask[i * width] >= 0.5) out[n++] = i;
  return out.subarray(0, n);
}

function pick<T extends Float32Array | Uint8Array>(src: T, width: number, keep?: Uint32Array): T {
  if (!keep) return src;
  const out = new (src.constructor as new (n: number) => T)(keep.length * width);
  for (let j = 0; j < keep.length; j++) {
    const i = keep[j];
    for (let c = 0; c < width; c++) out[j * width + c] = src[i * width + c];
  }
  return out;
}

function widen(src: Float32Array, width: number, rows: number): Float32Array {
  if (width === 3) return src;
  const out = new Float32Array(rows * 3);
  for (let i = 0; i < rows; i++) {
    for (let c = 0; c < 3; c++) out[i * 3 + c] = c < width ? src[i * width + c] : 0;
  }
  return out;
}

/** The inverse of `project`'s normalized Web Mercator (see `desugar` in the planner). */
function inverseMercator(src: Float32Array, width: number, rows: number, keep?: Uint32Array): Float32Array {
  const n = keep ? keep.length : rows;
  const out = new Float32Array(n * 3);
  for (let j = 0; j < n; j++) {
    const i = keep ? keep[j] : j;
    out[j * 3] = src[i * width] * 360;
    out[j * 3 + 1] = (2 * Math.atan(Math.exp(src[i * width + 1] * 2 * Math.PI)) - Math.PI / 2) * (180 / Math.PI);
  }
  return out;
}
