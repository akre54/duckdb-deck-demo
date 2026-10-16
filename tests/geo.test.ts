import { describe, it, expect, beforeAll } from 'vitest';
import {
  type Expr, parseExpr, inlineFunctions, simplifyExpr, toSqlColumns, castToDouble, toJs, GEO_PRELUDE,
} from '@noodles.gl/planner';
import { openNodeDuck, type NodeDuck } from './duckdb-node.js';

/**
 * The geo prelude, executed in DuckDB and compared with the JS backend. Node can only prove
 * the SQL *compiles* by looking at it; this runs it. Both sides are f64, so they must agree to
 * rounding — a disagreement is a semantic difference between backends (argument order of
 * `atan2`, `%` on negatives, `least`/`greatest` for clamp), not precision.
 */

const resolve = (src: string): Expr =>
  simplifyExpr(inlineFunctions(parseExpr(src, { functions: GEO_PRELUDE }), GEO_PRELUDE));

function js(e: Expr, row: Record<string, number>): number[] {
  const emitted = toJs(e, (name) => ({ width: 1, component: () => `c.${name}` }));
  const fn = new Function('c', 'p', `return [${emitted.components.join(', ')}];`) as (
    c: Record<string, number>, p: Record<string, number>,
  ) => number[];
  return fn(row, {}).map(Number);
}

/** Pairs chosen to cross the antimeridian, the equator and both hemispheres' signs. */
const ROWS = [
  { lng1: -73.78, lat1: 40.64, lng2: -71.01, lat2: 42.37, km: 300, deg: 45 },
  { lng1: 179.5, lat1: -16.9, lng2: -178.2, lat2: -18.1, km: 50, deg: -120 },
  { lng1: 0, lat1: 0, lng2: 180, lat2: 0, km: 20000, deg: 90 },
  { lng1: 151.2, lat1: -33.9, lng2: -0.1, lat2: 51.5, km: 10, deg: 179 },
  { lng1: -122.4, lat1: 37.8, lng2: -122.4, lat2: 37.8, km: 0, deg: 0 },
];
const COLS = ['lng1', 'lat1', 'lng2', 'lat2', 'km', 'deg'] as const;
const VALUES = ROWS.map(
  (r, i) => `(${i}, ${COLS.map((c) => `CAST(${r[c]} AS DOUBLE)`).join(', ')})`,
).join(', ');

const CASES = [
  'distance([lng1, lat1], [lng2, lat2])',
  'st_distance_sphere([lng1, lat1], [lng2, lat2])',
  'st_dwithin([lng1, lat1], [lng2, lat2], 400000.0)',
  'bearing([lng1, lat1], [lng2, lat2])',
  'st_azimuth([lng1, lat1], [lng2, lat2])',
  'destination([lng1, lat1], km, deg)',
  'st_project([lng1, lat1], km * 1000.0, radians(deg))',
  'midpoint([lng1, lat1], [lng2, lat2])',
  'to_mercator([lng1, lat1])',
  'from_mercator(to_mercator([lng1, lat1]))',
  '[mercator_x(lng1), mercator_y(lat1)]',
  'point_in_bbox([lng1, lat1], -180.0, -20.0, 0.0, 45.0)',
];

let duck: NodeDuck;
beforeAll(async () => { duck = await openNodeDuck(); });

describe('geo prelude in DuckDB', () => {
  it.each(CASES)('%s agrees with the JS backend', async (src) => {
    const e = resolve(src);
    // Selected the way a layer query selects an attribute, but kept in DOUBLE: a FLOAT cast
    // would make this a precision test instead of a semantics one.
    const { items } = toSqlColumns(e, e.kind === 'vec' ? 'v' : 'v_0', undefined, castToDouble);
    const rows = await duck.rows(
      `SELECT ${items.join(', ')} FROM (VALUES ${VALUES}) t(i, ${COLS.join(', ')}) ORDER BY i`,
    );
    ROWS.forEach((row, i) => {
      const want = js(e, row);
      want.forEach((w, c) => {
        const got = Number(rows[i][`v_${c}`]);
        // Bearing between identical points is atan2(0, 0): both sides say 0, which is
        // what keeps this row in rather than skipped.
        expect(Math.abs(got - w), `${src} row ${i} component ${c}: sql ${got}, js ${w}`)
          .toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(w)));
      });
    });
  });
});

/**
 * Constant geometries, expanded: the same comparison over points around the literals, some on
 * a vertex or an edge, where a backend that tested `<` for `<=` would split from the others.
 */
const MANHATTAN = 'POLYGON((-74.02 40.70, -73.93 40.70, -73.91 40.80, -73.97 40.88, -74.01 40.76, -74.02 40.70), ' +
  '(-73.99 40.74, -73.96 40.74, -73.96 40.77, -73.99 40.77, -73.99 40.74))';
const ROUTE = 'LINESTRING(-122.42 37.77, -122.40 37.79, -122.39 37.80, -122.27 37.80)';
const PLACES = [
  { lng: -73.95, lat: 40.75, km: 0 },
  { lng: -73.975, lat: 40.755, km: 1.5 }, // in the hole
  { lng: -73.93, lat: 40.70, km: 2.8 }, // on a vertex
  { lng: -73.97, lat: 40.70, km: 4.2 }, // on the horizontal edge
  { lng: -74.2, lat: 40.5, km: 14.7 },
  { lng: -122.35, lat: 37.9, km: 9 },
  { lng: -122.41, lat: 37.78, km: 30 },
];
const PLACE_COLS = ['lng', 'lat', 'km'] as const;
const PLACE_VALUES = PLACES.map(
  (r, i) => `(${i}, ${PLACE_COLS.map((c) => `CAST(${r[c]} AS DOUBLE)`).join(', ')})`,
).join(', ');
const GEOMETRY_CASES = [
  `st_contains('${MANHATTAN}', [lng, lat])`,
  `st_intersects([lng, lat], 'MULTIPOLYGON(((-74 40.6, -73.9 40.6, -73.95 40.8, -74 40.6)), ((-122.5 37.7, -122.3 37.7, -122.3 37.9, -122.5 37.9, -122.5 37.7)))')`,
  `st_distance('${MANHATTAN}', [lng, lat])`,
  `st_distance('${ROUTE}', [lng, lat])`,
  `st_distance('MULTIPOINT(-73.97 40.78, -122.42 37.77)', [lng, lat])`,
  `st_dwithin([lng, lat], '${ROUTE}', 5000.0)`,
  `along('${ROUTE}', km)`,
  `st_lineinterpolatepoint('${ROUTE}', km / 20.0)`,
];

describe('constant geometries in DuckDB', () => {
  it.each(GEOMETRY_CASES)('%s agrees with the JS backend', async (src) => {
    const e = resolve(src);
    const { items } = toSqlColumns(e, e.kind === 'vec' ? 'v' : 'v_0', undefined, castToDouble);
    const rows = await duck.rows(
      `SELECT ${items.join(', ')} FROM (VALUES ${PLACE_VALUES}) t(i, ${PLACE_COLS.join(', ')}) ORDER BY i`,
    );
    PLACES.forEach((row, i) => {
      js(e, row).forEach((w, c) => {
        const got = Number(rows[i][`v_${c}`]);
        expect(Math.abs(got - w), `${src.slice(0, 40)} row ${i} component ${c}: sql ${got}, js ${w}`)
          .toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(w)));
      });
    });
  });
});
