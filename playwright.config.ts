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
 *
 * Port policy (`TEST_PORT`):
 *
 * - The suite serves the build it is supposed to test, so the server and the
 *   tree must stay paired. With one fixed port and `reuseExistingServer`, a
 *   second checkout of this repository on the same machine (a git worktree, a
 *   second clone) finds 4321 already answering and borrows it — its specs then
 *   pass or fail against the *other* tree's build, silently and greenly. That
 *   is the wrong-tree hazard: nothing goes red, the run is simply about the
 *   wrong code.
 * - So each concurrent checkout sets its own `TEST_PORT`. Setting it also turns
 *   reuse off: a busy port is then a loud startup failure instead of a borrowed
 *   server. A malformed value is rejected rather than defaulted, because
 *   falling back to 4321 on a typo is exactly the failure this avoids.
 * - Unset, everything is as it was: port 4321, reuse unless CI. CI runs one
 *   checkout per machine and sees no change.
 */
const DEFAULT_PORT = 4321;

function resolveTestPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `TEST_PORT must be an integer between 1024 and 65535, got "${raw}".`,
    );
  }
  return port;
}

const port = resolveTestPort(process.env.TEST_PORT);

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 30_000 },
  // Light spec files; cap workers so local runs stay polite next to
  // whatever else the machine is doing.
  workers: 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
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
    command: `bun run build && bunx vite preview --port ${port} --strictPort`,
    port,
    // A checkout that asked for its own port never wants someone else's
    // server on it — see the port policy above.
    reuseExistingServer: process.env.TEST_PORT === undefined && !process.env.CI,
    timeout: 180_000,
  },
});
