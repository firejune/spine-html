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
 *
 * Typecheck policy (`SPINE_CORE_MINOR`):
 *
 * - The package is typed against one spine-core generation (4.3) and *runs* on
 *   several, through the seam in `src/coreCompat.ts`. So `tsc --noEmit` over
 *   `src/` and `tests/` is only meaningful in the column whose installed core
 *   is the one the code is typed for; under an older core it reports the
 *   difference the seam exists to absorb, which is not a defect and must not
 *   be made to look like one by loosening the types.
 * - `SPINE_CORE_MINOR` names the spine-core minor a run is against (the CI
 *   matrix sets it; a local swap can too). Anything other than the typed minor
 *   builds the pages without the typecheck. Unset — every ordinary local run —
 *   is the typed path, unchanged.
 * - What is NOT skipped anywhere is the typecheck of what npm actually ships:
 *   `tests/package.spec.ts` compiles a consumer against the built `dist/` and
 *   the installed core, in every column. The emitted `.d.ts` names only types
 *   that exist across the supported range, so that check is a real assertion in
 *   an older column rather than a formality.
 */
const DEFAULT_PORT = 4321;
/** The spine-core minor `src/` and `tests/` are typed against. */
const TYPED_CORE_MINOR = '4.3';

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

/**
 * True when this run is against a spine-core other than the one `src/` and
 * `tests/` are typed against, so a type *check* of them would report the
 * difference the seam absorbs rather than a defect. Exported because
 * `tests/package.spec.ts` needs the same answer, and one knob read in two
 * places is one knob — a second copy of the rule is how the two would drift.
 */
export const UNTYPED_CORE =
  !!process.env.SPINE_CORE_MINOR && process.env.SPINE_CORE_MINOR !== TYPED_CORE_MINOR;

const buildScript = UNTYPED_CORE ? 'build:pages' : 'build';

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
    // Both build scripts carry the fetch-assets hook (idempotent), so a fresh
    // checkout works end-to-end with `bun run test`.
    command: `bun run ${buildScript} && bunx vite preview --port ${port} --strictPort`,
    port,
    // A checkout that asked for its own port never wants someone else's
    // server on it — see the port policy above.
    reuseExistingServer: process.env.TEST_PORT === undefined && !process.env.CI,
    timeout: 180_000,
  },
});
