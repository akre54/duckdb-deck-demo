import { describe, it, expect, beforeAll } from 'vitest';
import {
  type Expr, parseExpr, enginesFor, toSql, SqlParams, toWgsl, wgslParamMember, toJs,
  inlineFunctions, simplifyExpr, GEO_PRELUDE,
} from '@noodles.gl/planner';
import {
  gpuDevice, duck, readBuffer, storageBuffer, emptyStorageBuffer, expectNoGpuError,
  isSoftwareAdapter,
} from './harness.js';

/**
 * The claim this project rests on, finally executed.
 *
 * `agreement.test.ts` in Node runs the JS backend against hand-computed values and checks the
 * other two only compile. That leaves the load-bearing assertion — that one IR produces the
 * *same numbers* through DuckDB, through WGSL and through JS — untested on the engines that
 * matter. Here all three actually run over the same inputs and are compared element-wise.
 *
 * Tolerance is f32-scale: the GPU computes in f32 and DuckDB in f64, so exact equality is the
 * wrong assertion. Anything looser than ~1e-4 relative would hide a real disagreement.
 */

const COLUMNS = ['a', 'b', 'c'] as const;
type ColumnName = (typeof COLUMNS)[number];

/** Inputs chosen to exercise sign, magnitude and the awkward values. */
const INPUTS: Record<ColumnName, number[]> = {
  a: [1, 2.5, 10, 0.5, 100, 7, 0.001, 64],
  b: [3, 0.5, 4, 2, 25, 3, 1000, 8],
  c: [-2, 1, 0.25, 8, 0.1, -5, 12, 2],
};
const ROWS = INPUTS.a.length;

/**
 * Expressions every backend claims to support. Each must produce identical results.
 * Deliberately includes the ones where the backends' spellings genuinely diverge — `min`/`max`
 * become `least`/`greatest`, `ln` becomes `log`, and `%` is a hand-written polyfill in WGSL.
 */
const PORTABLE = [
  'a + b',
  'a - b * c',
  'a / b',
  'sqrt(a)',
  'abs(c)',
  'min(a, b)',
  'max(a, b)',
  'ln(a)',
  'log2(b)',
  'exp(c)',
  'pow(a, 2)',
  'floor(a * 1.7)',
  'ceil(a * 1.7)',
  'round(a * 1.7)',
  'sign(c)',
  'clamp(a, 1, 10)',
  'fit(a, 0, 100, 0, 1)',
  'lerp(a, b, 0.25)',
  'a % b',
  'c % b',
  'sin(a)',
  'cos(a)',
  'atan2(a, b)',
  'a > b ? a : b',
  'a > b ? 1 : 0',
  '(a > b) * 2 + 1',
  'fit(ln(a), 0, 5, 1, 9)',
  'clamp(fit(ln(a), 0, 5, 0, 1), 0, 1)',
  '-a + min(b, c)',
];

let device: GPUDevice;

beforeAll(async () => {
  device = await gpuDevice();
  const sql = await duck();
  // Columns are explicitly DOUBLE. Left to inference, DuckDB picks DECIMAL for literals like
  // 2.5, and Arrow returns a decimal as an *unscaled* integer — so `least(a, c)` came back as
  // -3000 instead of -3 and looked like a backend disagreement.
  await sql.exec(`
CREATE OR REPLACE TABLE vals AS
SELECT i::INTEGER AS i, a::DOUBLE AS a, b::DOUBLE AS b, c::DOUBLE AS c FROM (VALUES
${INPUTS.a.map((_, i) => `  (${i}, ${INPUTS.a[i]}, ${INPUTS.b[i]}, ${INPUTS.c[i]})`).join(',\n')}
) AS t(i, a, b, c);
`);
});

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

/**
 * Parse as `analyze` resolves an expression: with the geo prelude in scope, inlined, then
 * simplified. For anything that calls no prelude function this is exactly `parseExpr`.
 */
function parse(src: string): Expr {
  return simplifyExpr(inlineFunctions(parseExpr(src, { functions: GEO_PRELUDE }), GEO_PRELUDE));
}

/** Run the generated SQL in DuckDB and read the column back. */
async function viaSql(src: string, params: Record<string, number> = {}): Promise<number[]> {
  const bind = new SqlParams();
  const emitted = toSql(parse(src), bind);
  const binds = bind.order.map((name) => params[name] ?? 0);
  const sql = await duck();
  // ::DOUBLE so the result is never a DECIMAL, which Arrow reports unscaled.
  const { table } = await sql.run(
    `SELECT (${emitted.code})::DOUBLE AS v FROM vals ORDER BY i`,
    binds,
  );
  return (table.toArray() as { v: number }[]).map((r) => Number(r.v));
}

/** Compile the expression into a compute kernel, dispatch it, and read the buffer back. */
async function viaWgsl(src: string, params: Record<string, number> = {}): Promise<number[]> {
  const emitted = toWgsl(parse(src), (name) => ({ code: `b_${name}[i]`, width: 1 }));
  const paramList = emitted.params;

  const paramDecl = paramList.length
    ? `struct Params {\n${paramList.map((p) => `  ${wgslParamMember(p)}: f32,`).join('\n')}\n};\n@group(0) @binding(0) var<uniform> params: Params;`
    : '@group(0) @binding(0) var<uniform> params: vec4<f32>;';

  const readDecls = COLUMNS.map(
    (name, slot) => `@group(0) @binding(${slot + 2}) var<storage, read> b_${name}: array<f32>;`,
  );

  const code = `
${paramDecl}
@group(0) @binding(1) var<uniform> rowInfo: vec4<u32>;
${readDecls.join('\n')}
@group(0) @binding(${COLUMNS.length + 2}) var<storage, read_write> out_v: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= rowInfo.x) { return; }
  out_v[i] = ${emitted.code};
}
`;

  return expectNoGpuError(device, async () => {
    const module = device.createShaderModule({ code });

    // An explicit layout, not `layout: 'auto'`. Auto layout prunes bindings the shader does
    // not reference, so an expression that ignores one of the input columns — or takes no
    // parameters — produces a layout without those slots, and the bind group is then rejected
    // for supplying entries that "do not exist".
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ...COLUMNS.map((_, i) => ({
          binding: i + 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' as const },
        })),
        {
          binding: COLUMNS.length + 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' as const },
        },
      ],
    });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'main' },
    });

    const paramData = new Float32Array(Math.max(4, paramList.length));
    paramList.forEach((p, i) => { paramData[i] = params[p] ?? 0; });
    const paramBuffer = device.createBuffer({
      size: paramData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(paramBuffer, 0, paramData as unknown as GPUAllowSharedBufferSource);

    const info = device.createBuffer({
      size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(info, 0, new Uint32Array([ROWS, 0, 0, 0]) as unknown as GPUAllowSharedBufferSource);

    const inputs = COLUMNS.map((name) => storageBuffer(device, new Float32Array(INPUTS[name]), name));
    const output = emptyStorageBuffer(device, ROWS, 'out');

    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: paramBuffer } },
        { binding: 1, resource: { buffer: info } },
        ...inputs.map((buffer, i) => ({ binding: i + 2, resource: { buffer } })),
        { binding: COLUMNS.length + 2, resource: { buffer: output } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(ROWS / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);

    const result = [...(await readBuffer(device, output, ROWS))];
    for (const b of inputs) b.destroy();
    output.destroy();
    paramBuffer.destroy();
    info.destroy();
    return result;
  });
}

/** Run the generated JS. */
function viaJs(src: string, params: Record<string, number> = {}): number[] {
  const emitted = toJs(parse(src), (name) => ({
    width: 1, component: () => `cols.${name}[i]`,
  }));
  const fn = new Function(
    'cols', 'p', 'rows',
    `const out = []; for (let i = 0; i < rows; i++) out.push(${emitted.components[0]}); return out;`,
  ) as (cols: Record<string, number[]>, p: Record<string, number>, rows: number) => number[];
  return fn(INPUTS, params, ROWS);
}

/**
 * f32-scale comparison: relative for large values, absolute near zero. `floor` is that
 * absolute part, for a result whose f32 error does not shrink with its magnitude.
 */
function expectClose(
  actual: number[],
  expected: number[],
  label: string,
  floor = 1e-4,
  relative = 1e-4,
): void {
  expect(actual, `${label} length`).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    const a = actual[i];
    if (Number.isNaN(e)) {
      expect(Number.isNaN(a), `${label}[${i}] should be NaN`).toBe(true);
      continue;
    }
    const tolerance = Math.max(floor, Math.abs(e) * relative);
    expect(Math.abs(a - e), `${label}[${i}]: got ${a}, want ${e}`).toBeLessThan(tolerance);
  }
}

// ---------------------------------------------------------------------------

describe('all three backends compute the same numbers', () => {
  it('the harness itself works', async () => {
    // If this fails, every comparison below is meaningless.
    expect(await viaSql('a')).toEqual(INPUTS.a);
    expectClose(await viaWgsl('a'), INPUTS.a, 'wgsl identity');
    expect(viaJs('a')).toEqual(INPUTS.a);
  });

  it.each(PORTABLE)('%s', async (src) => {
    const engines = enginesFor(parseExpr(src));
    expect(engines.has('sql'), `${src} should be SQL-expressible`).toBe(true);
    expect(engines.has('gpu'), `${src} should be GPU-expressible`).toBe(true);

    const js = viaJs(src);
    const sql = await viaSql(src);
    const wgsl = await viaWgsl(src);

    // JS is the reference because it is the one executable in Node and therefore the one the
    // unit suite pins against hand-computed values.
    expectClose(sql, js, `${src} sql vs js`);
    expectClose(wgsl, js, `${src} wgsl vs js`);
  });
});

describe('parameters bind identically across backends', () => {
  const params = { lo: 2, hi: 20, k: 1.5 };

  it.each([
    'a * {{k}}',
    'fit(a, {{lo}}, {{hi}}, 0, 1)',
    'clamp(a, {{lo}}, {{hi}})',
    // The case that exposed the placeholder bug: fit repeats its domain-low argument, so the
    // SQL text contains more placeholders than there are binds.
    'clamp(fit(ln(a), {{lo}}, {{hi}}, 0, {{k}}), 0, {{k}})',
  ])('%s', async (src) => {
    const js = viaJs(src, params);
    expectClose(await viaSql(src, params), js, `${src} sql`);
    expectClose(await viaWgsl(src, params), js, `${src} wgsl`);
  });

  it('a parameter named after a WGSL reserved word still works end to end', async () => {
    // The Node suite proves the emitted struct member is prefixed; this proves the shader
    // actually compiles and computes with it.
    const src = 'a * {{type}}';
    const withReserved = { type: 3 };
    expectClose(await viaWgsl(src, withReserved), viaJs(src, withReserved), 'reserved param');
  });
});

describe('divergences that are known and deliberate', () => {
  it('WGSL float modulo follows floor semantics, and JS matches it', async () => {
    // JS's own `%` truncates toward zero and would disagree for negatives. The JS backend
    // implements the floor-based form on purpose; this proves both agree on real engines.
    const src = 'c % b';
    const js = viaJs(src);
    const wgsl = await viaWgsl(src);
    expectClose(wgsl, js, 'floor modulo');
    // And it genuinely differs from naive JS `%` for the negative inputs.
    const naive = INPUTS.c.map((c, i) => c % INPUTS.b[i]);
    const differs = js.some((v, i) => Math.abs(v - naive[i]) > 1e-6);
    expect(differs, 'inputs should include a negative case').toBe(true);
  });

  it('integer division does not truncate in SQL', async () => {
    // Bare integer literals make DuckDB infer INTEGER, so `1 / 2` would be 0. The SQL backend
    // forces float literals to prevent it.
    expectClose(await viaSql('a / 4'), viaJs('a / 4'), 'float division');
    const { table } = await (await duck()).run('SELECT 1 / 2 AS naive');
    // Confirms the hazard is real, so the guard is not superstition.
    expect(Number((table.toArray() as { naive: number }[])[0].naive)).toBeCloseTo(0.5, 6);
  });
});

/**
 * Relative tolerance for the geo prelude on the GPU.
 *
 * WGSL allows sin and cos up to 2^-11 absolute error and atan2 4096 ULP. Metal comes in far
 * under that and holds 1e-4. SwiftShader, which CI runs on, measured 1-2e-4 per call, and a
 * geo function chains several: a distance came in at 1.25e-4 and a midpoint at 2.8e-4. So
 * 5e-4 on SwiftShader, which is platform error and not slack: a wrong formula is off by more.
 * Before `__geo_destination`'s longitude was reconditioned this needed 2e-3, and that was
 * hiding a 1.3% error in a 25 km move at 80° N. If a SwiftShader-only failure wants this
 * raised, find the cancellation first.
 */
function geoRelative(): number {
  return isSoftwareAdapter(device) ? 5e-4 : 1e-4;
}

describe('the geo prelude computes the same numbers on all three', () => {
  // Points made from the three columns, so every row is a different pair and both signs of
  // Δlat and Δlng occur: a = 0.001..100, b = 0.5..1000, c = -5..12. The old hand-written
  // haversine squared with `pow(sin(Δ), 2.0)`, which WGSL leaves undefined for a negative
  // base; half of these rows have one.
  const A = '[c * 10.0, a * 0.8]';
  const B = '[b * 0.17 - 80.0, c * 6.0]';

  it.each([
    `distance(${A}, ${B})`,
    `st_distance_sphere(${A}, ${B}) / 1000.0`,
    `st_dwithin(${A}, ${B}, 5000000.0)`,
    `bearing(${A}, ${B})`,
    `st_azimuth(${A}, ${B})`,
    `st_x(destination(${A}, b, c * 30.0))`,
    `st_y(destination(${A}, b, c * 30.0))`,
    `st_x(midpoint(${A}, ${B}))`,
    `st_y(midpoint(${A}, ${B}))`,
    `st_y(to_mercator(${A})) / 1000.0`,
    `mercator_y(a * 0.8)`,
  ])('%s', async (src) => {
    // EPSG:3857 y near the equator is `R * ln(1 + ε)`, and f32 cannot hold 1 + ε to better
    // than R * 2^-23 ≈ 0.8 m: an absolute floor of a metre or two however small y is, found
    // at lat 0.0008° where the GPU read 90.5 m against 89.1 m.
    const floor = src.includes('to_mercator') ? 0.005 : 1e-4;
    const engines = enginesFor(parse(src));
    expect([...engines].sort(), `${src} engines`).toEqual(['gpu', 'sql']);

    const js = viaJs(src);
    const sql = await viaSql(src);
    const wgsl = await viaWgsl(src);
    expect(js.some(Number.isNaN), `${src} js NaN`).toBe(false);
    expectClose(sql, js, `${src} sql vs js`);
    // f32 on the GPU: 1e-4 relative is ~1 km on a 10,000 km distance and 0.02° on a bearing,
    // which is the f32 floor for inputs this size, not slack. See `geoRelative` for SwiftShader.
    expectClose(wgsl, js, `${src} wgsl vs js`, floor, geoRelative());
  });
});

describe('constant geometries compute the same numbers on all three', () => {
  // Points from the columns, spread over the polygon, its hole and outside:
  // (−0.62, 2.68) in, (0.31, 2.2) hole, (0.08, −0.09) in, (2.48, 1.96) in, (0.03, −0.01) in,
  // (−1.55, 2.31) out, (3.72, 1.0) out, (0.62, 2.84) above the hole. None is within f32 reach
  // of an edge.
  const P = '[c * 0.31, sin(a) * 2.0 + 1.0]';
  const RING = "'POLYGON((-1 -0.5, 3 -0.5, 3 3, -1 3, -1 -0.5), (0 0.5, 1 0.5, 1 2.5, 0 2.5, 0 0.5))'";
  const LINE = "'LINESTRING(-2 0, 0 1, 2 1.5, 4 0)'";

  it.each([
    `st_contains(${RING}, ${P})`,
    `st_distance(${RING}, ${P})`,
    `st_distance(${LINE}, ${P})`,
    `st_distance('MULTIPOINT(0 0, 3 3)', ${P})`,
    `st_dwithin(${P}, ${LINE}, 60000.0)`,
    `st_x(along(${LINE}, a * 5.0))`,
    `st_y(along(${LINE}, a * 5.0))`,
  ])('%s', async (src) => {
    expect([...enginesFor(parse(src))].sort(), `${src} engines`).toEqual(['gpu', 'sql']);
    const js = viaJs(src);
    expectClose(await viaSql(src), js, `${src} sql vs js`);
    // f32: 1e-4 relative is ~10 m on these distances, and 1e-4° on a position.
    expectClose(await viaWgsl(src), js, `${src} wgsl vs js`, 1e-4, geoRelative());
  });

  it('classifies the rows as expected', () => {
    expect(viaJs(`st_contains(${RING}, ${P})`).map(Number)).toEqual([1, 0, 1, 1, 1, 0, 0, 1]);
  });
});
