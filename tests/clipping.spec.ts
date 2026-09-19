import { writeFileSync } from 'node:fs';

import { expect, type Page, test } from '@playwright/test';
import type { ClipCapture } from './harness';

/**
 * Clipping attachments as element-level CSS clip-paths.
 *
 * ## The oracle
 *
 * A clip-path is a string, and a string is not evidence: a polygon put through
 * the wrong transform still parses, still applies, and still counts as a clip
 * applied. So nothing here asserts on the strings the renderer writes (beyond
 * their presence or absence, which is a different claim). The oracle is pixels,
 * built so that it CANNOT agree with the implementation by sharing its
 * mistake — it never touches an element's local frame:
 *
 *   clipped_capture  ==  mask(unclipped_capture, world_polygon)
 *
 * where `mask` clips a 2d context to the world polygon mapped through the
 * capture's stage transform (origin + scale, both reported by the harness) and
 * draws the unclipped capture into it, over nothing — the capture boxes are
 * transparent and screenshotted with `omitBackground`, so "no artwork here" is
 * alpha 0 rather than a color that has to be told apart from the artwork. The
 * renderer reaches that same picture by inverting each element's own matrix,
 * per element; the oracle reaches it once, in screen space. A forgotten Y flip,
 * a world polygon used as a local one, a missed inverse — each of those moves
 * the renderer's picture and leaves the oracle's where it was.
 *
 * Both captures come from the same pose and the same slots (the probes hide
 * everything the clip does not cover), so the clip is the only variable.
 *
 * ## What is asserted, and why it is not a pixel budget
 *
 * Comparing the two captures pixel VALUE by pixel value does not work, and the
 * reason was measured rather than guessed. A clipped element and an unclipped
 * one are the same geometry, but the browser draws the clipped one through a
 * mask, and the artwork's own antialiased silhouettes come out a shade
 * different all over the picture — 590 such pixels on the rigid cell, every
 * single one of them on a silhouette, as far as 52 px from the clip. So a
 * value comparison, even the shift-tolerant one parity.spec.ts uses, measures
 * the rasterizer rather than the clip.
 *
 * What is NOT the cause, also measured: the mere presence of a clip-path. The
 * `control` capture is clipped by a polygon so large it removes nothing, and
 * it comes back byte-identical to the unclipped capture (rawBad 0, maxDelta 0).
 * Only a clip that actually cuts changes anything, and what it changes is the
 * silhouettes, not where the artwork is.
 *
 * So the assertions are about OCCUPANCY — is there artwork at this point? —
 * which is the question a clip actually answers, and they are absolute rather
 * than budgeted. Outside a RIM_PX band around the polygon's outline, where the
 * two rasterizers legitimately disagree about the boundary itself:
 *
 * 1. `contentOutsideClip` — artwork surviving at a point the polygon excludes.
 *    Nothing is compared against another rasterization to decide this, so no
 *    tolerance applies at all. Must be 0.
 * 2. `contentMissingInsideClip` — artwork the unclipped capture has and the
 *    clipped one lost, at a point the polygon includes. Must be 0.
 *
 * Both are 0 on both engines today. A clip that landed somewhere else fails
 * the first by the whole area it should have removed; a clip that ate too much
 * fails the second the same way. The mutation table in the pull request is the
 * evidence that they do.
 *
 * The value-level numbers are still computed and logged — they are the drift
 * signal over time, the way parity.spec.ts's are — and `CLIP_DUMP=1` writes
 * the pictures behind them.
 */

/**
 * `CLIP_DUMP=1` turns every cell below into an instrument, the way
 * `PARITY_DUMP` does for parity.spec.ts: it writes the clipped capture, the
 * unclipped one, the oracle built from it, and a mask painting each
 * disagreeing pixel over a dimmed silhouette of the clipped capture: magenta
 * where occupancy disagrees (the shape a clip in the wrong place has), red and
 * orange where only the value does, yellow inside the rim. The counts say how
 * many pixels disagree and never where, and "where" is the whole question when
 * a clip is wrong — the magenta wedge that identified `polygon()` as unable to
 * carry an inverse clip's second ring was found this way and no other.
 * Left unset, none of it is computed and nothing is written.
 */
const DUMP = process.env.CLIP_DUMP === '1';

/** Max per-channel delta before a pixel counts as disagreeing. */
const CHANNEL_TOLERANCE = 24;
/**
 * Band around the polygon's outline, in capture pixels, where the occupancy
 * checks stand down. Two rasterizers draw that boundary — the browser's
 * clip-path and the canvas `ctx.clip()` the oracle uses — and they antialias
 * it differently; where clipped elements overlap along it, the renderer's edge
 * is composited more than once. One pixel of antialiasing on each side, plus
 * one for that overlap.
 */
const RIM_PX = 3;
/**
 * Alpha above which a pixel counts as ARTWORK for the occupancy checks. Not a
 * trace: the antialiasing fringe around a silhouette runs a few alpha units,
 * and the browser reproduces it a shade weaker once an element is drawn
 * through a clip mask, which is enough to flip any near-zero threshold along
 * every outline in the picture (measured: 92 such pixels on the rigid cell at
 * a threshold of 8, all of them a 1 px ring around the character, none of them
 * visible). A quarter-opaque floor asks the question that matters — is the
 * artwork here or not — instead of asking about the edge of its shadow.
 */
const CONTENT_ALPHA = 64;

/**
 * Whether the installed spine-core can express an inverse clip at all.
 *
 * `ClippingAttachment.inverse` arrived in 4.3 and no older editor exports one,
 * so on an older core `src/coreCompat.ts` answers `false` rather than reading a
 * property that is not there. The probe for it sets the flag by hand, which on
 * such a core would be writing a field nothing reads and then asserting a
 * clip-path shape that cannot occur — an absent feature, not a wrong
 * behaviour. Detected off the class rather than off a version string, for the
 * same reason the seam is, and phrased as a *feature* so that the day the
 * supported range's floor moves, this simply starts running again.
 *
 * Asked of the *page* rather than constructed here, because plain node cannot
 * import spine-core 4.0 at all and Playwright loads a spec file's imports with
 * node's resolver — see the header of tests/invariants.spec.ts.
 */
async function inverseClippingSupported(page: Page): Promise<boolean> {
  return (await page.evaluate(() => window.spineHtmlHarness.regionGeometryProbe()))
    .inverseClipping;
}

interface MaskMetrics {
  width: number;
  height: number;
  /** Pixels differing from the oracle by more than the tolerance, directly. */
  rawBad: number;
  /** Of those, the ones with no in-tolerance match in the other image's 3×3. */
  bad: number;
  /** Of those, the ones further than RIM_PX from the polygon outline. */
  badOutsideRim: number;
  maxDelta: number;
  /** Largest distance-to-outline among disagreeing pixels. */
  maxBadDistance: number;
  /** Disagreeing pixels bucketed by distance to the outline: index = px. */
  rimHistogram: number[];
  /** Artwork pixels in the clipped capture — a vacuity guard. */
  content: number;
  /** Raw pixels where the clipped and unclipped captures differ at all. */
  cutPixels: number;
  /**
   * Of the disagreeing pixels outside the rim, how many sit on a silhouette —
   * a neighbourhood the unclipped capture itself already paints with a hard
   * edge. Those are a rasterizer difference between two pictures of the same
   * geometry, not a clip landing in the wrong place.
   */
  badOutsideRimOnEdge: number;
  /**
   * Content the clip should have REMOVED and did not: artwork in the clipped
   * capture at a point the world polygon excludes, further than RIM_PX from
   * its outline. Absolute — nothing is compared against another rasterization
   * to decide it, so no tolerance applies. Must be 0.
   */
  contentOutsideClip: number;
  /**
   * Content the clip should have KEPT and did not: a point the polygon
   * includes, further than RIM_PX from the outline, where the unclipped
   * capture has artwork in its 3×3 and the clipped capture has none in its
   * own. Must be 0.
   */
  contentMissingInsideClip: number;
  /** Distance-to-outline buckets for the two counts above: index = px. */
  occupancyHistogram: number[];
  /** CLIP_DUMP only: the pictures behind the counts, PNG base64. */
  dump?: { oracle: string; mask: string };
}

/**
 * Builds the oracle and measures against it, entirely in the page (canvas
 * getImageData — no extra dependency, same approach as parity.spec.ts).
 */
async function maskMetrics(
  page: Page,
  clipped: Buffer,
  unclipped: Buffer,
  capture: ClipCapture,
  polygon: number[],
  evenOdd: boolean,
): Promise<MaskMetrics> {
  return page.evaluate(
    async ({
      aB64,
      bB64,
      capture,
      polygon,
      tolerance,
      rim,
      contentAlpha,
      evenOdd,
      withDump,
    }): Promise<MaskMetrics> => {
      const decode = async (b64: string): Promise<HTMLImageElement> => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        return img;
      };
      const context = (w: number, h: number): CanvasRenderingContext2D => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('2d context unavailable');
        return ctx;
      };
      const [aImg, bImg] = await Promise.all([decode(aB64), decode(bB64)]);
      const w = aImg.naturalWidth;
      const h = aImg.naturalHeight;
      if (bImg.naturalWidth !== w || bImg.naturalHeight !== h) {
        throw new Error(`capture size mismatch: ${w}x${h} vs ${bImg.naturalWidth}x${bImg.naturalHeight}`);
      }

      // The world polygon in capture pixels — the stage transform, applied
      // once, in screen space. Nothing here knows how an element is posed.
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < polygon.length; i += 2) {
        pts.push([
          capture.originX + capture.scale * polygon[i],
          capture.originY + capture.scale * polygon[i + 1],
        ]);
      }

      const aCtx = context(w, h);
      aCtx.drawImage(aImg, 0, 0);
      const bCtx = context(w, h);
      bCtx.drawImage(bImg, 0, 0);

      // The oracle: the unclipped capture through the polygon, over nothing.
      // The boxes are captured with `omitBackground`, so "outside the clip"
      // means alpha 0 rather than "close to some backdrop color".
      const oCtx = context(w, h);
      oCtx.save();
      oCtx.beginPath();
      if (evenOdd) {
        // An inverse clip keeps what is OUTSIDE the polygon: the outer ring is
        // the capture box, and even-odd removes the polygon from it.
        oCtx.moveTo(0, 0);
        oCtx.lineTo(w, 0);
        oCtx.lineTo(w, h);
        oCtx.lineTo(0, h);
        oCtx.closePath();
      }
      oCtx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) oCtx.lineTo(pts[i][0], pts[i][1]);
      oCtx.closePath();
      oCtx.clip(evenOdd ? 'evenodd' : 'nonzero');
      oCtx.drawImage(bImg, 0, 0);
      oCtx.restore();

      const pa = aCtx.getImageData(0, 0, w, h).data;
      const pb = bCtx.getImageData(0, 0, w, h).data;
      const po = oCtx.getImageData(0, 0, w, h).data;

      /**
       * Does the clip KEEP this point? Ray casting against the same world
       * polygon, in the same screen space, with `evenOdd` (an inverse clip)
       * flipping the answer. This is what makes the two assertions absolute:
       * each side of the boundary has an expected answer of its own, and
       * neither is "whatever the other rasterizer produced".
       */
      const kept = (px: number, py: number): boolean => {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i];
          const [xj, yj] = pts[j];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
          }
        }
        return evenOdd ? !inside : inside;
      };

      // Distance from a pixel centre to the polygon's outline (its segments),
      // which is what "the residue is the rim" has to be measured against.
      const distanceToOutline = (px: number, py: number): number => {
        let best = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const [x1, y1] = pts[i];
          const [x2, y2] = pts[(i + 1) % pts.length];
          const dx = x2 - x1;
          const dy = y2 - y1;
          const len2 = dx * dx + dy * dy;
          let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = x1 + t * dx - px;
          const qy = y1 + t * dy - py;
          const d = Math.sqrt(qx * qx + qy * qy);
          if (d < best) best = d;
        }
        return best;
      };

      // Artwork is whatever is not transparent. Unambiguous in a way a
      // color-distance test is not: spineboy's outfit is nearly black, so
      // against a dark backdrop "dark" and "absent" would be the same answer.
      const isContent = (p: Uint8ClampedArray, i: number): boolean => p[i + 3] > contentAlpha;

      /**
       * Occupancy: does this pixel, or any of its 3×3 neighbours, carry
       * artwork? The neighbourhood is what makes it a statement about the
       * picture rather than about one sample of it — a silhouette pixel slides
       * across the background threshold under any resampling difference, while
       * a clip in the wrong place empties (or fills) a whole region and cannot
       * find content next door.
       */
      const occupiedNear = (p: Uint8ClampedArray, i: number, radius: number): boolean => {
        const q = i / 4;
        const px = q % w;
        const py = (q - px) / w;
        for (let dy = -radius; dy <= radius; dy++) {
          const y = py + dy;
          if (y < 0 || y >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const x = px + dx;
            if (x < 0 || x >= w) continue;
            if (isContent(p, (y * w + x) * 4)) return true;
          }
        }
        return false;
      };

      /**
       * Shift-tolerant match, the same one parity.spec.ts uses: is there any
       * pixel in the other image's 3×3 neighbourhood within tolerance of this
       * one? Sub-pixel resampling speckle always has such a neighbour; a clip
       * that moved does not.
       */
      const matchesNear = (
        from: Uint8ClampedArray,
        i: number,
        into: Uint8ClampedArray,
      ): boolean => {
        const p = i / 4;
        const px = p % w;
        const py = (p - px) / w;
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
              Math.abs(from[i + 2] - into[j + 2]) <= tolerance &&
              Math.abs(from[i + 3] - into[j + 3]) <= tolerance
            ) {
              return true;
            }
          }
        }
        return false;
      };

      /**
       * Is this pixel on a hard edge of the picture itself? Measured on the
       * UNCLIPPED capture, so the answer describes the artwork's silhouette
       * and never the clip: the widest per-channel spread across the 3×3.
       */
      const onSilhouette = (i: number): boolean => {
        const p = i / 4;
        const px = p % w;
        const py = (p - px) / w;
        let lo = 255;
        let hi = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const y = py + dy;
          if (y < 0 || y >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = px + dx;
            if (x < 0 || x >= w) continue;
            const j = (y * w + x) * 4;
            for (let ch = 0; ch < 4; ch++) {
              if (pb[j + ch] < lo) lo = pb[j + ch];
              if (pb[j + ch] > hi) hi = pb[j + ch];
            }
          }
        }
        return hi - lo > tolerance;
      };

      let rawBad = 0;
      let bad = 0;
      let badOutsideRim = 0;
      let badOutsideRimOnEdge = 0;
      let maxDelta = 0;
      let maxBadDistance = 0;
      let content = 0;
      let cutPixels = 0;
      let contentOutsideClip = 0;
      let contentMissingInsideClip = 0;
      const occupancyHistogram: number[] = [];
      const rimHistogram: number[] = [];
      const maskData = withDump ? new Uint8ClampedArray(pa.length) : null;
      for (let i = 0; i < pa.length; i += 4) {
        if (isContent(pa, i)) content++;
        // The two absolute checks, run on every pixel rather than only on the
        // ones that disagree by value: a clip in the wrong place can EMPTY a
        // region, and an emptied region over a dark backdrop need not trip a
        // value compare at all.
        const p0 = i / 4;
        const px0 = (p0 % w) + 0.5;
        const py0 = (p0 - (p0 % w)) / w + 0.5;
        const outsideRim = distanceToOutline(px0, py0) > rim;
        let occupancyDiffers = false;
        const dist1 = distanceToOutline(px0, py0);
        if (outsideRim) {
          if (kept(px0, py0)) {
            // Inside the clip: whatever the unclipped capture draws here has
            // to have survived.
            if (occupiedNear(pb, i, 1) && !occupiedNear(pa, i, 2)) {
              contentMissingInsideClip++;
              occupancyDiffers = true;
            }
          } else if (isContent(pa, i)) {
            // Outside the clip: there must be nothing at all.
            contentOutsideClip++;
            occupancyDiffers = true;
          }
          if (occupancyDiffers) {
            const b = Math.min(Math.floor(dist1), 12);
            occupancyHistogram[b] = (occupancyHistogram[b] ?? 0) + 1;
          }
        }
        const cut = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]),
          Math.abs(pa[i + 3] - pb[i + 3]),
        );
        if (cut > tolerance) cutPixels++;
        const delta = Math.max(
          Math.abs(pa[i] - po[i]),
          Math.abs(pa[i + 1] - po[i + 1]),
          Math.abs(pa[i + 2] - po[i + 2]),
          Math.abs(pa[i + 3] - po[i + 3]),
        );
        if (delta > maxDelta) maxDelta = delta;
        if (maskData) {
          const grey = (((pa[i + 3] / 255) * 160 + 30) * 0.45) | 0;
          maskData[i] = grey;
          maskData[i + 1] = grey;
          maskData[i + 2] = grey;
          maskData[i + 3] = 255;
          if (occupancyDiffers) {
            // Magenta: the signature of a clip that landed somewhere else.
            maskData[i] = 255;
            maskData[i + 1] = 0;
            maskData[i + 2] = 255;
          }
        }
        if (delta <= tolerance) continue;
        rawBad++;
        // Only a pixel with no match anywhere in the other image's 3×3 is a
        // real disagreement; see the header for what the rest of them are.
        if (matchesNear(pa, i, po) && matchesNear(po, i, pa)) continue;
        bad++;
        const p = i / 4;
        const px = p % w;
        const d = distanceToOutline(px + 0.5, (p - px) / w + 0.5);
        if (d > maxBadDistance) maxBadDistance = d;
        let outsideOnEdge = false;
        if (d > rim) {
          badOutsideRim++;
          outsideOnEdge = onSilhouette(i);
          if (outsideOnEdge) badOutsideRimOnEdge++;
        }
        const bucket = Math.min(Math.floor(d), 12);
        rimHistogram[bucket] = (rimHistogram[bucket] ?? 0) + 1;
        if (maskData && !occupancyDiffers) {
          // Red = outside the rim and NOT on a silhouette (the shape a wrong
          // transform has). Orange = outside the rim but on a silhouette.
          // Yellow = inside the rim.
          maskData[i] = 255;
          maskData[i + 1] = d > rim ? (outsideOnEdge ? 140 : 0) : 255;
          maskData[i + 2] = 0;
        }
      }
      for (let i = 0; i <= 12; i++) {
        rimHistogram[i] = rimHistogram[i] ?? 0;
        occupancyHistogram[i] = occupancyHistogram[i] ?? 0;
      }

      let dump: MaskMetrics['dump'];
      if (maskData) {
        const mCtx = context(w, h);
        mCtx.putImageData(new ImageData(maskData, w, h), 0, 0);
        const strip = (url: string): string =>
          url.replace(/^data:image\/png;base64,/, '');
        dump = {
          oracle: strip(oCtx.canvas.toDataURL('image/png')),
          mask: strip(mCtx.canvas.toDataURL('image/png')),
        };
      }

      return {
        width: w,
        height: h,
        rawBad,
        bad,
        badOutsideRim,
        badOutsideRimOnEdge,
        maxDelta,
        maxBadDistance,
        rimHistogram,
        content,
        cutPixels,
        contentOutsideClip,
        contentMissingInsideClip,
        occupancyHistogram,
        dump,
      };
    },
    {
      aB64: clipped.toString('base64'),
      bB64: unclipped.toString('base64'),
      capture,
      polygon,
      tolerance: CHANNEL_TOLERANCE,
      rim: RIM_PX,
      contentAlpha: CONTENT_ALPHA,
      evenOdd,
      withDump: DUMP,
    },
  );
}

async function report(
  label: string,
  m: MaskMetrics,
  clipped: Buffer,
  unclipped: Buffer,
): Promise<void> {
  const info = test.info();
  console.log(
    `[clipping] ${info.project.name} ${label}: ${m.width}x${m.height}, ` +
      `content=${m.content}, cut=${m.cutPixels}, bad=${m.bad} of ${m.rawBad} raw ` +
      `(outside ${RIM_PX}px rim: ${m.badOutsideRim}, of which on a silhouette ` +
      `${m.badOutsideRimOnEdge}, furthest ${m.maxBadDistance.toFixed(2)}px), ` +
      `maxDelta=${m.maxDelta}, NOT removed outside the clip=${m.contentOutsideClip}, ` +
      `NOT kept inside it=${m.contentMissingInsideClip}, ` +
      `rim histogram [px]=${m.rimHistogram.join(',')}, ` +
      `occupancy histogram [px]=${m.occupancyHistogram.join(',')}`,
  );
  if (!m.dump) return;
  const files: Record<string, Buffer> = {
    'clipped.png': clipped,
    'unclipped.png': unclipped,
    'oracle.png': Buffer.from(m.dump.oracle, 'base64'),
    'mask.png': Buffer.from(m.dump.mask, 'base64'),
  };
  for (const [name, body] of Object.entries(files)) {
    const path = info.outputPath(name);
    writeFileSync(path, body);
    await info.attach(name, { path, contentType: 'image/png' });
  }
}

/**
 * Two captures compared directly — no oracle, no polygon, no masking. Used for
 * the control: what two renders of the same unclipped scene disagree about,
 * which is the floor the cells above are calibrated against.
 */
async function captureFloor(
  page: Page,
  a: Buffer,
  b: Buffer,
): Promise<{ rawBad: number; bad: number; maxDelta: number }> {
  return page.evaluate(
    async ({ aB64, bB64, tolerance }) => {
      const load = async (b64: string): Promise<Uint8ClampedArray> => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('2d context unavailable');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [pa, pb] = await Promise.all([load(aB64), load(bB64)]);
      const img = new Image();
      img.src = `data:image/png;base64,${aB64}`;
      await img.decode();
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const near = (from: Uint8ClampedArray, i: number, into: Uint8ClampedArray): boolean => {
        const p = i / 4;
        const px = p % w;
        const py = (p - px) / w;
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
              Math.abs(from[i + 2] - into[j + 2]) <= tolerance &&
              Math.abs(from[i + 3] - into[j + 3]) <= tolerance
            ) {
              return true;
            }
          }
        }
        return false;
      };
      let rawBad = 0;
      let bad = 0;
      let maxDelta = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const delta = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]),
          Math.abs(pa[i + 3] - pb[i + 3]),
        );
        if (delta > maxDelta) maxDelta = delta;
        if (delta <= tolerance) continue;
        rawBad++;
        if (!near(pa, i, pb) || !near(pb, i, pa)) bad++;
      }
      return { rawBad, bad, maxDelta };
    },
    { aB64: a.toString('base64'), bB64: b.toString('base64'), tolerance: CHANNEL_TOLERANCE },
  );
}

async function capturesOf(
  page: Page,
  clipped: ClipCapture,
  unclipped: ClipCapture,
): Promise<[Buffer, Buffer]> {
  return [
    await page.locator(`#${clipped.id}`).screenshot({ omitBackground: true }),
    await page.locator(`#${unclipped.id}`).screenshot({ omitBackground: true }),
  ];
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.spineHtmlHarness));
});

test('part mask: the repository asset clips exactly the slots in its range', async ({ page }) => {
  const result = await page.evaluate(() => window.spineHtmlHarness.clipPartMaskProbe());

  // The scene is the one the demo and the parity suite already use.
  expect(result.startSlot).toBe('clipping');
  expect(result.endSlot).toBe('head-bb');
  expect(result.inRangeSlots.length).toBeGreaterThan(5);
  expect(result.outOfRangeSlots.length).toBeGreaterThan(5);
  expect(result.counters.clipCount).toBe(1);
  expect(result.counters.clipSkipCount).toBe(0);
  // A part mask is not the whole-skeleton case: the root is untouched.
  expect(result.rootClipPath).toBe('');

  // Range discipline, read off the DOM of the full render: every drawn element
  // the clip covers carries a clip-path, and no element outside it does.
  const drawn = result.elements.filter((e) => e.visible);
  const insideClipped = drawn.filter((e) => e.inRange && e.clipPath !== '');
  const insideBare = drawn.filter((e) => e.inRange && e.clipPath === '');
  const outsideClipped = drawn.filter((e) => !e.inRange && e.clipPath !== '');
  expect(insideClipped.length).toBeGreaterThan(5);
  expect(insideBare.map((e) => e.slot)).toEqual([]);
  expect(outsideClipped.map((e) => e.slot)).toEqual([]);
  expect(drawn.some((e) => !e.inRange)).toBe(true);

  const [clipped, unclipped] = await capturesOf(page, result.clipped, result.unclipped);
  const m = await maskMetrics(page, clipped, unclipped, result.clipped, result.polygon, false);
  await report('part mask (spineboy-pro portal)', m, clipped, unclipped);

  // Not vacuous: something is drawn, and the clip visibly removes part of it.
  //
  // Alone in this file, this cell's polygon is the ASSET's — the clipping
  // attachment in spineboy's own `portal` animation — so how much it removes is
  // a property of the export, not of the renderer, and it moves when the suite
  // runs against another spine-core's example assets (measured at the same
  // pose: 2465 / 2426 cut of 6235 / 6198 content on the 4.3 exports, chromium /
  // webkit; 2070 / 1999 of 6689 / 6617 on the 4.2 ones — the 4.2 portal poses
  // the character differently under the same mask). The guard is therefore a
  // proportion rather than a pixel count: it says what it always meant — the
  // clip takes a substantial bite out of what was drawn — in terms no export
  // version owns. Every cell around it authors its polygon in world space and
  // keeps its absolute numbers.
  expect(m.content).toBeGreaterThan(5000);
  expect(m.cutPixels).toBeGreaterThan(m.content / 4);
  // The residue is the rim, and only the rim.
  // The two absolute claims: the clip removed everything outside it, and kept
  // everything inside it. Neither is a comparison of two rasterizations, and
  // neither moves with the export — both held unchanged on 4.2.
  expect(m.contentOutsideClip).toBe(0);
  expect(m.contentMissingInsideClip).toBe(0);
});

test('rigid tier: a tilted clip over rotated <img> matrices', async ({ page }) => {
  const result = await page.evaluate(() => window.spineHtmlHarness.clipRigidProbe());

  expect(result.counters.clipCount).toBe(1);
  expect(result.counters.clipSkipCount).toBe(0);
  // Rotated and scaled elements are what makes this the inverse-matrix test:
  // on an axis-aligned unit matrix a missing inverse would be invisible.
  expect(result.rotatedOrScaled).toBeGreaterThan(5);
  expect(result.clippedSlots.length).toBeGreaterThan(5);
  expect(result.unclippedSlots).toEqual([]);
  // The end slot lies ahead, so the clip is per element, not on the root.
  expect(result.rootClipPath).toBe('');

  const [clipped, unclipped] = await capturesOf(page, result.clipped, result.unclipped);

  // Measured first, because it is what the cell's tolerance is made of: the
  // control is clipped by a polygon that removes nothing, so it differs from
  // the unclipped capture only in that its elements CARRY a clip-path. That
  // difference is the rasterizer's, not the geometry's.
  const control = await page
    .locator(`#${result.control.id}`)
    .screenshot({ omitBackground: true });
  const floor = await captureFloor(page, unclipped, control);
  console.log(
    `[clipping] ${test.info().project.name} rigid tier control ` +
      `(clip-path present but clipping nothing, vs no clip-path): ` +
      `rawBad=${floor.rawBad}, shift-tolerant bad=${floor.bad}, maxDelta=${floor.maxDelta}`,
  );

  const m = await maskMetrics(page, clipped, unclipped, result.clipped, result.polygon, false);
  await report('rigid tier (tilted quad over spineboy-ess)', m, clipped, unclipped);

  expect(m.content).toBeGreaterThan(5000);
  expect(m.cutPixels).toBeGreaterThan(2000);
  // The two absolute claims: the clip removed everything outside it, and kept
  // everything inside it. Neither is a comparison of two rasterizations.
  expect(m.contentOutsideClip).toBe(0);
  expect(m.contentMissingInsideClip).toBe(0);
});

test('whole-skeleton clip: one clip-path on the root, and the root style given back', async ({
  page,
}) => {
  const result = await page.evaluate(() => window.spineHtmlHarness.clipRootProbe());

  expect(result.counters.clipCount).toBe(1);
  expect(result.counters.clipSkipCount).toBe(0);
  // The fast path is what ran: the root carries the polygon and no element
  // carries anything. Both halves matter — the two are never applied together.
  expect(result.rootClipPath).toMatch(/^polygon\(/);
  expect(result.elementsWithClipPath).toBe(0);
  expect(result.drawnElements).toBeGreaterThan(5);
  // One write for the root, none for the elements.
  expect(result.counters.clipWriteCount).toBe(1);

  // The root belongs to the caller: its inline clip-path is borrowed, not taken.
  const contract = result.styleContract;
  expect(contract.duringClip).toMatch(/^polygon\(/);
  expect(contract.afterClipEnds).toBe(contract.before);
  expect(contract.duringSecondClip).toMatch(/^polygon\(/);
  expect(contract.afterDispose).toBe(contract.before);

  const [clipped, unclipped] = await capturesOf(page, result.clipped, result.unclipped);
  const m = await maskMetrics(page, clipped, unclipped, result.clipped, result.polygon, false);
  await report('whole-skeleton clip (root fast path)', m, clipped, unclipped);

  expect(m.content).toBeGreaterThan(5000);
  expect(m.cutPixels).toBeGreaterThan(2000);
  // The two absolute claims: the clip removed everything outside it, and kept
  // everything inside it. Neither is a comparison of two rasterizations.
  expect(m.contentOutsideClip).toBe(0);
  expect(m.contentMissingInsideClip).toBe(0);
});

test('inverse clip: even-odd against the element box keeps what is outside', async ({ page }) => {
  test.skip(
    !(await inverseClippingSupported(page)),
    'the installed spine-core has no inverse clipping',
  );
  const result = await page.evaluate(() => window.spineHtmlHarness.clipInverseProbe());

  expect(result.counters.clipCount).toBe(1);
  expect(result.counters.clipSkipCount).toBe(0);
  expect(result.elementsWithClipPath).toBeGreaterThan(5);
  // Two rings — the element's box and the polygon — which `polygon()` cannot
  // carry, so an inverse clip is a two-subpath `path()` with the even-odd
  // rule. Engines re-serialize an inline clip-path their own way, so match the
  // shape rather than the exact spacing the renderer wrote.
  expect(result.sampleClipPath).toMatch(/^path\(\s*evenodd[,\s]/);
  expect(result.sampleClipPath).toMatch(/M.*Z.*M.*Z/s);
  // An inverse clip is excluded from the root fast path: the outer ring has to
  // be the element's own box, and the root is a 0×0 origin element.
  expect(result.rootClipPath).toBe('');

  const [clipped, unclipped] = await capturesOf(page, result.clipped, result.unclipped);
  const m = await maskMetrics(page, clipped, unclipped, result.clipped, result.polygon, true);
  await report('inverse clip (even-odd)', m, clipped, unclipped);

  expect(m.content).toBeGreaterThan(5000);
  expect(m.cutPixels).toBeGreaterThan(2000);
  // The two absolute claims: the clip removed everything outside it, and kept
  // everything inside it. Neither is a comparison of two rasterizations.
  expect(m.contentOutsideClip).toBe(0);
  expect(m.contentMissingInsideClip).toBe(0);
});

test('clip-paths are written on change only', async ({ page }) => {
  const result = await page.evaluate(() => window.spineHtmlHarness.clipCountersProbe());

  const covered = result.inRangeElements;
  expect(covered).toBeGreaterThan(5);

  // First frame pays for the sweep; a pose and a polygon that did not move pay
  // nothing at all. This is the headline claim of the write cache.
  expect(result.firstRender.clipWriteCount).toBeGreaterThanOrEqual(covered);
  expect(result.secondRender.clipWriteCount).toBe(0);
  expect(result.secondRender.changedSlots).toEqual([]);
  expect(result.secondRender.elementsWithClipPath).toBe(covered);

  // Move the polygon and every covered element's local polygon moves with it.
  expect(result.polygonMoved.clipWriteCount).toBe(covered);
  expect(result.polygonMoved.changedSlots.length).toBe(covered);

  // Nudge one bone and exactly one element's local polygon changes — the other
  // covered elements hold still and are not rewritten.
  expect(result.oneSlotMoved.clipWriteCount).toBe(1);
  expect(result.oneSlotMoved.changedSlots).toEqual([result.movedSlot]);
});

test('clipping = false counts the clip and leaves no clip-path behind', async ({ page }) => {
  const result = await page.evaluate(() => window.spineHtmlHarness.clipCountersProbe());

  expect(result.disabled.clipCount).toBe(0);
  expect(result.disabled.clipSkipCount).toBe(1);
  expect(result.disabled.elementsWithClipPath).toBe(0);
  // Turning it off removes what was there rather than freezing it.
  expect(result.disabled.clipWriteCount).toBe(result.inRangeElements);

  // And turning it back on re-applies, with nothing else changed.
  expect(result.reEnabled.clipCount).toBe(1);
  expect(result.reEnabled.clipSkipCount).toBe(0);
  expect(result.reEnabled.elementsWithClipPath).toBe(result.inRangeElements);
});

test('a second clip met while one is active is ignored, as in spine-core', async ({ page }) => {
  const result = await page.evaluate(() => window.spineHtmlHarness.clipCountersProbe());

  // SkeletonClipping.clipStart opens with `if (this.clipAttachment) return` —
  // the second clip does not nest and does not replace, it is dropped.
  expect(result.nested.clipCount).toBe(1);
  expect(result.nested.clipSkipCount).toBe(1);
});
