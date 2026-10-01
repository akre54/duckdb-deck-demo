<!--
Destination: new issue on visgl/deck.gl, titled with the [RFC] prefix recent RFCs use
Title: [RFC] Layers that draw a GPU-selected subset: row-id indirection + GPU-resident instance count
Status: draft, not posted
-->

## Problem

A filter evaluated on the GPU can't currently reduce what a deck layer draws. A layer has two
options, and both are expensive at millions of rows:

- **Discard mask** (`DataFilterExtension`'s approach). Every row is still an instance, and rejected
  rows are culled in the shader. The frame cost scales with total rows, not with visible rows.
- **Requery and re-upload.** The surviving rows go back through the CPU into new attribute buffers.
  The frame is cheap, but every slider tick pays for a round trip.

GPU stream compaction (luma's GPU Dataframe, `gpu-crossfilter`, `DrawCommandBuffer` culling) already
produces what a third option needs: a compacted `u32` list of surviving row ids, and the survivor
count in a GPU buffer. What's missing is a layer that can draw *instance k = row ids[k]* with
`instanceCount` read from that buffer.

## Measurements

`v > :cut` over 4M points keeping 5%, one slider tick to drained pixels, then the steady-state
frame. Apple Metal-3, raw WebGPU passes outside deck (FINDINGS §12 in akre54/duckdb-deck-demo):

| Approach | Tick to pixels | Steady frame | Instances drawn |
|---|---:|---:|---:|
| requery + re-upload | 31.6 ms | 0.31 ms | 200k |
| discard mask | 6.17 ms | 5.30 ms | 4M |
| compact ids + `drawIndirect` | **1.80 ms** | **0.30 ms** | 200k |

The extra indirection (`ids[instance_index]` read from a storage buffer in the vertex stage)
cost nothing measurable. The compacted path draws as cheaply as the re-uploaded one.

## Proposal

Two optional layer-level inputs, WebGPU only:

- `instanceIds: Buffer`, a `u32` storage buffer. When set, the vertex shader fetches every
  per-instance attribute at `ids[instance_index]` rather than `instance_index`.
- `instanceCount` sourced from a GPU buffer, building on luma `Model`'s indirect draw record
  (visgl/luma.gl#3328). The layer never learns the count on the CPU.

Fetching by index means per-instance attributes are read as storage buffers, not instanced vertex
buffers. That is a large change for deck's attribute system as a whole, but not for a family that
already binds GPU vectors. So I'd propose landing this first in the `GPUVectorModel`-based layers
from visgl/luma.gl#3169, starting with `GPUScatterplotLayer`, and generalizing later only if it
proves out.

### Picking

The picking color must encode the *source* row, `ids[k]`, not `k`, so `info.index` still means
a data row. #3169 already returns global row plus batch-local provenance, so this would extend it
rather than add a new path.

### WebGL2

WebGL2 has no indirect draws and no vertex-stage storage buffers. The props would be WebGPU-only
and assert on WebGL, the same rule luma #3328 uses for `setIndirectBuffer`.

## Open questions

1. Is a layer prop the right level, or should this be a `LayerExtension` that rewrites attribute
   fetch? An extension can't currently change how attributes are bound, which is why I lean
   toward the prop.
2. Should the id list be allowed to come from a different `Device` wrapper than the layer's? The
   answer is probably "no, same `GPUDevice`", which #3313's `attach()` makes practical.
3. Interaction with `DataFilterExtension`: the two would likely be mutually exclusive on one layer.
