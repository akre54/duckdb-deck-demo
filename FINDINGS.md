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

*Update, 2026-10-01:* `requiredLimits` merged upstream in luma.gl#3312, and `attach()` is in
review as luma.gl#3313. §14 tracks both.

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

**A render pass held a destroyed buffer after a reallocation.** Reported from the demo, not
found by a test — a filter change at 1M rows produced
`[Buffer "attr:Cd"] used in submit while destroyed`. `requery` reallocates an attribute buffer
when the new row count outgrows capacity, but the render pass had captured the `GpuAttribute`
*object* at build time. Its bind-group cache key was computed from that stale object, so the
key never changed and the cached bind group kept pointing at the freed buffer. The kernel host
was immune by accident: it looks attributes up by name from the live set each dispatch.

Two things made it hard to see. WebGPU only notices at `queue.submit`, so the error surfaced on
a later frame rather than at the reallocation. And the cache key looked adequate — it contained
the buffer's label and its capacity, but the label is `attr:<name>` and never changes, and a
capacity can repeat across a reallocation. Fixed by giving every attribute a `generation`
counter bumped on each allocation, and by having the passes resolve buffers by name per frame
the way the kernel already did. The regression test reproduces the original message exactly
against the unfixed code.

**A raw node's output locals were declared inside the block that scoped them.** The WGSL escape
hatch splices author-written statements into a generated kernel, inside a `{ }` block so two raw
nodes can both declare `let elevation` without colliding. The SSA locals carrying the result out
were declared inside that block — so they were out of scope by the time the next node read them,
the kernel failed to compile, and every derived attribute came back zero. Identical symptom to
the `layout: 'auto'` bug above, from an unrelated cause, and identically invisible to a
structural test: the plan was correct, the code was generated, the numbers were zero. Found on
the first run of a browser test that compared the kernel's output against DuckDB's.

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
- A requery that grows the row count past capacity reallocating without stranding a bind
  group, and its complement: a requery that shrinks the result reusing the buffer, because
  otherwise every drag of a filter slider allocates.

### Three traps worth knowing

Playwright's default headless binary is `chrome-headless-shell`, which ships **without
WebGPU**: `navigator.gpu` exists but `requestAdapter()` returns null, so every GPU test skips
while appearing to have run. `channel: 'chromium'` selects the full build.

`Runtime.build()` marks kernels dirty but does not dispatch them — that happens in `frame()`.
Reading a derived attribute straight after `build()` compares zeroes, which is how three of
these tests initially "failed" for the wrong reason.

A **bind-group cache must key on buffer identity, and identity needs an explicit token**.
Nothing observable on a `GPUBuffer` distinguishes it from its replacement: labels are not
unique and sizes repeat. A monotonic counter on the owning attribute is the cheapest thing that
works, and it belongs on the attribute rather than in each consumer, because every consumer
that caches gets the invariant wrong in the same way.

## 9. The attribute vocabulary had to become configuration

`P`, `Cd`, `pscale` and `Alpha` were spelled out in fourteen places as `x ?? 'P'` — in
desugaring, in the optimizer's binding count, in the emitter, in the WebGPU runtime, and in
both deck adapters. Every one of those is the same decision made again, and a library whose
attribute names are compiled in is only usable by a renderer that agreed to Houdini's spelling.

The fix that mattered was not adding an options bag. It was moving the resolution to a single
point: `analyze` now resolves each render channel to a concrete name and publishes them as
`Analysis.channels`, so every consumer downstream reads a resolved name and *no* call site
applies a fallback. The fourteen sites became one.

Two things fell out of doing it properly. The internal prefix (`__`) is part of the vocabulary
too, because it decides which attributes get a buffer — so a consumer changing the prefix
without changing the mask name would produce an attribute that is bound but never allocated.
That combination is now rejected at construction with an explanation, rather than surfacing as
a WebGPU error at first draw. And renaming attributes must not change *placement*: it is a
spelling change, not a cost change. A test asserts the chosen assignment, kernel count and
estimated rows are identical under both vocabularies, which is the check that the naming has
not leaked into the optimizer.

## 10. Two ways to be programmable, and only one of them is free

The wrangle node made the pipeline programmable without the planner learning anything. The
question that followed was what "custom logic" should mean beyond it, and the two answers have
very different costs.

**User-defined functions are free, because they are inlined.** `fn ease(x) = x * x * (3 - 2x)`
is resolved before anything else looks at the tree, so the three backends, `enginesFor`,
`widthOf`, `opCount` and fusion are all unchanged. A real call mechanism would have to be
implemented three times — SQL has no per-query user functions, WGSL has real ones, JS has
closures — and would have to answer "which engines can run this function" separately from
"which engines can run its body". Inlining collapses those into one question, and the price is
argument duplication, which `opCount` prices honestly.

One thing did not survive contact: the parser validates call names and arity eagerly, so a user
function was rejected before inlining ever ran. The fix was to *declare functions to the parser*
rather than relax the check, because relaxing it would move every typo's error from the offending
text to a later engine-capability failure. `parseExpr(src, { functions })`.

**A raw SQL/WGSL node costs exactly what it gives up.** Its feasible set is declared rather than
derived, so it is a set of one and it pins the stage boundary instead of being placed. Its reads,
writes, params and op count must be declared, because none of them can be inferred from opaque
text — and the planner then *trusts* those declarations, which is the real cost: an undeclared
read is an unbound buffer, not an error.

What it does not cost is fusion. A raw GPU node is spliced into the same kernel as its
neighbours, because fusion follows the stage assignment and has no opinion about legibility.
That was the surprise — the escape hatch is a placement constraint, not a pipeline barrier.

## 11. A node editor compiles to the same IR, and the routes hold under interaction

The question here was whether the planner could sit under a Noodles-style editor with forks,
joins and animation, without a second IR. It can. The planner gained multiple sources,
relational nodes, layer outputs and SQL-only strings. `compileProgram` cuts a graph into
memoized relations and per-layer sub-graphs, and the per-layer piece is the unchanged
`plan()`. An operator library and a document lowering sit above it, and the planner never
sees an editor concept.

Measured live in the editor (Chromium, this machine, the four example projects on their real
public data):

| change | what ran | cost |
|---|---|---|
| load the route network (7.7k airports, 67.7k routes, double join) | 5 relations materialized, 3 layer queries | 701 ms, mostly fetching |
| drag the route-length slider 5 times | 5 CPU passes of one layer, **0 DuckDB executions** | — |
| play the trips timeline, 60 frames (48k vertices + 1.5k columns) | 60 prop updates, **0 executions, 0 attribute rebuilds** | ~1.7 ms of work per frame |
| un-bypass the time window, so the same clock filters the grid | 30 frames → 30 requeries of the grid layer only; trails still prop | 3.7 ms per requery |
| collapse three nodes into a subnet | the lowered graph is byte-identical, **0 recompiles** | — |
| key a parameter | its declared change rate goes from 2/s to the timeline's 30/s | a replan, once |

Three things made this work, and each is a claim the tests check by counting executions
(`tests/runtime.test.ts`) rather than by timing:

- **Parameters are routed, not re-evaluated.** Each parameter's routes come from the plan
  (`prop`, `uniform`, `cpu`, `requery`, `rematerialize`), and the runtime does only that much
  work. The cost model still chooses: with 309 routes and a slider dragged at 4/s, it kept the
  length filter on the CPU as a mask, because a requery per tick costs more.
- **Relations are memoized by value.** A relation's hash includes the parameter values it
  inlines. Changing the country re-runs the filter and the joins, the two file sources are
  memo hits, and changing it back hits the table left from before.
- **Binary data keeps its identity.** The deck adapter builds a layer's typed arrays once per
  `LayerData`. A prop change hands deck the same object, so it re-uploads nothing.

Executing, not compiling, found seven more bugs, five of them in code that predates the editor:

1. GROUP BY on a SQL-computed attribute emitted a query over a column that was never selected.
2. A channel bound straight to a source column was dropped by projection pushdown.
3. `gpu-first` produced an illegal plan whenever a node could only run in SQL.
4. A vector nested inside an expression (`c ? [1, 0, 0] : [0, 0, 1]`) was marked SQL-feasible
   and failed at emission.
5. `readColumn` on a string vector cast its UTF-8 bytes to floats, with no error.
6. Collapsing into a subnet wired the outer edge to the subnet's own input.
7. A relative reference stopped resolving once its node moved into a subnet. References are
   now rebased on every move and rename, as Houdini does.

The planner's node tests now run SQL for real, through duckdb-wasm's blocking Node build
(`tests/duckdb-node.ts`). That is the "test by executing" rule applied to the half of the
stack that previously could only be shown to compile outside a browser.

## 12. luma.gl's GPU Dataframe beats our discard mask, as a filter engine only

luma 9.4.2 ships `@luma.gl/experimental/gpu-dataframe`: a WebGPU executor that compiles a
predicate into a command graph producing a selection mask, the **compacted** ids of the
selected rows, and a per-batch selected count, all on the GPU. §4's complaint was that a GPU
filter here cannot remove rows. luma's compaction can. So `src/luma/` runs luma's filter over
our own attribute buffers, and `PointsPass` gained an indexed `drawIndirect`: instance `k` draws
row `ids[k]`, and luma's count is copied into the draw arguments on the GPU. Nothing is read back.

`npm run perf:gpu` (`tests/browser/engines.browser.test.ts`) runs one workload, `v > {{cut}}`
feeding a point layer, through six engines on one device and one DuckDB table. It checks every
engine's selected count against a CPU count before timing anything. *update* is one slider tick
to drained pixels. *frame* is the steady state after it. Apple Metal-3, median of 9, 1 px points.
Full table in `tests/browser/__perf__/engines.md`.

| 4M rows | sel | update ms | frame ms | drawn |
|---|---:|---:|---:|---:|
| sql (requery + upload) | 0.05 | 31.6 | 0.31 | 200k |
| gpu-mask (uniform + kernel) | 0.05 | 6.17 | 5.30 | 4M |
| cost (chose sql) | 0.05 | 27.7 | 0.30 | 200k |
| **luma** (compact + drawIndirect) | 0.05 | **1.80** | **0.30** | 200k |
| js loop (deck-style) | 0.05 | 6.55 | 0.44 | 200k |
| gpu-mask | 0.5 | 6.80 | 5.40 | 4M |
| **luma** | 0.5 | **5.02** | **2.94** | 2M |
| gpu-mask | 0.9 | 7.48 | 5.51 | 4M |
| luma | 0.9 | 7.84 | 5.18 | 3.6M |

**It wins wherever the filter removes rows, and ties where it does not.** At 5% selectivity luma
updates 15× faster than the plan our optimizer actually chose, SQL, and it draws as cheaply. It
draws 18× cheaper than the discard mask. At 90% it ties the mask, since both draw about the
same number of rows. Compaction is a strict improvement for a slider-driven filter. The
cost-based choice the planner makes today (requery when selective, mask when not) is the best of
two engines that are both beaten by a third.

**The indirect, indexed draw costs nothing measurable.** luma and sql draw the same K rows in
the same frame time (0.30 vs 0.31 ms at 200k), so reading row ids through one extra storage
buffer is free here.

**Batch topology dominates luma's cost.** luma preserves record batches: one dispatch per
batch and one id list per batch. Handing it DuckDB's 2048-row chunks as-is (the `luma-batched`
row, same memory, sliced views) costs 90 ms per filter at 4M rows instead of 1.6 ms, and 2.4 s to
compile instead of 27 ms. Per-batch ids would also need one draw call per batch. So luma only works
here on top of §2's chunked upload, which packs DuckDB's batches into one buffer. Arrow-shaped
input and GPU-shaped input are different things, and the packing is where they meet.

**What it cannot do is most of what our kernels do.** luma's expression language is `+ - * /`,
comparisons, `and`/`or`/`not` and null tests. There is no `%`, no functions, no vectors and no
conditionals. `toLumaExpr` returning `null` is the capability test, like `enginesFor`. So luma is
a filter engine beside our kernels, not a replacement for them. In the planner's terms it is a
fourth placement for `filter` nodes only.

### 12a. Compaction as a planned placement

It is now wired in, without the planner learning luma's name. Here is how the pieces fit:

- **Capability.** `TargetCaps.compaction` is the capability, and `compactable(expr)` is the rule
  for which predicates qualify. `Assignment.compact` is a third field on a candidate, and it
  exists only where a GPU-stage filter does. The search is still exhaustive.
- **Legality.** A compacting candidate is illegal unless its output is a point pass (the only
  indexed draw). It also needs no CPU-stage filter, a compactable predicate and scalar inputs.
- **Pricing.** Compile once, then one compaction pass per rebind. Rendering is priced at the
  estimated survivors instead of all rows. A parameter only the compacted filter reads gets its
  own cheapest route, `compact`: the kernel's outputs do not depend on it, so it does not re-run.
- **Runtime.** It takes a `compactor` factory (`src/webgpu/compaction.ts`), and `src/luma`
  supplies `lumaCompactor`. The kernel submits first, then the compaction, then a draw whose
  `instanceCount` is copied from the GPU-resident count.

Same sweep, the planner choosing freely (`cost+luma`) against the plan it chose before (`cost`):

| rows | sel | cost: update / frame ms | cost+luma: update / frame ms | cost+luma chose |
|---:|---:|---:|---:|---|
| 100k | 0.9 | 0.56 / 0.27 | 0.45 / 0.19 | mask (compaction not worth its compile) |
| 1M | 0.05 | 7.79 / 0.10 | **0.79** / 0.09 | compact |
| 4M | 0.05 | 28.8 / 0.32 | **2.27** / 0.32 | compact |
| 4M | 0.5 | 7.15 / 5.79 | **5.45 / 3.24** | compact |
| 4M | 0.9 | 8.15 / 6.01 | 8.47 / 5.68 | compact (a wash) |

The planned path lands within about 10% of hand-driven luma at every size. The cost model's
luma constants come from one machine (`DEFAULT_COSTS.compact*`). They are not calibrated at boot
the way the kernel constants are. That is the next thing to fix before trusting the 90% cases.

Three smaller results from wiring it up:

- **luma can wrap a device it did not create.** `luma.attachDevice` throws in 9.4 (§5a), but
  `new WebGPUDevice(props, gpuDevice, adapter, adapter.info)` is exported and works. A luma
  `Buffer` also takes an existing `GPUBuffer` as `handle`. That is how luma runs on our device,
  with our raised limits, over our buffers, with no copy.
- **luma 9.4 can raise its own limits.** `featureLevel: 'max'` makes the WebGPU adapter request
  every adapter limit. The "no `requiredLimits`" half of §5a #3 has a 9.4 answer. Only
  `attach()` is still missing, and it still throws in `10.0.0-alpha.2`.
- **luma's first compile costs 100–150 ms cold**, then 5–30 ms. It is a build-time cost, like
  pipeline creation, and is not paid per slider tick.

## 13. luma's dense group-by wins a linked histogram, until a float sum meets few bins

§12 used luma as a filter, but luma 9.4.2 ships more than that. `@luma.gl/experimental` also has
a dense group-by (count/sum/min/max/mean), a unique-right hash join (inner/left/semi/anti), a
global sort with top-K, histograms, `gpu-crossfilter`, and a small SQL front end (`LuSQL`). Each
operator stays readback-free in the same way: it takes only shapes whose output size is known on
the CPU in advance. Group keys must be dense `u32` in `[0, groupCount)`, join keys must be unique
on the right, and every output has a fixed capacity. `LumaGroupBy` (`src/luma`) wraps the
group-by over our own buffers, as `LumaFilter` wraps the filter.

`tests/browser/groupby.browser.test.ts` races one crossfilter workload,
`SELECT bin, count(*), avg(v) WHERE v > {{cut}} GROUP BY bin`, where `cut` is a brush on another
view. DuckDB computes the bin once at load. Every engine's counts must match an f64 CPU reference
exactly, and its means must agree to 1e-3. *update* is one brush tick, ending with the result
where its consumer needs it. luma runs twice: on a device without the `subgroups` feature, and on
one with it. Apple Metal-3, median of 9. Full table in `tests/browser/__perf__/groupby.md`.

| 4M rows, sel 0.5 | 16 bins: update ms | 1024 bins: update ms |
|---|---:|---:|
| duckdb (prepared `$1`, dense scatter) | 97.1 | 102 |
| js loop (f64 accumulators) | 47.4 | 46.7 |
| **luma** count + mean, no `subgroups` | **366** | **4.40** |
| **luma** count + mean, `subgroups` | **54.9** | **4.19** |
| luma + one `mapAsync` of both outputs | 329 | 4.38 |
| luma count only | 2.90 | 2.54 |

DuckDB's times varied between runs: 38–55 ms at 4M rows in two earlier runs of the same sweep,
97–102 ms here. luma's 1024-bin times stayed between 3.8 and 4.4 ms in all three runs.

**With many bins luma is an order of magnitude faster than DuckDB.** At 1024 bins with half the
rows kept, a brush tick costs about 4 ms on the GPU, against 38–102 ms for the requery. It also
beats the JS loop by 10×. With 5% kept, DuckDB has less to aggregate, and the gap to DuckDB
narrows to 4.5–13×.

**With few bins the float sum turns it into the slowest engine.** Counts accumulate in workgroup
memory. Float sums go through `atomicCompareExchangeWeak` loops on bitcast `u32` words in global
memory, because WebGPU has no float atomics. 4M rows on 16 words is a contention storm: 366 ms
for count + mean, against 2.90 ms for the count alone. The cost tracks rows per bin, not rows.
1M rows on 16 bins is already 61 ms.

**`subgroups` helps 6.7×, but it does not close the gap.** For 16 groups or fewer, luma 9.4.2
first sums equal keys across a subgroup (`subgroupBallot` + `subgroupAdd`), then issues one CAS
per distinct key per subgroup. That takes 366 ms down to 55 ms. It is still 19× the count-only
time, and still slower than the JS loop. And it only happens if the device *requested* the
feature: luma checks `device.features`. Our harness did not, and `initGpu` did not either. It
does now. The remaining fix belongs in luma. Each workgroup should reduce to per-group partial
sums in workgroup memory, as counts already do, and write them without atomics to a
`[workgroups × groupCount]` scratch buffer, about 1 MB at 4M rows and 16 groups. A second pass
then sums each group's partials in a fixed order. That removes the contention and makes the
result deterministic. Until then, a planner should price luma's `sum`/`mean` by rows per group
and avoid it for low-cardinality keys.

**Readback is not the cost.** Mapping 2 × `groupCount` words back to JS adds nothing measurable
at 1024 bins (4.38 vs 4.40 ms). So a DOM- or SVG-drawn histogram fed by a GPU group-by is viable.
The worry that leaving the GPU erases the win does not hold for aggregate-sized outputs.

**The means are not deterministic, with or without subgroups.** The same parameters, run twice,
give bitwise-different means in every configuration, from 20k rows up. The relative error is
small: at most 1.2e-5, worst at 16 bins. But a tooltip that changes its last digit with no input
is a visible bug. The two-pass fixed-order reduction above fixes this too.

**A plain JS loop beats DuckDB at every size here.** This holds once the data is already in
typed arrays. It does not argue against DuckDB, whose work in this pipeline is the load, the
binning and the dense keys. It argues that the per-tick engine should be anything but a
requery.

## 14. Upstream status: what is in flight, what to ask for, and in what order

Most of the gaps in §5a, §12 and §13 are luma or deck work, and several are already open as PRs.
Status as of 2026-10-01. The drafts in `docs/upstream/` are the next asks, written against the
numbers above. Nothing in that directory has been posted.

**Already fixed upstream.** `requiredLimits` on `DeviceProps` merged in
[luma.gl#3312](https://github.com/visgl/luma.gl/pull/3312), which answers the limits half of §5a #3.
It is not in a release yet; this repo still runs 9.4.2.

**In review.** None of these PRs depends on another.

| Gap | PR |
|---|---|
| §5a #3: `attach()` an app-created `GPUDevice` | [luma.gl#3313](https://github.com/visgl/luma.gl/pull/3313) |
| §12: one dispatch per batch (90 ms vs 1.6 ms) | [luma.gl#3326](https://github.com/visgl/luma.gl/pull/3326) fuses contiguous batches (11,722 → 8 dispatches); [luma.gl#3337](https://github.com/visgl/luma.gl/pull/3337) packs on upload |
| §12a: indexed draw with a GPU-resident count | [luma.gl#3328](https://github.com/visgl/luma.gl/pull/3328), `Model` drawIndirect |
| Pipeline rebuild cost | [luma.gl#3302](https://github.com/visgl/luma.gl/pull/3302) |
| deck re-reading a buffer rewritten in place | [deck.gl#10779](https://github.com/visgl/deck.gl/pull/10779) |
| Per-pass GPU timing (the §5a "no deck GPU time" caveat) | [deck.gl#10778](https://github.com/visgl/deck.gl/pull/10778), which overlaps [deck.gl#10279](https://github.com/visgl/deck.gl/pull/10279) |

**Not yet asked for:**

- **luma group-by float sums.** §13 found the contention and the nondeterminism. Draft:
  `luma-group-by-float-sums.md`.
- **More closed operators in `GPUExpression`:** `floor`, `clamp`, `min`/`max`, `%`,
  `select`, and a `u32` cast. luma's expression language is closed on purpose, so no application
  text reaches generated WGSL, and a "bring your own WGSL" hook would go against that. These
  operators are enough to derive a dense group key on the GPU. That turns a bin-width change
  from a requery into a parameter. §12's other gap, functions, has a workaround that needs
  nothing upstream: our kernel computes the predicate into a 0/1 column, and luma filters on
  `col > 0.5`. Draft: `luma-expression-ops.md`.
- **deck layers that draw `ids[k]` with a GPU-resident instance count.** No deck issue exists.
  Draft: `deck-indexed-indirect-rfc.md`.
- **WebGPU f32 atomics,** [gpuweb#4894](https://github.com/gpuweb/gpuweb/issues/4894), Milestone 3.
  The WGSL committee's open question is whether the CAS polyfill is acceptable. §13 is a
  performance data point on that. Draft: `gpuweb-4894-comment.md`.

**Order.**

1. **Comments first.** They take minutes, and committees and maintainers take months.
2. **luma's in-review stack next.** Once #3313 lands, `lumaDeviceFor` in `src/luma` can use
   `attach()`, and the `new WebGPUDevice(...)` workaround goes away.
3. **The group-by fix.**
4. **Planner placement for group-by.** It follows §12a's pattern: a capability, legality (dense
   key) and pricing by rows per group.
5. **deck,** last. Its asks build on luma #3328 and on ibgreen's GPU-vector layers in
   [luma.gl#3169](https://github.com/visgl/luma.gl/pull/3169).

## Recommended order of work for noodles

Ranked by payoff per unit of risk. The first three are independent of any renderer decision.

1. **Classify parameters as structural vs value, and route value params to uniforms or prepared-statement binds.** Biggest win, entirely renderer-independent, and it is what makes a slider feel instant at 1M rows. DuckDB-Wasm's prepared statements already do the SQL half.
2. **Cast channel-bound columns to `FLOAT` in the generated SQL,** and upload Arrow per record batch instead of concatenating. Removes the largest CPU cost in the upload path for a very small diff.
3. **Test by executing, not by compiling.** Four of the five bugs above were invisible to a
   structural test and visible on the first run of an executing one. The cheap version of this
   is a browser test that evaluates one expression through every backend and compares — it does
   not need the whole pipeline to pay for itself.
4. **Make the expression IR the shared artifact and the SQL compiler a backend of it.** `sql-compiler/expression-to-sql.ts` is already the seed; add a WGSL backend beside it. Then retire `MapRangeOp`/`ColorRampOp` into `fit()`/`ramp()` templates — which is PR #491's own stated Phase 2, so the roadmaps already converge. The planner is a standalone package (`@noodles.gl/planner`, no runtime dependencies) precisely so this can be a dependency rather than a port.
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
- One `aggregate` per `plan()`; a program lifts it to one per layer. Relational joins exist only in programs, are SQL-only, and are not costed: the optimizer prices each layer's tail, not the relations above it, so a `rematerialize` route is reported but never weighed against the alternatives.
- **The optimizer is exact only within the family "stage boundaries in topological order".** For a linear chain that family is every legal plan. For a branching DAG it is not: an assignment that interleaves stages across independent branches is legal but unexplored. The topological order also fixes a particular tie-break, so a different (equally legal) order could yield a different boundary.
- **Cardinality estimation assumes uniformity and independence.** The 0.5% accuracy above is a property of uniformly-generated synthetic data, not of the estimator. Skewed or correlated columns are where it will be wrong, and the explain pane exists to show that rather than hide it.
- The cost model does not model: DuckDB's own parallelism or its choice of scan strategy, GPU occupancy or cache behavior, overdraw (a render term proportional to instances ignores that zoomed-out points overlap), or the possibility that a plan changes what is *visible* rather than only what it costs.
- Change rates are declared in the graph, not measured from real interaction. A planner that watched actual slider traffic would need no `changeRate` field.
- Strings are SQL-only (no string functions in the op table yet). No picking, no transitions, no polygon marks. The MapLibre basemap (`src/deck/maplibre-pane.ts`) uses the WebGL2 attribute path only, so it has no GPU stage; the orbit view's geo is still a hand-rolled mercator.
- Heatmap weights are quantized to 1/256 and accumulated as `u32`, because WebGPU has no float atomics. Weights below ~0.004 contribute nothing.
- Single machine, single GPU, synthetic data. The 5M-row case allocates 206 MB of attribute buffers, which needed an explicit `maxStorageBufferBindingSize` request.
