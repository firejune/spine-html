import { expect, type Page, test } from '@playwright/test';

/**
 * Atlas page textures in the shared WebGL blitter — the one resource that
 * outlives the renderer that asked for it.
 *
 * The blitter is a module-level singleton (browsers cap WebGL contexts), so a
 * page uploaded for one skeleton used to stay uploaded for the life of the
 * document: a viewer stepping through a cast paid `page w × h × 4` bytes of
 * GPU memory per skeleton it had ever shown. The pages are reference-counted
 * per renderer now — retained as each mesh job is queued, handed back by
 * dispose(), deleted when the last user goes.
 *
 * Oracle: GPU memory is not observable from script and a garbage collector
 * feels no pressure from it, so nothing here waits for a collection. The
 * blitter's live-texture counter (created minus deleted through retain /
 * release) is deterministic, and "the survivor still draws" is measured as
 * non-transparent pixels on its mesh canvases. No milliseconds, no bytes.
 */

type GlProbe = Awaited<ReturnType<Window['spineHtmlHarness']['glTextureProbe']>>;

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
});

/**
 * Runs the probe and refuses to pass vacuously: with no webgl mesh backend
 * there is no page texture to leak, so every assertion below would hold for
 * the wrong reason. The project is skipped with the reason instead.
 */
async function glProbe(page: Page, projectName: string): Promise<GlProbe> {
  const probe = await page.evaluate(() => window.spineHtmlHarness.glTextureProbe());
  test.skip(
    !probe.webglAvailable,
    `${projectName}: no shared WebGL context here, so the mesh webgl backend cannot run`,
  );
  const active = probe.cycles[0]?.backendActive;
  test.skip(
    active !== 'webgl',
    `${projectName}: meshBackend = 'webgl' fell back to '${active}' — nothing to measure`,
  );
  return probe;
}

test('load / render / dispose cycles leave no page texture behind', async ({ page }, testInfo) => {
  const probe = await glProbe(page, testInfo.project.name);

  expect(probe.cycles).toHaveLength(3);
  for (const [i, cycle] of probe.cycles.entries()) {
    // Fresh page image per cycle, so the un-fixed blitter pins one more each
    // time: afterRendererDispose reads baseline + 1, + 2, + 3.
    expect(cycle.backendActive, `cycle ${i} backend`).toBe('webgl');
    expect(cycle.meshPixels, `cycle ${i} drew no mesh pixels`).toBeGreaterThan(0);
    expect(cycle.before, `cycle ${i} did not start clean`).toBe(probe.baseline);
    expect(cycle.afterRender, `cycle ${i} uploaded no page texture`).toBe(probe.baseline + 1);
    expect(cycle.afterRendererDispose, `cycle ${i} kept its page texture`).toBe(probe.baseline);
    expect(cycle.afterAssetsDispose, `cycle ${i} after assets.dispose()`).toBe(probe.baseline);
  }
  expect(probe.final).toBe(probe.baseline);
});

test('a shared page survives disposing one of its renderers', async ({ page }, testInfo) => {
  const probe = await glProbe(page, testInfo.project.name);
  const sharing = probe.sharing;
  expect(sharing).not.toBeNull();
  if (!sharing) return;

  // Two renderers, two roots, one atlas page — what the demo does.
  expect(sharing.afterBothRendered, 'one page, one texture').toBe(probe.baseline + 1);
  expect(sharing.pixelsBeforeFirstDispose).toBeGreaterThan(0);
  // The negative control: releasing on the first dispose regardless of the
  // other user shows up right here.
  expect(sharing.afterFirstDispose, 'the surviving renderer still needs the page').toBe(
    probe.baseline + 1,
  );
  // Re-dirtied before the redraw, so the dirty-skip cannot fake this.
  expect(sharing.meshesRedrawn, 'the survivor skipped its raster').toBeGreaterThan(0);
  expect(sharing.pixelsAfterFirstDispose, 'the survivor stopped drawing what it drew').toBe(
    sharing.pixelsBeforeFirstDispose,
  );
  expect(sharing.afterSecondRender).toBe(probe.baseline + 1);
  expect(sharing.afterSecondDispose, 'the last user left the texture behind').toBe(probe.baseline);
});

test('disposing twice releases once', async ({ page }, testInfo) => {
  const probe = await glProbe(page, testInfo.project.name);
  const idempotence = probe.idempotence;
  expect(idempotence).not.toBeNull();
  if (!idempotence) return;

  // Two users again, so a second decrement is observable: on its own, the
  // second dispose() of the only user would find nothing to delete either way.
  expect(idempotence.afterBothRendered).toBe(probe.baseline + 1);
  expect(idempotence.afterFirstDispose).toBe(probe.baseline + 1);
  expect(idempotence.afterFirstDisposedTwice, 'the second dispose() decremented again').toBe(
    probe.baseline + 1,
  );
  expect(idempotence.afterSecondDispose).toBe(probe.baseline);

  expect(idempotence.loneAfterRender).toBe(probe.baseline + 1);
  expect(idempotence.loneAfterDisposedTwice).toBe(probe.baseline);
});

test('a canvas2d-only renderer never touches the texture count', async ({ page }, testInfo) => {
  const probe = await glProbe(page, testInfo.project.name);
  const canvas2dOnly = probe.canvas2dOnly;
  expect(canvas2dOnly).not.toBeNull();
  if (!canvas2dOnly) return;

  expect(canvas2dOnly.backendActive).toBe('canvas2d');
  expect(canvas2dOnly.meshPixels, 'the canvas2d renderer drew nothing').toBeGreaterThan(0);
  expect(canvas2dOnly.before).toBe(probe.baseline);
  expect(canvas2dOnly.afterRender, 'canvas2d uploaded a page texture').toBe(probe.baseline);
  expect(canvas2dOnly.afterDispose).toBe(probe.baseline);
});

test('a released page uploads again for the next renderer', async ({ page }, testInfo) => {
  const probe = await glProbe(page, testInfo.project.name);
  const reuse = probe.reuse;
  expect(reuse).not.toBeNull();
  if (!reuse) return;

  // Same page image, still alive — the release must cost nothing but the
  // re-upload.
  expect(reuse.beforeNewRenderer).toBe(probe.baseline);
  expect(reuse.backendActive).toBe('webgl');
  expect(reuse.afterNewRendererRender, 'the page did not upload again').toBe(probe.baseline + 1);
  expect(reuse.meshPixels, 'the re-uploaded page drew nothing').toBeGreaterThan(0);
  expect(reuse.afterDispose).toBe(probe.baseline);
});
