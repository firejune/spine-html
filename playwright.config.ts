import { defineConfig } from '@playwright/test';

/**
 * Test policy:
 *
 * - Visual checks are A/B within one run and one engine (canvas2d vs webgl
 *   screenshots of the same deterministic pose) — no golden snapshot files,
 *   nothing platform- or GPU-dependent is committed.
 * - Counter/invariant checks read the demo's #stats line. They never assert
 *   absolute milliseconds: headless numbers are not performance evidence
 *   (headless WebKit is a software rasterizer, measured up to 28× off real
 *   Safari) — the on-device demo stats line is the perf oracle.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 30_000 },
  // Two light spec files; cap workers so local runs stay polite next to
  // whatever else the machine is doing.
  workers: 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4321',
    viewport: { width: 900, height: 640 },
    deviceScaleFactor: 1,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    // Build includes the fetch-assets hook (idempotent), so a fresh checkout
    // works end-to-end with `bun run test`.
    command: 'bun run build && bunx vite preview --port 4321 --strictPort',
    port: 4321,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
