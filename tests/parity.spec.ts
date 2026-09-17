import { writeFileSync } from 'node:fs';

import { expect, type Page, test } from '@playwright/test';

/**
 * Backend A/B visual parity — the core rendering test.
 *
 * Strategy: NO golden snapshot files (they rot across platforms/GPUs).
 * Within one run and one engine, the same deterministic pose (?time seeks,
 * ?timescale=0 freezes) is screenshotted with both mesh raster backends and
 * the two buffers are diffed directly. Everything platform-specific (fonts,
 * GPU, AA flavor) cancels out; what remains is exactly the difference
 * between the canvas2d and webgl mesh rasterizers — missing parts, wrong
 * colors, seams.
 *
 * Expected residual: the backends legitimately differ by sub-pixel amounts
 * (canvas2d closes seams with a 0.5px clip overdraw, and the two rasterizers
 * antialias edges differently), which shows up as speckle on high-contrast
 * texture detail. The diff is therefore shift-tolerant — a pixel is only
 * "bad" with no in-tolerance match in the other image's 3×3 neighborhood —
 * and budgets are measured against drawn content, not the mostly-empty stage.
 *
 * Until 2026-08 the dominant residual was neither of those: the canvas2d path
 * addressed texels as `uv * (size - 1)` against GL's `uv * size`, a systematic
 * sub-texel offset over the whole page. Removing it (issue #1) dropped the
 * floor by 15–250× depending on the cell, and the limits with it — every
 * number on the constants below is post-fix.
 *
 * Hairline seam cracks (calibrated at 0.07–0.20% of content) no longer sit
 * below the noise floor, but they still sit below any limit this diff can
 * carry, so seams keep their own deterministic canary at the bottom of this
 * file instead of a screenshot threshold: with a frozen pose and one engine,
 * `?expand=0` must change the canvas2d raster — if the overdraw ever dies, the
 * two captures become bit-identical. (The GL path needs no overdraw:
 * adjacent triangles index the same vertex array entries, so shared edges
 * are watertight by construction.)
 *
 * ## PARITY_DUMP=1 — the counts made visible
 *
 * The counts below say how many pixels disagree; they never say WHERE. That
 * matters for the one platform whose residue is unexplained (linux WebKit,
 * whose badRatio limit is held far looser): bad pixels on silhouettes, inside
 * the additive glow, or spread over the fill point at different causes, and
 * that platform exists only on the CI runner. So the environment variable
 * `PARITY_DUMP=1` turns every parity cell into an instrument. It writes, into
 * the test's output directory (and attaches, so artifact uploads and reporters
 * both find them):
 *
 * - `a-canvas2d.png` / `b-webgl.png` — the two captures exactly as taken, not
 *   re-captured: the bytes that were diffed.
 * - `diff-mask.png` — same dimensions, a dimmed greyscale of capture A as the
 *   backdrop (so the silhouette is readable), every shift-tolerant bad pixel
 *   painted pure red, and every raw-bad pixel that the 3×3 match rescued
 *   painted yellow.
 * - `metrics.json` — the numbers of the log line, plus project, scene and
 *   platform.
 *
 * The mask is painted by the SAME pass that counts, so red === `bad` and
 * red + yellow === `rawBad` by construction; the dump branch asserts exactly
 * that, which is the instrument's self-check (a mask drawn from the wrong set
 * fails it). Greys can never collide with the two markers: the backdrop is
 * dimmed to ≤ 115 per channel and has r === g === b.
 *
 * Without `PARITY_DUMP=1` nothing above happens — no mask is computed in the
 * page, no file is written, and the assertions and log lines are the ones that
 * have always run. This switch is an instrument, not a threshold.
 */

const POSE = 'time=1.2&timescale=0&count=1&dpr=1';

/** Scenes cover the element-level features both backends must agree on. */
const SCENES = [
  // Hoverboard exhaust uses BlendMode.Additive → mix-blend-mode: plus-lighter.
  { name: 'hoverboard (additive glow)', query: `skel=pro&anim=hoverboard&${POSE}` },
  // Portal carries a ClippingAttachment — deliberately skipped, on both backends.
  { name: 'portal (clipping skip)', query: `skel=pro&anim=portal&${POSE}` },
  // Whole-skeleton tint rides the feColorMatrix filter on <img> and <canvas>.
  { name: 'walk (tint filter)', query: `skel=pro&anim=walk&tint=ff9060&${POSE}` },
] as const;

/** Max per-channel delta a pixel may show before it counts as "bad". */
const CHANNEL_TOLERANCE = 24;
/**
 * Bad (shift-tolerant, see below) pixels allowed, as a fraction of the union
 * of drawn-content pixels. Recalibrated 2026-08-22 after the texel-addressing
 * fix, on macOS (chromium 1234 / webkit 2336): honest backend noise now
 * measures 0.000–0.011% on chromium and 0.025–0.049% on webkit (it was
 * 0.29–1.30% before the fix), while a dropped tint still scores ~87% and a
 * blanked mesh its full area share.
 *
 * 0.005 keeps ~10× headroom over the worst floor. Ten, not the previous ~3×,
 * because the measured spread between raster flavors on one scene reaches
 * ~7.8× (pre-fix walk+tint: macOS WebKit 0.72% vs linux WebKit 5.59%) — a
 * limit under ~10× the floor would be one browser-raster change away from
 * red. Chromium's floor is platform-independent — ubuntu CI post-fix reads
 * 0.000% / 0.009% / 0.000%, matching macOS — so it keeps the strict limit
 * everywhere.
 *
 * Verified red, not just green: re-introducing the `- 1` texel offset takes
 * both hoverboard cells (1.25% / 1.29%) and webkit walk+tint (0.72%) past
 * this limit, so a relapse fails the suite.
 */
const BAD_RATIO_LIMIT = 0.005;
/**
 * Linux WebKit only: its raster flavor is measurably noisier than macOS
 * WebKit's. Floors on ubuntu CI (run 32580117738, 2026-08-22, post-texel-fix):
 * hoverboard 4.77%, walk+tint 4.32%, portal 0.53% — contentMismatch ≤ 0.40%
 * (under its unchanged limit), seam canary rawBad=90.
 *
 * This limit is NOT tightened with the strict one, because the texel fix
 * barely moved this platform: raw diff pixels roughly halved (3422 → 1580 on
 * hoverboard) while the shift-tolerant count did not (1049 → 1042). Its
 * residue is therefore not sub-pixel — those are pixels with no in-tolerance
 * match anywhere in the other image's 3×3, at maxDelta ~233. Something else
 * differs between the backends under that software rasterizer; until it is
 * understood, 0.13 (~2.7× over the worst floor) stays. Nothing is lost: the
 * synthetic regressions score ~87% there like everywhere else, and missing
 * parts stay guarded by CONTENT_MISMATCH_LIMIT, which is not relaxed.
 */
const BAD_RATIO_LIMIT_WEBKIT_LINUX = 0.13;

function badRatioLimitFor(projectName: string): number {
  return projectName === 'webkit' && process.platform === 'linux'
    ? BAD_RATIO_LIMIT_WEBKIT_LINUX
    : BAD_RATIO_LIMIT;
}
/**
 * Allowed relative difference in drawn-content pixel counts — the
 * missing-part guard. Measured noise ≤ 0.22%, except linux WebKit at ≤ 0.40%;
 * blanking even the smallest spineboy-pro mesh moves it past ~1.6%, a dropped
 * tint ~6%.
 */
const CONTENT_MISMATCH_LIMIT = 0.015;

/** See the header: an on-demand instrument, never a threshold. */
const DUMP = process.env.PARITY_DUMP === '1';

interface DiffMetrics {
  width: number;
  height: number;
  /** Pixels whose max per-channel delta exceeds CHANNEL_TOLERANCE, raw. */
  rawBad: number;
  /** Raw-bad pixels with no in-tolerance match in the other image's 3×3. */
  bad: number;
  /** The two directions `bad` is the max of: A against B, and B against A. */
  badAB: number;
  badBA: number;
  maxDelta: number;
  /** Non-background pixels in each screenshot, and in their union. */
  contentA: number;
  contentB: number;
  contentUnion: number;
  /** Only when the caller asked for one (PARITY_DUMP); see the header. */
  mask?: {
    /** The painted mask, PNG, base64 without the data: prefix. */
    pngBase64: string;
    /** Which direction's fail set was painted red — the one `bad` came from. */
    direction: 'a-vs-b' | 'b-vs-a';
    /** Counted back off the painted pixels, not off the loop's counters. */
    red: number;
    yellow: number;
  };
}

async function captureStage(
  page: Page,
  query: string,
  backend: 'canvas2d' | 'webgl',
): Promise<Buffer> {
  await page.goto(`/?${query}&backend=${backend}`);
  const stats = page.locator('#stats');
  // A frozen scene has settled when every mesh reuses its raster: the pose
  // (including any physics) has stopped moving, so the screenshot is
  // deterministic. Content-based wait — no arbitrary sleeps.
  await expect(stats).toContainText(/mesh canvases 0 drawn \(0 tris\) \/ \d+ reused/);
  if (backend === 'webgl') {
    // Guard the guard: if WebGL were unavailable this test would diff
    // canvas2d against itself and pass vacuously.
    await expect(stats).toContainText('· webgl');
    await expect(stats).not.toContainText('unavailable');
  }
  return page.locator('#stage').screenshot();
}

/**
 * Decode both PNGs in the page (canvas getImageData — zero extra deps) and
 * reduce them to diff metrics. "Content" is any pixel that differs from the
 * stage background or the floor strip (sampled from the corners), so the
 * ratios measure the skeleton, not the empty stage around it.
 *
 * With `withMask` (PARITY_DUMP only) the same pass also paints the mask
 * described in the header, so the picture and the counts cannot drift apart.
 * Left false, not a byte of mask work runs in the page.
 */
async function diffInPage(
  page: Page,
  a: Buffer,
  b: Buffer,
  withMask = false,
): Promise<DiffMetrics> {
  return page.evaluate(
    async ({ aB64, bB64, tolerance, withMask }): Promise<DiffMetrics> => {
      const decode = async (b64: string): Promise<ImageData> => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('2d context unavailable');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      };
      const [da, db] = await Promise.all([decode(aB64), decode(bB64)]);
      if (da.width !== db.width || da.height !== db.height) {
        throw new Error(
          `screenshot size mismatch: ${da.width}x${da.height} vs ${db.width}x${db.height}`,
        );
      }
      const pa = da.data;
      const pb = db.data;
      // Backgrounds: stage fill (top-left) and floor strip (bottom-left).
      const w = da.width;
      const h = da.height;
      const stripAt = (w * (h - 1)) * 4;
      const bg = [pa[0], pa[1], pa[2]];
      const strip = [pa[stripAt], pa[stripAt + 1], pa[stripAt + 2]];
      const isContent = (p: Uint8ClampedArray, i: number): boolean => {
        const nearBg =
          Math.abs(p[i] - bg[0]) <= 8 &&
          Math.abs(p[i + 1] - bg[1]) <= 8 &&
          Math.abs(p[i + 2] - bg[2]) <= 8;
        if (nearBg) return false;
        return !(
          Math.abs(p[i] - strip[0]) <= 8 &&
          Math.abs(p[i + 1] - strip[1]) <= 8 &&
          Math.abs(p[i + 2] - strip[2]) <= 8
        );
      };
      // Shift-tolerant match: the backends legitimately differ by sub-pixel
      // amounts (canvas2d closes seams with a 0.5px clip overdraw, and the
      // two rasterizers antialias silhouette edges differently), so a pixel
      // only counts as bad when NOTHING in the other image's 3×3 neighborhood
      // is within the channel tolerance. Real regressions — missing parts,
      // wrong colors, interior seams — have no matching neighbor and stay
      // caught.
      const matchesNear = (
        from: Uint8ClampedArray,
        i: number,
        into: Uint8ClampedArray,
      ): boolean => {
        const px = (i / 4) % w;
        const py = (i / 4 - px) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const y = py + dy;
          if (y < 0 || y >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = px + dx;
            if (x < 0 || x >= w) continue;
            const j = (y * w + x) * 4;
            if (
              Math.abs(from[i] - into[j]) <= tolerance &&
              Math.abs(from[i + 1] - into[j + 1]) <= tolerance &&
              Math.abs(from[i + 2] - into[j + 2]) <= tolerance
            ) {
              return true;
            }
          }
        }
        return false;
      };
      let rawBad = 0;
      let badAB = 0;
      let badBA = 0;
      let maxDelta = 0;
      let contentA = 0;
      let contentB = 0;
      let contentUnion = 0;
      // Mask buffers, allocated only when dumping. `flags` remembers, per
      // pixel, what the counting loop decided — bit 1 raw-bad, bit 2 "no match
      // for A in B", bit 4 "no match for B in A" — so the picture below is
      // painted from the counters' own verdicts rather than a second opinion.
      const maskData = withMask ? new Uint8ClampedArray(pa.length) : null;
      const flags = withMask ? new Uint8Array(pa.length / 4) : null;
      for (let i = 0; i < pa.length; i += 4) {
        const delta = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]),
        );
        if (delta > maxDelta) maxDelta = delta;
        if (delta > tolerance) {
          rawBad++;
          // Only pixels failing the direct compare need the neighborhood scan.
          const missAB = !matchesNear(pa, i, pb);
          const missBA = !matchesNear(pb, i, pa);
          if (missAB) badAB++;
          if (missBA) badBA++;
          if (flags) flags[i / 4] = 1 | (missAB ? 2 : 0) | (missBA ? 4 : 0);
        }
        if (maskData) {
          // Backdrop: capture A as dimmed greyscale. Dimmed so the markers
          // read over it, greyscale so it can never BE a marker (r === g === b,
          // and ≤ 115 per channel, while the markers are pure red and yellow).
          const grey =
            ((pa[i] * 0.299 + pa[i + 1] * 0.587 + pa[i + 2] * 0.114) * 0.45) | 0;
          maskData[i] = grey;
          maskData[i + 1] = grey;
          maskData[i + 2] = grey;
          maskData[i + 3] = 255;
        }
        const ca = isContent(pa, i);
        const cb = isContent(pb, i);
        if (ca) contentA++;
        if (cb) contentB++;
        if (ca || cb) contentUnion++;
      }
      const bad = Math.max(badAB, badBA);
      let mask: DiffMetrics['mask'];
      if (maskData && flags) {
        // `bad` is the max of the two directions, so red is the fail set of
        // whichever direction produced it — that is what makes red === bad by
        // construction. Every other raw-bad pixel was rescued by the 3×3 match
        // and goes yellow, so red + yellow === rawBad, also by construction.
        const redBit = badAB >= badBA ? 2 : 4;
        for (let p = 0; p < flags.length; p++) {
          if (!(flags[p] & 1)) continue;
          const i = p * 4;
          maskData[i] = 255;
          maskData[i + 1] = flags[p] & redBit ? 0 : 255;
          maskData[i + 2] = 0;
        }
        // Count the markers back off the painted pixels — a scan of what the
        // picture actually says, not a copy of the counters above.
        let red = 0;
        let yellow = 0;
        for (let i = 0; i < maskData.length; i += 4) {
          if (maskData[i] !== 255 || maskData[i + 2] !== 0) continue;
          if (maskData[i + 1] === 0) red++;
          else if (maskData[i + 1] === 255) yellow++;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        ctx.putImageData(new ImageData(maskData, w, h), 0, 0);
        mask = {
          pngBase64: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
          direction: badAB >= badBA ? 'a-vs-b' : 'b-vs-a',
          red,
          yellow,
        };
      }
      return {
        width: w,
        height: h,
        rawBad,
        bad,
        badAB,
        badBA,
        maxDelta,
        contentA,
        contentB,
        contentUnion,
        mask,
      };
    },
    {
      aB64: a.toString('base64'),
      bB64: b.toString('base64'),
      tolerance: CHANNEL_TOLERANCE,
      withMask,
    },
  );
}

for (const scene of SCENES) {
  test(`canvas2d / webgl parity: ${scene.name}`, async ({ page }, testInfo) => {
    const canvas2d = await captureStage(page, scene.query, 'canvas2d');
    const webgl = await captureStage(page, scene.query, 'webgl');
    const m = await diffInPage(page, canvas2d, webgl, DUMP);

    const badRatio = m.bad / Math.max(1, m.contentUnion);
    const contentMismatch =
      Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB);
    // Always in the run log (CI included): the drift of these numbers over
    // time is the early signal, not just the pass/fail line.
    console.log(
      `[parity] ${testInfo.project.name} ${scene.name}: ${m.width}x${m.height}, ` +
        `content a=${m.contentA} b=${m.contentB} union=${m.contentUnion}, ` +
        `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(3)}% of content, ` +
        `ch>${CHANNEL_TOLERANCE}), maxDelta=${m.maxDelta}, ` +
        `contentMismatch=${(contentMismatch * 100).toFixed(3)}%`,
    );
    const badRatioLimit = badRatioLimitFor(testInfo.project.name);
    if (badRatio > badRatioLimit || contentMismatch > CONTENT_MISMATCH_LIMIT) {
      // Keep the pair on failure, for eyeballing the regression.
      writeFileSync(testInfo.outputPath('canvas2d.png'), canvas2d);
      writeFileSync(testInfo.outputPath('webgl.png'), webgl);
    }

    if (DUMP) {
      const mask = m.mask;
      if (!mask) throw new Error('PARITY_DUMP is set but the diff returned no mask');
      const files = {
        'a-canvas2d.png': canvas2d,
        'b-webgl.png': webgl,
        'diff-mask.png': Buffer.from(mask.pngBase64, 'base64'),
        'metrics.json': Buffer.from(
          `${JSON.stringify(
            {
              project: testInfo.project.name,
              scene: scene.name,
              platform: process.platform,
              width: m.width,
              height: m.height,
              contentA: m.contentA,
              contentB: m.contentB,
              contentUnion: m.contentUnion,
              bad: m.bad,
              badAB: m.badAB,
              badBA: m.badBA,
              rawBad: m.rawBad,
              maxDelta: m.maxDelta,
              channelTolerance: CHANNEL_TOLERANCE,
              badRatio,
              badRatioLimit,
              contentMismatch,
              contentMismatchLimit: CONTENT_MISMATCH_LIMIT,
              maskDirection: mask.direction,
              maskRed: mask.red,
              maskYellow: mask.yellow,
            },
            null,
            2,
          )}\n`,
        ),
      };
      for (const [name, body] of Object.entries(files)) {
        const path = testInfo.outputPath(name);
        writeFileSync(path, body);
        await testInfo.attach(name, {
          path,
          contentType: name.endsWith('.png') ? 'image/png' : 'application/json',
        });
      }
      // The instrument's self-check (dump runs only). The mask is painted by
      // the counting pass, so a mask that disagrees with the counts means the
      // picture is lying about which pixels the numbers are made of — the one
      // failure mode that would send the reader of these images after the
      // wrong cause.
      expect(mask.red).toBe(m.bad);
      expect(mask.red + mask.yellow).toBe(m.rawBad);
    }

    // The scene must actually draw something — a blank stage would "match".
    expect(m.contentUnion).toBeGreaterThan(5000);
    // Sub-pixel sampling differences are expected (and absorbed); missing
    // parts and wrong colors blow past these limits (calibrated: a dropped
    // tint scores ~87% bad, a blanked mesh shifts content by its area).
    expect(badRatio).toBeLessThanOrEqual(badRatioLimit);
    expect(contentMismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
  });
}

test('seam canary: the canvas2d crack-closing overdraw is alive', async ({ page }) => {
  // Hairline cracks are below the A/B noise floor (see header), so the seam
  // guard is exact instead of statistical: same engine, same frozen pose,
  // canvas2d with and without the 0.5px clip expansion. The renders are
  // fully deterministic, so if the overdraw stopped doing anything the two
  // captures would be bit-identical (rawBad = 0). Today they differ on the
  // ~half-pixel silhouette ring plus any engine clip-AA seams.
  const query = `skel=pro&anim=hoverboard&${POSE}`;
  const withExpand = await captureStage(page, query, 'canvas2d');
  const withoutExpand = await captureStage(page, `${query}&expand=0`, 'canvas2d');
  const m = await diffInPage(page, withExpand, withoutExpand);
  console.log(`[parity] ${test.info().project.name} seam canary: rawBad=${m.rawBad}`);
  expect(m.rawBad).toBeGreaterThanOrEqual(10);
});
