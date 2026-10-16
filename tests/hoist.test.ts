import { describe, it, expect, beforeAll } from 'vitest';
import {
  compileProgram, targetCaps, HOIST_PREFIX, type Graph, type ProgramPlan, type LayerPlan,
} from '@noodles.gl/planner';
import { MaterializingCatalog } from '../src/program/catalog.js';
import { queryLayer } from '../src/program/execute.js';
import { openNodeDuck, type NodeDuck } from './duckdb-node.js';

/**
 * Hoisting through a program, executed. The unit tests show what is lifted; this shows that
 * what DuckDB then computes with the derived bind is what it computed without one, and that
 * nothing outside the plan ever sees a `__hoist_` name.
 */

const SITES = `code,lng,lat
JFK,-73.78,40.64
BOS,-71.01,42.36
LHR,-0.45,51.47
SYD,151.18,-33.95
`;

/** turf.distance, independently. */
function km(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 6371.0088;
}

function centred(): Graph {
  return {
    params: {
      lng0: { value: -73.97, changeRate: 60 },
      lat0: { value: 40.78, changeRate: 60 },
    },
    nodes: [
      { id: 'sites', type: 'source', dataset: { ref: 'sites' }, file: { format: 'csv', url: 'sites.csv' } },
      { id: 'd', type: 'attribute', input: 'sites', name: 'km', expr: 'distance([lng, lat], [{{lng0}}, {{lat0}}])' },
      { id: 'pos', type: 'project', input: 'd', mode: 'identity', x: 'lng', y: 'lat' },
      { id: 'dots', type: 'layer', kind: 'scatter', input: 'pos', channels: { radius: 'km' }, orderBy: ['code'] },
      { id: 'deck', type: 'deck', inputs: ['dots'], view: { longitude: 0, latitude: 0, zoom: 1 } },
    ],
  };
}

let duck: NodeDuck;
let program: ProgramPlan;
let dots: LayerPlan;
beforeAll(async () => {
  duck = await openNodeDuck();
  duck.registerText('sites.csv', SITES);
  // sql-first, so the hoisted factor is a SQL bind and DuckDB does the arithmetic around it.
  program = await compileProgram(centred(), new MaterializingCatalog(duck), {
    caps: targetCaps('deck-webgl2', undefined), policy: 'sql-first',
  });
  dots = program.layers.find((l) => l.id === 'dots')!;
}, 30_000);

describe('a hoisted parameter in a program', () => {
  it('is a bind of the layer query, and not a parameter of the program', () => {
    expect(program.errors).toEqual([]);
    expect(dots.plan.derived).toHaveLength(1);
    expect(dots.plan.sqlParams).toContain(dots.plan.derived[0].name);
    expect(Object.keys(program.params).some((p) => p.startsWith(HOIST_PREFIX))).toBe(false);
  });

  it('routes under the parameter it is computed from', () => {
    expect(Object.keys(program.routes).some((p) => p.startsWith(HOIST_PREFIX))).toBe(false);
    expect(program.routes.lat0).toEqual([{ route: 'requery', target: 'dots' }]);
    expect(program.routes.lng0).toEqual([{ route: 'requery', target: 'dots' }]);
  });

  it('queries the same distances as the formula, for the default and a moved centre', async () => {
    for (const [lng0, lat0] of [[-73.97, 40.78], [2.35, 48.86]]) {
      const q = await queryLayer(duck, dots, { lng0, lat0 });
      const got = q.uploads.get('km')!;
      const data = got.data ?? Float32Array.from(got.chunks!.flatMap((c) => [...c]));
      const sites = SITES.trim().split('\n').slice(1).map((l) => l.split(','));
      sites.sort(([a], [b]) => (a < b ? -1 : 1));
      sites.forEach(([, lng, lat], i) => {
        // Read back as f32 from a DOUBLE computation.
        expect(data[i]).toBeCloseTo(km(Number(lng), Number(lat), lng0, lat0), 2);
      });
    }
  });
});
