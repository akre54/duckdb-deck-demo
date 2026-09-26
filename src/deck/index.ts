/**
 * deck.gl adapters.
 *
 * Two panes, one per capability story:
 *
 *   `DeckWebgl2Pane`  no compute shaders, so attributes are computed by the generated JS
 *                     loop and handed to deck as binary attributes.
 *   `DeckWebgpuPane`  compute available, so the plan's kernel writes luma Buffers and deck
 *                     binds them with no readback.
 *   `DeckMaplibrePane` the WebGL2 path again, drawn over a MapLibre basemap through
 *                     `@deck.gl/mapbox`'s `MapboxOverlay`. The caller creates the map.
 *   `DeckProgramPane` every layer of a compiled program (scatter, arc, path, trips, column,
 *                     text) over a MapLibre map. Trips need `@deck.gl/geo-layers`.
 *
 * Requires `@deck.gl/core`, `@deck.gl/layers` and `@luma.gl/*` as peer dependencies, plus
 * `@deck.gl/mapbox` for the map pane; the core entry does not.
 */

export { DeckPane as DeckWebgl2Pane, type DeckMetrics } from './webgl2-pane.js';
export { DeckWebgpuPane, type DeckWebgpuStatus } from './webgpu-pane.js';
export { DeckMaplibrePane, type DeckMaplibreOptions, type MapLike } from './maplibre-pane.js';
export { DeckProgramPane, type ProgramLayerInput, type ProgramPaneMetrics } from './program-pane.js';
