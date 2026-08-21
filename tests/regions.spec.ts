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
