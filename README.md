# DuckDB → WebGPU procedural graph

A proof of concept for the noodles.gl design, built from first principles: a JSON graph
of filters, aggregations, scales and color scales, compiled to DuckDB SQL and WGSL
compute, rendered to a WebGPU canvas. No deck.gl in the critical path.

```bash
npm install
npm run dev
```

Needs Chrome/Edge 113+ or Safari 26+. Read [FINDINGS.md](FINDINGS.md) for the measured
results and the recommendation for noodles.

## The idea

Attributes are named, Houdini-style: `P` is position, `Cd` is color, `pscale` is radius.
A graph node is a wrangle that creates or overwrites one.

The load-bearing piece is **one expression IR with three backends**. `sqrt(pop) * 2`
compiles to a DuckDB `SELECT` expression, a WGSL statement, or a JS loop body from the
same AST — so "which engine runs this node" is a cost decision, not a rewrite.

```
src/graph/expr.ts            parser + AST + the capability table
src/graph/backends/sql.ts    -> DuckDB, with `?` placeholders for prepared statements
src/graph/backends/wgsl.ts   -> WGSL, width- and bool-aware
src/graph/backends/js.ts     -> JS, for the CPU stage and the deck comparison
```

Planning is three phases, deliberately separated so a plan exists as data before anything
is generated:

```
src/graph/analyze.ts     topological order, feasible engines per node, widths, op counts
src/graph/optimizer.ts   price every legal plan, pick the cheapest
src/graph/planner.ts     emit SQL + WGSL + the CPU loop for the chosen assignment
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
**cost constants** calibrated on your device at startup (`engine/calibrate.ts` — hand-derived
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

`src/graphs/scatter.json` — instanced points, log-scaled radius from a `stats`-derived
domain, elevation through a viridis ramp. Three GPU nodes fuse into one kernel.

`src/graphs/heatmap.json` — the same source binned on the GPU with `atomicAdd` into a
screen-space grid, then rasterized through the ramp.

`src/graphs/wrangle.json` — the scatter graph again, but as one four-statement wrangle body
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
src/graph/      expression IR + backends, analyze/optimize/emit, statistics, cost model,
                target capabilities, wrangle parser, JSON schema + desugaring
src/engine/     webgpu device, duckdb host, arrow→gpu upload, attribute registry,
                orbit camera, kernel host, render passes, calibration, runtime
src/compare/    CPU stage evaluation + the two deck.gl panes (webgl2 and webgpu)
src/ui/         inspector panes, explain pane, counter strip
src/data/       synthetic source, generated inside DuckDB
```

## Tests

```bash
npm test
```

146 tests over the parts with a right answer:

- expression parsing, and **three-backend agreement** — the JS backend is *executed*
  against hand-computed values, so operator precedence, integer division, float modulo and
  ternary branch order are checked rather than asserted
- selectivity estimation, and the optimizer's decisions: pushing a selective filter to SQL,
  preferring a real filter over a discard mask, forcing CPU placement when the target has no
  compute, rejecting plans over the memory or binding limits
- wrangle statement parsing, local scoping and renaming, register-only locals
- DAG topological order, dead-code elimination, cycle detection
- Arrow upload tier detection across Float32/Float64/int/nullable/multi-chunk fixtures

## Known limits

One aggregate and one color ramp per graph. No relational joins, no strings, no picking, no
transitions, no line or polygon marks. The optimizer is exact only within the family "stage
boundaries in topological order" — for a linear chain that is every legal plan, for a
branching DAG it is not. Cardinality estimation assumes uniformity and independence, so the
sub-1% accuracy on this synthetic data says more about the data than the estimator. deck.gl's
WebGPU render path currently fails on kernel-written buffers for three specific reasons — see
§5a and the end of [FINDINGS.md](FINDINGS.md).
