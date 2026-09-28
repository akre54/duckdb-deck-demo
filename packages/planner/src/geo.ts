/**
 * Geospatial functions: the point subset of PostGIS and turf.js, written in the expression
 * language and inlined like any user function.
 *
 *     "@km"   = "distance([lng, lat], [{{lng0}}, {{lat0}}])"
 *     "@near" = "st_dwithin([lng, lat], [{{lng0}}, {{lat0}}], 500.0)"
 *
 * **There is no geometry type.** A point is a vec2 `[lng, lat]` in degrees, which the IR
 * already has, so nothing is serialized, converted or boxed. Every function here compiles out
 * to arithmetic before the planner looks at it (see `functions.ts` for why inlining rather
 * than calling), which is what gives each one SQL, WGSL and JS forms, an `enginesFor` answer
 * and an `opCount` price with no per-function code in any backend. The swizzle simplifier in
 * `analyze` is what keeps them SQL-feasible: `st_x([lng, lat])` inlines to `lng`, not to a
 * swizzle SQL cannot express. Called with a vec *column* (`distance(P, Q)`) they are GPU/CPU
 * only, because SQL columns are scalars.
 *
 * Lines and polygons are absent on purpose: they are variable-length, and the IR's values are
 * one to four f32s. `docs/geometry.md` sketches what that tier would need.
 *
 * Both vocabularies are offered because both have users. They differ in units, and each
 * keeps its own: PostGIS names take and return metres and radians, turf names kilometres and
 * degrees. Where the units match, one name is an alias of the other; where they differ, both
 * call one shared `__geo_` helper, so there is still only one formula to get wrong.
 *
 * Accuracy: this is a sphere of radius 6371008.8 m (the IUGG mean radius, turf's
 * `earthRadius` and DuckDB spatial's), not PostGIS's spheroid; distances differ from
 * `ST_Distance(geography)` by up to about 0.5%. On the GPU the inputs are f32, about 1 m at
 * the equator, so short distances there carry an absolute error of a metre or so.
 *
 * `pow(x, 2.0)` is spelled `x * x` throughout: WGSL's `pow` is undefined for a negative base,
 * and `sin` of a negative difference is negative half the time.
 */

import { type FunctionRegistry, type FunctionSpec, buildRegistry, GEO_SOURCE_PREFIX } from './functions.js';

/** Mean Earth radius in metres. */
export const EARTH_RADIUS_M = 6371008.8;
/** The WGS84 semi-major axis, which EPSG:3857 uses as its sphere. */
export const WEB_MERCATOR_RADIUS_M = 6378137;
/** Web Mercator's latitude limit: the latitude at which the map is square. */
export const WEB_MERCATOR_MAX_LAT = 85.0511287798;

const DEG = 0.017453292519943295;
const HALF_DEG = 0.008726646259971648;

/**
 * In declaration order: `buildRegistry` parses each body in the scope built so far, so a
 * helper has to come before its first caller.
 */
export const GEO_SPECS: Record<string, FunctionSpec> = {
  radians: { params: ['d'], body: `d * ${DEG}` },
  degrees: { params: ['r'], body: 'r * 57.29577951308232' },

  st_point: { params: ['lng', 'lat'], body: '[lng, lat]' },
  point: { params: ['lng', 'lat'], body: 'st_point(lng, lat)' },
  st_x: { params: ['p'], body: 'p.x' },
  st_y: { params: ['p'], body: 'p.y' },

  // Haversine. The scalar form is the real one; the point forms unpack into it. `min(…, 1.0)`
  // because rounding can put the square root a hair above 1 for antipodal points, and asin
  // of that is NaN.
  haversine_m: {
    params: ['lng1', 'lat1', 'lng2', 'lat2'],
    body:
      `${2 * EARTH_RADIUS_M} * asin(min(sqrt(` +
      `sin((lat2 - lat1) * ${HALF_DEG}) * sin((lat2 - lat1) * ${HALF_DEG}) + ` +
      `cos(radians(lat1)) * cos(radians(lat2)) * ` +
      `sin((lng2 - lng1) * ${HALF_DEG}) * sin((lng2 - lng1) * ${HALF_DEG})), 1.0))`,
  },
  st_distance_sphere: { params: ['a', 'b'], body: 'haversine_m(a.x, a.y, b.x, b.y)' },
  /** turf.distance: kilometres. */
  distance: { params: ['a', 'b'], body: 'st_distance_sphere(a, b) / 1000.0' },
  st_dwithin: { params: ['a', 'b', 'm'], body: 'st_distance_sphere(a, b) <= m' },

  // Initial great-circle bearing, in radians from north, in (-π, π].
  __geo_bearing: {
    params: ['a', 'b'],
    body:
      'atan2(sin(radians(b.x - a.x)) * cos(radians(b.y)), ' +
      'cos(radians(a.y)) * sin(radians(b.y)) - ' +
      'sin(radians(a.y)) * cos(radians(b.y)) * cos(radians(b.x - a.x)))',
  },
  /** turf.bearing: degrees in (-180, 180]. */
  bearing: { params: ['a', 'b'], body: 'degrees(__geo_bearing(a, b))' },
  /** ST_Azimuth: radians clockwise from north, in [0, 2π). `%` is floored on every backend. */
  st_azimuth: { params: ['a', 'b'], body: '__geo_bearing(a, b) % 6.283185307179586' },

  // Destination along a great circle, `d` in radians of arc and `az` in radians. The latitude
  // is its own helper because the longitude formula needs it too. Clamped for the same reason
  // as haversine: rounding at the poles.
  __geo_dest_lat: {
    params: ['p', 'd', 'az'],
    body: 'asin(clamp(sin(radians(p.y)) * cos(d) + cos(radians(p.y)) * sin(d) * cos(az), -1.0, 1.0))',
  },
  __geo_destination: {
    params: ['p', 'd', 'az'],
    body:
      '[degrees(radians(p.x) + atan2(sin(az) * sin(d) * cos(radians(p.y)), ' +
      'cos(d) - sin(radians(p.y)) * sin(__geo_dest_lat(p, d, az)))), ' +
      'degrees(__geo_dest_lat(p, d, az))]',
  },
  /** ST_Project(geog, metres, azimuth radians). */
  st_project: { params: ['p', 'm', 'az'], body: `__geo_destination(p, m / ${EARTH_RADIUS_M}, az)` },
  /** turf.destination(point, kilometres, bearing degrees). */
  destination: {
    params: ['p', 'km', 'deg'],
    body: `__geo_destination(p, km / ${EARTH_RADIUS_M / 1000}, radians(deg))`,
  },

  // Great-circle midpoint, the direct formula (turf goes through distance and destination,
  // which lands on the same point with three times the trigonometry).
  __geo_bx: { params: ['a', 'b'], body: 'cos(radians(b.y)) * cos(radians(b.x - a.x))' },
  __geo_by: { params: ['a', 'b'], body: 'cos(radians(b.y)) * sin(radians(b.x - a.x))' },
  midpoint: {
    params: ['a', 'b'],
    body:
      '[degrees(radians(a.x) + atan2(__geo_by(a, b), cos(radians(a.y)) + __geo_bx(a, b))), ' +
      'degrees(atan2(sin(radians(a.y)) + sin(radians(b.y)), sqrt(' +
      '(cos(radians(a.y)) + __geo_bx(a, b)) * (cos(radians(a.y)) + __geo_bx(a, b)) + ' +
      '__geo_by(a, b) * __geo_by(a, b))))]',
  },

  // Web Mercator normalized to [-0.5, 0.5], the `project` node's space. The text is the
  // project sugar's, character for character, so the sugar can call these and plan the same.
  mercator_x: { params: ['lng'], body: 'lng / 360.0' },
  mercator_y: { params: ['lat'], body: `ln(tan(0.7853981634 + lat * ${HALF_DEG})) / 6.283185307` },

  // EPSG:3857 metres, as turf's toMercator / toWgs84. Latitude is clamped where the projection
  // is square, as turf clamps. Longitude is not wrapped, which turf does for |lng| > 180.
  // Written componentwise: `[x, y] * R` would put a vector below the root and cost SQL.
  // In f32, y has an absolute floor of about a metre near the equator — `ln(1 + ε)` with
  // 1 + ε rounded to 2^-23 — and WGSL has no log1p to avoid it.
  to_mercator: {
    params: ['p'],
    body:
      `[${WEB_MERCATOR_RADIUS_M}.0 * radians(p.x), ` +
      `${WEB_MERCATOR_RADIUS_M}.0 * ln(tan(0.7853981633974483 + ` +
      `clamp(p.y, ${-WEB_MERCATOR_MAX_LAT}, ${WEB_MERCATOR_MAX_LAT}) * ${HALF_DEG}))]`,
  },
  toMercator: { params: ['p'], body: 'to_mercator(p)' },
  from_mercator: {
    params: ['p'],
    body:
      `[degrees(p.x / ${WEB_MERCATOR_RADIUS_M}.0), ` +
      `degrees(2.0 * atan(exp(p.y / ${WEB_MERCATOR_RADIUS_M}.0)) - 1.5707963267948966)]`,
  },
  toWgs84: { params: ['p'], body: 'from_mercator(p)' },

  /** Inclusive, and with no antimeridian handling: a box across ±180 needs two calls. */
  point_in_bbox: {
    params: ['p', 'minx', 'miny', 'maxx', 'maxy'],
    body: 'p.x >= minx && p.x <= maxx && p.y >= miny && p.y <= maxy',
  },
};

/**
 * The prelude every graph's registry starts from. Built once: parsing is the only cost, and
 * a `FunctionDef` is never mutated after it is made.
 */
export const GEO_PRELUDE: FunctionRegistry = buildRegistry(GEO_SPECS, new Map(), GEO_SOURCE_PREFIX);
