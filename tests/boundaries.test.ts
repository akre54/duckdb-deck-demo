import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

/**
 * The standing guard on the packaging.
 *
 * Subpath exports and a separate workspace package only mean anything if the layers actually
 * respect each other: a consumer importing `@noodles.gl/planner` must not end up with deck.gl,
 * luma, duckdb-wasm or a `GPUDevice` requirement in their dependency graph. That is an easy
 * invariant to break with one convenient import, and impossible to notice by reading a diff,
 * so it is asserted here rather than documented and hoped for.
 *
 * The planner living in its own package makes most of this mechanical — a stray import of the
 * WebGPU layer would not resolve at all. What still needs asserting is the part npm cannot
 * check: that the planner pulls in no *package* beyond Arrow's types, mentions no GPU or DOM
 * API, and is compiled without the DOM and WebGPU type libraries in scope.
 */

const ROOT = resolve(__dirname, '..');
const PLANNER = 'packages/planner';

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

const notTest = (f: string) => !f.endsWith('.test.ts') && !f.endsWith('.bench.ts');

/** A tsconfig is JSONC: comments are the point of having one, so strip them before parsing. */
function parseJsonc<T>(text: string): T {
  return JSON.parse(
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1'),
  ) as T;
}

/** The runtime layers, which live in the root package. */
const LIB_FILES = walk('src').filter(notTest);
/** The planner package's shipped source. `fixtures.ts` is shipped but test-only. */
const PLANNER_FILES = walk(`${PLANNER}/src`).filter(notTest);
const PLANNER_LIB = PLANNER_FILES.filter((f) => f !== `${PLANNER}/src/fixtures.ts`);

// ---------------------------------------------------------------------------

describe('the planner package stands alone', () => {
  it('has source to check', () => {
    // Guards every assertion below: a bad glob would make them all vacuously pass.
    expect(PLANNER_LIB.length).toBeGreaterThan(15);
  });

  it('no relative import escapes the package', () => {
    const violations: string[] = [];
    for (const file of PLANNER_FILES) {
      for (const specifier of importsOf(file)) {
        const target = resolveLocal(file, specifier);
        if (!target) continue;
        if (!target.startsWith(`${PLANNER}/src/`)) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never imports itself by package name', () => {
    // A self-referential import resolves through the alias during development and through
    // `dist` after a build, so the same file would exist twice at runtime with two copies of
    // every module-level constant.
    const violations = PLANNER_FILES.filter((f) =>
      importsOf(f).some((s) => s.startsWith('@noodles.gl/planner')));
    expect(violations).toEqual([]);
  });

  it('depends on no package other than apache-arrow', () => {
    const allowed = new Set(['apache-arrow']);
    const violations: string[] = [];
    for (const file of PLANNER_LIB) {
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

  it('uses apache-arrow for types only, so the built output has no runtime imports', () => {
    // This is what lets Arrow be an optional peer rather than a dependency. A value import
    // would survive compilation and become something every consumer has to install.
    for (const file of PLANNER_LIB) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const line of source.split('\n')) {
        if (!line.includes("'apache-arrow'")) continue;
        expect(line.trimStart(), `${file}: ${line.trim()}`).toMatch(/^import type /);
      }
    }
  });

  it('declares apache-arrow as an optional peer, not a dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, PLANNER, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies).toHaveProperty('apache-arrow');
    expect(pkg.peerDependenciesMeta?.['apache-arrow']?.optional).toBe(true);
  });

  it('never mentions a GPU or DOM runtime API', () => {
    // `target.ts` is allowed to read limits off an optional GPUDevice *type*, but nothing in
    // the planner may call a GPU method or touch the DOM.
    const forbidden = /\b(?:document|window|HTMLCanvasElement|GPUBufferUsage|createShaderModule|queue\.writeBuffer)\b/;
    const violations: string[] = [];
    for (const file of PLANNER_LIB) {
      if (file.endsWith('index.ts')) continue;
      const source = readFileSync(join(ROOT, file), 'utf8');
      // Strip comments so prose mentioning writeBuffer does not fail the test.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (forbidden.test(code)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('compiles without the DOM or WebGPU type libraries in scope', () => {
    // The real enforcement of the rule above: with `lib` restricted and `types` empty, an
    // accidental `document` or `GPUDevice` fails to compile rather than becoming a
    // requirement a consumer has to satisfy.
    const ts = parseJsonc<{
      compilerOptions: { lib: string[]; types: string[]; moduleResolution: string };
    }>(readFileSync(join(ROOT, PLANNER, 'tsconfig.json'), 'utf8'));
    expect(ts.compilerOptions.lib).toEqual(['ES2022']);
    expect(ts.compilerOptions.types).toEqual([]);
    // `bundler` resolution permits extensionless imports, which then fail in Node.
    expect(ts.compilerOptions.moduleResolution).toBe('nodenext');
  });

  it('is wired as a workspace the root package depends on', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      workspaces?: string[];
      dependencies?: Record<string, string>;
    };
    expect(root.workspaces).toContain(PLANNER);
    expect(root.dependencies).toHaveProperty('@noodles.gl/planner');
  });
});

describe('layer boundaries', () => {
  it('the runtime layers reach the planner only by package name', () => {
    // A relative path into `packages/` would work locally and break the moment the planner is
    // consumed from npm, which is the whole point of the split.
    const violations: string[] = [];
    for (const file of LIB_FILES) {
      for (const specifier of importsOf(file)) {
        if (specifier.includes('packages/') || specifier.includes('core/')) {
          violations.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('webgpu imports nothing from deck or duckdb', () => {
    const violations: string[] = [];
    for (const file of LIB_FILES.filter((f) => f.startsWith('src/webgpu/'))) {
      for (const specifier of importsOf(file)) {
        const target = resolveLocal(file, specifier);
        if (!target) continue;
        if (!target.startsWith('src/webgpu/')) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no library file imports from the demo', () => {
    const violations: string[] = [];
    for (const file of [...LIB_FILES, ...PLANNER_FILES]) {
      for (const specifier of importsOf(file)) {
        if (specifier.includes('demo/')) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('only the duckdb entry imports duckdb-wasm, and only deck imports deck.gl/luma', () => {
    const offenders: Record<string, string[]> = {};
    for (const file of [...LIB_FILES, ...PLANNER_FILES]) {
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
    for (const file of [...LIB_FILES, ...PLANNER_FILES]) {
      for (const specifier of importsOf(file)) {
        if (/\?(url|raw|worker|inline)\b/.test(specifier)) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('entry points', () => {
  const entries = (pkgDir: string, srcRoot: string) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, pkgDir, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; import: string }>;
    };
    return Object.entries(pkg.exports).map(([subpath, entry]) => ({
      subpath,
      entry,
      source: join(pkgDir, entry.import.replace(/^\.\/dist\//, `${srcRoot}/`))
        .replace(/\\/g, '/')
        .replace(/\.js$/, '.ts'),
    }));
  };

  const allEntries = [...entries('.', 'src'), ...entries(PLANNER, 'src')];

  it('has entries to check', () => {
    expect(allEntries.length).toBeGreaterThanOrEqual(5);
  });

  it('every export maps to a source file that exists', () => {
    for (const { subpath, entry, source } of allEntries) {
      const path = source.replace(/^\.\//, '');
      expect(existsSync(join(ROOT, path)), `${subpath} -> ${path}`).toBe(true);
      // Declarations must sit beside the JS or the types resolve to nothing.
      expect(entry.types).toBe(entry.import.replace(/\.js$/, '.d.ts'));
    }
  });

  it('each barrel re-exports every module in its directory', () => {
    // Catches a new file that nobody can import because the barrel was not updated.
    for (const [files, dir, barrel] of [
      [PLANNER_LIB, `${PLANNER}/src`, `${PLANNER}/src/index.ts`],
      [LIB_FILES, 'src/webgpu', 'src/webgpu/index.ts'],
      [LIB_FILES, 'src/program', 'src/program/index.ts'],
    ] as const) {
      const barrelSource = readFileSync(join(ROOT, barrel), 'utf8');
      const modules = files.filter(
        (f) => f.startsWith(`${dir}/`) && !f.endsWith('index.ts'),
      );
      const missing = modules.filter((m) => {
        const name = m.slice(dir.length + 1).replace(/\.ts$/, '');
        return !barrelSource.includes(`./${name}.js`);
      });
      expect(missing, `${barrel} is missing re-exports`).toEqual([]);
    }
  });

  it('does not export the test fixtures from the main barrel', () => {
    // They are exported from `./fixtures` on purpose, for this repo's own tests. Leaking them
    // into the public surface would make a graph generator part of the API.
    const barrel = readFileSync(join(ROOT, PLANNER, 'src/index.ts'), 'utf8');
    expect(barrel).not.toContain('./fixtures.js');
  });
});
