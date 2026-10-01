<!--
Destination: new issue on visgl/luma.gl
Title: GPUExpression: a few more closed operators, enough to derive a dense group key on the GPU
Status: draft, not posted
-->

### Use case

A linked histogram whose binning is interactive. The user drags the bin width or the domain, and
`count`/`mean` per bin update every frame. GPU Dataframe's dense `groupBy` is the right engine for
this. At 4M rows and 1024 bins a re-aggregation takes about 4 ms, against about 40–100 ms for
DuckDB-Wasm requerying the same table (FINDINGS §13 in akre54/duckdb-deck-demo).

The key, though, has to be a dense `u32` that already exists. `GPUExpression` has no way to derive
`u32(clamp(floor((x - lo) / width), 0, n - 1))`. So today the bin is computed by the database at
load time, and changing `width` means requerying and re-uploading the key column. That turns a
uniform write into a round trip. `histogram()` covers counts, but its domain is a literal (a
recompile), and it has no per-bin `mean`/`sum`.

### Ask

Extend the closed operator set. This keeps the existing guarantee that no application text reaches
generated WGSL:

| Operator | WGSL | Why |
|---|---|---|
| `floor`, `ceil`, `round` (unary) | `floor` / `ceil` / `round` | binning |
| `min`, `max` (binary), `clamp` (ternary) | `min` / `max` / `clamp` | binning into `[0, n)`, clipping |
| `abs` (unary) | `abs` | distances, tolerances |
| `modulo` (binary) | `%`, with a stated sign rule | periodic bins (hour of day, day of week) |
| `select(cond, a, b)` | `select` | CASE-style derived values |
| `toUint32` / `toFloat32` | `u32(...)` / `f32(...)` | f32 → u32 so `withColumn` can produce a key |

With these, `withColumn('bin', toUint32(clamp(floor(column('x').subtract(parameter('lo')).divide(parameter('width'))), 0, n - 1)), { format: 'uint32' })`
feeds `groupBy('bin', { groupCount: n })`, and `lo`/`width` are parameters. A domain or width
change is then an encode-time value with no recompile.

`modulo` needs a decision. WGSL's `%` truncates, so `-1 % 3 == -1`. SQL agrees with WGSL; Python's
floored modulo does not. We hit this in our own SQL/WGSL/JS backends, where a cross-backend test
caught it. I'd document truncation and match WGSL.

### What I'd leave out

Strings, vectors, user-defined functions and anything that changes an output's length all stay out.
Those belong upstream in the database, not in a per-row expression.

I can take this one too. The operator table and the null semantics for each new operator (null in
gives null out, as for the existing binary operators) are the main design surface.
