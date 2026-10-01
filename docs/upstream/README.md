# Upstream drafts

Issues and comments to post upstream, written against the numbers in [FINDINGS.md](../../FINDINGS.md)
§12–14. **Nothing here has been posted.** Each file starts with a comment giving its destination.
When one is posted, replace its row's status with the link.

Links into this repo point to `main`, so they only resolve once this directory's PR has merged.

| Draft | Kind | Destination | Status |
|---|---|---|---|
| [gpuweb-4894-comment.md](gpuweb-4894-comment.md) | comment | [gpuweb#4894](https://github.com/gpuweb/gpuweb/issues/4894) f32 atomics | draft |
| [luma-review-order-note.md](luma-review-order-note.md) | message | ibgreen (Slack) or [luma.gl#2550](https://github.com/visgl/luma.gl/issues/2550) | draft |
| [deck-timing-comment.md](deck-timing-comment.md) | comment | [deck.gl#10778](https://github.com/visgl/deck.gl/pull/10778), re #10279 | draft |
| [deck-10712-comment.md](deck-10712-comment.md) | comment | [deck.gl#10712](https://github.com/visgl/deck.gl/issues/10712) v10 tracker | draft |
| [luma-3169-comment.md](luma-3169-comment.md) | comment | [luma.gl#3169](https://github.com/visgl/luma.gl/pull/3169) | draft |
| [luma-group-by-float-sums.md](luma-group-by-float-sums.md) | new issue | visgl/luma.gl | draft |
| [luma-expression-ops.md](luma-expression-ops.md) | new issue | visgl/luma.gl | draft |
| [deck-indexed-indirect-rfc.md](deck-indexed-indirect-rfc.md) | new issue, `[RFC]` | visgl/deck.gl | draft; post after the #3169 comment gets an answer |

The order follows FINDINGS §14. Comments come first because they're cheap and slow to get
answered. The deck RFC goes last, since its shape depends on how ibgreen answers on #3169.

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
