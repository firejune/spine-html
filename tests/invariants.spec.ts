import { expect, test } from '@playwright/test';
import { RegionAttachment, type Slot, TextureRegion } from '@esotericsoftware/spine-core';
/**
 * `Sequence` comes through the namespace rather than by name because it is not
 * on spine-core 4.2's root entry at all — measured on 4.2.120, whose
 * `dist/index.js` re-exports every other `attachments/` module and not that
 * one; 4.3.13 does export it. A named import of a missing export is a *link*
 * error, so it would fail this whole spec file before the branch below could
 * decline to use it, in a column where nothing is actually wrong.
 */
import * as spine from '@esotericsoftware/spine-core';

/**
 * Deterministic counters and math invariants.
 *
 * Policy: never assert absolute milliseconds — timing numbers are
 * machine/headless-dependent (headless WebKit is a software rasterizer).
 * These tests only read the demo's deterministic counters from #stats.
 */

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
 * place the two supported spine-core generations differ in *construction*
 * rather than in reading, so this probe — and only this probe — has to build
 * the objects two ways.
 *
 * 4.3 moved them onto the `Sequence` (`RegionAttachment.computeUVs` fills a
 * caller's arrays, and the offsets are then passed into
 * `computeWorldVertices`); before that they lived on the attachment, written by
 * `updateRegion()` and read back out of it by a `computeWorldVertices` that
 * takes no offsets. `src/coreCompat.ts` hides that difference for *reading* a
 * posed skeleton, which is all the renderer ever does — it never constructs an
 * attachment, so the seam has no constructor to offer and this test detects the
 * generation itself, off the 4.3 method the seam calls.
 */
const POSE_CORE_INSTALLED = 'getOffsets' in RegionAttachment.prototype;

/** A region attachment in whichever shape the installed spine-core has. */
interface AnyRegionAttachment {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  width: number;
  height: number;
  region: unknown;
  offset: ArrayLike<number>;
  uvs: ArrayLike<number>;
  updateRegion(): void;
  computeWorldVertices(slot: unknown, world: Float32Array, offset: number, stride: number): void;
}

test('spine-core region corner order stays BL, UL, UR, BR', () => {
  // Node-side, no browser. The renderer derives its CSS matrix from three of
  // the four corners computeWorldVertices emits, assuming the order
  // BL, UL, UR, BR — which is what 4.2.98, 4.2.120 and 4.3.13 actually produce
  // (the br/bl/ul/ur comments inside computeWorldVertices are stale; upstream
  // believes the order is BR, BL, UL, UR). If a spine-core upgrade ever
  // reorders the corners, every rigid slot would render skewed — this test
  // must go red first.
  const region = new TextureRegion();
  region.u = 0;
  region.v = 0;
  region.u2 = 1;
  region.v2 = 1;
  region.width = 2;
  region.height = 1;
  region.originalWidth = 2;
  region.originalHeight = 1;
  region.offsetX = 0;
  region.offsetY = 0;
  region.degrees = 0;

  // 2×1 region, identity transforms: offsets must be the four corners
  // around the center, in BL, UL, UR, BR order (Spine is Y-up), and the UV
  // order must agree: (u,v2)=BL, (u,v)=UL, (u2,v)=UR, (u2,v2)=BR.
  const CORNERS = [-1, -0.5, -1, 0.5, 1, 0.5, 1, -0.5];
  const UVS = [0, 1, 0, 0, 1, 0, 1, 1];
  const world = new Float32Array(8);

  if (POSE_CORE_INSTALLED) {
    const offsets: number[] = new Array<number>(8).fill(0);
    const uvs = new Float32Array(8);
    RegionAttachment.computeUVs(region, 0, 0, 1, 1, 0, 2, 1, offsets, uvs);
    expect(offsets).toEqual(CORNERS);
    expect(Array.from(uvs)).toEqual(UVS);

    // An identity bone pose must preserve that order through
    // computeWorldVertices (which reads only slot.bone.appliedPose).
    const slot = {
      bone: { appliedPose: { worldX: 0, worldY: 0, a: 1, b: 0, c: 0, d: 1 } },
    } as unknown as Slot;
    const attachment = new RegionAttachment('corner-probe', new spine.Sequence(1, false));
    attachment.computeWorldVertices(slot, offsets, world, 0, 2);
  } else {
    const attachment = new (RegionAttachment as unknown as new (
      name: string,
      path: string,
    ) => AnyRegionAttachment)('corner-probe', 'corner-probe');
    attachment.region = region;
    attachment.width = 2;
    attachment.height = 1;
    attachment.updateRegion();
    expect(Array.from(attachment.offset)).toEqual(CORNERS);
    expect(Array.from(attachment.uvs)).toEqual(UVS);

    // Pre-4.3 the bone IS its own applied pose, and the offsets are read off
    // the attachment rather than handed in.
    const slot = { bone: { worldX: 0, worldY: 0, a: 1, b: 0, c: 0, d: 1 } };
    attachment.computeWorldVertices(slot, world, 0, 2);
  }

  expect(Array.from(world)).toEqual(CORNERS);
});

test("spine-core puts a rotated region's artwork top-left at the packed rect's bottom-left", () => {
  // The other half of the same read, and the source the rigid cut's rotation is
  // derived from (#49): the corner *order* is BL, UL, UR, BR (above), and these
  // are the UVs that order carries when the packer stored the region turned.
  // Written down here, against whichever core is installed, because the cut
  // must never derive its transform from itself — a reference that shares the
  // convention agrees with the code under test whichever way both are wrong.
  const region = new TextureRegion();
  // Distinct, asymmetric, and exact in f32 (the 4.3 path fills a Float32Array):
  // u is told from u2, v from v2, and neither axis from the other, so a
  // transposed or half-turned assignment cannot match by accident.
  region.u = 0.125;
  region.v = 0.25;
  region.u2 = 0.5;
  region.v2 = 0.875;
  region.width = 2;
  region.height = 1;
  region.originalWidth = 2;
  region.originalHeight = 1;
  region.offsetX = 0;
  region.offsetY = 0;
  region.degrees = 90;

  // BL (u2, v2), UL (u, v2), UR (u, v), BR (u2, v). So the artwork's top-left
  // corner (UL) carries the packed rect's near u and its far v — the rect's
  // bottom-left — and the artwork's top edge, UL → UR, runs *up* the rect's
  // left edge. Unpacking such a rect is therefore a clockwise turn, which is
  // what `cutRegion` in src/DomTexture.ts does and writes out.
  const ROTATED_UVS = [0.5, 0.875, 0.125, 0.875, 0.125, 0.25, 0.5, 0.25];

  if (POSE_CORE_INSTALLED) {
    const offsets: number[] = new Array<number>(8).fill(0);
    const uvs = new Float32Array(8);
    RegionAttachment.computeUVs(region, 0, 0, 1, 1, 0, 2, 1, offsets, uvs);
    expect(Array.from(uvs)).toEqual(ROTATED_UVS);
    // Packing is a fact about the page, not about the pose: the same corners
    // come out in world space either way, only the texels they carry move.
    expect(offsets).toEqual([-1, -0.5, -1, 0.5, 1, 0.5, 1, -0.5]);
  } else {
    const attachment = new (RegionAttachment as unknown as new (
      name: string,
      path: string,
    ) => AnyRegionAttachment)('rotated-probe', 'rotated-probe');
    attachment.region = region;
    attachment.width = 2;
    attachment.height = 1;
    attachment.updateRegion();
    expect(Array.from(attachment.uvs)).toEqual(ROTATED_UVS);
    expect(Array.from(attachment.offset)).toEqual([-1, -0.5, -1, 0.5, 1, 0.5, 1, -0.5]);
  }
});
