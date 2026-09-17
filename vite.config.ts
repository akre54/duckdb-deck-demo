import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Dev/build config for the demo app only. The library in `src/` is built with plain `tsc`
 * — nothing left in it uses a bundler-specific import, which is the point of moving the
 * DuckDB wasm `?url` wiring out to the demo.
 */

/**
 * The planner is a workspace package, but during development it resolves to source rather
 * than to `packages/planner/dist`. Without this every edit to the planner would need a build
 * before the demo or a test could see it. The published resolution is exercised by
 * `tests/boundaries.test.ts`, which reads the built output instead of the source.
 */
const plannerAliases = [
  { find: '@noodles.gl/planner/fixtures', replacement: resolve('packages/planner/src/fixtures.ts') },
  { find: '@noodles.gl/planner', replacement: resolve('packages/planner/src/index.ts') },
];

export default defineConfig({
  root: 'demo',
  resolve: { alias: plannerAliases },
  server: {
    // duckdb-wasm's threaded bundle wants SharedArrayBuffer. We select the mvp/eh bundle
    // at runtime so these aren't strictly required, but setting them keeps that door open.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    // duckdb-wasm ships its own workers + wasm; pre-bundling mangles the worker URLs.
    exclude: ['@duckdb/duckdb-wasm'],
  },
  worker: { format: 'es' },
  build: { outDir: '../dist-demo', emptyOutDir: true },
});
