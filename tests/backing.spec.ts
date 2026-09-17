import { expect, type Page, test } from '@playwright/test';
import type { BackingSnapshot } from './harness';

/**
 * Mesh-canvas backing stores across a pixelRatio change.
 *
 * `pixelRatio` is documented as reallocating every mesh canvas on the next
 * frame, and it does — but the picture is identical whatever size it lands on
 * (the CSS size mirrors the backing, so the mapping stays 1:1), which is why a
 * backing that never comes back down after a ratio *drop* is invisible to the
 * screenshot tests. Hence the harness and an A/B oracle inside one run: a
 * renderer switched to a ratio must hold exactly the backing a renderer
 * freshly given that ratio allocates, canvas by canvas. Equality, so there is
 * no threshold and no platform-dependent number here — and no absolute
 * milliseconds, per the standing rule.
 */

function probe(page: Page) {
  return page.evaluate(() => window.spineHtmlHarness.backingProbe());
}

/** Total allocated backing pixels — the quantity the defect leaves stuck. */
function pixels(snapshot: BackingSnapshot): number {
  return snapshot.backing.reduce((sum, size) => sum + size.width * size.height, 0);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
});

test('a pixelRatio drop sizes every mesh backing like a fresh renderer', async ({ page }) => {
  const result = await probe(page);

  expect(result.meshCanvasCount).toBeGreaterThan(0);
  expect(result.liveShrunk.backing.length).toBe(result.meshCanvasCount);
  expect(result.freshLow.backing.length).toBe(result.meshCanvasCount);
  // Canvas by canvas, in draw order — a per-canvas equality, not a total.
  expect(result.liveShrunk.backing).toEqual(result.freshLow.backing);
  // Guard against a vacuous pass: the two ratios must really differ in size,
  // otherwise "equals fresh" would hold for a renderer that changed nothing.
  expect(pixels(result.liveHigh)).toBeGreaterThan(pixels(result.freshLow));
});

test('the switch reallocates each mesh canvas once, and the frame after it none', async ({
  page,
}) => {
  const result = await probe(page);

  expect(result.liveShrunk.reallocCount).toBe(result.meshCanvasCount);
  // Rendering the same pose again must settle: no second GPU surface churn,
  // and the sizes stay where the switch put them.
  expect(result.liveShrunkAgain.reallocCount).toBe(0);
  expect(result.liveShrunkAgain.backing).toEqual(result.liveShrunk.backing);
});

test('a pixelRatio raise lands on the fresh renderer sizes too', async ({ page }) => {
  const result = await probe(page);

  expect(result.liveGrown.backing).toEqual(result.freshHigh.backing);
  expect(result.liveGrown.reallocCount).toBe(result.meshCanvasCount);
});

test('grow-only survives: a smaller pose at the same ratio keeps its backing', async ({ page }) => {
  const result = await probe(page);

  // The ratio never moves and every mesh bbox shrinks. Grow-only means the
  // backing must not follow it down: a deforming mesh changes its bbox every
  // frame, and chasing it would recreate GPU surfaces per frame. This is the
  // assertion an "always size from the need" repair breaks.
  expect(result.holdAfter.backing).toEqual(result.holdBefore.backing);
  expect(result.holdAfter.reallocCount).toBe(0);
  // …and the frame was not a dirty-skip: every mesh really did re-rasterize
  // at its new, smaller bbox.
  expect(result.holdAfter.meshDrawnCount).toBe(result.meshCanvasCount);
});

test('the CSS size mirrors the backing after a ratio switch', async ({ page }) => {
  const result = await probe(page);

  // backing / ratio, so the mesh keeps its on-screen size and the pixel
  // mapping stays 1:1 — the reason the defect is invisible in a screenshot.
  for (const [index, size] of result.liveShrunk.backing.entries()) {
    expect(result.liveShrunk.css[index]).toEqual({
      width: `${size.width / 0.5}px`,
      height: `${size.height / 0.5}px`,
    });
  }
  for (const [index, size] of result.liveGrown.backing.entries()) {
    expect(result.liveGrown.css[index]).toEqual({
      width: `${size.width / 2}px`,
      height: `${size.height / 2}px`,
    });
  }
});
