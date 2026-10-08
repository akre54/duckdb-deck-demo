# Upstream drafts and what became of them

Issues and comments written against the numbers in [FINDINGS.md](../../FINDINGS.md) §12–14. Status
as of 2026-10-08. The live picture of every open PR is in FINDINGS §14; this file only tracks the
drafts.

| Draft | Destination | Status |
|---|---|---|
| [gpuweb-4894-comment.md](gpuweb-4894-comment.md) | [gpuweb#4894](https://github.com/gpuweb/gpuweb/issues/4894) f32 atomics | **posted 2026-10-08**, no reply yet |
| [deck-indexed-indirect-rfc.md](deck-indexed-indirect-rfc.md) | [deck.gl#10781](https://github.com/visgl/deck.gl/issues/10781) | **posted 2026-10-01**, no reply; waits on luma D2 |
| [deck-10712-comment.md](deck-10712-comment.md) | [deck.gl#10712](https://github.com/visgl/deck.gl/issues/10712) v10 tracker | **posted 2026-10-01** |
| [deck-timing-comment.md](deck-timing-comment.md) | [deck.gl#10778](https://github.com/visgl/deck.gl/pull/10778), re #10279 | **posted 2026-10-01**, no reply |
| [luma-group-by-float-sums.md](luma-group-by-float-sums.md) | new luma issue | **superseded**: went straight to PR [luma.gl#3391](https://github.com/visgl/luma.gl/pull/3391) |
| [luma-expression-ops.md](luma-expression-ops.md) | new luma issue | **not filed**; raised as D5 on [luma.gl#2550](https://github.com/visgl/luma.gl/issues/2550). File it if ibgreen says "new issue" |

Two drafts were deleted rather than kept: the follow-up comment on luma.gl#3169 (that PR merged on
2026-10-02, and its questions became D2 on #2550) and the review-order note to ibgreen (it became
the PR map in the #2550 comment, 2026-10-05).

## The #2550 comment

On 2026-10-05 a comment on [luma.gl#2550](https://github.com/visgl/luma.gl/issues/2550) mapped the
open PRs onto the tranches and asked six questions. They are the thing to watch:

- **D1** physical layout of chunks: one buffer per column plus an offset table, or per-chunk buffers?
- **D2** one selection type (mask, or id list plus a GPU count) that `GPUVectorModel` accepts?
- **D3** `version` and dirty range on `GPUVector`/`GPUData` for v10, which would make
  deck.gl#10779 a v9-only change.
- **D4** float32 relative to `coordinateOrigin` as the position contract for kernel output.
- **D5** the closed `GPUExpression` operators (see `luma-expression-ops.md`).
- **D6** queryable autotune profiles, so planners above luma can price its operators.

## Deliberately not drafted

- **A persistent pipeline cache (gpuweb).** No issue exists. Before filing, measure what is
  actually missing: luma's first compile is 100–150 ms cold and 5–30 ms warm *within a session*
  (§12), but nobody has measured a cold compile after a browser restart. Chrome already caches
  shader blobs on disk, so the gap may be small.
- **`maxStorageBuffersPerShaderStage` ([gpuweb#4235](https://github.com/gpuweb/gpuweb/issues/4235)).**
  Chrome 146 raised it, but an M4 MacBook still reports 10, and that is tracked as
  [crbug 505056912](https://issues.chromium.org/issues/505056912). Star the crbug rather than
  commenting on #4235. §5a's planner result, where an 8-binding target forces a filter out of the
  fused kernel, is the use case to add there if asked.
- **64-bit integers ([gpuweb#273](https://github.com/gpuweb/gpuweb/issues/273)).** It is
  Milestone 4+, with "no near term plans". Rebasing timestamps to i32 offsets at load (DuckDB) is
  the working answer for now.
