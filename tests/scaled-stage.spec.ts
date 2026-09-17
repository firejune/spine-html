import { expect, type Page, test } from '@playwright/test';
import type { ScaledStageSnapshot } from './harness';

/**
 * syncPixelRatio() against a root under a CSS-scaled ancestor.
 *
 * The mesh tier rasters at `world × pixelRatio`, in the root's own
 * coordinates, so a `transform: scale(z)` on an ancestor — how a pan/zoom
 * stage is built — oversamples it by 1/z² in backing pixels unless the zoom is
 * folded into the ratio. Nothing about that is visible in a frame: the picture
 * is correct at any ratio, only the allocation differs, which is why this goes
 * through the harness like backing.spec.ts and shares its oracle. A renderer
 * that synced under the wrapper must hold exactly the backing a renderer
 * freshly given that ratio allocates, canvas by canvas — an equality, so no
 * threshold, no platform-dependent number, and no milliseconds anywhere.
 */

function probe(page: Page) {
  return page.evaluate(() => window.spineHtmlHarness.scaledStageProbe());
}

function pixels(snapshot: ScaledStageSnapshot): number {
  return snapshot.backing.reduce((sum, size) => sum + size.width * size.height, 0);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
});

test('a scaled stage syncs to the fresh-renderer backing, canvas by canvas', async ({ page }) => {
  const result = await probe(page);

  expect(result.meshCanvasCount).toBeGreaterThan(0);
  // The stage really is scaled: the harness's own probe of the root reads
  // 100 px × zoom, so the equality below cannot pass on an unscaled stage.
  expect(result.scaledMeasuredPx).toBeCloseTo(100 * result.zoom, 6);
  expect(result.syncedRatio).toBeCloseTo(result.devicePixelRatio * result.zoom, 6);
  expect(result.scaledSynced.pixelRatio).toBeCloseTo(result.syncedRatio, 6);

  expect(result.scaledSynced.backing.length).toBe(result.meshCanvasCount);
  expect(result.freshScaled.backing.length).toBe(result.meshCanvasCount);
  expect(result.scaledSynced.backing).toEqual(result.freshScaled.backing);
  // Guard against a vacuous pass: the unsynced stage really was oversampling,
  // so "equals fresh" is not something every renderer here satisfies.
  expect(pixels(result.scaledDefault)).toBeGreaterThan(pixels(result.scaledSynced));
});

test('meshBackingPixels is the sum of the canvas backing stores, before and after', async ({
  page,
}) => {
  const result = await probe(page);

  for (const snapshot of [
    result.scaledDefault,
    result.afterSync,
    result.scaledSynced,
    result.freshScaled,
  ]) {
    expect(snapshot.reportedBackingPixels).toBe(snapshot.domBackingPixels);
  }
  // Non-zero, and it really moves with the ratio — otherwise the equality
  // above would hold for a getter that returns a constant.
  expect(result.scaledSynced.reportedBackingPixels).toBeGreaterThan(0);
  expect(result.scaledDefault.reportedBackingPixels).toBeGreaterThan(
    result.scaledSynced.reportedBackingPixels,
  );
  // The sync itself allocates nothing: it moves the ratio, the next render
  // acts on it.
  expect(result.afterSync.backing).toEqual(result.scaledDefault.backing);
});

test('a second sync changes nothing and reallocates nothing', async ({ page }) => {
  const result = await probe(page);

  expect(result.syncedRatioAgain).toBe(result.syncedRatio);
  expect(result.scaledSyncedAgain.reallocCount).toBe(0);
  expect(result.scaledSyncedAgain.backing).toEqual(result.scaledSynced.backing);
  // The frame was not a dirty-skip either — the meshes really re-rendered at
  // the synced ratio.
  expect(result.scaledSynced.reallocCount).toBe(result.meshCanvasCount);
});

test('a ratio already inside the deadband is left exactly as it is', async ({ page }) => {
  const result = await probe(page);

  // 0.04% off the measured ratio. Rewriting pixelRatio recreates every mesh
  // canvas's GPU surface, so a difference this small must not be acted on —
  // layout reads jitter below it.
  expect(result.deadband.measuredPx).toBeCloseTo(100 * result.zoom, 6);
  expect(result.deadband.ratioBefore).not.toBe(result.syncedRatio);
  expect(result.deadband.returned).toBe(result.deadband.ratioBefore);
  expect(result.deadband.ratioAfter).toBe(result.deadband.ratioBefore);
  expect(result.deadband.after.reallocCount).toBe(0);
});

test('a root that is not laid out leaves the ratio alone', async ({ page }) => {
  const result = await probe(page);

  // display:none above the root: the probe box has no layout, so there is no
  // measurement and nothing to decide from. The marker ratio (3) is one no
  // measurement in this run could produce.
  expect(result.hidden.measuredPx).toBe(0);
  expect(result.hidden.ratioBefore).toBe(3);
  expect(result.hidden.returned).toBe(3);
  expect(result.hidden.ratioAfter).toBe(3);
  expect(result.hidden.after.reallocCount).toBe(0);
});

test('an unscaled root syncs to devicePixelRatio and reallocates nothing', async ({ page }) => {
  const result = await probe(page);

  // The negative control: no transform above the root, so the answer is the
  // device ratio and the backing must not move at all.
  expect(result.unscaled.measuredPx).toBeCloseTo(100, 6);
  expect(result.unscaled.returned).toBeCloseTo(result.devicePixelRatio, 6);
  expect(result.unscaled.ratioAfter).toBeCloseTo(result.devicePixelRatio, 6);
  expect(result.unscaled.after.reallocCount).toBe(0);
  expect(result.unscaled.after.backing.length).toBe(result.meshCanvasCount);
});

test('the sync leaves no probe behind and does not touch the slot elements', async ({ page }) => {
  const result = await probe(page);

  const { residue } = result;
  // Non-vacuous: the root really is full of slot elements at this point.
  expect(residue.childCountBefore).toBeGreaterThan(0);
  expect(residue.tagsBefore.filter((tag) => tag === 'canvas').length).toBe(result.meshCanvasCount);
  expect(residue.childCountAfter).toBe(residue.childCountBefore);
  expect(residue.tagsAfter).toEqual(residue.tagsBefore);
  // Same elements, same order — identity, compared in the page. A probe left
  // in the root, or slot elements re-created around it, breaks this.
  expect(residue.sameElements).toBe(true);
});
