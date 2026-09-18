import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * The benchmark page is its own vite project, not a third entry in the root
 * config, and that is a deliberate choice rather than a convenience.
 *
 * `vite.config.ts` at the root builds what gets deployed: the demo, plus the
 * test harness. Adding this page there would pull `@esotericsoftware/spine-webgl`
 * — a **development** dependency, under the Spine Runtimes License, and not
 * something this package asks a consumer to carry — into that build's output.
 * Keeping it separate means `bun run build` emits exactly what it emitted
 * before this page existed, which is the property worth having: a page nobody
 * deploys costs the deploy nothing.
 *
 * (The oracle's reference code does reach the harness entry, because that is
 * where test hooks belong. Rollup gives it its own chunk, loaded only by
 * `tests/harness.html`, so the demo's bytes are unchanged there too.)
 *
 * Run it with `bun run bench:dev`, or let `scripts/bench.mjs` start it.
 */
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  // The spineboy exports live in the repository's own public/ — fetched, never
  // redistributed (see NOTICE.md), and shared with the demo rather than copied.
  // `BENCH_CORPUS` swaps that directory for a local one holding real-world rigs
  // (`scripts/bench.mjs --corpus`), which is the whole of the corpus mechanism:
  // the page takes rig URLs by query and needs to know nothing else.
  publicDir: process.env.BENCH_CORPUS || fileURLToPath(new URL('../public', import.meta.url)),
  server: {
    fs: {
      // The page imports the library from ../src, which is outside this root.
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist-bench', import.meta.url)),
    emptyOutDir: true,
  },
});
