import { describe, it, expect } from 'vitest';
import { Deck, MapView } from '@deck.gl/core';
import { programLayers, type ProgramLayerInput } from '../../src/deck/program-pane.js';
import type { LayerData } from '../../src/program/execute.js';

/**
 * A polygon layer drawn by deck from our triangulation, checked by reading pixels back.
 *
 * The claim is that the caller-supplied indices are what deck draws: `_normalize: false` plus
 * binary `indices` means deck does no tessellation, so a hole is a hole only if `triangulate`
 * made it one. A 4x4 degree square with a 2x2 hole, viewed from its centre: the centre pixel
 * must be the clear color and a pixel on the ring must be the fill.
 */

const SIZE = 128;

function squareWithHole(): LayerData {
  // Outline, then hole, as the planner's ORDER BY (polygon, ring, vertex) delivers them.
  const P = new Float32Array([
    0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0,
    1, 1, 0, 1, 3, 0, 3, 3, 0, 3, 1, 0,
  ]);
  return {
    rows: 8,
    attributes: new Map([['P', { data: P, width: 3 }]]),
    strings: new Map(),
    starts: new Uint32Array([0]),
    rings: new Uint32Array([0, 4]),
    evalMs: 0,
    code: '',
  };
}

/** Render, and return RGBA pixels read inside deck's own after-render callback. */
function renderPixels(input: ProgramLayerInput): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  // Both: the attribute sizes the drawing buffer (300x150 otherwise), the style the layout.
  canvas.width = canvas.height = SIZE;
  canvas.style.width = canvas.style.height = `${SIZE}px`;
  document.body.appendChild(canvas);
  let frames = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('deck never rendered')), 10_000);
    const deck = new Deck({
      canvas,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      views: new MapView({}),
      // 4 degrees ~ 80 px at this zoom (512 px per 360 degrees per 2^zoom).
      viewState: { longitude: 2, latitude: 2, zoom: 3.8 },
      layers: programLayers(input),
      onAfterRender: ({ gl }: { gl?: WebGL2RenderingContext }) => {
        if (!gl) return;
        const out = new Uint8Array(SIZE * SIZE * 4);
        gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, out);
        // The first frame already has the fill; a second guards against a layer that
        // finishes loading a frame late.
        if (++frames < 2) { deck.redraw('poll'); return; }
        clearTimeout(timer);
        resolve(out);
        // Finalize after the callback returns, not inside deck's own render.
        setTimeout(() => { deck.finalize(); canvas.remove(); }, 0);
      },
      onError: (err: Error) => { clearTimeout(timer); reject(err); },
    } as never);
  });
}

/** Pixel at (x, y) from the top-left, as readPixels' rows start at the bottom. */
const at = (px: Uint8Array, x: number, y: number) => {
  const row = SIZE - 1 - y;
  return Array.from(px.subarray((row * SIZE + x) * 4, (row * SIZE + x) * 4 + 4));
};

describe('polygon layers draw the triangulation we supply', () => {
  it('fills the ring and leaves the hole empty', async () => {
    const px = await renderPixels({
      id: 'shapes',
      kind: 'polygon',
      data: squareWithHole(),
      bindings: [{ channel: 'position', attribute: 'P' }],
      props: { fillColor: [255, 0, 0] },
    });
    const centre = at(px, SIZE / 2, SIZE / 2);
    // About 20 px per degree: 1.5 degrees left of centre is on the ring, inside the outline.
    const ring = at(px, SIZE / 2 - 30, SIZE / 2);
    const outside = at(px, 2, 2);
    expect(ring[0], `ring pixel ${ring}`).toBeGreaterThan(200);
    expect(ring[3]).toBeGreaterThan(200);
    expect(centre[3], `hole pixel ${centre}`).toBe(0);
    expect(outside[3], `outside pixel ${outside}`).toBe(0);
  });

  it('an outline is a second layer of closed paths over the same vertex rows', () => {
    const layers = programLayers({
      id: 'shapes', kind: 'polygon', data: squareWithHole(),
      bindings: [{ channel: 'position', attribute: 'P' }], props: { stroked: true },
    });
    expect(layers.map((l) => l.id)).toEqual(['shapes', 'shapes:outline']);
    const outline = layers[1].props.data as unknown as { length: number; startIndices: Uint32Array };
    // One path per ring: the outline and the hole.
    expect(outline.length).toBe(2);
    expect([...outline.startIndices]).toEqual([0, 4]);
  });
});
