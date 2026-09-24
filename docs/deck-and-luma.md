# Using this with deck.gl and luma.gl

This repo does not replace deck.gl. It sits in front of it.

deck.gl draws layers from attributes: positions, colors, radii. In most apps those attributes
are computed in JavaScript, one accessor call per row. This repo computes them from a
declarative graph instead. A cost-based planner decides, per attribute, whether DuckDB, a
generated JavaScript loop, or a WebGPU compute kernel should produce it. The result reaches
deck in one of two forms:

- **Typed arrays**, handed to a layer as binary attributes. This works on every deck backend
  today, including WebGL2 and a MapLibre basemap.
- **luma.gl `Buffer`s that a compute kernel wrote**, handed to a layer with no readback. This
  needs luma's WebGPU device. The compute half works. deck's WebGPU draw of those buffers
  is blocked by three deck/luma bugs, listed below.

luma.gl is the layer that makes the second form possible. It owns the `Device`, it can run
the planner's WGSL through `createComputePipeline`, and a luma `Buffer` created with
`STORAGE | VERTEX` usage can be written by compute and read by a deck layer.

## The three paths

| path | module | device | derived attributes computed by | status |
|---|---|---|---|---|
| deck, WebGL2 | `src/deck/webgl2-pane.ts` | deck's own | generated JS loop | works |
| deck on MapLibre | `src/deck/maplibre-pane.ts` | MapLibre's WebGL2 context | generated JS loop | works |
| deck, WebGPU | `src/deck/webgpu-pane.ts` | luma WebGPU | WGSL compute into luma Buffers | compute works, draw fails |

All three take the same input: a `PhysicalPlan` from `@noodles.gl/planner`, the source
columns, the current parameter values, and a row count.

## Mapping a plan onto a deck layer

The plan names its render channels once, in `plan.channels`. Those map onto deck accessors:

| plan channel | default name | `ScatterplotLayer` attribute |
|---|---|---|
| `channels.position` | `P` | `getPosition` |
| `channels.color` | `Cd` | `getFillColor` (packed to `Uint8` RGBA with `toUint8Color`) |
| `channels.size` | `pscale` | `getRadius` |
| `plan.maskAttribute` | `__mask` | none. Rows where it is below 0.5 are dropped before binding |

The target tells the planner what deck can do. Plan with the target that matches the pane:

```ts
import { plan, targetCaps } from '@noodles.gl/planner';

plan(graph, schema, { caps: targetCaps('deck-webgl2') });   // no compute: no GPU stage
plan(graph, schema, { caps: targetCaps('deck-webgpu') });   // compute, 8 storage buffers
```

On `deck-webgl2` the GPU stage disappears, and anything with no SQL form (such as `ramp()`)
is placed on the CPU. On `deck-webgpu` the optimizer fits the fused kernel into 8 storage
bindings, because that is the limit on luma's device (see bug 3 below).

## deck.gl with WebGL2

```ts
import { DeckWebgl2Pane } from '@noodles.gl/gpu-runtime/deck';

const pane = new DeckWebgl2Pane(canvas);
pane.update(physicalPlan, sourceUploads, params, rows);
```

Internally this is `evaluateStage` followed by a `ScatterplotLayer` whose `data.attributes`
are typed arrays. deck runs no accessors. Every parameter change reruns the JS loop, which
is the cost the WebGPU path removes.

## deck.gl on a MapLibre basemap

The integration goes through `@deck.gl/mapbox`. Its `MapboxOverlay` is deck's adapter for
both mapbox-gl and maplibre-gl. It is a map control, and it keeps deck's view in step with
the map's camera. You create the map. The library never imports `maplibre-gl`.

```ts
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DeckMaplibrePane } from '@noodles.gl/gpu-runtime/deck';

const map = new maplibregl.Map({ container: 'map', style: STYLE_URL, center: [0, 15], zoom: 1.2 });
const pane = new DeckMaplibrePane(map, { coordinates: 'lnglat' });
pane.update(physicalPlan, sourceUploads, params, rows);
```

`coordinates` says what the position attribute holds:

- `'lnglat'`: `[lng, lat, metres]`, bound directly. A graph written for a map should produce
  this, for example with `project` in `mode: 'identity'` over `lng` and `lat`.
- `'normalized-mercator'`: the output of `project` in `mode: 'mercator'`, which the example
  graphs use for the orbit camera. The pane inverts it back to degrees on the CPU and drops
  Z.

Pass `interleaved: true` to draw inside MapLibre's WebGL2 context, between basemap layers,
instead of on a canvas stacked above it.

In the inspector, pick `deck.gl + maplibre (basemap)` in the mode menu.

## deck.gl with WebGPU and luma buffers

```ts
import { DeckWebgpuPane } from '@noodles.gl/gpu-runtime/deck';

const pane = new DeckWebgpuPane(canvas);
await pane.update(physicalPlan, sourceUploads, params, rows);
pane.status;   // { device, compute, render, sharedBuffers, detail }
```

The pane creates a luma WebGPU device and a `Deck` that shares it. It uploads the source
columns into luma Buffers, runs the plan's kernel through luma's compute pipeline, and binds
the output buffers as `data.attributes.getPosition = { buffer }`. No CPU work is done per
attribute.

The draw fails in deck 9.4 for three reasons. [FINDINGS.md](../FINDINGS.md) §5a has the
details:

1. `ScatterplotLayer` expects fp64-encoded positions (a 24-byte stride). WGSL has no f64, and
   `type: 'float32'` on the binary attribute does not override the layer.
2. A 3-component color becomes `unorm8x3`, which is not a valid WebGPU vertex format.
3. luma's WebGPU device cannot take `requiredLimits`, and `luma.attachDevice()` is not
   implemented. So deck cannot share an app-owned device, and runs at WebGPU's default
   limits.

## What deck keeps doing

This repo has none of the following, and deck already does them well: the layer catalog,
views and controllers, geographic projection, picking, transitions, basemap integration,
and WebGL2 reach. The recommendation in FINDINGS.md is to keep deck and feed it better
attributes, not to own the render path.

## Suggested next changes

Do next, roughly in order of payoff:

1. **Upstream the three deck/luma fixes.** Accept float32 positions on a `BinaryAttribute`.
   Emit `unorm8x4` for colors. Expose `requiredLimits` or implement `attach()` on the WebGPU
   adapter. These are what stand between the working compute path and pixels.
2. **Emit geographic positions from the planner.** Add a `project` mode that outputs lng/lat,
   or deck's common space, so the map path binds positions directly instead of inverting
   mercator on the CPU.
3. **Use `DataFilterExtension` for GPU masks.** The map pane compacts masked rows on the CPU.
   Binding the mask as a filter value would keep the buffer layout stable across parameter
   changes, which is how the cost model already prices a mask.
4. **Wrap a plan as a deck `Layer`.** A `PlannedLayer` would take a graph and parameters as
   props, own the plan, and route uniform parameters to layer uniforms. Apps would use it
   like any other layer, without a pane class.
5. **Map picking back to source rows.** deck picking returns an instance index. After SQL
   filtering that is not the source row, so the plan should carry an id column through.

Worth researching:

- **A GPU stage on WebGL2.** MapLibre and most deck installs are WebGL2, which has no compute.
  luma's transform feedback (`BufferTransform` in `@luma.gl/engine`) could run a GLSL version
  of the fused kernel. That would mean a fourth backend beside SQL, WGSL and JS.
- **Fusing into the vertex shader.** For attributes read only by one layer, the expression
  could be injected into deck's vertex shader through a shader module. That needs no buffer
  and no dispatch. The trade-off is re-evaluation every frame, which the cost model could
  price.
- **deck's GPU aggregation.** Compare `bin2d` with deck 9's GPU aggregation layers
  (`ScreenGridLayer`, `HeatmapLayer`) on the same data.
- **MapLibre on WebGPU.** If MapLibre ships a WebGPU renderer, the basemap and the
  kernel-written buffers could share one device, which would remove the WebGL2 limit on the
  map path.
- **Timing deck fairly.** deck has no hook equivalent to `queue.onSubmittedWorkDone()`, so its
  GPU time cannot be measured from outside. A small upstream hook would make the frame-time
  comparison meaningful.
