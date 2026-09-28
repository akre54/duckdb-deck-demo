# Geometry beyond points

The expression IR has one value shape: one to four f32s per row. A point fits in it, so
`packages/planner/src/geo.ts` covers the point subset of PostGIS and turf as inlined
arithmetic, and every function runs on all three backends. Lines and polygons do not fit.
They have a variable number of vertices, and no per-row value in the IR can hold that.

This note covers what the next tier would need. It sorts the missing operations by where the
variable-length part lives, because that decides which engine can run them. None of it is
built.

## What the point tier already covers

| PostGIS | turf | units | engines |
|---|---|---|---|
| `st_point`, `st_x`, `st_y` | `point` | degrees | SQL, GPU, CPU |
| `st_distance_sphere` | `distance` | m / km | SQL, GPU, CPU |
| `st_dwithin` | — | m | SQL, GPU, CPU |
| `st_azimuth` | `bearing` | rad / deg | SQL, GPU, CPU |
| `st_project` | `destination` | m, rad / km, deg | SQL, GPU, CPU |
| — | `midpoint` | degrees | SQL, GPU, CPU |
| — | `toMercator`, `toWgs84` (and `to_mercator`, `from_mercator`) | EPSG:3857 m | SQL, GPU, CPU |
| — | `point_in_bbox` | degrees | SQL, GPU, CPU |

SQL applies when a point is written as a literal of scalar columns, `[lng, lat]`. A point
held in a vec2 *column* is GPU and CPU only, because SQL columns are scalars.

## Case 1: the geometry is a constant, and each row is a point

Examples: "is this row inside the selected region", "distance to this route", "which
district". This is the most common case in interactive maps. It is also the cheapest to
add, because the variable-length part is the same for every row.

- **GPU.** Bind the vertices as a storage buffer, or as a uniform array when they fit under
  the 64 KB uniform limit. Point-in-polygon is a WGSL loop over the edges (crossing number).
  Distance to a line is a loop over the segments. This is the same shape as `ramp()`, which
  already binds a LUT per kernel. The geometry is a resource the kernel reads, not a value
  in the tree.
- **IR.** A new `call` whose argument is a *geometry param*, `st_contains({{region}}, [lng,
  lat])`. The call would need its own `FnSpec` with a WGSL body that is a loop, not an
  expression. It would also need a width rule, the scalar result, and an `opCount` price
  proportional to the vertex count. Editing the polygon changes a buffer, so its route is
  `uniform`, the same as a slider. A keyframed polygon stays on the GPU for the same reason a
  keyframed scalar does.
- **SQL.** `ST_Contains(ST_GeomFromText(?), ST_Point(lng, lat))` needs DuckDB spatial. See
  case 3 for why that extension is the hard part.
- **Limit.** One geometry per binding, as with one ramp per graph today (FINDINGS.md, "What
  this prototype does not prove"). A layer that tests against several regions needs several
  bindings, or a packed buffer with an offset table.

## Case 2: the geometry is spread across rows, one vertex per row

Examples: GPS traces, flight paths, a `path_id, seq, lng, lat` table. The variable-length
part is the *group*, not the row, so this is an aggregate or a window, not an expression.

- **Path length.** Written as a window: `sum(st_distance_sphere([lag(lng), lag(lat)], [lng,
  lat])) OVER (PARTITION BY path_id ORDER BY seq)`. The per-segment distance already exists.
  What is missing is `lag` and `OVER`. The IR has aggregates (`sum`, `avg` and the others are
  SQL-only in the op table) but no window functions. The `raw` node exists for exactly that
  gap (`types.ts`, `RawNode`), so a `raw` SQL node can do this today at the cost of
  legibility.
- **GPU.** A segmented scan over sorted rows: each row reads its predecessor, and a prefix
  sum runs per segment. It is expressible in WGSL, but it is a separate kernel with a
  barrier, not a fused per-row expression. It would need a new stage kind, not a new
  function.
- **Bounds and centroids** per path are plain aggregates (`minAgg`, `maxAgg`, `avg`) grouped
  by `path_id`. They work now in a program's relational nodes, with the usual caveat that
  relations are SQL-only and not costed.

## Case 3: the geometry is a column value

Examples: a GeoParquet of parcels, `ST_Area(geom)`, `ST_Intersects(a.geom, b.geom)` in a
spatial join. The value really is variable-length per row. Only SQL can hold it.

- **Typing.** A `GEOMETRY` column classifies as `'other'` (`relational.ts`,
  `columnTypeOf`). That means it can be selected into a relation but never put into a
  buffer. That is the right boundary. A geometry travels through SQL, and only its scalar
  results (`ST_Area`, `ST_X(ST_Centroid(geom))`) cross into attributes.
- **IR.** SQL-only `FnSpec`s with `wgsl: null`, the same pattern as the aggregates:
  `st_area`, `st_length`, `st_centroid`, `st_contains`, `st_intersects`. `enginesFor`
  already pins any tree that calls one of them to SQL. The new work would be an argument
  type check: these take an `'other'` column, and the point functions must not accept one.
- **Rendering polygons.** Out of scope for the planner. deck's `PolygonLayer` tessellates on
  the CPU. The planner could feed it per-feature attributes (fill colour, elevation) but not
  the vertices. FINDINGS.md already lists "no polygon marks".
- **The extension.** DuckDB spatial is an extension. DuckDB-Wasm downloads extensions on
  first use. With no network it *hangs* rather than failing, which is why
  `tests/duckdb-node.ts` sets `autoload_known_extensions = false`. Testing this tier offline
  would need the extension vendored and loaded explicitly, or these tests gated to the
  browser suite with a network allowance.

## Accuracy, for all three cases

The point tier uses a sphere of radius 6371008.8 m. That is turf's radius and DuckDB spatial's
`ST_Distance_Sphere` radius, not PostGIS's spheroid. `ST_Distance(geography)` differs from it
by up to about 0.5%. On the GPU the inputs are f32: about 1 m of resolution at the equator
in degrees, and about 1 m absolute on EPSG:3857 y near the equator. A spheroid tier (Vincenty,
Karney) is iterative. It would work as a GPU loop, but it would not be a per-row expression,
so it belongs with case 1's loops rather than with the prelude.
