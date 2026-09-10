/**
 * deck.gl adapters.
 *
 * Two panes, one per capability story:
 *
 *   `DeckWebgl2Pane`  no compute shaders, so attributes are computed by the generated JS
 *                     loop and handed to deck as binary attributes.
 *   `DeckWebgpuPane`  compute available, so the plan's kernel writes luma Buffers and deck
 *                     binds them with no readback.
 *
 * Requires `@deck.gl/core`, `@deck.gl/layers` and `@luma.gl/*` as peer dependencies; the
 * core entry does not.
 */

export { DeckPane as DeckWebgl2Pane, type DeckMetrics } from './webgl2-pane.js';
export { DeckWebgpuPane, type DeckWebgpuStatus } from './webgpu-pane.js';
