import { expect, type Page, test } from '@playwright/test';

/**
 * Deterministic counters and math invariants.
 *
 * Policy: never assert absolute milliseconds — timing numbers are
 * machine/headless-dependent (headless WebKit is a software rasterizer).
 * These tests only read the demo's deterministic counters from #stats.
 *
 * ## Why nothing here imports spine-core
 *
 * The two spine-core invariants at the bottom used to construct their probe
 * objects in this file, node-side. They cannot any more: **plain node cannot
 * import spine-core 4.0** (extensionless relative specifiers and no
 * `"type": "module"` — upstream's issue #16), Playwright resolves a spec file's
 * imports with node's own resolver, and a module-scope import that fails is not
 * a skipped test, it is a run that never starts. Every bundler resolves those
 * specifiers fine, which is exactly how such a runtime is consumed, so the
 * construction moved into `tests/harness.ts` and is reached through the browser
 * like everything else here. The assertions did not move, and they now run on
 * a generation that had no coverage at all.
 */

async function openHarness(page: Page): Promise<void> {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
}

test('frozen scene: every mesh reuses its raster, nothing reallocates', async ({ page }) => {
  await page.goto('/?skel=pro&anim=idle&count=10&dpr=1&timescale=0');
  const stats = page.locator('#stats');
  // 10 spineboy-pro instances × 8 mesh canvases: once the (physics-settled)
  // pose is static, the dirty-skip path must carry all 80 of them.
  await expect(stats).toContainText('mesh canvases 0 drawn (0 tris) / 80 reused');
  await expect(stats).not.toContainText("realloc'd");
});

test('running scene: grow-only mesh backing reaches a realloc-free steady state', async ({
  page,
}) => {
  await page.goto('/?skel=pro&anim=walk&count=10&dpr=1');
  const stats = page.locator('#stats');
  await expect(stats).toContainText('mesh canvases');
  // Wait for two fresh stats ticks (the line re-renders every 500ms) that
  // carry no realloc token. A per-frame realloc storm — the regression this
  // guards, canvas backing recreated every frame — would stamp the token
  // into every tick and time this out. Content-based waits, no sleeps.
  let prev = (await stats.textContent()) ?? '';
  for (let tick = 0; tick < 2; tick++) {
    await page.waitForFunction(
      (last) => {
        const text = document.getElementById('stats')?.textContent ?? '';
        return last !== text && text.includes('mesh canvases') && !text.includes("realloc'd");
      },
      prev,
      { timeout: 30_000 },
    );
    prev = (await stats.textContent()) ?? '';
  }
});

test('portal scene: the clipping attachment is applied, none skipped', async ({ page }) => {
  // spineboy-pro's portal animation carries one clipping attachment, a part
  // mask over the character. It is applied now (see tests/clipping.spec.ts for
  // what "applied" is worth in pixels); here it only has to be *visible* in
  // the stats line, on the applied side of it.
  await page.goto('/?skel=pro&anim=portal&count=1&dpr=1&time=1.2&timescale=0');
  const stats = page.locator('#stats');
  await expect(stats).toContainText('1 clips applied');
  await expect(stats).not.toContainText('clips skipped');
});

test('the installed core loads what this column\'s export actually writes', async ({ page }) => {
  // #53, and the reason the matrix has a column per minor rather than one
  // runtime reading everything: each generation's SkeletonJson stops looking
  // for the keys the format renamed. 4.0 and 4.1 write a bone's `transform`
  // where 4.2 and 4.3 read only `inherit`; 4.0 writes an animation's `deform`
  // where 4.1 and later read only `attachments`. None of it throws, the
  // constraint counts still match and the rig still renders, so the only
  // evidence that a column is running the *matching* runtime is that what the
  // file declares arrived in the parsed data.
  //
  // Keyed entirely off the file: whichever word this branch's export uses is
  // the word looked for, so this is one assertion in all four columns and not
  // a table of versions.
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
  const probe = await page.evaluate(() => window.spineHtmlHarness.generationProbe());
  console.log(`[generation] ${JSON.stringify(probe)}`);

  // Non-vacuity first: this export has both features, on every branch —
  // spineboy-pro carries four bones at `noRotationOrReflection`
  // (`back-foot-tip`, `front-foot-tip`, `hoverboard-thruster-front`,
  // `hoverboard-thruster-rear`) and four mesh deform timelines, all in
  // `hoverboard`. An export that lost them would make everything below pass
  // by describing nothing.
  expect(probe.inheritKey).not.toBe('');
  expect(probe.deformKey).not.toBe('');
  expect(Object.keys(probe.fileInherit).sort()).toEqual([
    'back-foot-tip',
    'front-foot-tip',
    'hoverboard-thruster-front',
    'hoverboard-thruster-rear',
  ]);
  expect(probe.fileDeform).toEqual({ hoverboard: 4 });

  // Every bone the file gives a mode arrived with one — 0 is Normal, the value
  // a reader that never looked for this key would leave behind — and no other
  // bone picked one up.
  for (const [bone, mode] of Object.entries(probe.loadedInherit)) {
    expect(mode, `${bone} loaded at Normal from \`${probe.inheritKey}\``).not.toBe(0);
  }
  expect(Object.keys(probe.loadedInherit).sort()).toEqual(Object.keys(probe.fileInherit).sort());
  expect(probe.loadedNonNormalBones).toBe(Object.keys(probe.fileInherit).length);

  // And every deform timeline the file declares was built.
  expect(probe.loadedDeform).toEqual(probe.fileDeform);

  // The seam the renderer will use for this core, so a column's log says which
  // one it exercised rather than leaving it to be inferred.
  expect(['poses', 'sequences', 'pre-sequences']).toContain(probe.coreShape);
});

test('portal scene with ?clipping=0: the clip is counted as skipped', async ({ page }) => {
  // The pre-0.6 behaviour is still reachable, and still says so in the same
  // words the stats line always used.
  await page.goto('/?skel=pro&anim=portal&count=1&dpr=1&time=1.2&timescale=0&clipping=0');
  const stats = page.locator('#stats');
  await expect(stats).toContainText(/\d+ clips skipped/);
  await expect(stats).not.toContainText('clips applied');
});

/**
 * Where a region attachment's vertex offsets and UVs are computed is the one
 * place the supported spine-core generations differ in *construction* rather
 * than in reading, so this probe — and only this probe — has to build the
 * objects three ways.
 *
 * 4.3 moved them onto the `Sequence` (`RegionAttachment.computeUVs` fills a
 * caller's arrays, and the offsets are then passed into
 * `computeWorldVertices`); before that they lived on the attachment. 4.1 and
 * 4.2 write them with `updateRegion()` and read them back out of a
 * `computeWorldVertices` that takes the **slot**; 4.0, before sequences
 * existed, writes the UVs in `setRegion()` and the offsets in `updateOffset()`,
 * and its `computeWorldVertices` takes the **bone**. `src/coreCompat.ts` hides
 * the reading difference for a posed skeleton, which is all the renderer ever
 * does — it never constructs an attachment, so the seam has no constructor to
 * offer, and the probe detects the generation itself, off the methods each one
 * carries rather than off a version string.
 *
 * The construction lives in `tests/harness.ts` (see the header above); what is
 * below is the expectation, which is the part that must not move.
 */

/**
 * A 2×1 region under identity transforms: the four corners around the centre,
 * in BL, UL, UR, BR order (Spine is Y-up).
 */
const CORNERS = [-1, -0.5, -1, 0.5, 1, 0.5, 1, -0.5];
/** The UV order that agrees with it: (u,v2)=BL, (u,v)=UL, (u2,v)=UR, (u2,v2)=BR. */
const UVS = [0, 1, 0, 0, 1, 0, 1, 1];

test('spine-core region corner order stays BL, UL, UR, BR', async ({ page }) => {
  // The renderer derives its CSS matrix from three of the four corners
  // computeWorldVertices emits, assuming the order BL, UL, UR, BR — which is
  // what 4.0.31, 4.1.56, 4.2.98, 4.2.120 and 4.3.13 actually produce (the
  // br/bl/ul/ur comments inside computeWorldVertices are stale; upstream
  // believes the order is BR, BL, UL, UR). If a spine-core upgrade ever
  // reorders the corners, every rigid slot would render skewed — this test
  // must go red first.
  await openHarness(page);
  const probe = await page.evaluate(() => window.spineHtmlHarness.regionGeometryProbe());
  console.log(
    `[region-geometry] poseCore=${probe.poseCore} regionTakesSlot=${probe.regionTakesSlot} ` +
      `inverseClipping=${probe.inverseClipping}`,
  );

  expect(probe.straight.offset).toEqual(CORNERS);
  expect(probe.straight.uvs).toEqual(UVS);
  // And an identity bone pose preserves that order through
  // computeWorldVertices — the call whose argument the seam has to get right.
  expect(probe.straight.world).toEqual(CORNERS);
});

test("spine-core puts a rotated region's artwork top-left at the packed rect's bottom-left", async ({
  page,
}) => {
  // The other half of the same read, and the source the rigid cut's rotation is
  // derived from (#49): the corner *order* is BL, UL, UR, BR (above), and these
  // are the UVs that order carries when the packer stored the region turned.
  // Written down here, against whichever core is installed, because the cut
  // must never derive its transform from itself — a reference that shares the
  // convention agrees with the code under test whichever way both are wrong.
  //
  // BL (u2, v2), UL (u, v2), UR (u, v), BR (u2, v). So the artwork's top-left
  // corner (UL) carries the packed rect's near u and its far v — the rect's
  // bottom-left — and the artwork's top edge, UL → UR, runs *up* the rect's
  // left edge. Unpacking such a rect is therefore a clockwise turn, which is
  // what `cutRegion` in src/DomTexture.ts does and writes out.
  const ROTATED_UVS = [0.5, 0.875, 0.125, 0.875, 0.125, 0.25, 0.5, 0.25];

  await openHarness(page);
  const probe = await page.evaluate(() => window.spineHtmlHarness.regionGeometryProbe());

  expect(probe.rotated.uvs).toEqual(ROTATED_UVS);
  // Packing is a fact about the page, not about the pose: the same corners
  // come out in world space either way, only the texels they carry move.
  expect(probe.rotated.offset).toEqual(CORNERS);
});
