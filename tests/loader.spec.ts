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

test('a skeleton that never arrives leaves no blob URL behind', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.loaderHttpFailureProbe());

  // A missing path is answered by the server, not by the library: this one is
  // a preview server with an SPA fallback, so it replies 200 with an HTML body
  // and the failure lands in the JSON read. The status is recorded rather than
  // pinned, and the HTTP-error branch is reached with a fetch double below.
  expect([200, 404]).toContain(probe.status);
  expect(probe.missingMessage).not.toBe('');
  expect(probe.missingCreatedUrls.length).toBeGreaterThan(0);
  expect([...probe.missingRevokedUrls].sort()).toEqual([...probe.missingCreatedUrls].sort());
  for (const url of probe.missingCreatedUrls) expect(probe.missingAliveAfter[url]).toBe(false);

  // The fetch rejects before the skeleton is ever read, and it rejects while
  // the atlas half is still unpacking — the case the one-call loader used to
  // get for free (both texts were fetched before any blob existed) and now has
  // to handle: the regions are already minted when the skeleton half fails.
  // Both halves go in flight together, as they did when one Promise.all
  // fetched both texts: the skeleton is asked for before the atlas is, so the
  // download does not wait for the atlas to be read, its pages to load and its
  // regions to be cut.
  expect(probe.fetchOrder[0]).toContain('spineboy-pro.json');
  expect(probe.fetchOrder[1]).toContain('spineboy.atlas');
  expect(probe.httpMessage).toContain('404');
  expect(probe.httpCreatedUrls.length).toBeGreaterThan(0);
  expect([...probe.httpRevokedUrls].sort()).toEqual([...probe.httpCreatedUrls].sort());
  for (const url of probe.httpCreatedUrls) expect(probe.httpAliveAfter[url]).toBe(false);
});

test('one atlas, two skeletons: regions are cut once and shared', async ({ page }) => {
  const shared = await page.evaluate(() => window.spineHtmlHarness.sharedAtlasProbe());
  // The same atlas through the one-call loader, for the count to compare with.
  const single = await page.evaluate(() => window.spineHtmlHarness.loaderProbe());

  // Minted once, not once per skeleton: the whole point of the two-step path.
  expect(shared.createdUrls.length).toBe(shared.regionCount);
  expect(shared.createdUrls.length).toBe(single.createdUrls.length);
  expect(shared.regionCount).toBe(single.regionCount);
  // Reading a skeleton owns no bitmaps, so it mints nothing at all.
  expect(shared.skeletonCreatedUrls).toEqual([]);

  // Both skeletons parsed, and both drew from the one shared map — ess is
  // rigid-only, pro deforms, so only pro is expected to have canvases.
  expect(shared.essAnimations).toContain('walk');
  expect(shared.proAnimations).toContain('walk');
  expect(shared.essElementCount).toBeGreaterThan(0);
  expect(shared.proElementCount).toBeGreaterThan(0);
  expect(shared.proCanvasCount).toBeGreaterThan(0);

  // Ownership runs the other way here than in the one-call loader: a read that
  // throws must leave the caller's assets whole, because the skeletons already
  // read from them still need the bitmaps. aliveBefore is sampled after that
  // failed read, so a loadSkeletonJson that disposed on failure fails here.
  expect(shared.badReadMessage).not.toBe('');
  expect(shared.badReadRevokedUrls).toEqual([]);
  for (const url of shared.createdUrls) expect(shared.aliveBefore[url]).toBe(true);

  // One dispose() for the shared assets, called twice: no duplicates, and
  // every URL dead afterwards.
  expect([...shared.revokedUrls].sort()).toEqual([...shared.createdUrls].sort());
  for (const url of shared.createdUrls) expect(shared.aliveAfter[url]).toBe(false);
});
