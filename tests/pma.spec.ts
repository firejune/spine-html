import { expect, type Page, test } from '@playwright/test';

/**
 * Premultiplied atlas pages (`pma: true`) — one picture, whatever the page's
 * alpha convention is.
 *
 * Spine's texture packer premultiplies by default, so a consumer atlas usually
 * carries `pma: true`: the page's RGB is already multiplied by its alpha. The
 * DOM and canvas 2D have no such mode — an <img> and `drawImage` composite
 * straight alpha by definition — and the GL mesh backend used to premultiply
 * every upload. Both multiplied such a page a second time, and every
 * semi-transparent texel came out darker than it was authored: soft edges, soft
 * shadows, glows (#37). The defect is one-directional by construction, which is
 * what the counts below are built around.
 *
 * ## The fixture
 *
 * Built in the test, not committed: the page that ships, with
 * `rgb = round(rgb * a / 255)` written into it, served under the same atlas text
 * plus a `pma: true` line. Rendered correctly the twin and the original are the
 * same picture, so every cell here is an A/B of two encodings of one artwork —
 * no golden, nothing platform-specific, exactly the parity suite's strategy.
 *
 * The twin's PNG is encoded byte by byte in the harness rather than through
 * `canvas.toBlob`, because a 2D canvas stores premultiplied colour and would
 * quantize the values on the way out — by up to ~12 of 255 around alpha 11,
 * which is the same order as the residue being measured. See `pmaFixtureProbe`,
 * which measures that the fixture is exact where a canvas can see it at all.
 *
 * ## What the residue is
 *
 * The DOM and canvas2d tiers read a straight-alpha derivation of the page,
 * produced with `rgb = round(rgb * 255 / a)`. That division happens in 8 bits
 * and starts from a canvas read, which has already quantized a premultiplied
 * texel: the ceiling is `min(a, 127.5/a + 0.5)` — nothing at a = 255 or a = 0,
 * ≤ 1 above a = 128, worst ~12 around a = 11. The GL backend has no such cost
 * (a `pma` page is uploaded unconverted, which is lossless), so cell (b) below
 * — canvas2d against webgl on the twin — is the direct measurement of what the
 * 8-bit un-premultiply loses.
 *
 * DIRECTIONAL_TOLERANCE is therefore what separates the two: it sits above the
 * derivation's analytic ceiling and far below the defect's amplitude.
 */

const POSE = { animation: 'walk', time: 1.2 } as const;

/** The parity suite's CHANNEL_TOLERANCE, so "bad" means here what it means there. */
const CHANNEL_TOLERANCE = 24;
/** The parity suite's BAD_RATIO_LIMIT — not to be tuned here, only measured against. */
const BAD_RATIO_LIMIT = 0.005;
/**
 * Above this per-channel move, a pixel counts as darker or lighter than the
 * reference. 16 clears the un-premultiply's analytic ceiling of ~12 (measured
 * peak across every cell here: 11) and sits well under the defect, which
 * darkens by ~38 luma on average and up to ~76.
 */
const DIRECTIONAL_TOLERANCE = 16;
/**
 * Directional pixels allowed, as a fraction of drawn content. Measured: the
 * repair leaves zero on either engine, at either page scale, on every tier;
 * ignoring the flag paints 9.2–10.6% of content, all on the one side. The limit
 * sits 45× under that and above a floor of nothing, so it is headroom against a
 * browser-raster change rather than a calibration against either population.
 */
const DIRECTIONAL_LIMIT = 0.002;

interface Diff {
  /** Shift-tolerant bad pixels and the content they are measured against. */
  bad: number;
  rawBad: number;
  contentUnion: number;
  maxDelta: number;
  /** Content pixels that moved by more than DIRECTIONAL_TOLERANCE, by direction. */
  darker: number;
  lighter: number;
  /** Mean and peak luma drop over the darker set — the defect's amplitude. */
  darkerMean: number;
  darkerMax: number;
}

/**
 * Screenshots the stage until two captures in a row are byte-identical (the
 * cut-rule spec's rule: a freshly decoded bitmap is not yet a settled raster).
 */
async function stableShot(page: Page): Promise<Buffer> {
  const stage = page.locator('#pma-stage');
  let previous = await stage.screenshot();
  for (let attempt = 0; attempt < 12; attempt++) {
    const next = await stage.screenshot();
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error('the stage raster never settled');
}

async function capture(
  page: Page,
  options: {
    page: 'straight' | 'pma';
    skeleton: 'ess' | 'pro';
    backend: 'canvas2d' | 'webgl';
    pageScale: number;
  },
): Promise<Buffer> {
  const info = await page.evaluate(
    (opts) => window.spineHtmlHarness.pmaStage(opts),
    { ...POSE, ...options },
  );
  // A clipped or empty stage would compare two pictures of nothing, and a flag
  // that never arrived would compare the shipped page with itself.
  expect(info.pagePma).toBe(options.page === 'pma');
  expect(info.imageCount + info.canvasCount).toBeGreaterThan(10);
  expect(info.contentBox.x).toBeGreaterThan(0);
  expect(info.contentBox.y).toBeGreaterThan(0);
  if (options.skeleton === 'pro') {
    expect(info.meshesDrawn).toBeGreaterThan(0);
    // Guard the guard: a webgl cell that silently fell back to canvas2d would
    // pass by comparing the 2d path with itself.
    expect(info.backendActive).toBe(options.backend);
  }
  return stableShot(page);
}

/**
 * The parity spec's in-page diff, plus the directional split this needs: a
 * doubled premultiply can only darken, so which *side* the differences fall on
 * is the signature, not their count.
 */
async function diffInPage(page: Page, a: Buffer, b: Buffer): Promise<Diff> {
  return page.evaluate(
    async ({ aB64, bB64, tolerance, directional }): Promise<Diff> => {
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
      const luma = (p: Uint8ClampedArray, i: number): number =>
        p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;

      let rawBad = 0;
      let badAB = 0;
      let badBA = 0;
      let maxDelta = 0;
      let contentUnion = 0;
      let darker = 0;
      let lighter = 0;
      let darkerSum = 0;
      let darkerMax = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const delta = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]),
        );
        if (delta > maxDelta) maxDelta = delta;
        if (delta > tolerance) {
          rawBad++;
          if (!matchesNear(pa, i, pb)) badAB++;
          if (!matchesNear(pb, i, pa)) badBA++;
        }
        const ca = isContent(pa, i);
        const cb = isContent(pb, i);
        if (ca || cb) contentUnion++;
        // Direction is read on content only: B (the page under test) against A
        // (the reference), per channel, so a tint cannot cancel itself out.
        if ((ca || cb) && delta > directional) {
          const drop = luma(pa, i) - luma(pb, i);
          if (drop > 0) {
            darker++;
            darkerSum += drop;
            if (drop > darkerMax) darkerMax = drop;
          } else {
            lighter++;
          }
        }
      }
      return {
        bad: Math.max(badAB, badBA),
        rawBad,
        contentUnion,
        maxDelta,
        darker,
        lighter,
        darkerMean: darker ? Math.round((darkerSum / darker) * 100) / 100 : 0,
        darkerMax: Math.round(darkerMax * 100) / 100,
      };
    },
    {
      aB64: a.toString('base64'),
      bB64: b.toString('base64'),
      tolerance: CHANNEL_TOLERANCE,
      directional: DIRECTIONAL_TOLERANCE,
    },
  );
}

async function openHarness(page: Page): Promise<void> {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
}

/** Every tier that reads a page, and the page scales they must compose with. */
const CELLS = [
  { name: 'rigid tier (spineboy-ess)', skeleton: 'ess', backend: 'canvas2d', pageScale: 1 },
  { name: 'canvas2d mesh tier (spineboy-pro)', skeleton: 'pro', backend: 'canvas2d', pageScale: 1 },
  { name: 'webgl mesh tier (spineboy-pro)', skeleton: 'pro', backend: 'webgl', pageScale: 1 },
  // The two rules compose: un-premultiply the image, then cut in its own frame.
  { name: 'rigid tier, 0.5× page', skeleton: 'ess', backend: 'canvas2d', pageScale: 0.5 },
  { name: 'canvas2d mesh tier, 0.5× page', skeleton: 'pro', backend: 'canvas2d', pageScale: 0.5 },
] as const;

for (const cell of CELLS) {
  test(`a premultiplied page draws the same picture: ${cell.name}`, async ({
    page,
  }, testInfo) => {
    await openHarness(page);
    const options = {
      skeleton: cell.skeleton,
      backend: cell.backend,
      pageScale: cell.pageScale,
    };
    // Thrown away, both of them: the stage keeps its bitmaps, so this leaves
    // each side's raster settled before either is measured. A first capture is
    // otherwise a cold raster, and cold-against-warm is a difference between
    // captures rather than between pages.
    await capture(page, { ...options, page: 'straight' });
    await capture(page, { ...options, page: 'pma' });

    const straight = await capture(page, { ...options, page: 'straight' });
    const pma = await capture(page, { ...options, page: 'pma' });
    const m = await diffInPage(page, straight, pma);

    const badRatio = m.bad / Math.max(1, m.contentUnion);
    const darkerRatio = m.darker / Math.max(1, m.contentUnion);
    console.log(
      `[pma] ${testInfo.project.name} ${cell.name}: content=${m.contentUnion}, ` +
        `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(3)}%, ch>${CHANNEL_TOLERANCE}), ` +
        `maxDelta=${m.maxDelta}, darker=${m.darker} (${(darkerRatio * 100).toFixed(3)}%, ` +
        `mean ${m.darkerMean} / max ${m.darkerMax} luma) lighter=${m.lighter} ` +
        `at ch>${DIRECTIONAL_TOLERANCE}`,
    );

    expect(m.contentUnion).toBeGreaterThan(5000);
    expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
    // The signature of a doubled premultiply: darker, never lighter. Both sides
    // are asserted, so a repair that over-corrects reds out here too.
    expect(darkerRatio).toBeLessThanOrEqual(DIRECTIONAL_LIMIT);
    expect(m.lighter / Math.max(1, m.contentUnion)).toBeLessThanOrEqual(DIRECTIONAL_LIMIT);
  });
}

test('canvas2d and webgl agree on a premultiplied page', async ({ page }, testInfo) => {
  // The two backends reach a `pma` page by different routes: the 2d path reads
  // an 8-bit un-premultiplied derivation, the GL path uploads the texels
  // unconverted. This is what the derivation costs against the lossless side,
  // measured against the parity suite's own limit rather than a new one.
  await openHarness(page);
  const options = { skeleton: 'pro', page: 'pma', pageScale: 1 } as const;
  // One warm-up is enough here: both captures are the same page variant, so
  // they share the stage's cached rigid bitmaps, and the mesh tier rasters into
  // canvases, which have no cold-bitmap escalation to settle.
  await capture(page, { ...options, backend: 'canvas2d' });

  const canvas2d = await capture(page, { ...options, backend: 'canvas2d' });
  const webgl = await capture(page, { ...options, backend: 'webgl' });
  const m = await diffInPage(page, canvas2d, webgl);

  const badRatio = m.bad / Math.max(1, m.contentUnion);
  console.log(
    `[pma] ${testInfo.project.name} canvas2d vs webgl on the pma page: ` +
      `content=${m.contentUnion}, bad=${m.bad} of ${m.rawBad} raw ` +
      `(${(badRatio * 100).toFixed(3)}% of content), maxDelta=${m.maxDelta}, ` +
      `darker=${m.darker} lighter=${m.lighter} at ch>${DIRECTIONAL_TOLERANCE}`,
  );

  expect(m.contentUnion).toBeGreaterThan(5000);
  expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
});

test('the premultiplied fixture is exact, and the derivation does not re-premultiply', async ({
  page,
}, testInfo) => {
  await openHarness(page);
  const result = await page.evaluate(() => window.spineHtmlHarness.pmaFixtureProbe());
  const bandLine = (bands: typeof result.readBack): string =>
    bands
      .map((band) => `${band.label} n=${band.pixels} max=${band.maxError} mean=${band.meanError}`)
      .join(' | ');
  console.log(
    `[pma] ${testInfo.project.name} fixture: ${result.pngBytes} B PNG\n` +
      `      read-back  ${bandLine(result.readBack)}\n` +
      `      composite  ${bandLine(result.composite)}\n` +
      `      derived drift: ${result.derivedMismatches} channels, max ${result.derivedMaxDrift}; ` +
      `composite maxErr=${result.compositeMaxError}\n` +
      `      worst: ${result.compositeWorst.join(' ; ')}`,
  );

  // The hand-encoded PNG decodes, at the right size.
  expect(result.decodedSize).toEqual(result.pageSize);
  // Where a canvas read is lossless — opaque texels — the twin holds exactly
  // what was written. That is the read-back proof that the fixture is the
  // artwork premultiplied, and not an artefact of some canvas round trip.
  expect(result.opaquePixels).toBeGreaterThan(10000);
  expect(result.opaqueMismatches).toBe(0);
  // Everywhere else the read is quantized, and every pixel must stay inside the
  // analytic ceiling for its alpha — the statement that the loss is 8-bit
  // rounding at low alpha and nothing else.
  for (const band of result.readBack) {
    expect(band.overBound, `${band.label} past the canvas round-trip ceiling`).toBe(0);
  }
  expect(result.readBack[0].maxError, 'opaque texels are exact').toBe(0);
  // putImageData stored the un-premultiplied values; it did not multiply them
  // back in. Verified by reading the derivation's pixels, not by assuming: the
  // canvas's own 8-bit conversion may land a step off this arithmetic, and a
  // step is all it may be.
  expect(result.derivedMaxDrift).toBeLessThanOrEqual(1);
  // And composited — the premultiplied product the screen gets — it reproduces
  // what the page holds. Above a = 128 a second premultiply would move a texel
  // by up to half its value, so ±2 there is the assertion that carries this.
  expect(result.composite[0].maxError, 'opaque texels composite exactly').toBe(0);
  expect(result.composite[1].maxError, 'a 128–254 composites within ±2').toBeLessThanOrEqual(2);
  for (const band of result.composite) {
    expect(band.overBound, `${band.label} past the round-trip ceiling`).toBe(0);
  }
});

test('rigid cuts from a premultiplied page decode to straight alpha', async ({
  page,
}, testInfo) => {
  await openHarness(page);
  const result = await page.evaluate(() => window.spineHtmlHarness.pmaCutProbe());
  console.log(
    `[pma] ${testInfo.project.name} cuts: ` +
      result.bands
        .map((band) => `${band.label} n=${band.pixels} max=${band.maxError} mean=${band.meanError}`)
        .join(' | ') +
      `, alpha maxErr=${result.maxAlphaError}, ` +
      `pass-through straight=${result.straight.wholePassedThrough} pma=${result.pma.wholePassedThrough}, ` +
      `minted straight=${result.straight.mintedCount} pma=${result.pma.mintedCount}`,
  );

  // A cut of a premultiplied page comes back straight: at mid alpha the two
  // readings agree within the 8-bit round trip. At very low alpha they need
  // not, and the band below says so rather than hiding it — dividing by a small
  // alpha multiplies the read's own quantization by 255/a, so a barely-visible
  // texel's *stored* colour can be far off (measured: mean ~112, max 223 of 255
  // under alpha 32). What that texel composites to is the bounded quantity, and
  // it is the one on screen: ≤ ~11 of 255, see the fixture test above.
  expect(result.bands[0].maxError, 'opaque texels are exact').toBe(0);
  expect(result.bands[1].maxError, 'a 128–254 within ±2').toBeLessThanOrEqual(2);
  for (const band of result.bands) {
    // Every band has to be populated, or its limit is a statement about nothing.
    expect(band.pixels, `${band.label} is empty`).toBeGreaterThan(0);
    expect(band.overBound, `${band.label} past the round-trip ceiling`).toBe(0);
  }
  // Alpha is carried, never divided.
  expect(result.maxAlphaError).toBe(0);

  // The whole-page pass-through: still taken on a straight page (no blob for
  // that region), never on a premultiplied one — that URL holds premultiplied
  // pixels and an <img> would composite them as straight alpha.
  expect(result.straight.wholePassedThrough).toBe(true);
  expect(result.pma.wholePassedThrough).toBe(false);
  expect(result.pma.mintedCount).toBe(result.straight.mintedCount + 1);
  // And the blob it mints is owned like any other: alive until revokeRegions.
  expect(result.pma.wholeAliveBefore).toBe(true);
  expect(result.pma.wholeAliveAfter).toBe(false);
  // The caller's page image is never revoked, on either page.
  expect(result.straight.pageAliveAfter).toBe(true);
  expect(result.pma.pageAliveAfter).toBe(true);
});

test('one straight-alpha derivation per page image, none without the flag', async ({
  page,
}, testInfo) => {
  await openHarness(page);
  const result = await page.evaluate(() => window.spineHtmlHarness.pmaDerivationProbe());
  console.log(
    `[pma] ${testInfo.project.name} derivations: straight=${result.straightDerivations} ` +
      `pma=${result.pmaDerivations}, backends=${result.backendsActive.join(',')}, ` +
      `meshes=${result.meshesDrawn.join(',')}`,
  );

  // A page with no pma line allocates nothing — requirement of "unchanged".
  expect(result.straightDerivations).toBe(0);
  // unpackRegions and two renderers, both backends, over one page image: one
  // derivation between them. Deriving per consumer would read 2 or 3.
  expect(result.pmaDerivations).toBe(1);
  // The count only proves that much if both backends actually drew.
  expect(result.backendsActive).toEqual(['canvas2d', 'webgl']);
  for (const drawn of result.meshesDrawn) expect(drawn).toBeGreaterThan(0);
});
