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

/**
 * Orientation of a 90°-packed cut (#49).
 *
 * `cutRegion` turned the packed rect counter-clockwise — the same way the
 * packer had turned the artwork — so the bitmap came out 180° round and the
 * rigid tier drew every rotated part inverted, in every release up to 0.7.0.
 * Nothing here was in a position to see it: the rotated region above covers its
 * page and the one in the scaled-page fixture is a single flat colour, and the
 * only reference in the harness for a turned bitmap reimplemented the cut's own
 * transform, which agrees with the code under test whichever way both are
 * wrong.
 *
 * So this is asserted against **spine-core's UVs** and nothing else. A rotated
 * region's corners, in the rigid tier's order BL, UL, UR, BR, carry
 * `(u2, v2), (u, v2), (u, v), (u2, v)` — `tests/invariants.spec.ts` pins that
 * against whichever core is installed, on both supported generations — so a
 * point (s, t) of the artwork, s across and t down from its top-left corner,
 * samples the page at
 *
 *   UL + s·(UR − UL) + t·(BL − UL)  =  ( u + t·(u2 − u),  v2 + s·(v − v2) )
 *
 * in the continuous `uv * size` frame both raster backends already address
 * texels in. That is the read the official runtime performs, written out. Every
 * pixel of the cut is held against it, not just the four corners, so a rect
 * taken one texel off is as visible as a turn.
 */

interface Grid {
  width: number;
  height: number;
  pixels: string[];
}

const texel = (grid: Grid, x: number, y: number): string => grid.pixels[y * grid.width + x];

test('a 90°-packed cut holds the page texels spine-core names for its corners', async ({
  page,
}) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.rotatedCutProbe());

  for (const [where, sample] of Object.entries(probe)) {
    const { region, cut } = sample;
    const pageGrid = sample.page;

    // The premise. Both fixtures are packed rotated, and both are cut: a
    // rotated region never takes the whole-page pass-through, since that URL
    // holds artwork lying on its side.
    expect(region.degrees, where).toBe(90);
    expect(sample.minted, where).toBe(true);
    // The bitmap is the artwork upright — the transpose of its rect on the page.
    expect([cut.width, cut.height], where).toEqual([region.width, region.height]);

    /** The page texel spine-core's UVs put under this pixel of the artwork. */
    const fromPage = (cx: number, cy: number): string => {
      const s = (cx + 0.5) / cut.width;
      const t = (cy + 0.5) / cut.height;
      const u = region.u + t * (region.u2 - region.u);
      const v = region.v2 + s * (region.v - region.v2);
      return texel(pageGrid, Math.floor(u * pageGrid.width), Math.floor(v * pageGrid.height));
    };

    const corners = {
      UL: [0, 0],
      UR: [cut.width - 1, 0],
      BR: [cut.width - 1, cut.height - 1],
      BL: [0, cut.height - 1],
    } as const;
    const drawn = Object.fromEntries(
      Object.entries(corners).map(([corner, [x, y]]) => [corner, texel(cut, x, y)]),
    );
    expect(drawn, where).toEqual(
      Object.fromEntries(
        Object.entries(corners).map(([corner, [x, y]]) => [corner, fromPage(x, y)]),
      ),
    );

    // Not vacuous: four different colours meet in the middle of the packed
    // rect, so no quarter-turn and no mirror of this bitmap holds them in the
    // same corners. The old transform put UL's colour at BR and BR's at UL.
    expect(new Set(Object.values(drawn)).size, where).toBe(4);

    // …and every other pixel, which is what also catches a rect read off by a
    // texel or a cut that fell partly outside the region.
    const wrong: string[] = [];
    for (let cy = 0; cy < cut.height; cy++) {
      for (let cx = 0; cx < cut.width; cx++) {
        const drawnTexel = texel(cut, cx, cy);
        const named = fromPage(cx, cy);
        if (drawnTexel !== named && wrong.length < 5) {
          wrong.push(`(${cx},${cy}) is ${drawnTexel}, UVs name ${named}`);
        }
      }
    }
    expect(wrong, where).toEqual([]);
  }
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

/**
 * Pages shipped at a resolution their atlas does not declare (#32).
 *
 * The same synthetic artwork is painted at 0.5×, 1× and 2× of the declared
 * page size — painted at each resolution, never resampled from another — and
 * cut at all three. What must hold: the sizes a caller sees stay in atlas
 * units, each bitmap is the native size of the rect it came from, and every
 * cut is exactly its own flat colour. A source rect taken in declared pixels
 * (the defect) reads the wrong rectangle at 0.5× and 2× and mixes colours in.
 */

/** RegionImage.width/height: the same at every page resolution. */
const ATLAS_UNITS: Record<string, [number, number]> = {
  tl: [32, 16],
  tr: [32, 16],
  rot: [16, 32],
  br: [32, 16],
  whole: [24, 16],
  'odd-left': [31, 32],
  'odd-right': [33, 32],
};

/** One flat colour per region, mirroring SCALED_PAGE_COLORS in the harness. */
const REGION_COLORS: Record<string, string> = {
  tl: '#ff0000ff',
  tr: '#00ff00ff',
  rot: '#0000ffff',
  br: '#ffff00ff',
  whole: '#ff00ffff',
  'odd-left': '#00ffffff',
  'odd-right': '#ffffffff',
};

/**
 * Bitmap pixels each cut must decode to, per page resolution.
 *
 * Every one of these is the region's packed rect scaled onto the image — the
 * declared size never appears. `rot` is listed in artwork orientation, which
 * is the transpose of the 32×16 rect it occupies on the page.
 */
const CUT_PIXELS: Record<string, Record<string, [number, number]>> = {
  half: {
    tl: [16, 8],
    tr: [16, 8],
    rot: [8, 16],
    br: [16, 8],
    whole: [12, 8],
    'odd-left': [16, 16],
    'odd-right': [16, 16],
  },
  natural: {
    tl: [32, 16],
    tr: [32, 16],
    rot: [16, 32],
    br: [32, 16],
    whole: [24, 16],
    'odd-left': [31, 32],
    'odd-right': [33, 32],
  },
  double: {
    tl: [64, 32],
    tr: [64, 32],
    rot: [32, 64],
    br: [64, 32],
    whole: [48, 32],
    'odd-left': [62, 64],
    'odd-right': [66, 64],
  },
};

const RESOLUTIONS = ['half', 'natural', 'double'] as const;

test('a page may ship at a resolution the atlas does not declare', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.scaledPageProbe());

  // The premise: one declared size, three different images painted for it.
  expect(probe.declared).toEqual({
    'art.png': { width: 64, height: 32 },
    'whole.png': { width: 24, height: 16 },
    'odd.png': { width: 64, height: 32 },
  });
  expect(probe.half.pageSizes['art.png']).toEqual({ width: 32, height: 16 });
  expect(probe.natural.pageSizes['art.png']).toEqual({ width: 64, height: 32 });
  expect(probe.double.pageSizes['art.png']).toEqual({ width: 128, height: 64 });

  for (const resolution of RESOLUTIONS) {
    const sample = probe[resolution];
    const names = sample.regions.map((region) => region.name);
    expect(names, resolution).toEqual(Object.keys(ATLAS_UNITS));

    for (const region of sample.regions) {
      const where = `${resolution}/${region.name}`;

      // The sizes a caller sees are atlas units at every resolution: the rigid
      // tier writes them onto the <img> and divides the world corners by them,
      // so a bitmap's own resolution must not reach them.
      expect([region.width, region.height], where).toEqual(ATLAS_UNITS[region.name]);

      // Right pixels, asserted before the bookkeeping because this is the
      // oracle: each region is one flat colour and they tile their page, so a
      // cut taken from the wrong rectangle is not uniform (it carries a
      // neighbour's colour), is transparent (it ran off the image), or is not
      // its own colour at all.
      expect(region.uniform, where).toBe(true);
      expect(region.color, where).toBe(REGION_COLORS[region.name]);

      // And the bitmap is the native size of the rect it was cut from — half
      // the pixels per axis at 0.5×, double at 2×. Upscaling every cut back to
      // declared size (what a consumer's fork of unpackRegions did) keeps the
      // colours right and fails here, which is the point of asserting both.
      expect([region.pixelWidth, region.pixelHeight], where).toEqual(
        CUT_PIXELS[resolution][region.name],
      );
    }
  }
});

test('a rotated region comes out upright at every page resolution', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.scaledPageProbe());

  // (d) `rot` is packed on its side: a 32×16 rect on the page holding 16×32 of
  // artwork. The cut has to be the transpose of the rect, scaled — swapping
  // the scaled width and height instead reads a rect that runs off the page,
  // which lands as transparent rows rather than the region's colour.
  for (const resolution of RESOLUTIONS) {
    const rot = probe[resolution].regions.find((region) => region.name === 'rot');
    expect(rot, resolution).toBeDefined();
    expect([rot?.width, rot?.height], resolution).toEqual([16, 32]);
    expect([rot?.pixelWidth, rot?.pixelHeight], resolution).toEqual(
      CUT_PIXELS[resolution]['rot'],
    );
    // Portrait bitmap, one opaque colour: a cut that was never turned back
    // upright is landscape, half transparent, or both.
    expect((rot?.pixelHeight ?? 0) / (rot?.pixelWidth ?? 1), resolution).toBe(2);
    expect(rot?.uniform, resolution).toBe(true);
    expect(rot?.color, resolution).toBe(REGION_COLORS['rot']);
  }
});

test('a whole-page region passes through at every page resolution', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.scaledPageProbe());

  // (e) "Whole page" is a statement about the declared size, so it holds at
  // any image resolution: the URL is the page's own and nothing is minted for
  // it. Six of the seven regions are cut; `whole` is the one that is not.
  for (const resolution of RESOLUTIONS) {
    const sample = probe[resolution];
    expect(sample.mintedCount, resolution).toBe(6);
    const whole = sample.regions.find((region) => region.name === 'whole');
    expect(whole?.passedThrough, resolution).toBe(true);
    for (const region of sample.regions) {
      if (region.name === 'whole') continue;
      expect(region.passedThrough, `${resolution}/${region.name}`).toBe(false);
    }
  }
});

test('neighbouring cuts tile the image on a boundary that falls mid-pixel', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.scaledPageProbe());

  // odd.png is split at x = 31 of 64 declared, which is x = 15.5 on the
  // half-resolution image. Each edge is rounded to the nearest pixel, so the
  // two cuts still tile the image exactly — 16 + 16 = 32. Rounding outward
  // instead gives 16 + 17, and the extra column is the neighbour's colour;
  // rounding inward leaves a column belonging to neither.
  for (const resolution of RESOLUTIONS) {
    const sample = probe[resolution];
    const left = sample.regions.find((region) => region.name === 'odd-left');
    const right = sample.regions.find((region) => region.name === 'odd-right');
    const pageWidth = sample.pageSizes['odd.png']?.width;
    expect((left?.pixelWidth ?? 0) + (right?.pixelWidth ?? 0), resolution).toBe(pageWidth);
    expect(left?.pixelHeight, resolution).toBe(sample.pageSizes['odd.png']?.height);
    // And neither cut carries the other's colour, which is the bleed itself.
    expect(left?.uniform, resolution).toBe(true);
    expect(right?.uniform, resolution).toBe(true);
  }
});

test('a half-resolution page renders the same rigid boxes', async ({ page }) => {
  const probe = await page.evaluate(() => window.spineHtmlHarness.halfResRenderProbe());

  // (f) The premise: one atlas declaring 1024×256, rendered once against the
  // page image that ships at that size and once against a 512×128 build of it.
  expect(probe.declared).toEqual({ width: 1024, height: 256 });
  expect(probe.fullPage).toEqual({ width: 1024, height: 256 });
  expect(probe.halfPage).toEqual({ width: 512, height: 128 });

  expect(probe.full.length).toBeGreaterThan(0);
  expect(probe.half.length).toBe(probe.full.length);

  // The bitmaps really are smaller — otherwise the comparison below is vacuous.
  // Half an axis to within a pixel, and not `round(size / 2)`: the cut rounds
  // each *edge*, so a region of odd size sitting at an odd offset keeps the
  // pixel its neighbour does not (21 px at y = 21 cuts to 10, not 11). That is
  // the tiling rule, and 2 × half − full ∈ {−1, 0, 1} is exactly what it allows.
  for (let i = 0; i < probe.full.length; i++) {
    const full = probe.full[i];
    const half = probe.half[i];
    expect(Math.abs(half.naturalWidth * 2 - full.naturalWidth), `slot ${i}`).toBeLessThanOrEqual(1);
    expect(Math.abs(half.naturalHeight * 2 - full.naturalHeight), `slot ${i}`).toBeLessThanOrEqual(
      1,
    );
    expect(half.naturalWidth, `slot ${i}`).toBeLessThan(full.naturalWidth);
    expect(half.naturalHeight, `slot ${i}`).toBeLessThan(full.naturalHeight);
    // …and the layout box and the matrix that poses it are untouched, because
    // RegionImage sizes are atlas units. renderRegion needs no change for any
    // of this: it reads those two numbers and nothing else about the bitmap.
    expect(half.attrWidth, `slot ${i}`).toBe(full.attrWidth);
    expect(half.attrHeight, `slot ${i}`).toBe(full.attrHeight);
    expect(half.rect, `slot ${i}`).toEqual(full.rect);
  }
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
