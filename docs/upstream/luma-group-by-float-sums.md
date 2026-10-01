<!--
Destination: new issue on visgl/luma.gl
Title: GPUDataFrame group-by: float sum/mean contend on few groups and are not deterministic
Status: draft, not posted
-->

### Summary

`groupBy(key).aggregate({ m: { mean: 'v' } })` is fast with many groups and very slow with few.
At 4M rows on 16 groups, count + mean takes 366 ms where count alone takes 2.9 ms. The same
parameters also give bitwise-different means from one run to the next. Both come from
`atomicAddFloat`, the `atomicCompareExchangeWeak` loop in
`modules/gpgpu/src/gpu-core/gpu-group-aggregation.ts`. `min` and `max` are unaffected because they
use a single `atomicMin`/`atomicMax` on order-encoded `u32`.

### Measurements

`SELECT bin, count(*), avg(v) WHERE v > :cut GROUP BY bin` over packed f32/u32 buffers, timed per
`cut` change (encode, submit, `onSubmittedWorkDone`), median of 9. luma 9.4.2 on Apple Metal-3 in
Chromium. Counts are checked against a CPU reference and means against f64 to 1e-3 before anything
is timed.

| 4M rows, half kept | 16 groups | 1024 groups |
|---|---:|---:|
| count + mean, device without `subgroups` | 366 ms | 4.40 ms |
| count + mean, device with `subgroups` | 54.9 ms | 4.19 ms |
| count only | 2.90 ms | 2.54 ms |
| DuckDB-Wasm, same query, prepared | 97 ms | 102 ms |

The cost follows rows per group rather than rows. 1M rows on 16 groups is already 61 ms. The
subgroup path for ≤16 groups (`subgroupBallot` + `subgroupAdd`) gives a 6.7× improvement, but it
still issues one global CAS per distinct key per subgroup, so 16 hot words stay hot.

The harness is `tests/browser/groupby.browser.test.ts` in
[akre54/duckdb-deck-demo](https://github.com/akre54/duckdb-deck-demo), and the write-up is
FINDINGS §13. The full table, including 100k and 1M rows and 5% selectivity, is in
`tests/browser/__perf__/groupby.md`.

### Proposal

For `groupCount <= MAXIMUM_LOCAL_GROUP_COUNT`, reduce sums the way counts are already reduced,
with one change so the result is deterministic:

1. Each workgroup reduces its rows to `groupCount` partial sums in workgroup memory. That can be
   subgroup-coalesced as today, then a fixed-order tree over subgroups instead of atomics.
2. Each workgroup writes its partials, without atomics, to a `[workgroupCount × groupCount]`
   scratch vector. At 4M rows, 256-wide workgroups and 16 groups that is about 1 MB.
3. A second pass sums each group's column of partials in index order, then the existing finalize
   pass divides for `mean`.

This removes the global contention, and because the summation order is fixed, the same input gives
the same bits on a given device. The scratch size is known at plan time, so the no-readback
contract holds.

Above 256 groups the global CAS path is already close to count-only (4.4 vs 2.5 ms at 1024
groups). The scratch for a deterministic version, though, would be `workgroupCount × groupCount`,
64 MB at 4M rows and 1024 groups, which is too large. A sort-then-segmented-reduce may be the
right tool there. I'd leave that out of a first PR unless you see it differently.

### Smaller, independent note

luma only takes the subgroup path when the device enabled `subgroups`, which is right. But an app
that wraps its own `GPUDevice`, as in the #3313 `attach()` case, gets the slow path silently if it
didn't request the feature. A line in the GPU Dataframe docs, or a one-time `log.info` when a
group-by compiles without subgroups on an adapter that has them, would have saved me a wrong
conclusion.

I'm happy to put up the PR for the two-pass reduction if this direction looks right.
