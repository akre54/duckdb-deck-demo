# DuckDB → WebGPU procedural graph

A declarative, cost-planned data graph: JSON in, GPU pixels out. Filters, aggregations,
scales and color scales compile to DuckDB SQL and WGSL compute, and a cost model decides
which engine runs each node. Houdini-style named attributes (`P`, `Cd`, `pscale`).

**Live demo:** <https://akre54.github.io/duckdb-deck-demo/> — the inspector with the three
example graphs below, published from `main` by `.github/workflows/pages.yml`.

```bash
npm install
npm run dev        # the inspector demo
npm test           # 612 node tests
npm run test:gpu   # 66 browser tests, real WebGPU + real DuckDB
```

Needs Chrome/Edge 113+ or Safari 26+. Read [FINDINGS.md](FINDINGS.md) for the measured
results and the recommendation for noodles.

## Using it as a library

Two packages. The planner is the reusable half and stands entirely alone; the runtime is a
reference implementation of executing what it plans.

```ts
// @noodles.gl/planner — headless. No GPU, no DOM, no database driver, and no runtime
// imports at all: apache-arrow is used for types only, so it erases at compile time.
import { plan, analyze, optimize, parseExpr, toSql, toWgsl } from '@noodles.gl/planner';

// The WebGPU runtime: needs a GPUDevice and a SqlEngine.
import { initGpu, Runtime, calibrate } from '@noodles.gl/gpu-runtime/webgpu';

// A SqlEngine over duckdb-wasm. Bundle URLs are passed in, so nothing here needs a bundler.
import { DuckDbEngine } from '@noodles.gl/gpu-runtime/duckdb';

// deck.gl adapters, for rendering the same plan through deck.
import { DeckWebgl2Pane, DeckWebgpuPane } from '@noodles.gl/gpu-runtime/deck';
```

Measured, not asserted — `tests/boundaries.test.ts` reads the built output:

```
@noodles.gl/planner              (no bare imports at all)
@noodles.gl/gpu-runtime/webgpu   @noodles.gl/planner
@noodles.gl/gpu-runtime/duckdb   @duckdb/duckdb-wasm
@noodles.gl/gpu-runtime/deck     @deck.gl/*, @luma.gl/*, @noodles.gl/planner
```

Planning is headless, so the compiler can be used on its own — a build step or a test can
inspect the generated SQL and WGSL without ever creating a device:

```ts
import { plan, targetCaps } from '@noodles.gl/planner';

const physical = plan(graph, schema, {
  policy: 'cost',
  stats,                                        // from statsSql + parseStatsRow
  caps: targetCaps('webgpu-native', device),    // or undefined, headless
  params: { speedCutoff: 60 },
  relation: '"my_table"',
});

physical.sql;                 // the DuckDB query, with $1-style binds
physical.kernels[0].code;     // the fused WGSL
physical.explain.candidates;  // every legal plan and its cost
```

Data arrives through a source provider rather than being baked in, so the library never
needs to know where rows come from:

```ts
import { parquetUrlSource, relationSource } from '@noodles.gl/planner';

runtime.registerSource('trips', parquetUrlSource('https://example.com/trips.parquet'));
runtime.registerSource('local', relationSource('already_loaded_table'));
```

## The idea

Attributes are named, Houdini-style: `P` is position, `Cd` is color, `pscale` is radius.
A graph node is a wrangle that creates or overwrites one.

The load-bearing piece is **one expression IR with three backends**. `sqrt(pop) * 2`
compiles to a DuckDB `SELECT` expression, a WGSL statement, or a JS loop body from the
same AST — so "which engine runs this node" is a cost decision, not a rewrite.

```
packages/planner/src/expr.ts          parser + AST + the capability table
packages/planner/src/functions.ts     user-defined functions, resolved by inlining
packages/planner/src/backends/sql.ts  -> DuckDB, with $1-style binds for prepared statements
packages/planner/src/backends/wgsl.ts -> WGSL, width- and bool-aware
packages/planner/src/backends/js.ts   -> JS, for the CPU stage and the deck comparison
```

Those names are a *default*, not a constant. The vocabulary is declared, and `analyze`
resolves every render channel once so nothing downstream applies a fallback:

```ts
plan(graph, schema, {
  conventions: { position: 'aPosition', color: 'aColor', mask: '$keep', internalPrefix: '$' },
});
```

A channel named with the internal prefix is rejected up front, because an internal attribute
is never given a buffer — the symptom would otherwise be a render pass binding an attribute
that does not exist, reported by WebGPU at submit time, nowhere near the graph that named it.

Planning is three phases, deliberately separated so a plan exists as data before anything
is generated:

```
packages/planner/src/analyze.ts    topological order, feasible engines, widths, op counts
packages/planner/src/optimizer.ts  price every legal plan, pick the cheapest
packages/planner/src/planner.ts    emit SQL + WGSL + the CPU loop for the chosen assignment
```

## The planner

Three stages, in this order and only this order — SQL cannot read a GPU buffer, and GPU
output cannot return to the CPU without a readback:

```
SQL   filters that really remove rows, aggregates, scalar expressions
CPU   generated JS over Arrow columns, results uploaded
GPU   one fused compute kernel writing attribute buffers in place
```

That constraint is what makes the search exact: an assignment is just **two boundary
indices** in topological order, so there are O(n²) candidates and all of them get priced.
The explain pane shows every one.

The objective is not build time alone:

```
cost = build
     + horizon × frameRate × renderFrame(rows)        drawing is recurring
     + horizon × Σ rate_p × rebind(stage owning p)    parameters have change rates
```

The second term is why a filter that removes rows beats a GPU discard mask — masked rows
are re-rasterized every frame. The third is the "parameterized query" idea as an objective:
a dragged slider pulls its consumers onto the GPU, where rebinding is a 16-byte uniform
write instead of a requery.

Inputs the planner actually uses: **statistics** (`stats.ts`, one DuckDB query per source —
row count, distinct counts, ranges, null fractions, with System-R selectivity estimation),
**cost constants** calibrated on your device at startup (`webgpu/calibrate.ts` — hand-derived
constants were off by up to 32×), and **target capabilities** (`target.ts` — compute
availability, GPU memory budget, storage-buffer limit).

## Programmable: the wrangle node

`scale`, `colorscale` and `project` are sugar over the IR. `wrangle` is the general case:

```
@P      = [lng / 360.0, ln(tan(0.7853981634 + lat * 0.008726646259971648)) / 6.283185307,
           elevation * {{exag}} * 0.0006];
var t   = clamp(fit(ln(pop), {{lo}}, {{hi}}, 0.0, 1.0), 0.0, 1.0);
@Cd     = ramp(t);
@pscale = ({{sizeScale}} * 0.4) + t * ({{sizeScale}} * 3.1);
```

`desugar()` expands it to one `attribute` node per statement and the planner needs no
knowledge of wrangles: each statement is placed independently and the existing fusion
merges them into one dispatch. Locals (`var t`) get an SSA register rather than a buffer, so
they cost no memory, no upload and no binding slot.

### User-defined functions

```
fn ease(x) = x * x * (3.0 - 2.0 * x);
@Cd = ramp(ease(t));
```

or as a graph-level `functions` map, callable from any expression. **They are inlined, not
compiled**: a call is replaced by its body with the arguments substituted, so every backend,
`enginesFor`, `widthOf`, `opCount` and fusion see an ordinary tree. A real call mechanism would
have to be implemented three times and would have to answer "which engines can run this
function" separately from "which engines can run its body"; inlining makes those one question.

The cost is duplication — `sq(expensive())` evaluates the argument twice. That is faithful
rather than surprising, and `opCount` prices it, so a function names work without hiding it.
Recursion is rejected with the cycle; shadowing a built-in is rejected at the declaration.

### The escape hatch: `raw`

For the cases the IR genuinely cannot reach — a window function, a texture sample, an atomic:

```json
{ "id": "custom", "type": "raw", "input": "src", "engine": "gpu",
  "code": "let t = elevation / 900.0;\ntint = vec3<f32>(t * k, t, 1.0 - t);",
  "writes": [{ "name": "tint", "width": 3 }],
  "reads": ["elevation"], "params": ["k"], "opCost": 6 }
```

The code sees plain names: a declared read, write or param is in scope as itself, never as
`r7` or `params.p_k`. In exchange the node declares what the planner can no longer infer — its
engine (a feasible set of one, so it pins the boundary rather than being placed), its reads and
writes, its parameters, and an op-count estimate. **Those declarations are trusted**: reading an
attribute you did not declare gives you an unbound buffer, so prefer a `wrangle` whenever the
expression fits.

What it does *not* give up is fusion. A raw GPU node is spliced into the same kernel as its
neighbours, because fusion follows the stage assignment, not legibility.

Nodes take `inputs: string[]`, so the topology is a DAG — branching works, unreachable
branches are dropped as dead code, cycles are reported. Relational joins are out of scope.

## Three graphs

`demo/graphs/scatter.json` — instanced points, log-scaled radius from a `stats`-derived
domain, elevation through a viridis ramp. Three GPU nodes fuse into one kernel.

`demo/graphs/heatmap.json` — the same source binned on the GPU with `atomicAdd` into a
screen-space grid, then rasterized through the ramp.

`demo/graphs/wrangle.json` — the scatter graph again, but as one four-statement wrangle body
instead of four operator nodes. Same image, one fused kernel.

## The inspector is the point

Every claim the architecture makes should be checkable on screen:

- **graph** — the planned DAG, each node tinted by its assigned stage, with a dashed box around
  the nodes that fused into one dispatch. Click a node for its reason and its slice of the
  generated code. Drawn from `plan.explain.edges`, which is the *desugared* topology — so a
  wrangle already appears as one node per statement and dead branches are already gone.
- **wrangle** — an editable body that replans on every keystroke (headless, ~2 ms) with a badge
  per statement showing which engine it landed on. Switch `policy` to `sql-first` and watch
  `@P` and `var t` move from GPU to SQL while `@Cd` stays put, because `ramp()` has no SQL form.
  A syntax error is reported against its line and leaves the previous plan on screen. Apply
  (or ⌘/Ctrl+Enter) does the expensive half.
- **explain** — the chosen plan, its cost breakdown, **every candidate plan with its cost**,
  every rejected one and why, estimated vs actual rows and time, the statistics the
  optimizer used, and the calibrated constants
- **plan** — each node's assigned engine and the reason, plus which route every
  parameter takes (`uniform` / `cpu` / `requery` / `rebuild`)
- **sql** — the generated query and its bind order
- **wgsl** — the generated kernel, and which nodes fused into it
- **attributes** — each column's upload tier, so "zero copy" is a measurement
- **bench** — `run sweep` rebuilds at 100k / 1M / 5M and times it
- **vs deck** — the same graph through deck.gl, either from CPU-computed binary attributes
  (WebGL2) or from buffers a compute kernel wrote (WebGPU)
- **calibration** — the raw micro-benchmarks the cost constants came from

Things worth doing by hand:

- Drag a `UNIFORM` slider and watch the footer: uniform writes go up, requeries and buffer
  allocations do not. Drag the `REQUERY` one and the row count changes while the SQL text
  stays byte-identical.
- Move `speed cutoff` up and rebuild. Around 98% selectivity the planner keeps the filter as
  a GPU discard mask; once it removes real volume the filter moves into SQL. The explain tab
  shows the cost that flipped.
- Switch `target` to `deck-webgl2`. There is no compute, so the GPU stage disappears and
  `ramp()` is forced onto the CPU — a capability changing the plan, not a cost.
- Set `policy` to `auto` / `sql-first` / `gpu-first` to measure the old rule-based placement
  against the cost model.

## Layout

```
packages/planner/   @noodles.gl/planner — expression IR + backends, analyze/optimize/emit,
                    statistics, cost model, target capabilities, attribute conventions,
                    source providers, wrangle parser, Arrow upload, CPU stage, fixtures
src/webgpu/         device, attributes, kernels, camera, calibration, passes, runtime
src/duckdb/         DuckDbEngine, a SqlEngine over duckdb-wasm
src/deck/           the WebGL2 and WebGPU deck.gl panes
demo/               the inspector app: main.ts, ui/, graphs/, data/ (not published)
tests/              boundary guard, budgets, benchmarks, browser/
```

The planner resolves to its source during development (a Vite/Vitest alias) and to its built
`dist` when the root package is compiled. `tests/boundaries.test.ts` is the standing guard on
the split: no relative import escapes the package, no package but Arrow's types is reached,
Arrow is imported `import type` only, no GPU or DOM API is mentioned, and the planner's
tsconfig keeps `lib` at ES2022 with `types: []` — so an accidental `document` or `GPUDevice`
fails to compile rather than becoming something a consumer has to install.

## Tests

```bash
npm test          # 612 tests, node, ~0.6s
npm run test:gpu  # 66 tests, Chromium, real WebGPU + real DuckDB
npm run bench     # throughput, reported not asserted
```

The split matters. Node covers everything with a right answer that does not need a device:
expression parsing, the op table's completeness (driven off `FUNCTIONS`, so a function added
without a JS implementation or a width rule fails a test), selectivity estimation, the cost
model's monotonicity, planner placement and fusion, generated-code invariants,
`perspective` mapping near→0 and far→1, shader codegen for all 16 subsets of optional
channels, and Arrow upload tier detection.

The browser suite exists because Node can only prove the SQL and WGSL backends *compile* —
only the JS one is executable there. In Chromium all three run, so:

- the same expression is evaluated through DuckDB, through a compute kernel, and through
  generated JS, and compared element-wise
- the same graph is planned under `cost`, `auto` and `sql-first`, and on a target without
  compute, and the resulting attribute buffers must be numerically identical
- ten uniform-routed parameter changes must produce zero requeries, zero reallocations and
  zero re-uploads, and still change the buffer
- exact bin counts are read back from the atomic grid
- calibration is checked against the machine it just measured
- a requery that grows the row count past buffer capacity must not strand a bind group
- raw WGSL and raw SQL compute what their code says, and a user function agrees element-wise
  with the same body written inline

That suite found five real bugs: no boolean tracking in the SQL backend, `%` disagreeing on
negatives, kernels with no parameters silently producing zeroes, a render pass holding a
destroyed buffer after a reallocation, and a raw node's SSA locals declared inside the block
that had to outlive it. See [FINDINGS.md](FINDINGS.md) §8.

Three gotchas for anyone extending it. Playwright's default headless binary is
`chrome-headless-shell`, which has no WebGPU — `navigator.gpu` exists but `requestAdapter()`
returns null, so GPU tests skip while looking like they ran; the config uses
`channel: 'chromium'` for the full build. `Runtime.build()` marks kernels dirty without
dispatching, so a derived attribute reads as zero until a frame is submitted. And WebGPU
reports a destroyed buffer only at `queue.submit`, so a bind-group cache has to key on
something that changes when a buffer is *replaced* — neither the label (`attr:Cd`, which never
changes) nor the capacity (which can repeat) is enough. Attributes carry a `generation` counter
for exactly this, and passes resolve buffers by name per frame instead of capturing them.

Performance assertions live in `tests/budgets.test.ts` and are deliberately of two kinds:
structural ones that cannot be flaky (the chunked upload path reports zero conversion time; a
kernel-only parameter never becomes a SQL bind) and wall-clock guards with 100–250×
headroom, to catch an order-of-magnitude regression rather than a 20% one.

## Known limits

One aggregate and one color ramp per graph. A `raw` node's declared reads and writes are
trusted, not checked against its code — that is the price of the escape hatch. Raw SQL produces
scalars only. User functions cannot recurse and are inlined, so they name work rather than
saving it. No relational joins, no strings, no picking, no
transitions, no line or polygon marks. The optimizer is exact only within the family "stage
boundaries in topological order" — for a linear chain that is every legal plan, for a
branching DAG it is not. Cardinality estimation assumes uniformity and independence, so the
sub-1% accuracy on this synthetic data says more about the data than the estimator. deck.gl's
WebGPU render path currently fails on kernel-written buffers for three specific reasons — see
§5a and the end of [FINDINGS.md](FINDINGS.md).
