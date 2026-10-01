<!--
Destination: comment on https://github.com/visgl/deck.gl/issues/10712 (Tracker: deck.gl v10)
Status: draft, not posted
-->

Two items for the v10 tracker, both under its "GPU Compute" goal.

**"on idle callback" (Performance).** #10362 (draft) adds `waitForFrameReady()`, and #10361 adds
`hasActiveTransitions()`. Together they cover most of "deck has settled". What's left is async
loading. Should I finish those against this item, or is someone already designing the idle event?

**A GPU-resident data path.** In the noodles prototype (akre54/duckdb-deck-demo), the cost of an
interactive filter at millions of rows is mostly moving data between the CPU and the GPU. The GPU
work itself is cheap: 1.8 ms per slider tick at 4M rows when the filtered rows never leave the GPU,
against 31.6 ms to requery and re-upload. The pieces in flight:

- [ ] luma.gl#3313: `attach()` an app-created `GPUDevice`, so compute and deck share one device
- [ ] luma.gl#3326 / #3337: GPU Dataframe over Arrow's many record batches without per-batch dispatch
- [ ] luma.gl#3328: `Model` draws with a GPU-resident instance count
- [ ] luma.gl#3169: GPUVector-first layers (ibgreen)
- [ ] deck.gl#10779: binary attributes rewritten in place are re-read (`version`, `dataRange`)
- [ ] deck.gl#10778: per-pass GPU frame timings
- [ ] RFC (to file): layers that draw `ids[k]` for a GPU-selected subset

If that framing is useful, I can keep this checklist updated here or in its own sub-tracker.
