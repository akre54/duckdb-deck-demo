import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // duckdb-wasm's multi-threaded bundle wants SharedArrayBuffer. We select the
    // mvp/eh bundle at runtime so these aren't strictly required, but setting them
    // keeps the door open for the threaded bundle without a config change.
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
});
