import { defineConfig } from 'vitest/config';

/**
 * Node suite: the fast, pure tests. Separate from `vite.config.ts` because that one sets
 * `root: 'demo'` for the app, which would hide every test under `src/`.
 *
 * Browser-only tests are excluded here and run by `vitest.browser.config.ts` instead.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/*.browser.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
