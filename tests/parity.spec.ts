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
 * (canvas2d closes seams with a 0.5px clip overdraw; its drawImage texel
 * addressing is offset from GL's texture2D by a fraction of a texel), which
 * shows up as speckle on high-contrast texture detail. The diff is therefore
 * shift-tolerant — a pixel is only "bad" with no in-tolerance match in the
 * other image's 3×3 neighborhood — and budgets are measured against drawn
 * content, not the mostly-empty stage.
 *
 * Hairline seam cracks sit *below* that speckle floor (calibrated: cracks
 * score 0.07–0.20% of content vs 0.29–1.30% honest noise), so seams get
 * their own deterministic canary at the bottom of this file instead of a
 * screenshot threshold: with a frozen pose and one engine, `?expand=0` must
 * change the canvas2d raster — if the crack-closing overdraw ever dies, the
 * two captures become bit-identical. (The GL path needs no overdraw:
 * adjacent triangles index the same vertex array entries, so shared edges
 * are watertight by construction.)
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
 * of drawn-content pixels. Calibrated 2026-08 on macOS (chromium 1234 /
 * webkit 2336): honest backend noise measures 0.29–1.30% across the three
 * scenes, while a dropped tint scores ~87% and a blanked mesh scores its
 * full area share — 0.04 keeps ~3× headroom on both sides, with slack for
 * CI engines whose AA flavor differs.
 */
const BAD_RATIO_LIMIT = 0.04;
/**
 * Allowed relative difference in drawn-content pixel counts — the
 * missing-part guard. Measured noise ≤ 0.23%; blanking even the smallest
 * spineboy-pro mesh moves it past ~1.6%, a dropped tint ~6%.
 */
const CONTENT_MISMATCH_LIMIT = 0.015;

interface DiffMetrics {
  width: number;
  height: number;
  /** Pixels whose max per-channel delta exceeds CHANNEL_TOLERANCE, raw. */
  rawBad: number;
  /** Raw-bad pixels with no in-tolerance match in the other image's 3×3. */
  bad: number;
  maxDelta: number;
  /** Non-background pixels in each screenshot, and in their union. */
  contentA: number;
  contentB: number;
  contentUnion: number;
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
 */
async function diffInPage(page: Page, a: Buffer, b: Buffer): Promise<DiffMetrics> {
  return page.evaluate(
    async ({ aB64, bB64, tolerance }) => {
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
      // amounts (canvas2d closes seams with a 0.5px clip overdraw, and its
      // drawImage texel addressing is offset from GL's texture2D by up to a
      // half texel), so a pixel only counts as bad when NOTHING in the other
      // image's 3×3 neighborhood is within the channel tolerance. Real
      // regressions — missing parts, wrong colors, interior seams — have no
      // matching neighbor and stay caught.
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
          if (!matchesNear(pa, i, pb)) badAB++;
          if (!matchesNear(pb, i, pa)) badBA++;
        }
        const ca = isContent(pa, i);
        const cb = isContent(pb, i);
        if (ca) contentA++;
        if (cb) contentB++;
        if (ca || cb) contentUnion++;
      }
      const bad = Math.max(badAB, badBA);
      return { width: w, height: h, rawBad, bad, maxDelta, contentA, contentB, contentUnion };
    },
    { aB64: a.toString('base64'), bB64: b.toString('base64'), tolerance: CHANNEL_TOLERANCE },
  );
}

for (const scene of SCENES) {
  test(`canvas2d / webgl parity: ${scene.name}`, async ({ page }, testInfo) => {
    const canvas2d = await captureStage(page, scene.query, 'canvas2d');
    const webgl = await captureStage(page, scene.query, 'webgl');
    const m = await diffInPage(page, canvas2d, webgl);

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
    if (badRatio > BAD_RATIO_LIMIT || contentMismatch > CONTENT_MISMATCH_LIMIT) {
      // Keep the pair on failure, for eyeballing the regression.
      writeFileSync(testInfo.outputPath('canvas2d.png'), canvas2d);
      writeFileSync(testInfo.outputPath('webgl.png'), webgl);
    }

    // The scene must actually draw something — a blank stage would "match".
    expect(m.contentUnion).toBeGreaterThan(5000);
    // Sub-pixel sampling differences are expected (and absorbed); missing
    // parts and wrong colors blow past these limits (calibrated: a dropped
    // tint scores ~87% bad, a blanked mesh shifts content by its area).
    expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
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
