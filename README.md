# DuckDB → WebGPU procedural graph

A declarative, cost-planned data graph: JSON in, GPU pixels out. Filters, aggregations,
scales and color scales compile to DuckDB SQL and WGSL compute, and a cost model decides
which engine runs each node. Houdini-style named attributes (`P`, `Cd`, `pscale`).

```bash
npm install
npm run dev        # the inspector demo
npm test           # 528 node tests
npm run test:gpu   # 59 browser tests, real WebGPU + real DuckDB
```

Needs Chrome/Edge 113+ or Safari 26+. Read [FINDINGS.md](FINDINGS.md) for the measured
results and the recommendation for noodles.

## Using it as a library

Four entry points, split along what each one needs. The package name is a placeholder —
change it in `package.json` before publishing.

```ts
// Headless: no GPU, no DOM, no database driver. Only dependency is apache-arrow, and
// even that is types-only, so the built core entry has zero runtime imports.
import { plan, analyze, optimize, parseExpr, toSql, toWgsl } from '@noodles/gpu-graph';

// The WebGPU runtime: needs a GPUDevice and a SqlEngine.
import { initGpu, Runtime, calibrate } from '@noodles/gpu-graph/webgpu';

// A SqlEngine over duckdb-wasm. Bundle URLs are passed in, so nothing here needs a bundler.
import { DuckDbEngine } from '@noodles/gpu-graph/duckdb';

// deck.gl adapters, for rendering the same plan through deck.
import { DeckWebgl2Pane, DeckWebgpuPane } from '@noodles/gpu-graph/deck';
```

Planning is headless, so the compiler can be used on its own — a build step or a test can
inspect the generated SQL and WGSL without ever creating a device:

```ts
import { plan, targetCaps } from '@noodles/gpu-graph';

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
import { parquetUrlSource, relationSource } from '@noodles/gpu-graph';

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
src/core/expr.ts            parser + AST + the capability table
src/core/backends/sql.ts    -> DuckDB, with $1-style binds for prepared statements
src/core/backends/wgsl.ts   -> WGSL, width- and bool-aware
src/core/backends/js.ts     -> JS, for the CPU stage and the deck comparison
```

Planning is three phases, deliberately separated so a plan exists as data before anything
is generated:

```
src/core/analyze.ts      topological order, feasible engines per node, widths, op counts
src/core/optimizer.ts    price every legal plan, pick the cheapest
src/core/planner.ts      emit SQL + WGSL + the CPU loop for the chosen assignment
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
src/core/       expression IR + backends, analyze/optimize/emit, statistics, cost model,
                target capabilities, source providers, wrangle parser, Arrow upload,
                CPU stage
src/webgpu/     device, attributes, kernels, camera, calibration, render passes, runtime
src/duckdb/     DuckDbEngine, a SqlEngine over duckdb-wasm
src/deck/       the WebGL2 and WebGPU deck.gl panes
demo/           the inspector app: main.ts, ui/, graphs/, data/ (not published)
tests/          boundary guard, budgets, benchmarks, fixtures, browser/
```

## Tests

```bash
npm test          # 528 tests, node, ~0.5s
npm run test:gpu  # 59 tests, Chromium, real WebGPU + real DuckDB
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

That suite found three real bugs on its first run: no boolean tracking in the SQL backend,
`%` disagreeing on negatives, and kernels with no parameters silently producing zeroes. See
[FINDINGS.md](FINDINGS.md) §8.

Two gotchas for anyone extending it. Playwright's default headless binary is
`chrome-headless-shell`, which has no WebGPU — `navigator.gpu` exists but `requestAdapter()`
returns null, so GPU tests skip while looking like they ran; the config uses
`channel: 'chromium'` for the full build. And `Runtime.build()` marks kernels dirty without
dispatching, so a derived attribute reads as zero until a frame is submitted.

Performance assertions live in `tests/budgets.test.ts` and are deliberately of two kinds:
structural ones that cannot be flaky (the chunked upload path reports zero conversion time; a
kernel-only parameter never becomes a SQL bind) and wall-clock guards with 100–250×
headroom, to catch an order-of-magnitude regression rather than a 20% one.

## Known limits

One aggregate and one color ramp per graph. No relational joins, no strings, no picking, no
transitions, no line or polygon marks. The optimizer is exact only within the family "stage
boundaries in topological order" — for a linear chain that is every legal plan, for a
branching DAG it is not. Cardinality estimation assumes uniformity and independence, so the
sub-1% accuracy on this synthetic data says more about the data than the estimator. deck.gl's
WebGPU render path currently fails on kernel-written buffers for three specific reasons — see
§5a and the end of [FINDINGS.md](FINDINGS.md).
