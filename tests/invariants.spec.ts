import { expect, test } from '@playwright/test';
import {
  RegionAttachment,
  Sequence,
  type Slot,
  TextureRegion,
} from '@esotericsoftware/spine-core';

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

test('portal scene: skipped clipping attachments are counted', async ({ page }) => {
  // Clipping is deliberately unsupported — but it must be *visible* in the
  // stats line, not silently dropped.
  await page.goto('/?skel=pro&anim=portal&count=1&dpr=1&time=1.2&timescale=0');
  await expect(page.locator('#stats')).toContainText(/\d+ clips skipped/);
});

test('spine-core region corner order stays BL, UL, UR, BR', () => {
  // Node-side, no browser. The renderer derives its CSS matrix from three of
  // the four corners computeWorldVertices emits, assuming the order
  // BL, UL, UR, BR — which is what 4.2.98 and 4.3.13 actually produce (the
  // br/bl/ul/ur comments inside computeWorldVertices are stale; upstream
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
  // around the center, in BL, UL, UR, BR order (Spine is Y-up).
  const offsets: number[] = new Array<number>(8).fill(0);
  const uvs = new Float32Array(8);
  RegionAttachment.computeUVs(region, 0, 0, 1, 1, 0, 2, 1, offsets, uvs);
  expect(offsets).toEqual([-1, -0.5, -1, 0.5, 1, 0.5, 1, -0.5]);
  // UV order agrees: (u,v2)=BL, (u,v)=UL, (u2,v)=UR, (u2,v2)=BR.
  expect(Array.from(uvs)).toEqual([0, 1, 0, 0, 1, 0, 1, 1]);

  // An identity bone pose must preserve that order through
  // computeWorldVertices (which reads only slot.bone.appliedPose).
  const slot = {
    bone: { appliedPose: { worldX: 0, worldY: 0, a: 1, b: 0, c: 0, d: 1 } },
  } as unknown as Slot;
  const world = new Float32Array(8);
  const attachment = new RegionAttachment('corner-probe', new Sequence(1, false));
  attachment.computeWorldVertices(slot, offsets, world, 0, 2);
  expect(Array.from(world)).toEqual([-1, -0.5, -1, 0.5, 1, 0.5, 1, -0.5]);
});
