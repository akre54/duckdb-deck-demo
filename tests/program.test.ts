import { describe, it, expect, beforeAll } from 'vitest';
import {
  compileProgram, runStarts, readValues, targetCaps, hashOf, canonicalJson,
  type Graph, type ProgramPlan, type LayerPlan, type CompileOptions,
} from '@noodles.gl/planner';
import { MaterializingCatalog } from '../src/program/catalog.js';
import { openNodeDuck, type NodeDuck } from './duckdb-node.js';

/**
 * Programs, executed. Every assertion about rows is read back from DuckDB, because the ways
 * relational lowering goes wrong — a join on the wrong key, an unnest pairing a vertex with
 * another trip's timestamp — all produce SQL that runs.
 */

const AIRPORTS = `code,name,country,lng,lat
JFK,Kennedy,US,-73.78,40.64
LGA,LaGuardia,US,-73.87,40.78
BOS,Logan,US,-71.01,42.36
LHR,Heathrow,GB,-0.45,51.47
MAN,Manchester,GB,-2.27,53.35
CDG,De Gaulle,FR,2.55,49.01
`;
const ROUTES = `airline,src,dst
AA,JFK,BOS
AA,JFK,LHR
BA,LHR,MAN
BA,LHR,JFK
DL,LGA,BOS
AF,CDG,LHR
XX,JFK,ZZZ
`;

const caps = targetCaps('deck-webgl2', undefined);

/** The Joby "network" shape: sites joined into routes, filtered by length, drawn as arcs. */
function network(): Graph {
  return {
    params: {
      country: { value: 'US', kind: 'value' },
      maxKm: { value: 400, min: 0, max: 20000, changeRate: 8 },
      width: { value: 2, changeRate: 8 },
    },
    functions: {
      // Haversine in km. Written once, inlined wherever it is called.
      km: {
        params: ['lng1', 'lat1', 'lng2', 'lat2'],
        body: '12742.0 * asin(sqrt(pow(sin((lat2 - lat1) * 0.00872664626), 2.0) + cos(lat1 * 0.01745329252) * cos(lat2 * 0.01745329252) * pow(sin((lng2 - lng1) * 0.00872664626), 2.0)))',
      },
    },
    nodes: [
      { id: 'airports', type: 'source', dataset: { ref: 'airports' }, file: { format: 'csv', url: 'airports.csv' } },
      { id: 'routes', type: 'source', dataset: { ref: 'routes' }, file: { format: 'csv', url: 'routes.csv' } },
      { id: 'region', type: 'filter', input: 'airports', predicate: 'country == {{country}}' },
      { id: 'j1', type: 'join', input: 'routes', right: 'region', on: [['src', 'code']], prefix: 'o_' },
      { id: 'j2', type: 'join', input: 'j1', right: 'region', on: [['dst', 'code']], prefix: 'd_' },
      { id: 'dist', type: 'attribute', input: 'j2', name: 'km', expr: 'km(o_lng, o_lat, d_lng, d_lat)' },
      { id: 'short', type: 'filter', input: 'dist', predicate: 'km < {{maxKm}}' },
      { id: 'ends', type: 'wrangle', input: 'short', body: '@from = [o_lng, o_lat, 0.0];\n@to = [d_lng, d_lat, 0.0];' },
      {
        id: 'arcs', type: 'layer', kind: 'arc', input: 'ends',
        channels: { sourcePosition: 'from', targetPosition: 'to' }, props: { widthScale: '{{width}}' },
      },
      { id: 'pos', type: 'project', input: 'region', mode: 'identity', x: 'lng', y: 'lat' },
      { id: 'dots', type: 'layer', kind: 'scatter', input: 'pos' },
      { id: 'labels', type: 'layer', kind: 'text', input: 'pos', channels: { text: 'name' } },
      { id: 'deck', type: 'deck', inputs: ['dots', 'arcs', 'labels'], view: { longitude: -73, latitude: 41, zoom: 5 } },
    ],
  };
}

let duck: NodeDuck;
beforeAll(async () => {
  duck = await openNodeDuck();
  duck.registerText('airports.csv', AIRPORTS);
  duck.registerText('routes.csv', ROUTES);
}, 30_000);

/** Run a layer's query with its binds, as the runtime would. */
async function layerRows(p: ProgramPlan, id: string, values: Record<string, number | string> = {}) {
  const lp = p.layers.find((l) => l.id === id)!;
  const binds = lp.plan.sqlParams.map((name) => values[name] ?? p.params[name].value);
  return duck.rows(lp.plan.sql, binds);
}

const layer = (p: ProgramPlan, id: string): LayerPlan => {
  const lp = p.layers.find((l) => l.id === id);
  if (!lp) throw new Error(`no layer ${id}: ${JSON.stringify(p.errors)}`);
  return lp;
};

describe('the network program', () => {
  let catalog: MaterializingCatalog;
  let program: ProgramPlan;
  // sql-first so the assertions below can name the SQL. Under `cost`, two rows and a slider
  // dragged at 8/s correctly keep the distance filter on the CPU as a mask: see the last test.
  const opts = (extra: Partial<CompileOptions> = {}): CompileOptions => ({ caps, policy: 'sql-first', ...extra });

  beforeAll(async () => {
    catalog = new MaterializingCatalog(duck);
    program = await compileProgram(network(), catalog, opts());
  });

  it('compiles without errors, one plan per layer, in deck order', () => {
    expect(program.errors).toEqual([]);
    expect(program.draw).toEqual(['dots', 'arcs', 'labels']);
  });

  it('makes the filter a relation, because a join reads it', () => {
    const ids = program.relations.map((r) => r.id);
    // Declaration order, dependencies first.
    expect(ids).toEqual(['airports', 'routes', 'region', 'j1', 'j2']);
    const region = program.relations.find((r) => r.id === 'region')!;
    expect(region.kind).toBe('filter');
    // Read by both joins and two layers: materialized, and the string inlined as a literal.
    expect(region.materialize).toBe(true);
    expect(region.sql).toContain(`= 'US'`);
    expect(region.params).toEqual(['country']);
  });

  it('joins routes to their origin and destination, dropping unmatched codes', async () => {
    const rows = await duck.rows(`SELECT airline, src, dst, o_name, d_name FROM ${program.relations.find((r) => r.id === 'j2')!.ref} ORDER BY src, dst`);
    expect(rows).toEqual([
      { airline: 'AA', src: 'JFK', dst: 'BOS', o_name: 'Kennedy', d_name: 'Logan' },
      { airline: 'DL', src: 'LGA', dst: 'BOS', o_name: 'LaGuardia', d_name: 'Logan' },
    ]);
  });

  it('computes the haversine in the layer query and filters on it with a bind', async () => {
    const arcs = layer(program, 'arcs');
    expect(arcs.plan.sqlParams).toEqual(['maxKm']);
    const near = await layerRows(program, 'arcs', { maxKm: 250 });
    // LGA–BOS is ~296 km and JFK–BOS ~300 km; neither is under 250.
    expect(near).toHaveLength(0);
    const all = await layerRows(program, 'arcs', { maxKm: 400 });
    expect(all).toHaveLength(2);
    const bos = all.find((r) => Number(r.from_0) < -73.8)!;
    expect(Number(bos.km)).toBeGreaterThan(290);
    expect(Number(bos.km)).toBeLessThan(310);
  });

  it('forks one relation into two layers and reads the label as a string', async () => {
    expect(layer(program, 'dots').relation).toBe('region');
    expect(layer(program, 'labels').relation).toBe('region');
    const labels = await layerRows(program, 'labels');
    expect(labels.map((r) => r.name).sort()).toEqual(['Kennedy', 'LaGuardia', 'Logan']);
    expect(layer(program, 'labels').plan.attributes.find((a) => a.name === 'name')?.type).toBe('str');
  });

  it('routes each parameter to exactly what reads it', () => {
    expect(program.routes.country).toEqual([{ route: 'rematerialize', target: 'region' }]);
    expect(program.routes.maxKm).toEqual([{ route: 'requery', target: 'arcs' }]);
    expect(program.routes.width).toEqual([{ route: 'prop', target: 'arcs' }]);
  });

  it('reports columns at every node, for the editor', () => {
    const at = (id: string) => program.nodes[id].columns.map((c) => c.name);
    expect(at('j1')).toEqual(expect.arrayContaining(['airline', 'o_code', 'o_lat']));
    expect(at('dist')).toContain('km');
    expect(at('ends')).toEqual(expect.arrayContaining(['from', 'to']));
    expect(program.nodes.region.columns.find((c) => c.name === 'name')?.type).toBe('str');
    expect(program.nodes.dist.engines.arcs).toBe('sql');
  });

  it('memoizes: recompiling runs nothing, a changed value rebuilds only downstream', async () => {
    const before = { ...catalog.counters };
    const again = await compileProgram(network(), catalog, opts());
    expect(catalog.counters.materialized).toBe(before.materialized);
    expect(again.relations.map((r) => r.hash)).toEqual(program.relations.map((r) => r.hash));

    const gb = await compileProgram(network(), catalog, opts({ values: { country: 'GB' } }));
    // region, j1 and j2 are new; the two file sources are hits.
    expect(catalog.counters.materialized - before.materialized).toBe(3);
    const hash = (p: ProgramPlan, id: string) => p.relations.find((r) => r.id === id)!.hash;
    expect(hash(gb, 'airports')).toBe(hash(program, 'airports'));
    expect(hash(gb, 'region')).not.toBe(hash(program, 'region'));
    expect(await layerRows(gb, 'arcs', { maxKm: 1000 })).toHaveLength(1); // LHR–MAN

    // Back to US: every table still exists.
    const mid = catalog.counters.materialized;
    await compileProgram(network(), catalog, opts({ values: { country: 'US' } }));
    expect(catalog.counters.materialized).toBe(mid);
  });

  it('does not recompute anything when a node is renamed', async () => {
    const g = network();
    const renamed: Graph = JSON.parse(JSON.stringify(g).replaceAll('"region"', '"usa"'));
    const before = catalog.counters.materialized;
    const p = await compileProgram(renamed, catalog, opts());
    expect(p.errors).toEqual([]);
    expect(catalog.counters.materialized).toBe(before);
  });

  it('lets the cost model keep a dragged filter off SQL when the data is tiny', async () => {
    const p = await compileProgram(network(), catalog, { caps });
    expect(layer(p, 'arcs').plan.explain.method).toBe('cost');
    // A requery per slider tick costs more than masking two rows on the CPU.
    expect(p.routes.maxKm).toEqual([{ route: 'cpu', target: 'arcs' }]);
  });

  it('reuses a layer plan across value changes via the cache', async () => {
    const cache = new Map<string, LayerPlan>();
    const a = await compileProgram(network(), catalog, opts({ cache, values: { maxKm: 100 } }));
    const b = await compileProgram(network(), catalog, opts({ cache, values: { maxKm: 900 } }));
    expect(layer(b, 'arcs').plan).toBe(layer(a, 'arcs').plan);
  });
});

describe('trips: unnest to vertices, fork into a path layer and a grid aggregate', () => {
  const trips: Graph = {
    params: { cell: { value: 1, changeRate: 1 }, time: { value: 0, changeRate: 60 } },
    nodes: [
      {
        id: 'raw', type: 'sql',
        query: `SELECT * FROM (VALUES
          (7, [[0.2, 0.2], [0.4, 0.3], [1.5, 0.5]], [0.0, 10.0, 20.0]),
          (9, [[2.5, 2.5], [2.6, 2.7]], [5.0, 15.0])) AS t(vendor, path, timestamps)`,
      },
      {
        id: 'verts', type: 'unnest', input: 'raw', lists: ['path', 'timestamps'],
        split: { path: ['lng', 'lat'] }, as: { timestamps: 't' }, rowId: 'trip', index: 'k',
      },
      { id: 'pos', type: 'project', input: 'verts', mode: 'identity', x: 'lng', y: 'lat' },
      { id: 'trips', type: 'layer', kind: 'trips', input: 'pos', pathId: 'trip', orderBy: ['k'], channels: { timestamp: 't' }, props: { currentTime: '{{time}}' } },
      { id: 'ix', type: 'attribute', input: 'verts', name: 'ix', expr: 'floor(lng / {{cell}})' },
      { id: 'iy', type: 'attribute', input: 'ix', name: 'iy', expr: 'floor(lat / {{cell}})' },
      { id: 'bins', type: 'aggregate', input: 'iy', groupBy: ['ix', 'iy'], aggs: [{ name: 'n', expr: 'count()' }] },
      { id: 'cellpos', type: 'attribute', input: 'bins', name: 'P', expr: '[(ix + 0.5) * {{cell}}, (iy + 0.5) * {{cell}}, 0.0]' },
      { id: 'cols', type: 'layer', kind: 'column', input: 'cellpos', channels: { elevation: 'n' }, orderBy: ['ix', 'iy'] },
      { id: 'deck', type: 'deck', inputs: ['cols', 'trips'] },
    ],
  };

  let program: ProgramPlan;
  beforeAll(async () => {
    program = await compileProgram(trips, new MaterializingCatalog(duck), { caps });
  });

  it('pairs every vertex with its own timestamp', async () => {
    expect(program.errors).toEqual([]);
    const rows = await layerRows(program, 'trips');
    expect(rows.map((r) => [Number(r.trip), Number(r.t)])).toEqual([[1, 0], [1, 10], [1, 20], [2, 5], [2, 15]]);
  });

  it('produces startIndices from the raw path ids', async () => {
    const lp = layer(program, 'trips');
    const { table } = await duck.run(lp.plan.sql, lp.plan.sqlParams.map((p) => program.params[p].value));
    expect([...runStarts(readValues(table, 'trip'))]).toEqual([0, 3]);
    expect(program.routes.time).toEqual([{ route: 'prop', target: 'trips' }]);
  });

  it('aggregates on computed cell keys, which used to emit an invalid GROUP BY', async () => {
    const rows = await layerRows(program, 'cols');
    expect(rows.map((r) => [Number(r.ix), Number(r.iy), Number(r.n)])).toEqual([[0, 0, 2], [1, 0, 1], [2, 2, 2]]);
    const cheap = await layerRows(program, 'cols', { cell: 10 });
    expect(cheap.map((r) => Number(r.n))).toEqual([5]);
  });
});

describe('generate and cross join: interpolating arcs', () => {
  it('expands each flight into N vertices with interpolated positions', async () => {
    const g: Graph = {
      params: { steps: { value: 3 } },
      nodes: [
        { id: 'flights', type: 'sql', query: 'SELECT * FROM (VALUES (1, 0.0, 0.0, 10.0, 20.0, 100.0, 200.0)) AS f(id, lng1, lat1, lng2, lat2, time1, time2)' },
        { id: 'steps', type: 'generate', count: '{{steps}}', name: 's' },
        { id: 'x', type: 'join', input: 'flights', right: 'steps', how: 'cross' },
        {
          id: 'interp', type: 'wrangle', input: 'x',
          body: 'var u = s / ({{steps}} - 1.0);\n@P = [lerp(lng1, lng2, u), lerp(lat1, lat2, u), 0.0];\n@t = lerp(time1, time2, u);',
        },
        { id: 'trail', type: 'layer', kind: 'trips', input: 'interp', pathId: 'id', orderBy: ['s'], channels: { timestamp: 't' } },
      ],
    };
    const p = await compileProgram(g, new MaterializingCatalog(duck), { caps, policy: 'sql-first' });
    expect(p.errors).toEqual([]);
    expect(p.routes.steps.map((r) => r.route).sort()).toEqual(['rematerialize', 'requery']);
    const rows = await layerRows(p, 'trail');
    expect(rows.map((r) => [Number(r.P_0), Number(r.P_1), Number(r.t)])).toEqual([[0, 0, 100], [5, 10, 150], [10, 20, 200]]);
  });
});

describe('errors stay on the node that caused them', () => {
  it('rejects merging two row sets without a join', async () => {
    const g: Graph = {
      nodes: [
        { id: 'a', type: 'sql', query: 'SELECT 1.0 AS x, 2.0 AS y' },
        { id: 'b', type: 'sql', query: 'SELECT 3.0 AS x, 4.0 AS y' },
        { id: 'm', type: 'attribute', input: 'a', inputs: ['a', 'b'], name: 'P', expr: '[x, y, 0.0]' },
        { id: 'l', type: 'layer', kind: 'scatter', input: 'm' },
      ],
    };
    const p = await compileProgram(g, new MaterializingCatalog(duck), { caps });
    expect(p.errors[0]).toMatchObject({ nodeId: 'l' });
    expect(p.errors[0].message).toMatch(/two different row sets/);
  });

  it('rejects a GPU-only node ahead of a join, and still compiles the other layers', async () => {
    const g: Graph = {
      nodes: [
        { id: 'a', type: 'sql', query: 'SELECT 1.0 AS k, 0.5 AS v' },
        { id: 'c', type: 'colorscale', input: 'a', expr: 'v', ramp: 'viridis', domain: ['0', '1'] },
        { id: 'j', type: 'join', input: 'c', right: 'a', on: [['k', 'k']], prefix: 'r_' },
        { id: 'p1', type: 'attribute', input: 'j', name: 'P', expr: '[k, v, 0.0]' },
        { id: 'bad', type: 'layer', kind: 'scatter', input: 'p1' },
        { id: 'p2', type: 'attribute', input: 'a', name: 'P', expr: '[k, v, 0.0]' },
        { id: 'good', type: 'layer', kind: 'scatter', input: 'p2' },
      ],
    };
    const p = await compileProgram(g, new MaterializingCatalog(duck), { caps });
    expect(p.nodes.c.error).toMatch(/must run in SQL/);
    expect(p.nodes.bad.error).toMatch(/failed/);
    expect(p.layers.map((l) => l.id)).toEqual(['good']);
  });

  it('names the ambiguity when a join would shadow a column', async () => {
    const g: Graph = {
      nodes: [
        { id: 'a', type: 'sql', query: 'SELECT 1.0 AS k' },
        { id: 'j', type: 'join', input: 'a', right: 'a', on: [['k', 'k']] },
        { id: 'p', type: 'attribute', input: 'j', name: 'P', expr: '[k, k, 0.0]' },
        { id: 'l', type: 'layer', kind: 'scatter', input: 'p' },
      ],
    };
    const p = await compileProgram(g, new MaterializingCatalog(duck), { caps });
    expect(p.nodes.j.error).toMatch(/Set 'prefix'/);
  });
});

describe('structural hashing', () => {
  it('ignores key order and undefined fields, and distinguishes values', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
    expect(hashOf({ a: NaN })).not.toBe(hashOf({ a: null }));
    expect(hashOf('x')).toMatch(/^[0-9a-f]{16}$/);
  });
});
