/**
 * The deck.gl comparison pane.
 *
 * Fed deck's own documented fast path — a `ScatterplotLayer` with binary attributes, so
 * no per-row JS accessors run inside deck. The JS cost is in `cpu-attributes.ts`
 * instead, which is where it honestly belongs: it is the cost of getting a graph's
 * derived attributes into a renderer that cannot read GPU buffers the graph wrote.
 *
 * Read the caveats before believing any number this produces:
 *
 *   1. deck.gl 9 renders through luma.gl's WebGL2 backend here. Its WebGPU backend is
 *      experimental and not what `npm install @deck.gl/core` gives you. So a frame-time
 *      comparison is across two graphics APIs, not two architectures.
 *   2. The camera framing is approximate. OrbitView's `zoom` is not our `distance`, and
 *      chasing an exact match would not change what is being measured.
 *   3. In `both` mode the two renderers share one GPU. Use the solo modes for timings.
 */

import { Deck, OrbitView } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';

import type { PhysicalPlan } from '../graph/planner.js';
import type { OrbitCamera } from '../engine/camera.js';
import { evaluateStage, toUint8Color, type CpuAttributes } from './cpu-attributes.js';
import type { ColumnUpload } from '../engine/arrow-gpu.js';

export interface DeckMetrics {
  rows: number;
  /** CPU ms making source columns contiguous. */
  materializeMs: number;
  /** CPU ms in the generated per-row attribute loop. */
  evalMs: number;
  /** CPU ms packing float colors into deck's Uint8 RGBA. */
  packMs: number;
  /** Bytes of CPU-side typed arrays handed to deck. */
  bytes: number;
  frameMs: number;
  /** The generated JS loop, for the inspector. */
  code: string;
}

export class DeckPane {
  private deck: Deck<OrbitView>;
  private frameMs = 0;
  private lastStamp = 0;
  private attrs?: CpuAttributes;
  private metricsValue: DeckMetrics = {
    rows: 0, materializeMs: 0, evalMs: 0, packMs: 0, bytes: 0, frameMs: 0, code: '',
  };

  constructor(canvas: HTMLCanvasElement) {
    this.deck = new Deck<OrbitView>({
      canvas,
      views: new OrbitView({ id: 'orbit', orbitAxis: 'Y', fovy: 50, near: 0.01, far: 100 }),
      initialViewState: { target: [0, 0, 0], zoom: 0, rotationX: 30, rotationOrbit: 0 },
      // Driven from the shared OrbitCamera so both panes show the same thing.
      controller: false,
      parameters: { depthTest: true } as Record<string, unknown>,
      layers: [],
      onAfterRender: () => {
        const now = performance.now();
        if (this.lastStamp) this.frameMs = this.frameMs * 0.9 + (now - this.lastStamp) * 0.1;
        this.lastStamp = now;
        this.metricsValue.frameMs = this.frameMs;
      },
    });
  }

  metrics(): DeckMetrics {
    return this.metricsValue;
  }

  /**
   * Force a redraw this frame.
   *
   * Without this, deck.gl renders only when props or view state change, so its
   * "frame time" would be the idle interval between redraws — a number that looks
   * spectacular and means nothing. Our loop draws every frame, so deck has to as well
   * before the two can be compared at all.
   */
  tick(): void {
    this.deck.redraw('comparison-continuous');
  }

  /**
   * Note on what is deliberately NOT measured here.
   *
   * There is no honest deck.gl equivalent of `Runtime.timeFrames`. `deck.redraw()` only
   * sets a needs-redraw flag — the draw happens later inside deck's own animation loop —
   * so timing a loop of `redraw()` calls returns ~0.04 ms and measures nothing. And deck
   * exposes no completion hook equivalent to `queue.onSubmittedWorkDone()`, so its GPU
   * execution cannot be drained and timed from outside.
   *
   * The live `frameMs` from `onAfterRender` is the best available number, and it is only
   * trustworthy while the tab is visible, because requestAnimationFrame throttles
   * otherwise. So the sweep compares the CPU attribute path — which is the axis that
   * actually differs architecturally — and leaves frame time to the on-screen readout.
   */

  /**
   * Rebuild the layer from the plan by evaluating its GPU stage on the CPU. This is the
   * expensive call — it is the deck path's equivalent of a kernel dispatch, except a
   * dispatch does not touch JS at all.
   */
  update(
    plan: PhysicalPlan,
    sources: Map<string, ColumnUpload>,
    params: Record<string, number>,
    rows: number,
  ): void {
    if (rows === 0 || plan.render.mode !== 'points') {
      this.deck.setProps({ layers: [] });
      this.metricsValue = { rows, materializeMs: 0, evalMs: 0, packMs: 0, bytes: 0, frameMs: this.frameMs, code: plan.render.mode !== 'points' ? '(heatmap mode has no deck.gl equivalent here)' : '' };
      return;
    }

    // deck gets both stages on the CPU: it cannot read a buffer the kernel wrote without
    // a readback, so anything the plan placed on the GPU has to be recomputed here.
    const attrs = evaluateStage([...plan.cpuStage, ...plan.gpuStage], plan, sources, params, rows);
    this.attrs = attrs;

    const posName = plan.render.position ?? 'P';
    const pos = attrs.values.get(posName);
    if (!pos) throw new Error(`deck pane: no '${posName}' attribute after CPU evaluation`);

    const colorName = plan.render.color ?? 'Cd';
    const sizeName = plan.render.size ?? 'pscale';
    const colorSrc = attrs.values.get(colorName);
    const sizeSrc = attrs.values.get(sizeName);

    const tPack = performance.now();
    const colors = colorSrc ? toUint8Color(colorSrc.data, colorSrc.width, rows) : undefined;
    const packMs = performance.now() - tPack;

    // deck wants vec3 positions; widen if the graph produced 2D.
    const positions = pos.width === 3 ? pos.data : widen(pos.data, pos.width, rows);

    const layer = new ScatterplotLayer({
      id: 'compare',
      // Binary attributes: deck skips its accessor loop entirely.
      data: {
        length: rows,
        attributes: {
          getPosition: { value: positions, size: 3 },
          ...(colors ? { getFillColor: { value: colors, size: 4 } } : {}),
          ...(sizeSrc ? { getRadius: { value: sizeSrc.data, size: 1 } } : {}),
        },
      },
      // The COORDINATE_SYSTEM enum is deprecated; the string is the current spelling.
      coordinateSystem: 'cartesian',
      radiusUnits: 'pixels',
      radiusMinPixels: 0.5,
      radiusMaxPixels: 64,
      getFillColor: colors ? undefined : [140, 200, 242],
      getRadius: sizeSrc ? undefined : 2,
      pickable: false,
    });

    this.deck.setProps({ layers: [layer] });

    const bytes =
      positions.byteLength + (colors?.byteLength ?? 0) + (sizeSrc?.data.byteLength ?? 0);
    this.metricsValue = {
      rows,
      materializeMs: attrs.materializeMs,
      evalMs: attrs.evalMs,
      packMs,
      bytes,
      frameMs: this.frameMs,
      code: attrs.code,
    };
  }

  /**
   * Drive deck's view from the shared orbit camera.
   *
   * OrbitView's `zoom` is not a distance: it is log2 of pixels-per-world-unit. Our
   * camera instead shows a vertical extent of `2 * distance * tan(fovY / 2)` world units
   * across the canvas height, so the equivalent zoom is derived from that. Getting this
   * wrong collapses the whole scene into a single pixel, which is exactly what a naive
   * `log2(1 / distance)` does.
   */
  syncCamera(camera: OrbitCamera, heightPx: number): void {
    const s = camera.state;
    const worldHeight = 2 * Math.max(s.distance, 1e-4) * Math.tan(s.fovY / 2);
    const pixelsPerWorldUnit = Math.max(1e-4, heightPx) / worldHeight;
    this.deck.setProps({
      viewState: {
        target: [...s.target],
        zoom: Math.log2(pixelsPerWorldUnit),
        rotationX: (s.pitch * 180) / Math.PI,
        rotationOrbit: (-s.yaw * 180) / Math.PI,
      },
    });
  }

  /** The generated CPU loop, for display. */
  generatedCode(): string {
    return this.attrs?.code ?? '';
  }

  destroy(): void {
    this.deck.finalize();
  }
}

function widen(src: Float32Array, width: number, rows: number): Float32Array {
  const out = new Float32Array(rows * 3);
  for (let i = 0; i < rows; i++) {
    for (let c = 0; c < 3; c++) out[i * 3 + c] = c < width ? src[i * width + c] : 0;
  }
  return out;
}
