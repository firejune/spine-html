import { defineConfig } from 'vite';

/**
 * Two build entries:
 *
 * - `index.html` — the demo (and the perf oracle; see README).
 * - `tests/harness.html` — a browser test harness that exposes the loading
 *   path (unpackRegions / revokeRegions) to Playwright, so tests can call the
 *   library directly instead of inferring it from the demo's stats line.
 *
 * Neither is what npm ships: the package is built from `tsconfig.build.json`
 * (`bun run build:lib`) and contains `src/` only.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        demo: 'index.html',
        harness: 'tests/harness.html',
      },
    },
  },
});
