import { expect, type Page, test } from '@playwright/test';

/**
 * How a rigid cut locates its pixels when the page ships at another resolution.
 *
 * `planCut` rounds each *edge* of the scaled rect to a whole image pixel, so a
 * cut stays a lossless 1:1 copy and neighbours keep tiling exactly, at the
 * price of up to half an image pixel of placement. The alternative normalized
 * UVs describe — sample the fractional rect with interpolation — buys exact
 * placement with a resample of the whole bitmap. Which one lands closer to the
 * same pose drawn from the 1:1 page was measured rather than argued (#35), on
 * the `cutRuleStage` probe in harness.ts: rigid-only spineboy-ess, two frozen
 * poses, page scales 0.5 / 0.75 / 1.5 / 2, both projects, against a
 * deliberately wrong control (the shipped rule displaced one whole image
 * pixel) that scored 2.4–11× worse than either real rule and so proved the
 * instrument can see placement at all.
 *
 * The answer was mixed, which is why nothing changed in `planCut`: fractional
 * sampling lowers the raw difference and the peak channel delta, and raises the
 * count of pixels with no in-tolerance match anywhere in the reference's 3×3 —
 * rounding displaces the picture, which a shift-tolerant compare forgives,
 * while sampling blurs it, which it does not. At an integer page scale the two
 * rules are bit-identical (no fractional part exists), so the question only
 * arises in between.
 *
 * What is asserted here is the half of that which decided it, and the only half
 * that repeated everywhere: at 0.5× — the common case, a half-resolution
 * texture build — the shipped rule is *closer* to the 1:1 reference than
 * fractional sampling by the parity suite's own shift-tolerant count. Margins
 * measured over both poses: 1.3× at the tightest (webkit 1443 vs 1888, 1580 vs
 * 2124) and 2.2× at the widest (chromium 638 vs 1238, 430 vs 948). It is
 * written as an inequality, never as a limit on either count: absolute counts
 * move with the raster — chromium's first document in a worker was measured in
 * two states ~30% apart on a loaded machine — while the ordering held in every
 * run, in both states and on both projects.
 *
 * Strict `<` is deliberate: it also makes the test non-vacuous. Were the
 * alternative ever to stop being applied, the two captures would be identical
 * and the counts equal, and this would go red rather than pass on an
 * unexercised rule.
 */

const POSE = { animation: 'walk', time: 1.2 } as const;
/** The common case: a half-resolution texture build under an untouched atlas. */
const PAGE_SCALE = 0.5;
/** Same tolerance as the parity suite, so "bad" means there what it means here. */
const CHANNEL_TOLERANCE = 24;

/**
 * Screenshots the stage until two captures in a row are byte-identical.
 *
 * Chromium raises the quality of a scaled image's raster a frame or two after
 * the first paint, and a capture that lands mid-escalation reads as a
 * difference between rules (measured: 23,612 pixels between the first capture
 * of a page and the two after it). Settled is defined by the bytes.
 */
async function stableShot(page: Page): Promise<Buffer> {
  const stage = page.locator('#cut-rule-stage');
  let previous = await stage.screenshot();
  for (let attempt = 0; attempt < 12; attempt++) {
    const next = await stage.screenshot();
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error('the stage raster never settled');
}

async function capture(page: Page, pageScale: number, rule: 'edge' | 'fractional'): Promise<Buffer> {
  const info = await page.evaluate(
    (opts) => window.spineHtmlHarness.cutRuleStage(opts),
    { ...POSE, pageScale, rule },
  );
  // A clipped or empty stage would compare two pictures of nothing.
  expect(info.imageCount).toBeGreaterThan(10);
  expect(info.contentBox.x).toBeGreaterThan(0);
  expect(info.contentBox.y).toBeGreaterThan(0);
  return stableShot(page);
}

/**
 * The parity spec's in-page diff, reduced to the two counters this needs: the
 * shift-tolerant bad count, and the content union it is measured against.
 */
async function diffInPage(
  page: Page,
  a: Buffer,
  b: Buffer,
): Promise<{ bad: number; contentUnion: number }> {
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
        throw new Error('screenshot size mismatch');
      }
      const pa = da.data;
      const pb = db.data;
      const w = da.width;
      const h = da.height;
      const bg = [pa[0], pa[1], pa[2]];
      const isContent = (p: Uint8ClampedArray, i: number): boolean =>
        !(
          Math.abs(p[i] - bg[0]) <= 8 &&
          Math.abs(p[i + 1] - bg[1]) <= 8 &&
          Math.abs(p[i + 2] - bg[2]) <= 8
        );
      // A pixel is bad only when nothing in the other image's 3×3 neighborhood
      // is within tolerance — sub-pixel displacement is forgiven, which is
      // exactly the error each rule trades against the other.
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
      let badAB = 0;
      let badBA = 0;
      let contentUnion = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const delta = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]),
        );
        if (delta > tolerance) {
          if (!matchesNear(pa, i, pb)) badAB++;
          if (!matchesNear(pb, i, pa)) badBA++;
        }
        if (isContent(pa, i) || isContent(pb, i)) contentUnion++;
      }
      return { bad: Math.max(badAB, badBA), contentUnion };
    },
    { aB64: a.toString('base64'), bB64: b.toString('base64'), tolerance: CHANNEL_TOLERANCE },
  );
}

test('the edge-rounded cut stays closer to the 1:1 page than fractional sampling', async ({
  page,
}, testInfo) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
  // Thrown away: it makes the reference below not the document's first raster.
  await capture(page, 1, 'edge');

  const reference = await capture(page, 1, 'edge');
  const edge = await capture(page, PAGE_SCALE, 'edge');
  const fractional = await capture(page, PAGE_SCALE, 'fractional');

  const edgeDiff = await diffInPage(page, reference, edge);
  const fractionalDiff = await diffInPage(page, reference, fractional);
  console.log(
    `[cut-rule] ${testInfo.project.name} ${PAGE_SCALE}× page vs 1:1: ` +
      `edge bad=${edgeDiff.bad}, fractional bad=${fractionalDiff.bad}, ` +
      `content union=${edgeDiff.contentUnion}`,
  );

  // The scene has to be drawn, and a rescaled page has to differ from the 1:1
  // one at all — otherwise both counts are zero and the comparison says nothing.
  expect(edgeDiff.contentUnion).toBeGreaterThan(5000);
  expect(edgeDiff.bad).toBeGreaterThan(0);
  expect(edgeDiff.bad).toBeLessThan(fractionalDiff.bad);
});
