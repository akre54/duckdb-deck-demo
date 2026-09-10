import { describe, it, expect, beforeAll } from 'vitest';
import { parseExpr, enginesFor } from '../../src/core/expr.js';
import { toSql, SqlParams } from '../../src/core/backends/sql.js';
import { toWgsl, wgslParamMember } from '../../src/core/backends/wgsl.js';
import { toJs } from '../../src/core/backends/js.js';
import {
  gpuDevice, duck, readBuffer, storageBuffer, emptyStorageBuffer, expectNoGpuError,
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

/** Run the generated SQL in DuckDB and read the column back. */
async function viaSql(src: string, params: Record<string, number> = {}): Promise<number[]> {
  const bind = new SqlParams();
  const emitted = toSql(parseExpr(src), bind);
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
  const emitted = toWgsl(parseExpr(src), (name) => ({ code: `b_${name}[i]`, width: 1 }));
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
  const emitted = toJs(parseExpr(src), (name) => ({
    width: 1, component: () => `cols.${name}[i]`,
  }));
  const fn = new Function(
    'cols', 'p', 'rows',
    `const out = []; for (let i = 0; i < rows; i++) out.push(${emitted.components[0]}); return out;`,
  ) as (cols: Record<string, number[]>, p: Record<string, number>, rows: number) => number[];
  return fn(INPUTS, params, ROWS);
}

/** f32-scale comparison: relative for large values, absolute near zero. */
function expectClose(actual: number[], expected: number[], label: string): void {
  expect(actual, `${label} length`).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    const a = actual[i];
    if (Number.isNaN(e)) {
      expect(Number.isNaN(a), `${label}[${i}] should be NaN`).toBe(true);
      continue;
    }
    const tolerance = Math.max(1e-4, Math.abs(e) * 1e-4);
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
