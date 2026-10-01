<!--
Destination: comment on https://github.com/gpuweb/gpuweb/issues/4894 (wgsl: support atomics on f32)
Status: draft, not posted
-->

A performance data point on the bitcast + `atomicCompareExchangeWeak` polyfill, from a data-viz
workload. The 2025-11-04 minutes discuss whether the polyfill is good enough, so this may help.

The workload is a GPU group-by, `sum(v)` per key, with keys dense in `[0, n)`, as in a linked
histogram. It uses luma.gl 9.4.2's GPU Dataframe, Chromium on Apple Metal-3, 4M rows with half of
them accepted, median of 9:

| Accumulation | 16 keys | 1024 keys |
|---|---:|---:|
| f32 sum, CAS loop on a global `atomic<u32>` per key | 366 ms | 4.4 ms |
| the same, after `subgroupAdd` coalescing of equal keys | 55 ms | 4.2 ms |
| u32 count, `atomicAdd` on `var<workgroup>` then one global add per workgroup | 2.9 ms | 2.5 ms |

The cost of the CAS loop follows rows per key, so it shows up exactly where viz workloads put their
data: a handful of bins, categories or series. The integer path is fast for a reason the float path
can't copy today. It accumulates in workgroup memory and touches global memory once per workgroup.
Doing that for f32 needs either a CAS loop on a `var<workgroup>` `atomic<u32>`, or a full manual
tree reduction per key. So workgroup-address-space f32 `atomicAdd`, which this issue covers, would
let the float sum use the same strategy as the integer count.

I didn't observe hangs or forward-progress problems with the polyfill on this hardware. This is a
throughput data point only. Determinism is a separate matter: any atomic accumulation gives
order-dependent f32 results, so native atomics would not change that.

Reproduction: `tests/browser/groupby.browser.test.ts` in
https://github.com/akre54/duckdb-deck-demo (FINDINGS §13).
