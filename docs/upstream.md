# Upstream changes

What this prototype has sent to luma.gl, deck.gl and gpuweb, and where each item stands. Status
as of 2026-10-16. [FINDINGS.md](../FINDINGS.md) §14 explains why each one matters and the order to
ask in. This file only tracks state. All PRs are akre54's unless noted.

## Landed

| Change | Where |
|---|---|
| `requiredLimits` in `DeviceProps` (§5a #3) | [luma.gl#3312](https://github.com/visgl/luma.gl/pull/3312), in `v10.0.0-alpha.3` |
| `WebGPUAdapter.attach()` for an app-created `GPUDevice` (§5a #3) | [luma.gl#3313](https://github.com/visgl/luma.gl/pull/3313), in `v10.0.0-alpha.3`, v10 only |
| GPU table binders: empty batches, chunk vertex offsets | [luma.gl#3338](https://github.com/visgl/luma.gl/pull/3338), in `v10.0.0-alpha.3` |
| `Buffer` `byteOffset`; range-only readback | [luma.gl#3335](https://github.com/visgl/luma.gl/pull/3335), [#3330](https://github.com/visgl/luma.gl/pull/3330); in 9.4 as #3336 and #3386 |
| WebGL and WebGPU draw-call semantics aligned | [luma.gl#3333](https://github.com/visgl/luma.gl/pull/3333), merged 2026-10-09 |
| GPUVector-first deck layer family (ibgreen) | [luma.gl#3169](https://github.com/visgl/luma.gl/pull/3169), merged 2026-10-02 |

## In flight

**luma.gl PRs**

| Change | PR |
|---|---|
| Deterministic two-pass group-by `sum`/`mean` (§13) | [luma.gl#3391](https://github.com/visgl/luma.gl/pull/3391), reviewed once, awaiting re-review |
| Fuse dataframe filters over contiguous batches (§12) | [luma.gl#3326](https://github.com/visgl/luma.gl/pull/3326) |
| Pack record batches on upload (§12) | [luma.gl#3337](https://github.com/visgl/luma.gl/pull/3337) |
| `Model` with a GPU-resident instance count (§12a) | [luma.gl#3328](https://github.com/visgl/luma.gl/pull/3328) |
| One render pipeline per attachment-format variant | [luma.gl#3302](https://github.com/visgl/luma.gl/pull/3302) |
| WebGPU compat black screen in two examples | [luma.gl#3345](https://github.com/visgl/luma.gl/pull/3345) |

**deck.gl PRs**

| Change | PR |
|---|---|
| Version-based invalidation for `BinaryAttribute` | [deck.gl#10779](https://github.com/visgl/deck.gl/pull/10779), may be rescoped to v9 (D3 on luma.gl#2550) |
| External float64 buffers on WebGPU (§5a #1) | [deck.gl#10776](https://github.com/visgl/deck.gl/pull/10776), may be superseded by D4 |
| Pad unaligned 8/16-bit attributes on WebGPU (§5a #2) | [deck.gl#10753](https://github.com/visgl/deck.gl/pull/10753) |
| Per-frame GPU timings, `_onFrameTimings` | [deck.gl#10778](https://github.com/visgl/deck.gl/pull/10778), overlaps ibgreen-openai's [#10279](https://github.com/visgl/deck.gl/pull/10279) |
| `Deck#waitForFrameReady()`, `Deck#hasActiveTransitions()` | [deck.gl#10362](https://github.com/visgl/deck.gl/pull/10362), [#10361](https://github.com/visgl/deck.gl/pull/10361) |

**Issues and comments, waiting for an answer**

- [luma.gl#2550](https://github.com/visgl/luma.gl/issues/2550) (v10 tracker), comment 2026-10-05:
  maps the PRs onto the tranches and asks D1–D6. D1 (physical chunk layout) and D2 (one selection
  type) gate #3326, #3337 and deck.gl#10781.
- [deck.gl#10781](https://github.com/visgl/deck.gl/issues/10781), RFC 2026-10-01: layers that draw
  a GPU-selected subset. Waiting on D2.
- [deck.gl#10712](https://github.com/visgl/deck.gl/issues/10712) (v10 tracker), comment
  2026-10-01: the GPU-resident data path checklist.
- [gpuweb#4894](https://github.com/gpuweb/gpuweb/issues/4894), comment 2026-10-08: §13 as a data
  point on the f32 atomics polyfill.

## Not filed

Drafts that were written but not posted. The links are to the last commit that had them.

- **`GPUCommandGraph` topology for inspector UIs**: per-node resource uses and dependency edges,
  so `describeCommandGraph` can stop reading private fields.
  [Draft](https://github.com/akre54/duckdb-deck-demo/blob/8f5cc62ac653bec28900152129ab7beb88db3426/docs/upstream/luma-command-graph-topology.md).
- **More closed `GPUExpression` operators** (`floor`, `clamp`, `min`/`max`, `%`, `select`, a `u32`
  cast), raised as D5 on luma.gl#2550.
  [Draft](https://github.com/akre54/duckdb-deck-demo/blob/8f5cc62ac653bec28900152129ab7beb88db3426/docs/upstream/luma-expression-ops.md).
