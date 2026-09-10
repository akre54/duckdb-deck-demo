import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

/**
 * The standing guard on the packaging.
 *
 * Subpath exports only mean anything if the layers actually respect each other: a consumer
 * importing the headless core must not end up with deck.gl, luma, duckdb-wasm or a
 * `GPUDevice` requirement in their dependency graph. That is an easy invariant to break with
 * one convenient import and impossible to notice by reading a diff, so it is asserted here
 * rather than documented and hoped for.
 */

const ROOT = resolve(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((entry) => {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) return walk(rel);
    return rel.endsWith('.ts') ? [rel] : [];
  });
}

/** Static import/export specifiers in a file, module paths only. */
function importsOf(relPath: string): string[] {
  const source = readFileSync(join(ROOT, relPath), 'utf8');
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1] ?? match[2]);
  }
  return specifiers;
}

/** Resolve a relative specifier to a repo-relative path, ignoring bare package names. */
function resolveLocal(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return relative(ROOT, resolve(ROOT, dirname(fromFile), specifier)).replace(/\\/g, '/');
}

const LIB_FILES = walk('src').filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.bench.ts'));
const CORE_FILES = LIB_FILES.filter((f) => f.startsWith('src/core/'));

describe('layer boundaries', () => {
  it('core imports nothing from webgpu, duckdb, deck or the demo', () => {
    const violations: string[] = [];
    for (const file of CORE_FILES) {
      for (const specifier of importsOf(file)) {
        const target = resolveLocal(file, specifier);
        if (!target) continue;
        if (!target.startsWith('src/core/')) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('core depends on no package other than apache-arrow', () => {
    // Anything else would land in a consumer's graph just for using the planner.
    const allowed = new Set(['apache-arrow']);
    const violations: string[] = [];
    for (const file of CORE_FILES) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('.')) continue;
        const pkg = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!allowed.has(pkg)) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('core never mentions a GPU or DOM runtime type', () => {
    // `target.ts` is allowed to read limits off an optional GPUDevice *type*, but nothing in
    // core may call a GPU method or touch the DOM.
    const forbidden = /\b(?:document|window|HTMLCanvasElement|GPUBufferUsage|createShaderModule|queue\.writeBuffer)\b/;
    const violations: string[] = [];
    for (const file of CORE_FILES) {
      if (file.endsWith('index.ts')) continue;
      const source = readFileSync(join(ROOT, file), 'utf8');
      // Strip comments so prose mentioning writeBuffer does not fail the test.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (forbidden.test(code)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('webgpu imports nothing from deck, duckdb or the demo', () => {
    const violations: string[] = [];
    for (const file of LIB_FILES.filter((f) => f.startsWith('src/webgpu/'))) {
      for (const specifier of importsOf(file)) {
        const target = resolveLocal(file, specifier);
        if (!target) continue;
        const ok = target.startsWith('src/webgpu/') || target.startsWith('src/core/');
        if (!ok) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no library file imports from the demo', () => {
    const violations: string[] = [];
    for (const file of LIB_FILES) {
      for (const specifier of importsOf(file)) {
        if (specifier.includes('demo/')) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('only the duckdb entry imports duckdb-wasm, and only deck imports deck.gl/luma', () => {
    const offenders: Record<string, string[]> = {};
    for (const file of LIB_FILES) {
      for (const specifier of importsOf(file)) {
        const misplaced =
          (specifier.startsWith('@duckdb/') && !file.startsWith('src/duckdb/')) ||
          ((specifier.startsWith('@deck.gl/') || specifier.startsWith('@luma.gl/')) &&
            !file.startsWith('src/deck/'));
        if (misplaced) (offenders[file] ??= []).push(specifier);
      }
    }
    expect(offenders).toEqual({});
  });

  it('no library file uses a bundler-specific import suffix', () => {
    // `?url` / `?raw` / `?worker` only work under a bundler. The DuckDB wasm URLs used to be
    // imported this way, which silently made the library unusable outside Vite.
    const violations: string[] = [];
    for (const file of LIB_FILES) {
      for (const specifier of importsOf(file)) {
        if (/\?(url|raw|worker|inline)\b/.test(specifier)) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('entry points', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, { types: string; import: string }>;
  };

  it('every export maps to a barrel that exists', () => {
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      const source = entry.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
      expect(LIB_FILES, `${subpath} -> ${source}`).toContain(source);
      // Declarations must sit beside the JS or the types resolve to nothing.
      expect(entry.types).toBe(entry.import.replace(/\.js$/, '.d.ts'));
    }
  });

  it('each barrel re-exports every module in its directory', () => {
    // Catches a new file that nobody can import because the barrel was not updated.
    for (const [dir, barrel] of [
      ['src/core', 'src/core/index.ts'],
      ['src/webgpu', 'src/webgpu/index.ts'],
    ] as const) {
      const barrelSource = readFileSync(join(ROOT, barrel), 'utf8');
      const modules = LIB_FILES.filter(
        (f) => f.startsWith(`${dir}/`) && !f.endsWith('index.ts'),
      );
      const missing = modules.filter((m) => {
        const name = m.slice(dir.length + 1).replace(/\.ts$/, '');
        return !barrelSource.includes(`./${name}.js`);
      });
      expect(missing, `${barrel} is missing re-exports`).toEqual([]);
    }
  });
});
