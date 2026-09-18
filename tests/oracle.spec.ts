import { writeFileSync } from 'node:fs';

import { expect, type Page, test } from '@playwright/test';

import { CHANNEL_TOLERANCE, diffInPage } from './pixelDiff';

// The stage is taller than the suite's default viewport, because the poses the
// oracle draws need the room (see ORACLE_STAGE in tests/oracleStage.ts) and a
// stage that does not fit would be screenshotted through a scroll.
test.use({ viewport: { width: 820, height: 760 } });

/**
 * The pixel oracle — this package against the official runtime.
 *
 * ## Why
 *
 * Every other visual test here is an A/B between this package's own two mesh
 * backends. That catches one backend drifting from the other and, by
 * construction, cannot catch a defect they share. #37 was that shape: `pma:
 * true` atlas pages were drawn one multiply too dark in *every* tier, the suite
 * stayed green for months, and a consumer found it. A reference that is not us
 * would have gone red on the first run. `@esotericsoftware/spine-webgl` is that
 * reference — the same export, the same pose, the same size, the same page,
 * drawn by the runtime this one is trying to agree with.
 *
 * It is a devDependency, named by `tests/oracleStage.ts` and nowhere else, and
 * unreachable from `src/`; `tests/package.spec.ts` is what keeps it that way.
 *
 * ## What is being compared, and what is forgiven
 *
 * The camera/pose match is derived rather than fitted — see the mapping in
 * `tests/oracleStage.ts` — and it is *proved* by driving it: the alignment
 * canary at the bottom of this file offsets the DOM side by one world unit and
 * requires the diff to see it. A comparison that could not detect a one-unit
 * shift would not be evidence of anything.
 *
 * What legitimately differs is antialiasing and texture filtering, and nothing
 * else. spine-webgl draws every slot as GL triangles sampled with linear
 * filtering into one multisampled canvas; this package composes DOM layers —
 * `<img>` cuts under a CSS matrix, per-part canvases, a `feColorMatrix` tint
 * filter, a CSS `clip-path` — and lets the browser's own image scaling and
 * compositor antialias them. So the residue is silhouette-shaped: it lives on
 * edges and on high-contrast texture detail, and it is measured the way this
 * repository measures everything else — shift-tolerant bad pixels as a **ratio
 * of drawn content**, at the channel tolerance the parity suite already uses,
 * never as an absolute per-pixel precision number. The pma bullet in CLAUDE.md
 * is why: a precision figure calibrated on macOS is macOS's number, and Linux
 * WebKit has reddened three CI runs proving it with the code working perfectly.
 *
 * The stage is drawn at scale 0.5, which is where one atlas texel is one CSS
 * pixel for this export, so neither runtime is asked to resample and the
 * forgivable residue sits at its floor rather than being inflated by a
 * downscale.
 *
 * ## The limits
 *
 * Measured, per cell, on macOS, in both engines, and recorded on the constants
 * below with the mutants that take them past. Linux exists only on the CI
 * runner, which cannot be reached from here — so every limit states its
 * headroom, and the headroom is the claim, not the floor.
 *
 * `ORACLE_DUMP=1` writes both captures, the diff mask and metrics.json for
 * every cell, the way `PARITY_DUMP=1` does for the parity suite. It is an
 * instrument, not a threshold: without it no mask is computed in the page.
 *
 * ## ROTATED PACKING — what this found on its first run, unfixed
 *
 * **The rigid tier draws a 90°-packed atlas region differently from the
 * official runtime.** Every cell below is `test.fixme` on an atlas that has
 * any, and that is a *feature* test on the parsed atlas (`rotatedRegions`),
 * not a version key — the trigger is "this packer rotated something", which a
 * consumer atlas can do on any generation.
 *
 * It surfaced because the two spineboy branches pack differently: the atlas on
 * the **4.3** branch rotates **nothing**, and the one on the **4.2** branch
 * rotates **ten** regions — `front-shin`, `front-thigh`, `rear-shin`,
 * `rear-upper-arm`, `front-fist-open`, `muzzle01`, `muzzle03`, `muzzle-ring`,
 * `hoverboard-thruster`, `portal-flare2`. So the 4.3 column is green and the
 * 4.2 column was not, and the difference between the columns is the artwork's
 * packing rather than the runtime's generation.
 *
 * MEASURED (macOS chromium, 4.2 exports, spine-core 4.2.120, full suite run):
 * every cell over the limit, `bad` 3.402–13.732% of content against a 0.141–
 * 1.778% floor on the unrotated atlas, peak channel delta 213–240. It is not
 * antialiasing and not filtering:
 *
 * - **Direction: neither.** darker and lighter come out level (10.648% against
 *   12.426% on the rigid cell), which is displacement, not a colour error.
 * - **Nothing is missing.** contentMismatch stays at 0.146–1.727%, inside the
 *   floor — the same pixels are painted, in different places.
 * - **The mask puts it on the parts, not the edges.** Solid red over both
 *   thighs, both shins and the boots, while the head, torso and gun carry only
 *   the usual yellow outline. Every solid-red part is a `rotate: 90` region or
 *   is posed by one.
 * - **It is the rigid tier.** Every rotated region is a *region* attachment in
 *   `spineboy-ess`, and all but one (`front-shin`) in `spineboy-pro` — and the
 *   meshed cells score lower (7.653–7.730%) than the rigid ones (13.418–
 *   13.732%) because their mesh slots are correct and dilute it. The mesh tier
 *   samples the page through spine-core's UVs; the rigid tier draws an
 *   unpacked, un-rotated cut through a CSS matrix. Only the second one
 *   disagrees.
 *
 * Which side is wrong is not asserted here, but the reference's leg is
 * anatomically coherent and this package's is not (knee pad at the ankle, boot
 * detached at the hip), and the rigid tier is the only side doing anything
 * rotation-specific.
 *
 * Nothing was tuned to hide this and nothing in `src/` was touched to make it
 * go away: the limits above are calibrated on the unrotated atlas, where they
 * hold with the headroom recorded, and the cells say plainly when they are not
 * measuring what they claim to.
 */

const POSE = { animation: 'walk', time: 1.2 } as const;

/** See the header: an on-demand instrument, never a threshold. */
const DUMP = process.env.ORACLE_DUMP === '1';

/**
 * Shift-tolerant bad pixels allowed, as a fraction of drawn content.
 *
 * Two runtimes agreeing is a much looser thing than one package's two backends
 * agreeing: the parity suite's floor is 0.000–0.049% of content, and this one's
 * is an order of magnitude above it, because every silhouette in the picture is
 * antialiased by a different machine on each side — GL multisampling against
 * the browser's compositor — and spineboy is mostly silhouette.
 *
 * MEASURED, macOS, per cell, both engines (the PR body carries the full table).
 * Repaired floor: 0.141–1.778% on chromium and 0.141–0.842% on webkit, the
 * worst being the premultiplied rigid cell, whose 8-bit un-premultiply adds a
 * residue of its own on top of the AA.
 *
 * Against that, the mutants:
 *
 * - #37 reintroduced (every tier ignores `page.pma`): 6.200–7.370% on the
 *   three premultiplied cells, and *nothing* on the other eight.
 * - every rigid region's world vertices offset 8 world units — 4 CSS px at
 *   this stage scale: 9.302–26.636%, every cell, both engines.
 * - one mesh (`torso`) never drawn: 2.581–6.540% on the cells that show it.
 *
 * 0.04 sits 2.25× over the worst floor and 2.33× under the quietest defect.
 * Not the parity suite's 10× headroom: at 10× this limit would be 18% of
 * content and could no longer see a missing part at all. That gap is what
 * there is, and the headroom is the claim.
 *
 * Its sensitivity floor, stated because it is a real limit and not a
 * guess: the same geometric mutant at *3* world units (1.5 CSS px) scores
 * 1.341–4.438%, which overlaps the AA floor — only the rigid-tier cells clear
 * 0.04, which is still three red cells and still a red suite, but the margin
 * is gone. Below that, geometry is the alignment canary's job, not this
 * limit's: it detects a *single* world unit at 3.3× (chromium) and 6.5×
 * (webkit).
 *
 * This is the limit most at risk on Linux, and deliberately the one with the
 * least margin. If a cell reddens there, the answer is a one-variable dispatch
 * with `ORACLE_DUMP=1` and a look at the mask: a residue that is genuinely AA
 * sits on outlines, and anything on whole triangles or whole parts is not.
 */
const BAD_RATIO_LIMIT = 0.04;

/**
 * Allowed relative difference in drawn-content pixel counts — the missing-part
 * guard.
 *
 * It counts *how much* of the stage each runtime covered, so it is nearly blind
 * to edge antialiasing (a softened edge pixel is still content on both sides)
 * and loud about anything that fails to draw. It is deliberately blind to a
 * geometric shift too, which moves content rather than removing it: the 4 px
 * mutant above leaves this at 0.081–1.062%, inside the floor.
 *
 * MEASURED: floor 0.009–1.279% on chromium and 0.011–0.702% on webkit (the
 * `shoot` cell drives it — its muzzle flash is a large soft additive area, so
 * the two runtimes disagree most about where content starts). The missing-mesh
 * mutant takes it to 2.765–5.994% on the cells that show the part.
 *
 * 0.025 is 1.95× over the worst floor and ~1.1× under the smallest defect. The
 * thin end of that is chromium's, and chromium's floors have historically been
 * platform-independent here — ubuntu CI matched macOS across the parity suite.
 * The platform that does move is Linux WebKit, which ran ~1.8× macOS WebKit on
 * the parity suite's own content-mismatch floor (0.22% → 0.40%); the same
 * factor on this suite's worst webkit floor is ~1.26%, leaving 2× under this
 * limit.
 */
const CONTENT_MISMATCH_LIMIT = 0.025;

/**
 * One-sided colour error allowed on a premultiplied page, as a fraction of
 * content.
 *
 * #37's defect class is directional by construction — a doubled premultiply can
 * only darken — so the premultiplied cells assert on the *side* the differences
 * fall on and not merely on how many there are. Antialiasing noise lands on
 * both sides of the line in comparable measure, so the excess of darker over
 * lighter cancels it; a second multiply lands on one side and does not.
 *
 * MEASURED on the three premultiplied cells: excess −0.193% to +1.235%
 * repaired (darker and lighter within about a factor of two of each other, the
 * signature of noise), and +8.136% to +9.753% with the flag ignored, where the
 * lighter side collapses to 0.4–1.2% while the darker side climbs past 8.5%.
 *
 * 0.03 is 2.43× over the worst floor and 2.71× under the quietest mutant.
 *
 * It is asserted on the premultiplied cells only, which is where the defect
 * class lives. The straight-alpha cells measure the same floor (up to 1.234%),
 * so the check could be widened — but that would put a limit this machine
 * cannot calibrate on Linux across 22 cells instead of 6, and the evidence for
 * doing it is not here yet.
 */
const DIRECTIONAL_EXCESS_LIMIT = 0.03;

/** What the oracle asks of the shared differ: the stage is one flat colour. */
const ORACLE_DIFF = { directional: CHANNEL_TOLERANCE } as const;

interface Cell {
  name: string;
  page: 'plain' | 'pma';
  skeleton: 'ess' | 'pro';
  animation?: string;
  /** Track time, when the cell wants a pose other than the file's default. */
  time?: number;
  backend?: 'canvas2d' | 'webgl';
  tint?: string;
}

/**
 * The cells. Every tier that reads a page, every element-level feature that has
 * no equivalent inside the reference's single canvas, and both alpha
 * conventions — because the conventions and the tiers are what #37 crossed.
 */
const CELLS: Cell[] = [
  // The rigid tier is pure DOM: <img> elements under CSS matrices, no raster
  // of ours at all. Nothing else in the suite compares it to anything but
  // itself.
  { name: 'rigid tier (spineboy-ess)', page: 'plain', skeleton: 'ess', backend: 'canvas2d' },
  { name: 'mesh tier, canvas2d', page: 'plain', skeleton: 'pro', backend: 'canvas2d' },
  { name: 'mesh tier, webgl', page: 'plain', skeleton: 'pro', backend: 'webgl' },
  // The exporter's own premultiplied twin of the same artwork — spineboy-pma
  // differs from spineboy by the page name and a `pma: true` line and by
  // nothing else, so these three are #37's cells exactly: one per tier that
  // has to read the flag.
  { name: 'pma page, rigid tier', page: 'pma', skeleton: 'ess', backend: 'canvas2d' },
  { name: 'pma page, mesh tier canvas2d', page: 'pma', skeleton: 'pro', backend: 'canvas2d' },
  { name: 'pma page, mesh tier webgl', page: 'pma', skeleton: 'pro', backend: 'webgl' },
  // Clipping is a CSS clip-path here and a CPU triangle clipper there: two
  // entirely different mechanisms for one polygon.
  { name: 'clipping (portal)', page: 'plain', skeleton: 'pro', animation: 'portal', backend: 'canvas2d' },
  // The hoverboard exhaust is the export's own BlendMode.Additive slot —
  // `mix-blend-mode: plus-lighter` here against GL's ONE/ONE there. 25 of
  // spineboy's 52 slots are additive, and the exhaust ones carry a slot colour
  // (`5eb4ffff`) on top, so this cell is blend and tint at once.
  { name: 'additive blend (hoverboard), canvas2d', page: 'plain', skeleton: 'pro', animation: 'hoverboard', backend: 'canvas2d' },
  { name: 'additive blend (hoverboard), webgl', page: 'plain', skeleton: 'pro', animation: 'hoverboard', backend: 'webgl' },
  // Per-slot colour AND per-slot alpha, from the asset rather than from a knob:
  // `shoot` animates `rgba` timelines on the muzzle slots, and at t=0.15 the
  // flash is mid-fade — muzzle-glow around ff400c at partial alpha, the four
  // muzzle rings dropping from d8baff to zero. Tint is an SVG feColorMatrix
  // filter here and a vertex colour there; alpha is element opacity here and a
  // vertex alpha there, so a translucent tinted slot crosses both at once.
  { name: 'slot rgba + alpha (shoot)', page: 'plain', skeleton: 'pro', animation: 'shoot', time: 0.15, backend: 'canvas2d' },
  // Whole-skeleton tint — the one tint input no slot supplies, and the knob the
  // parity suite drives with `?tint=`.
  { name: 'tint (skeleton colour)', page: 'plain', skeleton: 'pro', tint: 'ff9060', backend: 'canvas2d' },
];

async function openHarness(page: Page): Promise<void> {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
}

/**
 * Screenshots the stage until two captures in a row are byte-identical — the
 * cut-rule spec's rule: a freshly decoded bitmap is not yet a settled raster.
 */
async function stableShot(page: Page): Promise<Buffer> {
  const stage = page.locator('#oracle-stage');
  let previous = await stage.screenshot();
  for (let attempt = 0; attempt < 12; attempt++) {
    const next = await stage.screenshot();
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error('the stage raster never settled');
}

interface Capture {
  shot: Buffer;
  info: Awaited<ReturnType<typeof window.spineHtmlHarness.oracleStage>>;
}

async function capture(
  page: Page,
  cell: Cell,
  side: 'dom' | 'reference',
  offsetX = 0,
): Promise<Capture> {
  const info = await page.evaluate(
    (opts) => window.spineHtmlHarness.oracleStage(opts),
    {
      side,
      page: cell.page,
      skeleton: cell.skeleton,
      animation: cell.animation ?? POSE.animation,
      time: cell.time ?? POSE.time,
      backend: cell.backend,
      tint: cell.tint ?? null,
      offsetX,
    },
  );
  // A cell that quietly drew nothing, or drew the wrong page, would compare two
  // pictures of the same nothing and pass.
  expect(info.side).toBe(side);
  expect(info.pagePma).toBe(cell.page === 'pma');
  if (side === 'reference') {
    // Nothing reached the GPU is the one way this side fails silently.
    expect(info.drawCalls).toBeGreaterThan(0);
  } else {
    expect(info.imageCount + info.canvasCount).toBeGreaterThan(10);
    // The stage has to contain the skeleton, or the two runtimes are being
    // compared on a crop.
    expect(info.contentBox.x).toBeGreaterThan(0);
    expect(info.contentBox.y).toBeGreaterThan(0);
    expect(info.contentBox.x + info.contentBox.width).toBeLessThan(info.stage.width);
    expect(info.contentBox.y + info.contentBox.height).toBeLessThan(info.stage.height);
    if (cell.skeleton === 'pro') {
      expect(info.meshesDrawn).toBeGreaterThan(0);
      // Guard the guard: a webgl cell that fell back to canvas2d would be
      // testing the 2d path twice under two names.
      expect(info.backendActive).toBe(cell.backend);
    }
  }
  return { shot: await stableShot(page), info };
}

for (const cell of CELLS) {
  test(`spine-webgl oracle: ${cell.name}`, async ({ page }, testInfo) => {
    await openHarness(page);
    // A = the official runtime, B = this package, so "darker" below reads as
    // "spine-html darker than the reference" — #37's direction.
    const referenceShot = await capture(page, cell, 'reference');
    // See ROTATED PACKING at the top of this file: a 90°-packed region is drawn
    // differently from the official runtime, so on an atlas that has any, these
    // cells measure that defect and not what they were written to measure.
    test.fixme(
      referenceShot.info.rotatedRegions > 0,
      `${referenceShot.info.rotatedRegions} of this atlas's regions are 90°-packed — ` +
        'the rigid tier disagrees with the reference on those; see ROTATED PACKING',
    );
    const domShot = await capture(page, cell, 'dom');
    const reference = referenceShot.shot;
    const dom = domShot.shot;
    const m = await diffInPage(page, reference, dom, { ...ORACLE_DIFF, withMask: DUMP });

    const badRatio = m.bad / Math.max(1, m.contentUnion);
    const contentMismatch =
      Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB);
    const darkerRatio = m.darker / Math.max(1, m.contentUnion);
    const lighterRatio = m.lighter / Math.max(1, m.contentUnion);
    const directionalExcess = darkerRatio - lighterRatio;
    // Always in the run log, CI included: the drift of these numbers over time
    // is the early signal, not just the pass/fail line.
    console.log(
      `[oracle] ${testInfo.project.name} ${cell.name}: ${m.width}x${m.height}, ` +
        `content ref=${m.contentA} dom=${m.contentB} union=${m.contentUnion}, ` +
        `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(3)}% of content, ` +
        `ch>${CHANNEL_TOLERANCE}), maxDelta=${m.maxDelta}, ` +
        `contentMismatch=${(contentMismatch * 100).toFixed(3)}%, ` +
        `darker=${(darkerRatio * 100).toFixed(3)}% lighter=${(lighterRatio * 100).toFixed(3)}% ` +
        `excess=${(directionalExcess * 100).toFixed(3)}% ` +
        `(mean drop ${m.darkerMean}, peak ${m.darkerMax})`,
    );

    if (DUMP) {
      const mask = m.mask;
      if (!mask) throw new Error('ORACLE_DUMP is set but the diff returned no mask');
      const files: Record<string, Buffer> = {
        'a-reference.png': reference,
        'b-spine-html.png': dom,
        'diff-mask.png': Buffer.from(mask.pngBase64, 'base64'),
        'metrics.json': Buffer.from(
          `${JSON.stringify(
            {
              project: testInfo.project.name,
              cell: cell.name,
              platform: process.platform,
              width: m.width,
              height: m.height,
              contentReference: m.contentA,
              contentDom: m.contentB,
              contentUnion: m.contentUnion,
              bad: m.bad,
              rawBad: m.rawBad,
              maxDelta: m.maxDelta,
              channelTolerance: CHANNEL_TOLERANCE,
              badRatio,
              badRatioLimit: BAD_RATIO_LIMIT,
              contentMismatch,
              contentMismatchLimit: CONTENT_MISMATCH_LIMIT,
              darkerRatio,
              lighterRatio,
              directionalExcess,
              maskDirection: mask.direction,
              maskRed: mask.red,
              maskYellow: mask.yellow,
            },
            null,
            2,
          )}\n`,
        ),
      };
      for (const [name, body] of Object.entries(files)) {
        const path = testInfo.outputPath(name);
        writeFileSync(path, body);
        await testInfo.attach(name, {
          path,
          contentType: name.endsWith('.png') ? 'image/png' : 'application/json',
        });
      }
      // The instrument's self-check: the mask is painted by the counting pass,
      // so a mask that disagrees with the counts is a picture that would send
      // its reader after the wrong cause.
      expect(mask.red).toBe(m.bad);
      expect(mask.red + mask.yellow).toBe(m.rawBad);
    }

    if (badRatio > BAD_RATIO_LIMIT || contentMismatch > CONTENT_MISMATCH_LIMIT) {
      writeFileSync(testInfo.outputPath('reference.png'), reference);
      writeFileSync(testInfo.outputPath('spine-html.png'), dom);
    }

    // Both runtimes must actually have drawn a skeleton — two blank stages
    // agree perfectly.
    expect(m.contentUnion).toBeGreaterThan(5000);
    expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
    expect(contentMismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
    // Only where the defect class is directional: a premultiplied page is the
    // one place a shared multiply can hide.
    if (cell.page === 'pma') {
      expect(directionalExcess).toBeLessThanOrEqual(DIRECTIONAL_EXCESS_LIMIT);
    }
  });
}

/**
 * The alignment canary — the proof that the two frames are the same frame.
 *
 * Every number above is worthless if the camera and the DOM stage do not land
 * world space on the same pixels: two runtimes drawing the same skeleton a few
 * units apart would still score as "sub-pixel noise on silhouettes", just more
 * of it. So the mapping is driven rather than asserted: the DOM side is offset
 * by one world unit — half a CSS pixel at this stage scale, the smallest
 * deliberate error worth calling an error — and the diff must see it.
 *
 * It reads `rawBad`, the direct per-pixel compare, and not the shift-tolerant
 * `bad` the cells use, because the 3×3 neighbourhood match forgives a whole-image
 * shift of up to one pixel *by construction* — that is what it is for, and it is
 * precisely the wrong instrument for this question.
 *
 * Deterministic on both sides (one frozen pose, one engine, one run), so the
 * counts are exact rather than statistical. MEASURED: aligned 1,151 raw-bad
 * (chromium) and 555 (webkit); offset by one world unit, 3,781 and 3,611 — a
 * 3.28× and 6.51× move for half a CSS pixel.
 *
 * The assertion is on the *ratio*, not on either count: the aligned figure is a
 * rasterizer's number and would be expected to sit higher on a noisier one,
 * while the offset figure is dominated by the shift. 1.5× leaves 2.2× and 4.3×
 * of margin here, and survives an aligned floor that doubles.
 */
test('alignment canary: a one-unit world offset is detected', async ({ page }) => {
  await openHarness(page);
  const cell = CELLS[1]; // the meshed canvas2d cell — every tier is in it
  const referenceShot = await capture(page, cell, 'reference');
  test.fixme(
    referenceShot.info.rotatedRegions > 0,
    'a 90°-packed region moves the aligned floor this canary is a ratio against; ' +
      'see ROTATED PACKING',
  );
  const reference = referenceShot.shot;
  const aligned = (await capture(page, cell, 'dom')).shot;
  const offset = (await capture(page, cell, 'dom', 1)).shot;

  const alignedDiff = await diffInPage(page, reference, aligned);
  const offsetDiff = await diffInPage(page, reference, offset);
  console.log(
    `[oracle] ${test.info().project.name} alignment canary: ` +
      `aligned rawBad=${alignedDiff.rawBad}, +1 world unit rawBad=${offsetDiff.rawBad}, ` +
      `ratio=${(offsetDiff.rawBad / Math.max(1, alignedDiff.rawBad)).toFixed(2)}×`,
  );

  // The offset capture must differ from the aligned one at all — a `skeleton.x`
  // that did nothing would make this whole test vacuous.
  const shift = await diffInPage(page, aligned, offset);
  expect(shift.rawBad).toBeGreaterThan(1000);
  // And the offset has to cost measurably more disagreement with the reference
  // than the alignment does. Ratio, not an absolute count: the floor is a
  // rasterizer's number and the ratio is the geometry's.
  expect(offsetDiff.rawBad).toBeGreaterThan(alignedDiff.rawBad * 1.5);
});
