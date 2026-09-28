# Geometry beyond points

The expression IR has one value shape: one to four f32s per row. A point fits in it, so
`packages/planner/src/geo.ts` covers the point subset of PostGIS and turf as inlined
arithmetic, and every function runs on all three backends. Lines and polygons do not fit.
They have a variable number of vertices, and no per-row value in the IR can hold that.

This note sorts the operations on them by where the variable-length part lives, because that
decides which engine can run them. One case is built: a geometry written as a literal
(case 1a). The rest are not.

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

And against a literal geometry (case 1a). `g` is a WKT or GeoJSON string, directly or through
`st_geomfromtext` / `st_geomfromgeojson`; `p` is a point.

| PostGIS | turf | units | engines |
|---|---|---|---|
| `st_contains(g, p)`, `st_within(p, g)`, `st_intersects`, `st_disjoint` | `booleanPointInPolygon(p, g)`, `point_in_polygon` | — | SQL, GPU, CPU |
| `st_distance(g, p)`, `st_distance_sphere`, `st_dwithin(g, p, m)` | `pointToLineDistance(p, g)`, `point_to_line_distance` | m / km | SQL, GPU, CPU |
| `st_lineinterpolatepoint(g, f)`, `st_startpoint`, `st_endpoint` | `along(g, km)` | fraction / km | SQL, GPU, CPU |
| `st_area`, `st_length`, `st_perimeter`, `st_npoints` | `area` | m², m | constant |
| `st_xmin` … `st_ymax`, `st_centroid`, `st_makeenvelope` | `bbox`, `centroid`, `center` | degrees | constant |

turf's `length` cannot be offered: `length` is already the vector length. Use `st_length`.

## Case 1: the geometry is a constant, and each row is a point

Examples: "is this row inside the selected region", "distance to this route", "which
district". This is the most common case in interactive maps. It is also the cheapest,
because the variable-length part is the same for every row.

### 1a. A literal: built

```
st_contains('POLYGON((-74.02 40.70, -73.93 40.70, …))', [lng, lat])
```

A geometry that is written in the expression is not a per-row value. It is a set of constants.
The functions that take one are macros (`FunctionDef.expand` in `functions.ts`), so they run
during inlining:

1. `geometry.ts` parses the literal once, cached by text. It accepts WKT, EWKT with
   `SRID=4326`, and GeoJSON (a FeatureCollection merges into a Multi\*). It rejects rings
   that are not closed, and latitudes outside ±90, which usually means the axes are swapped.
2. `geo.ts` expands the call into arithmetic over the vertices:
   - point in polygon is a crossing-number sum over the edges, summed as a balanced tree;
   - distance is a `min` over the segments;
   - `along` is a balanced `cond` search over cumulative lengths, followed by the
     destination formula.
   Quantities that depend only on vertices, such as edge slopes, cosines and bearings, are
   computed in f64 at plan time.
3. Measures of the literal itself (area, length, bounds, centroid) fold to numbers.

The resulting tree is an ordinary tree. `enginesFor` returns SQL, GPU and CPU, `opCount`
prices it at about 30 operators per edge, and DuckDB needs no spatial extension. The cap is
`MAX_GEOMETRY_VERTICES` (1024). A boundary that detailed belongs in case 3.

Semantics: edges are straight in lng/lat, as in PostGIS `geometry` and turf, so this is not
`geography`. A point on an edge or vertex follows the crossing-number rule (half-open in y)
on all three backends. `tests/geo.test.ts` checks them against each other at 1e-9, and
`backends.browser.test.ts` checks them on the GPU.

### 1b. A geometry param: not built

The literal is fixed at plan time, so changing it replans the graph. A polygon the user drags or
keyframes needs to be a *param*:

- **GPU.** Bind the vertices as a storage buffer, or as a uniform array when they fit under
  the 64 KB uniform limit. Point-in-polygon becomes a WGSL loop over the edges, and distance
  to a line a loop over the segments. This is the same shape as `ramp()`, which already binds
  a LUT per kernel. The geometry is a resource the kernel reads, not a value in the tree.
- **IR.** A new `call` whose argument is a geometry param, `st_contains({{region}}, [lng,
  lat])`. It needs its own `FnSpec` with a WGSL body that is a loop, not an expression. It
  also needs a width rule, the scalar result, and an `opCount` price proportional to the
  vertex count. Editing the polygon changes a buffer, so its route is `uniform`, the same as
  a slider. A keyframed polygon then stays on the GPU for the same reason a keyframed scalar
  does.
- **SQL.** Either `ST_Contains(ST_GeomFromText(?), ST_Point(lng, lat))`, which needs DuckDB
  spatial (see case 3), or case 1a's expansion regenerated on each edit, which requeries.
- **Limit.** One geometry per binding, as with one ramp per graph today (FINDINGS.md, "What
  this prototype does not prove").

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

Everything here uses a sphere of radius 6371008.8 m, turf's radius. DuckDB spatial's
`ST_Distance_Sphere` uses 6371000 m, so it reads 1.4 ppm shorter. Neither is PostGIS's
spheroid, and `ST_Distance(geography)` differs from both by up to about 0.5%. Measured
against DuckDB's `_Spheroid` functions, these are the gaps:

| measure | literal | sphere vs spheroid |
|---|---|---|
| `st_area` | a Manhattan polygon with a hole | −0.15% |
| `st_area` | a 1°×1° box at the equator | +0.45% |
| `st_perimeter` | the same polygon's outer ring | +0.04% |
| `st_length` | a 15 km San Francisco line | −0.16% |

Other references:

- turf's `area` uses 6378137 m, so it reads 0.22% above ours.
- Distance to a line is found in a local equirectangular frame and then measured at the
  mean latitude. Within 50 km it is within 1.2e-6 of the haversine to the true nearest point.
  A great-circle edge (`geography`) bows poleward of the straight lng/lat edge by
  L²·tan(lat)/8R, which is 1.7 m for a 10 km edge at 38°.
- `st_centroid` is PostGIS's planar centroid, matching DuckDB's to 1e-12.

**Trap for anyone pinning references:** DuckDB's `ST_Distance_Sphere` and every `_Spheroid`
function read points as (lat, lng). Pass lng/lat geometries through `ST_FlipCoordinates`,
or `ST_Length_Spheroid` returns NaN and the areas come out wrong. On the GPU the inputs are f32: about 1 m of resolution at the equator
in degrees, and about 1 m absolute on EPSG:3857 y near the equator. A spheroid tier (Vincenty,
Karney) is iterative. It would work as a GPU loop, but it would not be a per-row expression,
so it belongs with case 1's loops rather than with the prelude.
