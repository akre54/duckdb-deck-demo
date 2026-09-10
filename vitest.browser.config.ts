import { defineConfig } from 'vitest/config';

/**
 * Browser suite: real WebGPU and real DuckDB-Wasm in Chromium.
 *
 * This exists because the Node suite can only check the SQL and WGSL backends *structurally*
 * — it can prove they compile, not that they compute the right numbers. Only the JS backend is
 * executable in Node. Running in a browser makes all three executable, which is what turns
 * "three backends agree" from a claim into a measurement.
 *
 * Chromium needs `--enable-unsafe-swiftshader` so WebGPU works on a machine with no usable GPU
 * (CI, containers). On a real GPU it will use it. DuckDB-Wasm needs the cross-origin isolation
 * headers for its threaded bundle; we select mvp/eh at runtime so they are belt-and-braces.
 */
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  worker: { format: 'es' },
  test: {
    include: ['tests/browser/**/*.browser.test.ts'],
    // Real GPU work and a wasm database are both slow to start.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      name: 'chromium',
      provider: 'playwright',
      headless: true,
      providerOptions: {
        launch: {
          /**
           * `channel: 'chromium'` selects the full Chrome-for-Testing build in new-headless
           * mode. Playwright's default headless binary is `chrome-headless-shell`, which ships
           * without WebGPU — `navigator.gpu` exists but `requestAdapter()` returns null, so
           * every GPU test skips while looking like it ran.
           */
          channel: 'chromium',
          args: [
            // Software rasterization, so the suite works on a machine or CI box with no
            // usable GPU. A real GPU is used when one is available.
            '--enable-unsafe-swiftshader',
          ],
        },
      },
    },
  },
});
