import { expect, test } from '@playwright/test';

/**
 * loadSkeletonAssets — the optional convenience loader.
 *
 * Driven through the harness page against the real spineboy export, so this
 * covers the wiring the twenty lines of boilerplate used to do by hand:
 * fetching both files, resolving page names relative to the atlas URL,
 * attaching the page textures, unpacking the regions, and freeing them again.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
});

test('loads an atlas + skeleton pair and renders from it', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.loaderProbe());

  expect(probe.animations).toContain('walk');
  expect(probe.pageCount).toBe(1);
  expect(probe.regionCount).toBeGreaterThan(0);
  // Page images resolved against the atlas URL's directory (the default),
  // proven by the frame actually drawing: rigid slots as <img>, spineboy-pro's
  // deform slots as per-part <canvas>.
  expect(probe.imageCount).toBeGreaterThan(0);
  expect(probe.canvasCount).toBeGreaterThan(0);
  expect(probe.rootChildrenAfterDispose).toBe(0);

  // dispose() frees exactly what the load minted — called twice, so a
  // non-idempotent implementation would show duplicates here.
  expect(probe.createdUrls.length).toBe(probe.regionCount);
  expect([...probe.revokedUrls].sort()).toEqual([...probe.createdUrls].sort());
  for (const url of probe.createdUrls) expect(probe.aliveAfter[url]).toBe(false);
});

test('a failed load leaves no blob URL behind', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.loaderFailureProbe());

  // The skeleton URL points at the atlas file: the regions unpack, then the
  // JSON read throws — the one step that could strand them.
  expect(probe.message).not.toBe('');
  expect(probe.createdUrls.length).toBeGreaterThan(0);
  expect([...probe.revokedUrls].sort()).toEqual([...probe.createdUrls].sort());
});
