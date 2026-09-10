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

`src/core/expr.ts` parses a small VEX-flavored expression language into an AST. `backends/sql.ts`, `backends/wgsl.ts` and `backends/js.ts` each walk that AST. 103 tests, including 21 that *execute* the JS backend against hand-computed values so the numeric semantics are checked rather than asserted.

The load-bearing detail is that **capability is a table, not a code path.** `FUNCTIONS` in `expr.ts` records, per function, how it spells in SQL and in WGSL, with `null` meaning "no equivalent". So the planner's question — can this node run in SQL? — is `enginesFor(tree)`, a walk over the AST. It never pattern-matches node types.

That is what makes engine assignment a *cost* decision rather than a rewrite. The same tree also compiles to JS, which is how the deck.gl pane renders the identical graph.

Two places the backends genuinely diverge, both handled in the op table rather than by special-casing:

- `min`/`max` → `least`/`greatest` in SQL; `ln` → `log` in WGSL; `clamp` has no 3-arg SQL form so it expands to `least(greatest(…))`.
- `%` on floats does not exist in WGSL, so it emits `a - b*floor(a/b)`. The JS backend matches that floor-based semantics rather than JS's own `%`, which differs for negatives. There is a test for exactly this.

**Consequence for noodles:** `MapRangeOp` and `ColorRampOp` do not need to be operators. They are expression templates. `desugar()` in `src/core/types.ts` is ~50 lines and turns `scale`, `colorscale` and `project` into plain `attribute` nodes emitting `fit(…)`, `ramp(…)` and a mercator expression. That is PR #491's own Phase 2 note, and it costs less than the ops it replaces.

## 2. DuckDB-Wasm never hands you one Arrow chunk

This is the finding that most contradicts the premise we started from ("the column IS the attribute buffer, byte for byte").

**A 300k-row DuckDB-Wasm result arrives as 147 record batches of 2048 rows.** 5M rows is 2445 batches. There is no single contiguous `Float32Array` per column, at any realistic size. A design that assumes one will silently fall through to a full CPU pass on every column.

That does not force a JS loop — it moves the concatenation to the right place. `src/core/arrow.ts` has three tiers:

| tier | when | cost |
|---|---|---|
| `arrow` | 1 chunk, Float32, no nulls | one `writeBuffer` over the column's own memory |
| `chunked` | N chunks, Float32, no nulls | N `writeBuffer` calls at byte offsets; **zero JS element loops** |
| `cast` | Float64 / integer / nullable | one JS pass into a fresh `Float32Array` |

At 5M rows the FLOAT columns take the chunked path at 0 ms CPU. The 24.7 ms of cast time is entirely the three `DOUBLE` columns.

**Two concrete actions for noodles, both cheap:**

1. `arrow-data.ts` should upload per batch rather than concatenating. 2445 `writeBuffer` calls at 5M rows cost 69.9 ms total including allocation — the GPU copy engine is good at this, and it replaces a JS loop over 5M elements per column.
2. **Cast to `FLOAT` in the generated SQL.** WGSL has no f64, so every `DOUBLE` column bound to a visual channel pays a CPU narrowing pass. Emitting `CAST(expr AS FLOAT)` in the projection list moves that work into DuckDB's vectorized executor and eliminates the tier entirely. **Since implemented here** — and it turned out to fix a second bug at the same time: DuckDB infers `DECIMAL` for a literal like `1.0`, Arrow reports a decimal as an *unscaled* integer, and the upload path read it as garbage. See §8.

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

### 5a. What happened when it was actually run

The four steps above were implemented (`src/deck/webgpu-pane.ts`) rather than left as an argument from type definitions, because "the API exists" and "I ran it" are different claims. Verified with WebGPU error scopes, not by absence of exceptions — luma reports validation failures by logging them, so a `try`/`catch` around a dispatch stays silent while the pipeline is invalid and nothing is computed.

| step | result |
|---|---|
| luma WebGPU device via `webgpuAdapter` | **works** |
| planner's generated WGSL through `Device.createComputePipeline` | **works**, 4 ms for 300k rows |
| kernel writes luma `Buffer`s (`STORAGE \| VERTEX \| COPY_DST`) | **works** |
| buffers bound as `data.attributes.getPosition = { buffer }` | **works**, 0 ms CPU attribute work |
| deck's WebGPU **draw** of those buffers | **fails** |

So the compute and handoff half of the answer is confirmed on shipping versions. The render half hits three concrete deck/luma bugs, all in the experimental backend:

1. **Positions must be fp64-encoded.** `ScatterplotLayer` declares `getPosition` as `float64`, and since WebGPU has no 64-bit vertex format deck emulates it as hi/lo `float32` pairs — a 24-byte stride. A `float32x3` buffer is rejected as half the expected size, and `type: 'float32'` on the `BinaryAttribute` does **not** override the layer's declaration. A kernel cannot write f64 (WGSL has no f64), so this needs either deck accepting float32 positions or the kernel emitting deck's hi/lo encoding.
2. **3-component colors emit an invalid vertex format.** deck derives `unorm8x3`, which is not a `GPUVertexFormat` — WebGPU defines only `unorm8x2` and `unorm8x4`. Binding a color buffer throws at render-pipeline creation.
3. **luma's device cannot be raised or shared.** `DeviceProps` has no `requiredLimits`, and `luma.attachDevice(existingGPUDevice, …)` throws `WebGPUAdapter.attach() not implemented`. So deck's device is stuck at WebGPU defaults — notably **8** storage buffers per compute stage, where our own device requests the adapter's 10. That is a real capability difference between targets, and it is why `targetCaps('deck-webgpu')` reports 8.

Point 3 turned into a useful demonstration rather than a blocker: the optimizer treats the binding limit as a hard constraint, and on that target it *moves the filter node out of the kernel* so the fused kernel fits in exactly 8 bindings. The constraint does real work.

**Revised recommendation.** The seam is real and the compute path works today, but the last inch — deck drawing a kernel-written buffer — needs three small fixes in deck/luma, not an architectural change. Those are the concrete asks: accept `float32` positions on a `BinaryAttribute`, emit `unorm8x4` instead of `unorm8x3`, and expose `requiredLimits` (or implement `attach()`) on the WebGPU adapter.

---

## 6. A cost-based planner changes the answer, and the missing term was rendering

The first version placed nodes by rule (`volume-reducing → SQL`, `volume-preserving → GPU`). That is a heuristic wearing a cost model's clothes: it cannot know that a filter keeping 98% of rows is not worth a requery, or that a slider being dragged should pull its consumers onto the GPU.

Replacing it needed three pieces — statistics (`core/stats.ts`), a calibrated cost model (`core/cost.ts` + `webgpu/calibrate.ts`), and a search (`core/optimizer.ts`) — and one structural observation that made the search exact rather than heuristic:

> SQL cannot read a GPU buffer, and GPU output cannot return to the CPU without a readback. So in topological order the stages must appear as `SQL* CPU* GPU*`. **An assignment is two boundary indices**, there are O(n²) of them, and every one can be priced.

For the scatter graph that is 15 candidates. All 15 are costed and shown in the explain pane; the chosen plan is provably the minimum, not the first thing a greedy walk landed on.

### The decision tracks the data

Same graph, same machine, only the filter threshold moved:

| cutoff | estimated selectivity | chosen plan | filter placement | est. rows | actual rows |
|---:|---:|---|---|---:|---:|
| 0 | 98.0% | `sql[0,0) gpu[0,4)` | GPU discard mask | 300,000 | 300,000 |
| 60 | 50.0% | `sql[0,1) gpu[1,4)` | **SQL** `WHERE` | 149,978 | 149,259 |
| 110 | 8.3% | `sql[0,1) gpu[1,4)` | **SQL** `WHERE` | 24,995 | 24,754 |

Cardinality estimates land within 0.5% here — but that is because the synthetic data is uniform, which is exactly the assumption the estimator makes. On skewed real data this is where the error would appear, which is why the pane reports estimated against actual rather than only estimated.

### The bug the cost model exposed

The first cost-based version chose the *discard mask* at every threshold. It was not wrong about anything it modeled — it modeled build cost, and keeping 3× the rows costs nothing at build time. What it ignored is that those rows are re-rasterized every frame, forever.

**A planner for a renderer needs a render term.** Adding `renderPerInstanceMs × instances × frames-over-horizon` flipped the decision and is what makes row reduction worth anything:

```
cost(plan) = build
           + horizon × frameRate × renderFrame(rows)          <- the missing term
           + horizon × Σ_params rate_p × rebind(stage owning p)
```

The amortized third term is the "parameterized query" idea as an objective function: a parameter's change rate decides where its consumers belong, because rebinding costs a 16-byte uniform write on the GPU, a full JS loop on the CPU, and a requery in SQL.

### Calibration was not optional

The constants measured on this machine differ from the ones derived by hand from the sweep table above by up to **32×** — because dividing a total by a row count folds fixed cost into the marginal term. Calibration measures at two sizes and takes the slope. It costs 334 ms at startup.

| constant | hand-derived | measured |
|---|---:|---:|
| sql per row per column | 9 ns | 2.97 ns |
| cast per element | 1.7 ns | 0.42 ns |
| cpu per row per op | 6 ns | 0.19 ns |
| kernel per row per op | 0.4 ns | 0.0098 ns |
| uniform write | 10 µs | 0.63 µs |

A planner shipped with the left-hand column would make confident, portable-looking, wrong decisions.

### Capability constraints are the same machinery

Targets are described by capability, not product name (`core/target.ts`): `compute`, `appOwnedBuffers`, `gpuBudgetBytes`, `maxStorageBuffersPerStage`. Two of these visibly change plans:

- **`compute: false`** (deck on WebGL2) makes the GPU stage illegal, so `ramp()` — which has no SQL form — is forced onto the CPU and the plan becomes `SQL* CPU*` with zero kernels. The comparison pane stopped being hand-written glue and became a physical plan.
- **`maxStorageBuffersPerStage: 8`** rejects candidates whose fused kernel needs more bindings, and the optimizer routes around it by moving a node out of the kernel.

GPU memory works the same way: over-budget candidates are rejected, and if none survive the error lists every candidate with its shortfall rather than saying "no plan".

## 7. A wrangle node makes the pipeline programmable, and needs no planner support

`scale`, `colorscale` and `project` were already sugar over the expression IR. The `wrangle` node is the general case — a VEX-style multi-statement body, which is PR #491's stated Phase 2 `AttributeWrangleOp`:

```
@P      = [lng / 360.0, ln(tan(0.7853981634 + lat * 0.008726646259971648)) / 6.283185307, elevation * {{exag}} * 0.0006];
var t   = clamp(fit(ln(pop), {{lo}}, {{hi}}, 0.0, 1.0), 0.0, 1.0);
@Cd     = ramp(t);
@pscale = ({{sizeScale}} * 0.4) + t * ({{sizeScale}} * 3.1);
```

`desugar()` expands it into one `attribute` node per statement, with locals renamed to graph-unique names. **The planner needed no changes at all**: each statement is placed independently, and the existing kernel fusion merges them back into one dispatch. Four statements, four independently-placeable nodes, one kernel.

Two things worth noting:

- **Locals are free.** `var t` is read twice and never leaves the kernel, so it gets an SSA register and no buffer — no allocation, no upload, and no binding slot consumed. Materializing it would have pushed the kernel to 9 storage buffers and failed pipeline creation at 8.
- **Statements are placed separately, not as a block.** Under `sql-first`, `@P` compiles into the SQL `SELECT` while `@Cd` stays on the GPU, because `ramp()` has no SQL form and SQL must be a prefix.

Deliberately not a language: no control flow, no loops, no user functions. Every statement must be a pure expression, because that is what keeps it placeable on all three engines. An `if` would mean either divergence in the kernel or an escape to CPU-only.

DAG support came with it: nodes take `inputs: string[]`, topological order replaces the linear chain walk, unreachable branches are dropped as dead code, and cycles are reported instead of hanging. Multi-input means merging attribute namespaces over a shared row set — relational joins are out of scope.

## 8. Executing the backends found bugs that compiling them did not

The suite spent most of its life checking that the SQL and WGSL backends *compile*, because
only the JS backend is executable in Node. Running all three in Chromium against real DuckDB
and real WebGPU found four bugs on the first pass, every one of which would have reached a
user.

**The SQL backend had no boolean tracking.** WGSL and JS both convert a comparison to a
number in an arithmetic context — the WGSL emitter has carried an `isBool` flag for exactly
that since it was written. SQL does not, and DuckDB rejects `(a > b) * 2` with a binder error.
Any graph whose attribute expression used a comparison arithmetically failed at query time.

**`%` disagreed across backends for negative operands.** DuckDB's `%` truncates toward zero;
WGSL has no float `%` at all and the polyfill floors, as does the JS backend. So `-2 % 3` was
1 on two backends and −2 in SQL. Nothing structural could have caught this: all three
compiled, and all three were self-consistent.

**Kernels with no parameters silently produced zeroes.** `Kernel` used `layout: 'auto'`, which
omits bindings the shader never references. A GPU stage using no parameters never reads
`params`, so slot 0 vanished from the derived layout and the bind group was rejected for
supplying it — and WebGPU reports that through `uncapturederror` rather than throwing, which
invalidates the *entire* command buffer including the compute pass. Every derived attribute
came back zero-filled with nothing logged as a failure. The demo never showed it because its
graphs always had a parameter.

**`DECIMAL` columns read back as garbage.** DuckDB infers `DECIMAL` for a literal like `1.0`,
and Arrow represents a decimal as an *unscaled* integer, so a constant weight of `1.0` arrived
as 0 and the heatmap accumulated nothing. Fixed by casting SELECT items to `FLOAT` — which is
what §2 recommended for a different reason, and which also removes the `cast` upload tier for
`DOUBLE` columns by moving the narrowing into DuckDB's vectorised executor.

A fifth, found by the Node suite: selectivity conflated `>` with `>=` on a single-valued
column, reporting that `x > 5` keeps every row when `x` is always 5.

### What the browser suite now asserts

- The same expression through DuckDB, through a compute kernel, and through generated JS,
  compared element-wise over 29 portable expressions plus parameter binding.
- The same graph planned under `cost`, `auto` and `sql-first`, and on a target with no compute
  at all, producing numerically identical attribute buffers. Placement is meant to be a cost
  decision; if it changed the picture the optimizer would not be free to choose.
- Ten uniform-routed parameter changes producing zero requeries, zero reallocations and zero
  re-uploads — and still changing the buffer.
- Exact bin counts read back from the atomic grid, rather than a heatmap that looks plausible.
- Every calibrated constant finite and positive, and predicted build cost within an order of
  magnitude of measured.

### Two traps worth knowing

Playwright's default headless binary is `chrome-headless-shell`, which ships **without
WebGPU**: `navigator.gpu` exists but `requestAdapter()` returns null, so every GPU test skips
while appearing to have run. `channel: 'chromium'` selects the full build.

`Runtime.build()` marks kernels dirty but does not dispatch them — that happens in `frame()`.
Reading a derived attribute straight after `build()` compares zeroes, which is how three of
these tests initially "failed" for the wrong reason.

## Recommended order of work for noodles

Ranked by payoff per unit of risk. The first three are independent of any renderer decision.

1. **Classify parameters as structural vs value, and route value params to uniforms or prepared-statement binds.** Biggest win, entirely renderer-independent, and it is what makes a slider feel instant at 1M rows. DuckDB-Wasm's prepared statements already do the SQL half.
2. **Cast channel-bound columns to `FLOAT` in the generated SQL,** and upload Arrow per record batch instead of concatenating. Removes the largest CPU cost in the upload path for a very small diff.
3. **Test by executing, not by compiling.** Four of the five bugs above were invisible to a
   structural test and visible on the first run of an executing one. The cheap version of this
   is a browser test that evaluates one expression through every backend and compares — it does
   not need the whole pipeline to pay for itself.
4. **Make the expression IR the shared artifact and the SQL compiler a backend of it.** `sql-compiler/expression-to-sql.ts` is already the seed; add a WGSL backend beside it. Then retire `MapRangeOp`/`ColorRampOp` into `fit()`/`ramp()` templates.
5. **Add a cost model before adding more operator types.** Statistics from one DuckDB query per source, constants calibrated at startup, and the exact two-boundary search. The rule-based version cannot distinguish a filter worth pushing from one that is not, and the difference was 3× the rows on screen. Budget for the render term — without it the model prefers discard masks.
6. **Replace operator types with a `wrangle` node.** It needed no planner support, it subsumes scale/colorscale/project, and locals cost nothing. This is the cheapest large win in the list.
7. **Keep deck.gl, and pass it app-owned luma Buffers** for the layer types that dominate — scatter and heatmap. The compute path works today; the three deck/luma fixes in §5a are what stand between that and pixels.
8. Only if 1–7 land and the remaining bottleneck is deck itself, consider owning the render path. On this evidence that is not where the cost is.

## What this prototype does not prove

Stated plainly, because the numbers above are easy to over-read.

- **The frame times are not a deck.gl comparison.** deck.gl 9 renders through luma.gl's WebGL2 backend here; its WebGPU backend is experimental and is not what `npm install` gives you. `deck.redraw()` also only flags a redraw rather than drawing, and deck exposes no `onSubmittedWorkDone` equivalent, so its GPU time cannot be drained and timed from outside. The `gpu frame` column is a WebGPU number with no deck counterpart. The meaningful comparison is the CPU attribute column.
- `requestAnimationFrame` throttles hard in a hidden tab — an 8 ms frame reports as 640 ms. The sweep uses a drained-queue submit loop for exactly this reason; the live footer readout is only trustworthy with the tab visible.
- Camera framing between the two panes is approximate: `OrbitView`'s `zoom` is log2 pixels-per-world-unit, not our `distance`.
- One color ramp per graph (one LUT is bound per kernel). Two `colorscale` nodes with different ramps is a legitimate use case and is rejected with an error.
- One `aggregate` per graph. Multi-input DAGs, branching and dead-code elimination work; **relational joins do not** — multi-input means merging attribute namespaces over a shared row set.
- **The optimizer is exact only within the family "stage boundaries in topological order".** For a linear chain that family is every legal plan. For a branching DAG it is not: an assignment that interleaves stages across independent branches is legal but unexplored. The topological order also fixes a particular tie-break, so a different (equally legal) order could yield a different boundary.
- **Cardinality estimation assumes uniformity and independence.** The 0.5% accuracy above is a property of uniformly-generated synthetic data, not of the estimator. Skewed or correlated columns are where it will be wrong, and the explain pane exists to show that rather than hide it.
- The cost model does not model: DuckDB's own parallelism or its choice of scan strategy, GPU occupancy or cache behavior, overdraw (a render term proportional to instances ignores that zoomed-out points overlap), or the possibility that a plan changes what is *visible* rather than only what it costs.
- Change rates are declared in the graph, not measured from real interaction. A planner that watched actual slider traffic would need no `changeRate` field.
- No strings, no picking, no transitions, no basemap, no geo beyond a hand-rolled mercator, no line or polygon marks.
- Heatmap weights are quantized to 1/256 and accumulated as `u32`, because WebGPU has no float atomics. Weights below ~0.004 contribute nothing.
- Single machine, single GPU, synthetic data. The 5M-row case allocates 206 MB of attribute buffers, which needed an explicit `maxStorageBufferBindingSize` request.
