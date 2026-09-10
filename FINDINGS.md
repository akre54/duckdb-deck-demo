# Findings

A working prototype of the design: **JSON graph → planner → (DuckDB SQL | WGSL compute) → named attribute buffers → WebGPU canvas.** No deck.gl in the critical path; a deck.gl pane beside it for comparison.

The question this was built to answer was "how do I make this work with deck.gl, or how much smaller/more modular does deck have to get?" The short answer turned out to be **neither** — see finding 5.

All numbers below are measured on this machine, Chromium, the synthetic 9-cluster source. `npm run dev` → *run sweep* reproduces them.

| rows | duckdb | arrow→f32 cast | upload | total build | to GPU | writeBuffer calls | GPU frame | deck attr CPU |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 98k | 4.6 ms | 1.3 ms | 1.6 ms | 10.3 ms | 4.1 MB | 52 | 0.26 ms | 6.5 ms |
| 980k | 35.0 ms | 4.0 ms | 6.6 ms | 61.6 ms | 41.1 MB | 492 | 4.89 ms | 56.2 ms |
| 4.9M | 176.7 ms | 24.7 ms | 69.9 ms | 341.3 ms | 205.6 MB | 2445 | 30.9 ms | 199.6 ms |

---

## 1. One expression IR with three backends works

`src/graph/expr.ts` parses a small VEX-flavored expression language into an AST. `backends/sql.ts`, `backends/wgsl.ts` and `backends/js.ts` each walk that AST. 103 tests, including 21 that *execute* the JS backend against hand-computed values so the numeric semantics are checked rather than asserted.

The load-bearing detail is that **capability is a table, not a code path.** `FUNCTIONS` in `expr.ts` records, per function, how it spells in SQL and in WGSL, with `null` meaning "no equivalent". So the planner's question — can this node run in SQL? — is `enginesFor(tree)`, a walk over the AST. It never pattern-matches node types.

That is what makes engine assignment a *cost* decision rather than a rewrite. The same tree also compiles to JS, which is how the deck.gl pane renders the identical graph.

Two places the backends genuinely diverge, both handled in the op table rather than by special-casing:

- `min`/`max` → `least`/`greatest` in SQL; `ln` → `log` in WGSL; `clamp` has no 3-arg SQL form so it expands to `least(greatest(…))`.
- `%` on floats does not exist in WGSL, so it emits `a - b*floor(a/b)`. The JS backend matches that floor-based semantics rather than JS's own `%`, which differs for negatives. There is a test for exactly this.

**Consequence for noodles:** `MapRangeOp` and `ColorRampOp` do not need to be operators. They are expression templates. `desugar()` in `src/graph/types.ts` is ~50 lines and turns `scale`, `colorscale` and `project` into plain `attribute` nodes emitting `fit(…)`, `ramp(…)` and a mercator expression. That is PR #491's own Phase 2 note, and it costs less than the ops it replaces.

## 2. DuckDB-Wasm never hands you one Arrow chunk

This is the finding that most contradicts the premise we started from ("the column IS the attribute buffer, byte for byte").

**A 300k-row DuckDB-Wasm result arrives as 147 record batches of 2048 rows.** 5M rows is 2445 batches. There is no single contiguous `Float32Array` per column, at any realistic size. A design that assumes one will silently fall through to a full CPU pass on every column.

That does not force a JS loop — it moves the concatenation to the right place. `src/engine/arrow-gpu.ts` has three tiers:

| tier | when | cost |
|---|---|---|
| `arrow` | 1 chunk, Float32, no nulls | one `writeBuffer` over the column's own memory |
| `chunked` | N chunks, Float32, no nulls | N `writeBuffer` calls at byte offsets; **zero JS element loops** |
| `cast` | Float64 / integer / nullable | one JS pass into a fresh `Float32Array` |

At 5M rows the FLOAT columns take the chunked path at 0 ms CPU. The 24.7 ms of cast time is entirely the three `DOUBLE` columns.

**Two concrete actions for noodles, both cheap:**

1. `arrow-data.ts` should upload per batch rather than concatenating. 2445 `writeBuffer` calls at 5M rows cost 69.9 ms total including allocation — the GPU copy engine is good at this, and it replaces a JS loop over 5M elements per column.
2. **Cast to `FLOAT` in the generated SQL.** WGSL has no f64, so every `DOUBLE` column bound to a visual channel pays a CPU narrowing pass. Emitting `expr::FLOAT` in the SQL compiler's projection list moves that work into DuckDB's vectorized executor and eliminates the tier entirely. This is a one-line change in a SQL compiler that removes the single largest CPU cost in the upload path.

The remaining unavoidable casts are nullable columns (Arrow's validity bitmap has to become something WGSL understands — here NaN, discarded in-shader) and SQL-built vectors (see finding 4).

A bug worth naming because it will bite anyone doing this: **Arrow JS returns a zero-length `Uint8Array` for `nullBitmap` when a column has no nulls, not `undefined`.** Bit-testing that reads `undefined`, which looks like "null" for every row. It renders as an empty canvas with no error. Gate on `chunk.nullCount`, not on the bitmap's existence.

## 3. Value-parameter rebinding is the real architectural difference

Measured, not argued. 30 consecutive changes to a kernel-bound parameter:

```
uniform writes  1 → 31
requeries       0 → 0
buffer allocs   7 → 7
writeBuffer     150 → 150
```

Then one change to a SQL-bound parameter: prepared statement rebound, **SQL text byte-identical**, rows 293,957 → 149,259, buffer allocations still 7 (the buffers are reused because the row count shrank).

The deck.gl path cannot do this. deck cannot re-evaluate the graph — it can only be handed new arrays — so every parameter change costs the whole CPU attribute rebuild: **56 ms at 1M rows, 200 ms at 5M.** The WebGPU path costs one `writeBuffer` of a few bytes plus a dispatch inside a 4.9 ms / 30.9 ms frame.

That gap is not about WebGPU being faster than WebGL. It is about *who owns the buffer*.

## 4. Two costs that argue against pushing everything into SQL

The `policy` selector (`auto` / `sql-first` / `gpu-first`) exists so this is measurable rather than theoretical.

- **SQL vectors arrive unpacked.** SQL columns are scalars, so a `vec3` position built in SQL comes back as `P_0`, `P_1`, `P_2` and must be interleaved on the CPU — and there is no chunked shortcut, because the destination stride is not the source stride. A kernel writes it packed already. Position and color math should stay on the GPU.
- **GPU filters cannot remove rows.** A predicate that isn't SQL-expressible becomes a discard mask; the row still occupies memory and an instance slot. The planner says so in the inspector rather than hiding it. Filters and aggregations belong in SQL because volume reduction is the actual win.

Which is what the default `auto` policy encodes: *volume-reducing → SQL, volume-preserving per-row → GPU, and the op table forces the rest.*

## 5. deck.gl does not need to get smaller — it already has the seam

This is the answer to the original question, and it inverts the premise.

From `@deck.gl/core@9.4`:

```ts
// dist/types/layer-props.d.ts
attributes?: Record<string, TypedArray | Buffer | BinaryAttribute>

// dist/lib/attribute/attribute.d.ts
export type BinaryAttribute = Partial<BufferAccessor> & {
  value?: TypedArray;
  buffer?: Buffer;          // <- a luma.gl Buffer the app owns
}

// dist/lib/deck.d.ts
device?: Device | null;                          // pass in your own
onDeviceInitialized?: (device: Device) => void;   // or take deck's
```

`DataColumn` already tracks an `externalBuffer`. **deck.gl will render a GPU buffer it did not allocate, and it will share a luma.gl `Device` with the host application.** So the design in this prototype does not require forking deck, shrinking deck, or a GPU readback. It requires:

1. Own the luma.gl `Device` (or take deck's via `onDeviceInitialized`).
2. Allocate luma `Buffer`s for `P`, `Cd`, `pscale` instead of `GPUBuffer`s.
3. Run the fused kernel into them.
4. Hand them to a layer as `data.attributes.getPosition = { buffer }`.

deck keeps doing what it is genuinely good at — the layer catalog, views and controllers, geo projection, picking, transitions, basemap integration, WebGL2 reach — none of which this prototype has. Its camera is 40 lines against deck's whole viewport system, and there is no picking at all.

**The one real constraint:** step 3 needs compute. luma.gl 9.4's WebGPU adapter gives real compute pipelines; the WebGL2 backend has no compute shaders, so a GPU-resident derived attribute there needs transform feedback via luma's buffer-transform path, or falls back to the CPU loop. So the honest sequencing is: adopt binary attributes and the parameter split now (they pay off on WebGL2 today), and gate GPU-resident attributes on the WebGPU device.

---

## Recommended order of work for noodles

Ranked by payoff per unit of risk. The first three are independent of any renderer decision.

1. **Classify parameters as structural vs value, and route value params to uniforms or prepared-statement binds.** Biggest win, entirely renderer-independent, and it is what makes a slider feel instant at 1M rows. DuckDB-Wasm's prepared statements already do the SQL half.
2. **Cast channel-bound columns to `FLOAT` in the generated SQL,** and upload Arrow per record batch instead of concatenating. Removes the largest CPU cost in the upload path for a very small diff.
3. **Make the expression IR the shared artifact and the SQL compiler a backend of it.** `sql-compiler/expression-to-sql.ts` is already the seed; add a WGSL backend beside it. Then retire `MapRangeOp`/`ColorRampOp` into `fit()`/`ramp()` templates.
4. **Keep deck.gl, and pass it app-owned luma Buffers** for the layer types that dominate — scatter and heatmap — where the per-frame CPU attribute rebuild actually hurts. Leave every other layer on deck's normal path.
5. Only if 1–4 land and the remaining bottleneck is deck itself, consider owning the render path. On this evidence that is not where the cost is.

## What this prototype does not prove

Stated plainly, because the numbers above are easy to over-read.

- **The frame times are not a deck.gl comparison.** deck.gl 9 renders through luma.gl's WebGL2 backend here; its WebGPU backend is experimental and is not what `npm install` gives you. `deck.redraw()` also only flags a redraw rather than drawing, and deck exposes no `onSubmittedWorkDone` equivalent, so its GPU time cannot be drained and timed from outside. The `gpu frame` column is a WebGPU number with no deck counterpart. The meaningful comparison is the CPU attribute column.
- `requestAnimationFrame` throttles hard in a hidden tab — an 8 ms frame reports as 640 ms. The sweep uses a drained-queue submit loop for exactly this reason; the live footer readout is only trustworthy with the tab visible.
- Camera framing between the two panes is approximate: `OrbitView`'s `zoom` is log2 pixels-per-world-unit, not our `distance`.
- One color ramp per graph (one LUT is bound per kernel). Two `colorscale` nodes with different ramps is a legitimate use case and is rejected with an error.
- One `aggregate` per chain, linear chains only — no joins, no multi-input nodes, no branching DAG. A real graph has all of those.
- No strings, no picking, no transitions, no basemap, no geo beyond a hand-rolled mercator, no line or polygon marks.
- Heatmap weights are quantized to 1/256 and accumulated as `u32`, because WebGPU has no float atomics. Weights below ~0.004 contribute nothing.
- Single machine, single GPU, synthetic data. The 5M-row case allocates 206 MB of attribute buffers, which needed an explicit `maxStorageBufferBindingSize` request.
