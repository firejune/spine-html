import { expect, test } from '@playwright/test';

/**
 * loadSkeletonBinary — the `spine-html/binary` entry point.
 *
 * Driven through the harness page against the real spineboy export, which
 * ships both formats of the same skeleton. That is the whole oracle: the JSON
 * read of the same file, against the same atlas assets, inside the same run.
 * A binary reader that got something subtly wrong would still produce a
 * plausible skeleton on its own — it cannot produce the JSON reader's one.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
});

test('a .skel read is the same skeleton as the .json read', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.binaryProbe());

  // Structure, in the terms a format must preserve exactly.
  expect(probe.binary.animations).toEqual(probe.json.animations);
  expect(probe.binary.animations).toContain('walk');
  expect(probe.binary.boneCount).toBe(probe.json.boneCount);
  expect(probe.binary.slotCount).toBe(probe.json.slotCount);
  expect(probe.binary.skins).toEqual(probe.json.skins);
  expect(probe.binary.boneCount).toBeGreaterThan(0);
  expect(probe.binary.slotCount).toBeGreaterThan(0);
  expect(probe.binary.skins.length).toBeGreaterThan(0);

  // Picture structure, from the deterministic pose: the two reads put the
  // same number of rigid <img> and mesh <canvas> elements in their roots.
  // Both non-zero, so this is spineboy-pro drawing through both tiers and not
  // two empty roots agreeing with each other.
  expect(probe.binary.imageCount).toBe(probe.json.imageCount);
  expect(probe.binary.canvasCount).toBe(probe.json.canvasCount);
  expect(probe.binary.imageCount).toBeGreaterThan(0);
  expect(probe.binary.canvasCount).toBeGreaterThan(0);
});

test('reading a .skel against shared atlas assets mints nothing', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.binaryProbe());

  // The atlas half cut exactly one set of regions; the reads own no bitmaps,
  // so between them they minted no blob URL at all — in either format.
  expect(probe.createdUrls.length).toBe(probe.regionCount);
  expect(probe.regionCount).toBeGreaterThan(0);
  expect(probe.skeletonCreatedUrls).toEqual([]);
  expect(probe.httpCreatedUrls).toEqual([]);
});

test('scale is honoured by the binary reader', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.binaryProbe());

  // A setup bone length, read straight off the export: no world transform and
  // no renderer between the reader's scale and this number. The factor is 0.5,
  // a power of two, so scaling is exact in binary floating point and the
  // tolerance only has to absorb the JSON round-trip out of the browser. The
  // 9 below is an absolute 5e-10 on a value near 42 — four orders of magnitude
  // above the f64 spacing there, and far below any error a wrong scale makes
  // (the mutant that drops `scale` misses by the whole 21.26).
  expect(probe.unscaledBoneLength).toBeGreaterThan(0);
  expect(probe.scaledBoneLength).toBeCloseTo(probe.unscaledBoneLength * probe.scaleFactor, 9);
  expect(probe.scaledBoneLength).not.toBe(probe.unscaledBoneLength);
});

test('a failed .skel read revokes nothing it does not own', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.binaryProbe());

  // Two failure shapes: a body that is not a .skel (the atlas file), and a
  // real HTTP error through a fetch double. Both reject, and neither may take
  // the caller's assets with it — the skeletons already read from them are
  // still using the bitmaps.
  expect(probe.badReadMessage).not.toBe('');
  expect(probe.badReadRevokedUrls).toEqual([]);
  expect(probe.httpMessage).toContain('404');
  expect(probe.httpRevokedUrls).toEqual([]);

  // aliveBefore is sampled after both failures, so a loadSkeletonBinary that
  // disposed on failure fails here rather than passing quietly.
  for (const url of probe.createdUrls) expect(probe.aliveBefore[url]).toBe(true);

  // The caller's one dispose(), called twice: no duplicates, everything dead.
  expect([...probe.revokedUrls].sort()).toEqual([...probe.createdUrls].sort());
  for (const url of probe.createdUrls) expect(probe.aliveAfter[url]).toBe(false);
});
