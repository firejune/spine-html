import type { Page } from '@playwright/test';

/**
 * The suite's one screenshot differ.
 *
 * It was written inside `tests/parity.spec.ts` and copied into
 * `tests/pma.spec.ts` when that file needed the same compare with a directional
 * split; `tests/oracle.spec.ts` would have been the third copy. Three differs
 * are three calibrations, and a fix to one of them silently leaves the other
 * two measuring something else — so it lives here, as the union of what those
 * files ask of it, and every caller gets the same arithmetic.
 *
 * What it does is unchanged from the original: decode both PNGs in the page
 * (canvas `getImageData`, zero extra deps) and reduce them to counts.
 *
 * - **Content** is any pixel that differs from the backdrop, so every ratio is
 *   measured against the artwork rather than the mostly-empty stage around it.
 *   The backdrop is sampled from the capture's own top-left pixel, and — with
 *   `floorStrip`, which the demo stage needs and the harness stages do not —
 *   the bottom-left one as well.
 * - **Bad** is shift-tolerant: a pixel over the channel tolerance counts only
 *   when *nothing* in the other image's 3×3 neighbourhood is within tolerance.
 *   Rasterizers that differ by sub-pixel amounts cancel out; missing parts,
 *   wrong colours and interior seams have no matching neighbour and stay
 *   caught. Note what that also means: a whole-image shift of one pixel is
 *   *forgiven* by construction, which is why an alignment probe reads `rawBad`
 *   (the direct compare) instead.
 * - **Direction** (`directional`) splits the content pixels that moved into
 *   darker and lighter, with the mean and peak luma drop over the darker set.
 *   A defect class that can only go one way — a doubled premultiply — is read
 *   off which side the pixels fall on, not off how many there are.
 * - **Mask** (`withMask`) paints the counting pass's own verdicts: capture A
 *   dimmed to greyscale as a backdrop, every shift-tolerant bad pixel pure red,
 *   every raw-bad pixel the 3×3 match rescued pure yellow. Red === `bad` and
 *   red + yellow === `rawBad` by construction, which is the instrument's
 *   self-check. Greys can never collide with the markers: the backdrop is
 *   dimmed to ≤ 115 per channel and has r === g === b.
 *
 * Nothing here is computed unless a caller asks for it: no mask work runs in
 * the page with `withMask` false, and no direction is read with `directional`
 * null.
 */

/** Max per-channel delta a pixel may show before it counts as "bad". */
export const CHANNEL_TOLERANCE = 24;

export interface DiffOptions {
  /** Per-channel delta above which a pixel differs. Defaults to CHANNEL_TOLERANCE. */
  tolerance?: number;
  /**
   * Per-channel delta above which a *content* pixel is classified darker or
   * lighter. Null (the default) skips the classification entirely.
   */
  directional?: number | null;
  /** Paint the diff mask described above. Off by default — it is an instrument. */
  withMask?: boolean;
  /**
   * Also treat the bottom-left pixel's colour as backdrop. The demo stage
   * paints a floor strip there; the harness stages are one flat colour.
   */
  floorStrip?: boolean;
}

export interface DiffMetrics {
  width: number;
  height: number;
  /** Pixels whose max per-channel delta exceeds the tolerance, raw. */
  rawBad: number;
  /** Raw-bad pixels with no in-tolerance match in the other image's 3×3. */
  bad: number;
  /** The two directions `bad` is the max of: A against B, and B against A. */
  badAB: number;
  badBA: number;
  maxDelta: number;
  /** Non-backdrop pixels in each capture, and in their union. */
  contentA: number;
  contentB: number;
  contentUnion: number;
  /** Content pixels that moved past `directional`, by direction. Zero without it. */
  darker: number;
  lighter: number;
  /** Mean and peak luma drop over the darker set — the defect's amplitude. */
  darkerMean: number;
  darkerMax: number;
  /** Only when the caller asked for one (`withMask`). */
  mask?: {
    /** The painted mask, PNG, base64 without the data: prefix. */
    pngBase64: string;
    /** Which direction's fail set was painted red — the one `bad` came from. */
    direction: 'a-vs-b' | 'b-vs-a';
    /** Counted back off the painted pixels, not off the loop's counters. */
    red: number;
    yellow: number;
  };
}

export async function diffInPage(
  page: Page,
  a: Buffer,
  b: Buffer,
  options: DiffOptions = {},
): Promise<DiffMetrics> {
  return page.evaluate(
    async ({ aB64, bB64, tolerance, directional, withMask, floorStrip }): Promise<DiffMetrics> => {
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
        throw new Error(
          `screenshot size mismatch: ${da.width}x${da.height} vs ${db.width}x${db.height}`,
        );
      }
      const pa = da.data;
      const pb = db.data;
      const w = da.width;
      const h = da.height;
      // Backdrops: stage fill (top-left) and, where there is one, the floor
      // strip (bottom-left).
      const stripAt = w * (h - 1) * 4;
      const bg = [pa[0], pa[1], pa[2]];
      const strip = [pa[stripAt], pa[stripAt + 1], pa[stripAt + 2]];
      const isContent = (p: Uint8ClampedArray, i: number): boolean => {
        const nearBg =
          Math.abs(p[i] - bg[0]) <= 8 &&
          Math.abs(p[i + 1] - bg[1]) <= 8 &&
          Math.abs(p[i + 2] - bg[2]) <= 8;
        if (nearBg) return false;
        if (!floorStrip) return true;
        return !(
          Math.abs(p[i] - strip[0]) <= 8 &&
          Math.abs(p[i + 1] - strip[1]) <= 8 &&
          Math.abs(p[i + 2] - strip[2]) <= 8
        );
      };
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
      let contentA = 0;
      let contentB = 0;
      let contentUnion = 0;
      let darker = 0;
      let lighter = 0;
      let darkerSum = 0;
      let darkerMax = 0;
      // Mask buffers, allocated only when dumping. `flags` remembers, per
      // pixel, what the counting loop decided — bit 1 raw-bad, bit 2 "no match
      // for A in B", bit 4 "no match for B in A" — so the picture below is
      // painted from the counters' own verdicts rather than a second opinion.
      const maskData = withMask ? new Uint8ClampedArray(pa.length) : null;
      const flags = withMask ? new Uint8Array(pa.length / 4) : null;
      for (let i = 0; i < pa.length; i += 4) {
        const delta = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]),
        );
        if (delta > maxDelta) maxDelta = delta;
        if (delta > tolerance) {
          rawBad++;
          // Only pixels failing the direct compare need the neighborhood scan.
          const missAB = !matchesNear(pa, i, pb);
          const missBA = !matchesNear(pb, i, pa);
          if (missAB) badAB++;
          if (missBA) badBA++;
          if (flags) flags[i / 4] = 1 | (missAB ? 2 : 0) | (missBA ? 4 : 0);
        }
        if (maskData) {
          // Backdrop: capture A as dimmed greyscale. Dimmed so the markers
          // read over it, greyscale so it can never BE a marker (r === g === b,
          // and ≤ 115 per channel, while the markers are pure red and yellow).
          const grey = ((pa[i] * 0.299 + pa[i + 1] * 0.587 + pa[i + 2] * 0.114) * 0.45) | 0;
          maskData[i] = grey;
          maskData[i + 1] = grey;
          maskData[i + 2] = grey;
          maskData[i + 3] = 255;
        }
        const ca = isContent(pa, i);
        const cb = isContent(pb, i);
        if (ca) contentA++;
        if (cb) contentB++;
        if (ca || cb) contentUnion++;
        // Direction is read on content only: B (the picture under test) against
        // A (the reference), by luma, so a tint cannot cancel itself out.
        if (directional !== null && (ca || cb) && delta > directional) {
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
      const bad = Math.max(badAB, badBA);
      let mask: DiffMetrics['mask'];
      if (maskData && flags) {
        // `bad` is the max of the two directions, so red is the fail set of
        // whichever direction produced it — that is what makes red === bad by
        // construction. Every other raw-bad pixel was rescued by the 3×3 match
        // and goes yellow, so red + yellow === rawBad, also by construction.
        const redBit = badAB >= badBA ? 2 : 4;
        for (let p = 0; p < flags.length; p++) {
          if (!(flags[p] & 1)) continue;
          const i = p * 4;
          maskData[i] = 255;
          maskData[i + 1] = flags[p] & redBit ? 0 : 255;
          maskData[i + 2] = 0;
        }
        // Count the markers back off the painted pixels — a scan of what the
        // picture actually says, not a copy of the counters above.
        let red = 0;
        let yellow = 0;
        for (let i = 0; i < maskData.length; i += 4) {
          if (maskData[i] !== 255 || maskData[i + 2] !== 0) continue;
          if (maskData[i + 1] === 0) red++;
          else if (maskData[i + 1] === 255) yellow++;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        ctx.putImageData(new ImageData(maskData, w, h), 0, 0);
        mask = {
          pngBase64: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
          direction: badAB >= badBA ? 'a-vs-b' : 'b-vs-a',
          red,
          yellow,
        };
      }
      return {
        width: w,
        height: h,
        rawBad,
        bad,
        badAB,
        badBA,
        maxDelta,
        contentA,
        contentB,
        contentUnion,
        darker,
        lighter,
        darkerMean: darker ? Math.round((darkerSum / darker) * 100) / 100 : 0,
        darkerMax: Math.round(darkerMax * 100) / 100,
        mask,
      };
    },
    {
      aB64: a.toString('base64'),
      bB64: b.toString('base64'),
      tolerance: options.tolerance ?? CHANNEL_TOLERANCE,
      directional: options.directional ?? null,
      withMask: options.withMask ?? false,
      floorStrip: options.floorStrip ?? false,
    },
  );
}
