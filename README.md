# DuckDB to WebGPU procedural graph

A declarative, cost-planned data graph: JSON in, GPU pixels out. Filters, aggregations,
scales and color scales compile to DuckDB SQL and WGSL compute, and a cost model decides
which engine runs each node. Houdini-style named attributes (`P`, `Cd`, `pscale`).

**Live demo:** <https://akre54.github.io/duckdb-deck-demo/>. This is the inspector app with
the three example graphs described below. It is published from `main` by
`.github/workflows/pages.yml`.

## How this fits with deck.gl and luma.gl

This repo does not replace deck.gl. It computes the attributes a deck layer draws, such as
position, color and radius, from a declarative graph. A planner decides whether DuckDB,
generated JavaScript, or a WebGPU compute kernel produces each one. The output reaches deck
either as typed arrays bound as binary attributes, which works today on WebGL2 and on a
MapLibre basemap through `@deck.gl/mapbox`, or as luma.gl `Buffer`s a compute kernel wrote,
bound with no readback. The compute half of that second path works on luma's WebGPU device.
deck's WebGPU draw of those buffers is blocked by three deck/luma bugs.
[docs/deck-and-luma.md](docs/deck-and-luma.md) shows each integration in code and lists
suggested next changes and open research.

## Quick start

```bash
npm install
npm run dev        # the inspector demo
npm test           # 612 node tests
npm run test:gpu   # 66 browser tests, real WebGPU + real DuckDB
```

You need Chrome or Edge 113+, or Safari 26+. [FINDINGS.md](FINDINGS.md) has the measured
results and the recommendation for noodles.

## Using it as a library

There are two packages.

- **`@noodles.gl/planner`** is the reusable half. It runs anywhere: no GPU, no DOM, no
  database driver. It has no runtime dependencies at all. It uses apache-arrow for types
  only, and those erase at compile time.
- **`@noodles.gl/gpu-runtime`** is a reference implementation that executes what the planner
  produces. It needs a `GPUDevice` and a SQL engine.

```ts
// Headless planning and compilation.
import { plan, analyze, optimize, parseExpr, toSql, toWgsl } from '@noodles.gl/planner';

// The WebGPU runtime.
import { initGpu, Runtime, calibrate } from '@noodles.gl/gpu-runtime/webgpu';

// A SqlEngine over duckdb-wasm. You pass in the bundle URLs, so no bundler is required.
import { DuckDbEngine } from '@noodles.gl/gpu-runtime/duckdb';

// deck.gl adapters, for rendering the same plan through deck, or over a MapLibre map.
import { DeckWebgl2Pane, DeckWebgpuPane, DeckMaplibrePane } from '@noodles.gl/gpu-runtime/deck';
```

Each entry point's dependencies are checked by a test, `tests/boundaries.test.ts`, which
reads the built output:

```
@noodles.gl/planner              (no bare imports at all)
@noodles.gl/gpu-runtime/webgpu   @noodles.gl/planner
@noodles.gl/gpu-runtime/duckdb   @duckdb/duckdb-wasm
@noodles.gl/gpu-runtime/deck     @deck.gl/*, @luma.gl/*, @noodles.gl/planner
```

### Planning without a GPU

Because the planner is headless, a build step or a test can inspect the generated SQL and
WGSL without creating a device:

```ts
import { plan, targetCaps } from '@noodles.gl/planner';

const physical = plan(graph, schema, {
  policy: 'cost',
  stats,                                        // from statsSql + parseStatsRow
  caps: targetCaps('webgpu-native', device),    // or undefined for headless
  params: { speedCutoff: 60 },
  relation: '"my_table"',
});

physical.sql;                 // the DuckDB query, with $1-style binds
physical.kernels[0].code;     // the fused WGSL
physical.explain.candidates;  // every legal plan and its cost
```

### Where the data comes from

Data arrives through a source provider. The library never needs to know where rows come from:

```ts
import { parquetUrlSource, relationSource } from '@noodles.gl/planner';

runtime.registerSource('trips', parquetUrlSource('https://example.com/trips.parquet'));
runtime.registerSource('local', relationSource('already_loaded_table'));
```

## How it works

### One expression language, three backends

Every graph node creates or overwrites a named attribute. The expression that computes it,
say `sqrt(pop) * 2`, is parsed once into a syntax tree. That one tree can be compiled to:

- a DuckDB `SELECT` expression,
- a WGSL statement, or
- the body of a JavaScript loop.

Because all three come from the same tree, choosing an engine for a node is a cost decision
rather than a rewrite.

```
packages/planner/src/expr.ts          parser, AST, and the table of what each engine supports
packages/planner/src/functions.ts     user-defined functions, resolved by inlining
packages/planner/src/backends/sql.ts  DuckDB, with $1-style binds for prepared statements
packages/planner/src/backends/wgsl.ts WGSL, aware of vector widths and booleans
packages/planner/src/backends/js.ts   JavaScript, for the CPU stage and the deck comparison
```

### Attribute names are configurable

`P`, `Cd` and `pscale` are defaults. You can declare your own vocabulary, and `analyze`
resolves every render channel once so nothing downstream needs a fallback:

```ts
plan(graph, schema, {
  conventions: { position: 'aPosition', color: 'aColor', mask: '$keep', internalPrefix: '$' },
});
```

A render channel whose name starts with the internal prefix is rejected up front. Internal
attributes never get a buffer, so without this check the error would surface much later, as
a WebGPU submit-time complaint about a missing attribute.

### Three planning phases

Planning is split into three phases, so that a plan exists as data before any code is
generated:

```
packages/planner/src/analyze.ts    topological order, feasible engines, widths, op counts
packages/planner/src/optimizer.ts  price every legal plan, pick the cheapest
packages/planner/src/planner.ts    emit SQL, WGSL and the CPU loop for the chosen plan
```

## The planner

Work runs in three stages, always in this order:

```
SQL   filters that really remove rows, aggregates, scalar expressions
CPU   generated JavaScript over Arrow columns, results uploaded
GPU   one fused compute kernel writing attribute buffers in place
```

The order is fixed because SQL cannot read a GPU buffer, and GPU output cannot return to the
CPU without a readback. This constraint is also what keeps the search exact. A plan is just
two boundary indices in topological order. That gives O(n²) candidates, and the planner
prices every one of them. The explain pane in the inspector lists them all.

### The cost function

Build time is only part of the cost:

```
cost = build
     + horizon × frameRate × renderFrame(rows)        drawing happens every frame
     + horizon × Σ rate_p × rebind(stage owning p)    parameters change at some rate
```

The second term is why a SQL filter that removes rows beats a GPU discard mask. Masked rows
are still rasterized every frame. The third term treats parameters like a parameterized
query: a slider the user drags often pulls its consumers onto the GPU, where a rebind is a
16-byte uniform write instead of a requery.

### What the planner reads

- **Statistics** from `stats.ts`. One DuckDB query per source gives row count, distinct
  counts, ranges and null fractions. Selectivity is estimated System-R style.
- **Cost constants** from `webgpu/calibrate.ts`, measured on your device at startup.
  Hand-derived constants were off by up to 32×.
- **Target capabilities** from `target.ts`: whether compute is available, the GPU memory
  budget, and the storage-buffer limit.

## Writing your own nodes

### The wrangle node

`scale`, `colorscale` and `project` are shorthand. `wrangle` is the general form. It takes a
body of statements, each assigning one attribute:

```
@P      = [lng / 360.0, ln(tan(0.7853981634 + lat * 0.008726646259971648)) / 6.283185307,
           elevation * {{exag}} * 0.0006];
var t   = clamp(fit(ln(pop), {{lo}}, {{hi}}, 0.0, 1.0), 0.0, 1.0);
@Cd     = ramp(t);
@pscale = ({{sizeScale}} * 0.4) + t * ({{sizeScale}} * 3.1);
```

`desugar()` expands this into one `attribute` node per statement, so the planner never has to
know about wrangles. Each statement is placed on its own, and the normal fusion step merges
neighbouring GPU statements into one dispatch. Locals declared with `var` become registers
rather than buffers. They cost no memory, no upload and no binding slot.

### User-defined functions

```
fn ease(x) = x * x * (3.0 - 2.0 * x);
@Cd = ramp(ease(t));
```

You can also pass a graph-level `functions` map, callable from any expression.

Functions are **inlined, not compiled**. A call is replaced by the function body with the
arguments substituted. After that, every backend and every analysis pass sees an ordinary
expression tree. A real call mechanism would need to be implemented three times, once per
backend, and would need its own answer to "which engines can run this function". Inlining
makes that the same question as "which engines can run its body".

The trade-off is duplication. `sq(expensive())` evaluates the argument twice. `opCount`
prices that honestly, so a function names work without hiding its cost. Recursion is
rejected and the cycle is reported. Shadowing a built-in is rejected at the declaration.

### The escape hatch: `raw`

For things the expression language cannot express, such as a window function, a texture
sample or an atomic, use a `raw` node:

```json
{ "id": "custom", "type": "raw", "input": "src", "engine": "gpu",
  "code": "let t = elevation / 900.0;\ntint = vec3<f32>(t * k, t, 1.0 - t);",
  "writes": [{ "name": "tint", "width": 3 }],
  "reads": ["elevation"], "params": ["k"], "opCost": 6 }
```

Inside the code, declared reads, writes and params are in scope under their own names, never
as generated names like `r7` or `params.p_k`. In exchange, the node must declare everything
the planner can no longer infer: its engine, its reads, its writes, its parameters, and an
op-count estimate. Declaring an engine pins that node to one stage, so it fixes a stage
boundary rather than being placed by the optimizer.

**These declarations are trusted, not checked.** Reading an attribute you did not declare
gives you an unbound buffer. Prefer `wrangle` whenever the expression fits.

Raw GPU nodes still fuse. A raw node is spliced into the same kernel as its neighbours,
because fusion follows stage assignment, not node type.

### Graph shape

Nodes take `inputs: string[]`, so a graph is a DAG. Branching works. Unreachable branches
are dropped as dead code. Cycles are reported as errors. Relational joins are out of scope.

## The example graphs

- **`demo/graphs/scatter.json`**: instanced points. Radius is log-scaled from a domain
  derived from `stats`. Elevation is mapped through a viridis ramp. Three GPU nodes fuse
  into one kernel.
- **`demo/graphs/heatmap.json`**: the same source, binned on the GPU with `atomicAdd` into a
  screen-space grid, then rasterized through the ramp.
- **`demo/graphs/wrangle.json`**: the scatter graph again, written as one four-statement
  wrangle body instead of four operator nodes. Same image, one fused kernel.

## The inspector

The inspector exists so every claim the architecture makes can be checked on screen.

### Tabs

- **graph**: the planned DAG. Each node is tinted by its assigned stage, and a dashed box
  surrounds nodes that fused into one dispatch. Click a node to see why it was placed there
  and its slice of the generated code. The view is drawn from the desugared topology, so a
  wrangle shows as one node per statement and dead branches are already gone.
- **wrangle**: an editable body that replans on every keystroke, headless, in about 2 ms.
  A badge per statement shows which engine it landed on. A syntax error is reported on its
  line and the previous plan stays on screen. Apply (or Cmd/Ctrl+Enter) runs the expensive
  half.
- **explain**: the chosen plan and its cost breakdown, every candidate plan with its cost,
  every rejected plan and why, estimated versus actual rows and time, the statistics the
  optimizer used, and the calibrated constants.
- **plan**: each node's engine and the reason, plus the route every parameter takes
  (`uniform`, `cpu`, `requery` or `rebuild`).
- **sql** and **wgsl**: the generated query with its bind order, and the generated kernel
  with the list of nodes fused into it.
- **attributes**: each column's upload tier, so "zero copy" is measured rather than claimed.
- **bench**: `run sweep` rebuilds at 100k, 1M and 5M rows and times each.
- **vs deck**: the same graph rendered through deck.gl, either from CPU-computed binary
  attributes (WebGL2) or from buffers a compute kernel wrote (WebGPU). The mode menu's
  `deck.gl + maplibre` option draws the WebGL2 path over a MapLibre basemap.
- **calibration**: the raw micro-benchmarks behind the cost constants.

### Things to try

1. Drag a `UNIFORM` slider and watch the footer. Uniform writes go up. Requeries and buffer
   allocations do not. Then drag the `REQUERY` slider: the row count changes while the SQL
   text stays byte-identical.
2. Raise `speed cutoff` and rebuild. Around 98% selectivity the planner keeps the filter as
   a GPU discard mask. Once the filter removes real volume, it moves into SQL. The explain
   tab shows the cost that flipped.
3. Switch `target` to `deck-webgl2`. There is no compute, so the GPU stage disappears and
   `ramp()` is forced onto the CPU. This is a capability changing the plan, not a cost.
4. In the wrangle tab, switch `policy` to `sql-first`. `@P` and `var t` move from GPU to
   SQL, while `@Cd` stays on the GPU because `ramp()` has no SQL form.
5. Compare `policy` values `auto`, `sql-first` and `gpu-first` against `cost` to measure the
   old rule-based placement against the cost model.

## Repository layout

```
packages/planner/   @noodles.gl/planner: expression IR and backends, analyze/optimize/emit,
                    statistics, cost model, target capabilities, attribute conventions,
                    source providers, wrangle parser, Arrow upload, CPU stage, fixtures
src/webgpu/         device, attributes, kernels, camera, calibration, passes, runtime
src/duckdb/         DuckDbEngine, a SqlEngine over duckdb-wasm
src/deck/           the WebGL2, WebGPU and MapLibre deck.gl panes
docs/               how the planner integrates with deck.gl and luma.gl
demo/               the inspector app: main.ts, ui/, graphs/, data/ (not published)
tests/              boundary guard, budgets, benchmarks, browser/
```

During development the planner resolves to its source through a Vite and Vitest alias. When
the root package is compiled, it resolves to the built `dist`.

`tests/boundaries.test.ts` guards the package split. It checks that no relative import
escapes the planner package, that the only package reached is Arrow and only as
`import type`, that no GPU or DOM API is mentioned, and that the planner's tsconfig keeps
`lib` at ES2022 with `types: []`. An accidental use of `document` or `GPUDevice` therefore
fails to compile instead of becoming a dependency a consumer has to install.

## Tests

```bash
npm test          # 612 tests, node, about 0.6s
npm run test:gpu  # 66 tests, Chromium, real WebGPU + real DuckDB
npm run bench     # throughput, reported not asserted
```

### Node tests

Node covers everything that has a right answer and does not need a device: expression
parsing, completeness of the op table, selectivity estimation, monotonicity of the cost
model, planner placement and fusion, invariants of the generated code, `perspective` mapping
near to 0 and far to 1, shader codegen for all 16 combinations of optional channels, and
Arrow upload tier detection.

The op table test is driven off `FUNCTIONS`, so adding a function without a JavaScript
implementation or a width rule fails a test.

### Browser tests

In Node, only the JavaScript backend can actually run. The SQL and WGSL backends can only be
shown to compile. In Chromium all three run, so the browser suite checks that:

- the same expression evaluated through DuckDB, a compute kernel and generated JavaScript
  agrees element-wise
- the same graph planned under `cost`, `auto`, `sql-first`, and on a target without compute,
  produces numerically identical attribute buffers
- ten uniform-routed parameter changes produce zero requeries, zero reallocations and zero
  re-uploads, and still change the buffer
- exact bin counts read back correctly from the atomic grid
- calibration matches the machine it just measured
- a requery that grows past buffer capacity does not strand a bind group
- raw WGSL and raw SQL compute what their code says, and a user function agrees element-wise
  with the same body written inline

This suite found five real bugs: no boolean tracking in the SQL backend, `%` disagreeing on
negative numbers, kernels with no parameters silently producing zeroes, a render pass holding
a destroyed buffer after a reallocation, and a raw node's locals being declared inside a block
they had to outlive. See [FINDINGS.md](FINDINGS.md) §8.

### Gotchas when extending the tests

- **Playwright's default headless binary has no WebGPU.** With `chrome-headless-shell`,
  `navigator.gpu` exists but `requestAdapter()` returns null, so GPU tests skip while
  appearing to pass. The config uses `channel: 'chromium'` to get the full build.
- **`Runtime.build()` does not dispatch.** It marks kernels dirty. A derived attribute reads
  as zero until a frame is submitted.
- **WebGPU reports a destroyed buffer only at `queue.submit`.** A bind-group cache must key on
  something that changes when a buffer is replaced. The label never changes and the capacity
  can repeat, so neither works. Attributes carry a `generation` counter for this, and passes
  look up buffers by name each frame instead of holding references.

### Performance tests

`tests/budgets.test.ts` has two kinds of assertion. Structural ones cannot be flaky, for
example that the chunked upload path reports zero conversion time, or that a kernel-only
parameter never becomes a SQL bind. Wall-clock guards have 100 to 250× headroom, so they
catch an order-of-magnitude regression rather than a 20% one.

## Known limits

- One aggregate and one color ramp per graph.
- A `raw` node's declared reads and writes are trusted, not checked against its code.
- Raw SQL produces scalars only.
- User functions cannot recurse and are inlined, so they name work rather than saving it.
- No relational joins, strings, picking, transitions, or line and polygon marks.
- The optimizer is exact only for plans whose stage boundaries follow topological order.
  For a linear chain that is every legal plan. For a branching DAG it is not.
- Cardinality estimation assumes uniformity and independence. The sub-1% accuracy on the
  synthetic demo data says more about the data than about the estimator.
- deck.gl's WebGPU render path currently fails on kernel-written buffers, for three specific
  reasons. See §5a and the end of [FINDINGS.md](FINDINGS.md).
