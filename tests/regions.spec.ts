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

test('a failed unpack revokes what it already minted', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.unpackFailureProbe());

  expect(probe.message).toContain('Missing page image: missing.png');
  // The first page unpacked before the second one threw.
  expect(probe.createdUrls.length).toBe(1);
  expect([...probe.revokedUrls].sort()).toEqual([...probe.createdUrls].sort());
  for (const url of probe.createdUrls) expect(probe.aliveAfter[url]).toBe(false);
});
