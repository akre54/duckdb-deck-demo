import { defineConfig } from 'vite';

/**
 * Dev/build config for the demo app only. The library in `src/` is built with plain `tsc`
 * — nothing left in it uses a bundler-specific import, which is the point of moving the
 * DuckDB wasm `?url` wiring out to the demo.
 */
export default defineConfig({
  root: 'demo',
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
