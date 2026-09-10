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
A graph node is a wrangle that creates or overwrites one. The planner decides which
engine evaluates each node, once at compile time:

```
volume-reducing        (filter, aggregate)  -> DuckDB SQL   fewer bytes to upload
volume-preserving      (per-row attribute)  -> WGSL kernel  reparameterizable by a
                                                            uniform write, no requery
GPU-impossible         (aggregates)         -> SQL          forced by the op table
SQL-impossible         (ramp, swizzle)      -> GPU          forced by the op table
```

The load-bearing piece is **one expression IR with three backends**. `sqrt(pop) * 2`
compiles to a DuckDB `SELECT` expression, a WGSL statement, or a JS loop body from the
same AST — so "which engine runs this node" is a cost decision, not a rewrite.

```
src/graph/expr.ts            parser + AST + the capability table
src/graph/backends/sql.ts    -> DuckDB, with `?` placeholders for prepared statements
src/graph/backends/wgsl.ts   -> WGSL, width- and bool-aware
src/graph/backends/js.ts     -> JS, so deck.gl can render the identical graph
src/graph/planner.ts         classify, fuse, emit the physical plan
```

`scale`, `colorscale` and `project` are sugar: `desugar()` rewrites them into plain
`attribute` nodes emitting `fit(…)`, `ramp(…)` and a mercator expression. There is only
ever one thing to compile.

## Two graphs

`src/graphs/scatter.json` — instanced points, log-scaled radius from a `stats`-derived
domain, elevation through a viridis ramp. Three GPU nodes fuse into one kernel.

`src/graphs/heatmap.json` — the same source binned on the GPU with `atomicAdd` into a
screen-space grid, then rasterized through the ramp.

## The inspector is the point

Every claim the architecture makes should be checkable on screen:

- **plan** — each node's assigned engine and the reason, plus which route every
  parameter takes (`uniform` / `requery` / `rebuild`)
- **sql** — the generated query and its bind order
- **wgsl** — the generated kernel, and which nodes fused into it
- **attributes** — each column's upload tier, so "zero copy" is a measurement
- **bench** — `run sweep` rebuilds at 100k / 1M / 5M and times it
- **vs deck** — the same graph rendered by deck.gl from CPU-computed binary attributes

Drag a `UNIFORM` slider and watch the footer: uniform writes go up, requeries and buffer
allocations do not. Drag the `REQUERY` one and the row count changes while the SQL text
stays byte-identical.

Header `render` switches between the WebGPU pane, the deck.gl pane, and both side by
side. Header `policy` overrides the planner's cost model so `sql-first` and `gpu-first`
can be measured against `auto`.

## Layout

```
src/graph/      expression IR, backends, planner, JSON schema + desugaring
src/engine/     webgpu device, duckdb host, arrow→gpu upload, attribute registry,
                orbit camera, kernel host, render passes, runtime
src/compare/    CPU evaluation of the same graph + the deck.gl pane
src/ui/         inspector panes and the counter strip
src/data/       synthetic source, generated inside DuckDB
```

## Tests

```bash
npm test
```

103 tests over the parts with a right answer: expression parsing, three-backend
agreement (the JS backend is *executed* against hand-computed values), planner engine
assignment and fusion, and Arrow upload tier detection across
Float32/Float64/int/nullable/multi-chunk fixtures.

## Known limits

Linear chains only, one aggregate and one color ramp per graph, no strings, no picking,
no transitions, no line or polygon marks. The deck.gl comparison runs WebGL2, so its
frame times are not comparable — see the end of [FINDINGS.md](FINDINGS.md).
