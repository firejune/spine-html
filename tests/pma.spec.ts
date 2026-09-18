import { expect, type Page, test } from '@playwright/test';

import { CHANNEL_TOLERANCE, diffInPage } from './pixelDiff';

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
 * quantize the values on the way out — by the same order as the residue being
 * measured, and by *more* than that on a coarser rasterizer. The fixture would
 * then be carrying the error it exists to detect, in a platform-dependent
 * amount. See `pmaFixtureProbe`, which measures that the twin is exact where a
 * canvas can see it at all (every opaque texel) and reports what the canvas
 * costs everywhere else as the control the rest is judged against.
 *
 * ## What the residue is
 *
 * The DOM and canvas2d tiers read a straight-alpha derivation of the page,
 * produced with `rgb = round(rgb * 255 / a)`. That division happens in 8 bits
 * and starts from a canvas read, which has already quantized the premultiplied
 * texel — and **how coarsely it quantized is the rasterizer's business, not
 * this package's**: Linux WebKit round-trips premultiplied storage several
 * times more coarsely than macOS does.
 *
 * So the per-texel precision tests assert nothing absolute. Each measures that
 * platform's own round trip in the same run, on the same fixture, as a
 * *control* — the premultiplied texels drawn into a canvas and read back, with
 * no un-premultiply by us — and then bounds this package's numbers relative to
 * it, plus the rounding of `round(rgb * 255 / a)` stated exactly at each site.
 * What remains asserted absolutely is only what is true on any rasterizer:
 * opaque texels untouched, alpha never divided, alpha 0 with no colour, and the
 * direction of the error.
 *
 * (Two absolute ceilings stood here first, both calibrated on macOS, and Linux
 * WebKit reddened them on two separate CI runs with the repair working
 * perfectly — every tier cell green on those same runs. A precision number read
 * off one platform is that platform's, however carefully it was derived. The
 * second one survived the first pass because that pass converted the numbers
 * that had already failed rather than every number of the kind; hence the note
 * above, and hence: no number here describes a browser this suite cannot run.)
 *
 * The GL backend has none of this cost — a `pma` page is uploaded unconverted,
 * which is lossless — so cell (b) below, canvas2d against webgl on the twin, is
 * the direct measurement of what the 8-bit un-premultiply loses. It is budgeted
 * against the parity suite's own ratio-of-content limit, which is platform
 * independent by construction.
 */

const POSE = { animation: 'walk', time: 1.2 } as const;

/** The parity suite's BAD_RATIO_LIMIT — not to be tuned here, only measured against. */
const BAD_RATIO_LIMIT = 0.005;
/**
 * Above this per-channel move, a pixel counts as darker or lighter than the
 * reference.
 *
 * It is the parity suite's tolerance, reused rather than calibrated: one
 * constant for the file, and a threshold the repository already trusts across
 * platforms. It is a *classification* knob, not a precision bound on anything
 * this package produces — the assertions below are on which side the pixels
 * fall and on ratios of drawn content.
 *
 * It sits above the derivation's residue with room to spare (the tier cells
 * measure a peak channel move of 4–11 locally and 11–14 on the Linux WebKit CI
 * runner) and far below the defect, which darkens by ~38 luma on average and
 * up to ~76 — with the flag ignored, 2,229 pixels of one cell move past this.
 */
const DIRECTIONAL_TOLERANCE = CHANNEL_TOLERANCE;
/**
 * Directional pixels allowed, as a fraction of drawn content. Measured: the
 * repair leaves zero on either engine, at either page scale, on every tier;
 * ignoring the flag paints 9.2–10.6% of content, all on the one side. The limit
 * sits 45× under that and above a floor of nothing, so it is headroom against a
 * browser-raster change rather than a calibration against either population.
 */
const DIRECTIONAL_LIMIT = 0.002;

/**
 * What this suite asks of the shared differ (`tests/pixelDiff.ts`): the
 * directional split. A doubled premultiply can only darken, so which *side*
 * the differences fall on is the signature, not their count. The harness
 * stage is one flat colour, so there is no floor strip to exclude.
 */
const PMA_DIFF = { directional: DIRECTIONAL_TOLERANCE } as const;

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

/** One line per band: the control, which is reported and never bounded. */
function controlLine(bands: ReadonlyArray<{
  label: string;
  pixels: number;
  maxError: number;
  meanError: number;
}>): string {
  return bands
    .map((band) => `${band.label} n=${band.pixels} max=${band.maxError} mean=${band.meanError}`)
    .join(' | ');
}

/** The same, for a measurement that is bounded relative to that control. */
function boundedLine(bands: ReadonlyArray<{
  label: string;
  pixels: number;
  maxError: number;
  meanError: number;
  overBound: number;
  worstExcess: number;
  vacuous: number;
}>): string {
  return bands
    .map(
      (band) =>
        `${band.label} n=${band.pixels} max=${band.maxError} mean=${band.meanError} ` +
        `over=${band.overBound} headroom=${(-band.worstExcess).toFixed(2)}` +
        (band.vacuous ? ` unbounded=${band.vacuous}` : ''),
    )
    .join(' | ');
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
    const m = await diffInPage(page, straight, pma, PMA_DIFF);

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
    // The signature of a doubled premultiply is *asymmetry*: it can only darken.
    // This form carries no magnitude at all, so it survives any rasterizer —
    // symmetric rounding noise, however coarse, keeps the two sides level,
    // while the defect puts thousands on one side and zero on the other.
    expect(m.darker, 'darker pixels outnumber lighter ones').toBeLessThanOrEqual(
      m.lighter + Math.ceil(DIRECTIONAL_LIMIT * m.contentUnion),
    );
    // And the magnitudes, as ratios of drawn content — the repository's own way
    // of budgeting a diff. Both sides, so an over-correction reds out too.
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
  const m = await diffInPage(page, canvas2d, webgl, PMA_DIFF);

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
  console.log(
    `[pma] ${testInfo.project.name} fixture: ${result.pngBytes} B PNG\n` +
      `      control    ${controlLine(result.control)}\n` +
      `      put/get    ${controlLine(result.putGet)}\n` +
      `      composite  ${boundedLine(result.composite)}\n` +
      `      drift      ${boundedLine(result.derivedDrift)}\n` +
      `      derived mismatches=${result.derivedMismatches}, drift max=${result.derivedMaxDrift}; ` +
      `composite maxErr=${result.compositeMaxError}\n` +
      `      worst: ${result.compositeWorst.join(' ; ')}`,
  );

  // The hand-encoded PNG decodes, at the right size.
  expect(result.decodedSize).toEqual(result.pageSize);
  // Where a canvas read is lossless — opaque texels — the twin holds exactly
  // what was written. That is the read-back proof that the fixture is the
  // artwork premultiplied, and not an artefact of some canvas round trip.
  //
  // Every exact `0` in this file is of that kind: at alpha 255 premultiplying
  // and un-premultiplying are both the identity, and at alpha 0 there is no
  // colour to carry, so these hold on any rasterizer however coarse its 8-bit
  // storage is. The quantities that *do* depend on the rasterizer are bounded
  // against a control measured on it, never against a number.
  expect(result.opaquePixels).toBeGreaterThan(10000);
  expect(result.opaqueMismatches).toBe(0);
  // The control is reported, never bounded: how coarsely a 2D canvas round-trips
  // premultiplied storage is the platform's business, and it differs by
  // rasterizer. What is asserted is only what this package adds to it.
  expect(result.control[0].maxError, 'opaque texels round-trip exactly').toBe(0);
  for (const band of result.control) {
    expect(band.pixels, `${band.label} is empty`).toBeGreaterThan(0);
  }
  // Alpha 0 keeps no colour, on any platform: there is nothing to divide by.
  expect(result.zeroAlphaNonBlack).toBe(0);
  // putImageData stored the un-premultiplied values; it did not multiply them
  // back in. Two ways, neither of them a number about this browser:
  //
  // 1. Exactly: the derived canvas must read back the same as a scratch canvas
  //    this test filled with the values the derivation was supposed to write.
  //    Same storage, same platform, so equality holds on any rasterizer — and a
  //    library that wrote something it did not compute breaks it.
  expect(result.derivedMismatches, 'the derivation wrote values it did not compute').toBe(0);
  // 2. Relatively: what the canvas then did to those values is bounded by the
  //    write-then-read control at that alpha, with an arithmetic term of zero —
  //    the derivation writes a value of exactly the class the control was
  //    measured on, and nothing touches it afterwards but that same storage.
  //
  // An absolute `≤ 1` stood here, taken from macOS, and Linux WebKit read 8 (CI
  // run 35362070508). The comparison that replaced it went red there as well
  // (run 35365368471), and that is what found the cause: the 8 was never the
  // storage. The harness read the page through a `willReadFrequently` canvas,
  // the library reads it through a plain one, and on that rasterizer the two
  // disagree by one level on a few hundred channels — which `× 255/a` carries
  // to 8 at alpha ~32. Both checks now start from the library's kind of canvas
  // (`libraryKindContext` in the harness), where run 35365862520 measured the
  // derived canvas equal to the scratch one on every channel.
  for (const band of result.derivedDrift) {
    expect(band.overBound, `${band.label}: the derivation drifted more than storage does`).toBe(0);
  }
  // And composited — the premultiplied product the screen gets — it reproduces
  // what the page holds, to within what the control already cost *that texel*
  // plus DERIVATION_SLACK (0.5 for `round(rgb * 255 / a)` arriving back through
  // × a/255, plus 1 for the canvas's own premultiply on the way in; see the
  // harness). A second premultiply moves a mid-alpha texel by up to half its
  // value, which no control excuses.
  expect(result.composite[0].maxError, 'opaque texels composite exactly').toBe(0);
  for (const band of result.composite) {
    expect(band.overBound, `${band.label}: the derivation added more than rounding`).toBe(0);
  }
});

test('rigid cuts from a premultiplied page decode to straight alpha', async ({
  page,
}, testInfo) => {
  await openHarness(page);
  const result = await page.evaluate(() => window.spineHtmlHarness.pmaCutProbe());
  console.log(
    `[pma] ${testInfo.project.name} cuts\n` +
      `      control  ${controlLine(result.control)}\n` +
      `      cuts     ${boundedLine(result.bands)}\n` +
      `      alpha maxErr=${result.maxAlphaError}, ` +
      `pass-through straight=${result.straight.wholePassedThrough} pma=${result.pma.wholePassedThrough}, ` +
      `minted straight=${result.straight.mintedCount} pma=${result.pma.mintedCount}`,
  );

  // A cut of a premultiplied page comes back straight. How *close* to the
  // straight page's own cut it comes is not a number to write down: both sides
  // are read through this platform's canvas, and the un-premultiply then
  // multiplies whatever that read already cost by 255/a. So the bound is the
  // control for that very texel, carried through the same division, plus the
  // rounding of the conversions (see `cutBound` in the harness) — and the
  // amplification is why a barely-visible texel's *stored* colour may be far
  // off while what it composites to stays within a few levels of 255 (the
  // fixture test above measures that end).
  //
  // An absolute ±2 stood here and was calibrated on macOS; Linux WebKit, whose
  // canvas round trip is several times coarser, read 6 and turned it red
  // without anything being wrong with the repair. A number read off one
  // platform fails on the next one.
  expect(result.bands[0].maxError, 'opaque texels are exact').toBe(0);
  for (const band of result.bands) {
    // Every band has to be populated, or its limit is a statement about nothing.
    expect(band.pixels, `${band.label} is empty`).toBeGreaterThan(0);
    expect(band.overBound, `${band.label}: the cut added more than rounding`).toBe(0);
  }
  // Where that bound bites: everywhere above alpha ~10. Below it the 255/a
  // amplification carries the bound past 255 and no 8-bit error could fail it
  // (`unbounded=` in the line above counts exactly those texels). They are not
  // unmeasured — the fixture test bounds what they composite to, at every
  // alpha — but this comparison is not what holds them, and the three upper
  // bands must stay fully bounded or this test has quietly stopped asserting.
  for (const band of result.bands.slice(0, 3)) {
    expect(band.vacuous, `${band.label}: the bound stopped biting`).toBe(0);
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
