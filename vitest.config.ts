import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Node suite: the fast, pure tests. Separate from `vite.config.ts` because that one sets
 * `root: 'demo'` for the app, which would hide every test under `src/`.
 *
 * Browser-only tests are excluded here and run by `vitest.browser.config.ts` instead.
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
  resolve: { alias: plannerAliases },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['**/*.browser.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
