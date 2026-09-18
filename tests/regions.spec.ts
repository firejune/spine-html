import { expect, test } from '@playwright/test';

/**
 * Region unpacking: blob URL ownership and lifetime.
 *
 * Driven through the harness page (harness.html/.ts), not the demo — the leak
 * this guards is invisible in a rendered frame. The oracle is the browser
 * itself: an object URL that was revoked stops resolving, one that was not
 * still fetches.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
});

test('revokeRegions frees every unpacked URL and nothing else', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.unpackProbe());

  expect(probe.regions.map((region) => region.name)).toEqual(['half-left', 'half-right']);
  const regionUrls = probe.regions.map((region) => region.url);
  for (const url of regionUrls) expect(url).toMatch(/^blob:/);
  // Both regions are sub-rects of the page, so each one is cut into its own blob.
  expect([...probe.createdUrls].sort()).toEqual([...regionUrls].sort());

  for (const url of [probe.pageUrl, ...regionUrls]) expect(probe.aliveBefore[url]).toBe(true);

  // The leak: before this fix nothing ever revoked these, so a load/unload
  // cycle (cutscenes) stranded one blob per region for the document's life.
  // Called twice in the probe — idempotent, so still exactly one revoke each.
  expect([...probe.revokedUrls].sort()).toEqual([...regionUrls].sort());
  for (const url of regionUrls) expect(probe.aliveAfter[url]).toBe(false);
  // The page image URL is the caller's, not ours: it must survive.
  expect(probe.aliveAfter[probe.pageUrl]).toBe(true);
});

test('a region covering its whole page reuses the page image', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.passThroughProbe());
  const region = (name: string) => probe.regions.find((entry) => entry.name === name);

  // One part per page: the cut would reproduce the page pixel for pixel, so
  // the page URL is handed through — no canvas, no PNG re-encode, no copy.
  expect(region('whole')).toEqual({
    name: 'whole',
    url: probe.pageUrls['part.png'],
    width: 64,
    height: 32,
  });
  // Still cut: a sub-rect, and a region that covers its page but is packed
  // rotated (the bitmap has to be turned upright).
  expect(region('sub')?.url).toMatch(/^blob:/);
  expect(region('whole-rotated')).toEqual({
    name: 'whole-rotated',
    url: expect.stringMatching(/^blob:/),
    width: 64,
    height: 32,
  });
  // Exactly the two cut regions were encoded — that count is the pass-through.
  expect(probe.createdUrls.length).toBe(2);

  // Pass-through URLs belong to the caller: revokeRegions must not free them,
  // or the whole atlas would go blank on the next load/unload cycle.
  expect(probe.aliveAfter[probe.pageUrls['part.png']]).toBe(true);
  expect(probe.aliveAfter[probe.pageUrls['rot.png']]).toBe(true);
  for (const url of probe.createdUrls) expect(probe.aliveAfter[url]).toBe(false);
});

test('a failed unpack revokes what it already minted', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.unpackFailureProbe());

  expect(probe.message).toContain('Missing page image: missing.png');
  // The first page unpacked before the second one threw.
  expect(probe.createdUrls.length).toBe(1);
  expect([...probe.revokedUrls].sort()).toEqual([...probe.createdUrls].sort());
  for (const url of probe.createdUrls) expect(probe.aliveAfter[url]).toBe(false);
});

/**
 * Concurrent cuts.
 *
 * PNG encoding is asynchronous and off the main thread, so awaiting one
 * `toBlob` per region made a load cost the sum of every encode — minutes in a
 * throttled background tab. The encodes are started together now, and these
 * four are what that is allowed to cost: the counter that says they overlap,
 * and the three properties the serial loop used to hand over for free.
 *
 * Nothing here is timed. The oracle is `toBlob` itself, wrapped by the probes
 * so the overlap is a count and the arrival order is chosen rather than raced.
 */

/**
 * Mirror of CUT_BACKING_BUDGET_PX in src/DomTexture.ts — private there on
 * purpose (it is a measurement, not a knob), so the guard restates it. 4 Mpx is
 * one 2048×2048 page's worth, ≈ 16 MiB of canvas backing at 4 bytes/px.
 */
const CUT_BACKING_BUDGET_PX = 4 * 1024 * 1024;

test('region cuts encode concurrently, bounded by the backing budget', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.cutConcurrencyProbe());

  // The defect, as a counter: awaited one at a time this peak is exactly 1.
  expect(probe.small.cuts.callCount).toBe(6);
  expect(probe.small.cuts.peakInFlight).toBe(6);

  // The real atlas: 40 regions, all cut, all in flight at once — and the
  // canvases they hold while they are is a fraction of the budget, so nothing
  // about the demo's own load is throttled by it.
  expect(probe.spineboy.regionCount).toBe(40);
  expect(probe.spineboy.cuts.callCount).toBe(40);
  expect(probe.spineboy.cuts.peakInFlight).toBe(40);
  expect(probe.spineboy.cuts.peakInFlightPixels).toBe(probe.spineboy.totalCutPixels);
  expect(probe.spineboy.cuts.peakInFlightPixels).toBeLessThan(CUT_BACKING_BUDGET_PX);

  // Six 1024×1024 cuts are 6.29 Mpx of backing — more than may be held at
  // once, so this is where the budget is observable rather than vacuous: still
  // concurrent, but not all of them, and never over the budget.
  expect(probe.budgeted.cuts.callCount).toBe(6);
  expect(probe.budgeted.totalCutPixels).toBe(6 * 1024 * 1024);
  expect(probe.budgeted.cuts.peakInFlight).toBeGreaterThan(1);
  expect(probe.budgeted.cuts.peakInFlight).toBeLessThan(probe.budgeted.cuts.callCount);
  expect(probe.budgeted.cuts.peakInFlightPixels).toBeLessThanOrEqual(CUT_BACKING_BUDGET_PX);
});

test('the map keeps atlas order when the blobs come back backwards', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.cutOrderProbe());

  // Not vacuous: the trap held all six blobs and handed them back last-first.
  expect(probe.order.deadlineHit).toBe(false);
  expect(probe.order.deliveryOrder).toEqual([5, 4, 3, 2, 1, 0]);

  expect(probe.atlasNames).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  expect(probe.mapNames).toEqual(probe.atlasNames);
  // Sizes travel with the blob, so a blob landing in the wrong region's slot
  // shows up here even if the keys happened to come out in order.
  expect(probe.regions.map((region) => [region.width, region.height])).toEqual([
    [10, 4],
    [11, 5],
    [12, 6],
    [13, 7],
    [14, 8],
    [15, 9],
  ]);
});

test('a duplicate name resolves to the last region in atlas order', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.cutOrderProbe());

  expect(probe.dupOrder.deadlineHit).toBe(false);
  expect(probe.dupOrder.deliveryOrder).toEqual([2, 1, 0]);
  expect(probe.dupAtlasNames).toEqual(['dup', 'solo', 'dup']);
  expect(probe.dupMapNames).toEqual(['dup', 'solo']);

  // The later 'dup' is the 8×8 one. Its blob was delivered *first*, so an
  // implementation that let arrival order decide would keep the 20×20 one.
  expect(probe.dupRegions.find((region) => region.name === 'dup')).toEqual({
    name: 'dup',
    url: expect.stringMatching(/^blob:/),
    width: 8,
    height: 8,
  });

  // Three cuts, two names: the shadowed URL is freed by unpackRegions itself,
  // rather than left in the ledger with nothing left pointing at it.
  expect(probe.dupCreatedUrls.length).toBe(3);
  const live = probe.dupCreatedUrls.filter((url) => probe.dupAliveAfterUnpack[url]);
  expect(live.length).toBe(probe.dupMapNames.length);
  expect([...live].sort()).toEqual([...probe.dupRegions.map((region) => region.url)].sort());
});

test('a cut that fails with others in flight strands none of them', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.cutFlightFailureProbe());

  expect(probe.message).toContain('toBlob failed');
  // Not vacuous: three encodes were still outstanding when the failure landed,
  // which is the case a serial loop could never produce.
  expect(probe.cuts.callCount).toBe(4);
  expect(probe.inFlightAtFailure).toBe(3);

  // Those three blobs arrived after the error was already known, so their URLs
  // are minted late — and revoked anyway, before the rejection propagates.
  // Liveness here is sampled after the held callbacks were all delivered.
  expect(probe.createdUrls.length).toBe(3);
  expect([...probe.revokedUrls].sort()).toEqual([...probe.createdUrls].sort());
  for (const url of probe.createdUrls) expect(probe.aliveAfter[url]).toBe(false);

  // Waiting for the stragglers must not leave a rejection for the window to
  // find: the cuts settle, they never reject on their own.
  expect(probe.unhandledRejections).toBe(0);
});
