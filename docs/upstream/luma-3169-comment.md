<!--
Destination: follow-up comment on https://github.com/visgl/luma.gl/pull/3169 (GPUVector-first layer family)
Context: akre54 already commented there about per-batch uniform writes and position64Low. This is a second comment, not first contact.
Status: draft, not posted
-->

A follow-up from the noodles prototype. I think this family is the natural home for something deck
can't do today: draw only the rows a GPU filter kept, without the count ever reaching the CPU.

The ingredients already exist in luma. GPU Dataframe compaction produces `rowIndices` and a
GPU-resident `selectedCount`. #3328 lets a `Model` take its instance count from an indirect record.
What's missing is the layer side: instance `k` draws row `ids[k]`. Since `GPUVectorModel` already
binds GPU vectors rather than instanced vertex buffers, the indirection might be a small change
here, where it would be a large one for classic deck attributes.

Measured outside deck, at 4M points keeping 5%: compaction plus an indexed `drawIndirect` takes
1.8 ms per slider tick at the same 0.30 ms frame as a fully re-uploaded subset. A discard mask
costs 5.3 ms every frame because it still draws 4M instances (FINDINGS §12 in
akre54/duckdb-deck-demo). Reading ids through one extra storage buffer cost nothing measurable.

Three questions before I write it up as a deck RFC:

1. Would you take an optional `instanceIds` vector plus an indirect count on `GPUScatterplotLayer`
   first, or would you rather see it as a `GPUVectorModel` capability that every fixed-width
   layer inherits?
2. For picking, I'd encode `ids[k]` (the source row) in the picking color, so `info.index` keeps
   meaning a data row. Does that fit the global-row/batch-local provenance you return now?
3. How does it compose with chunked vectors? A compacted id list over a multi-chunk column is one
   global list. If the model replays per chunk, the draw needs either a global-row fetch or one
   id list per chunk. #3326 currently keeps per-batch results; I can see it going either way.
