import {
  Texture,
  TextureAtlas,
  TextureAtlasRegion,
  type TextureFilter,
  type TextureWrap,
} from '@esotericsoftware/spine-core';

/**
 * Minimal Texture implementation for the DOM renderer. spine-core only needs
 * it as a handle attached to atlas pages; filtering/wrapping are GPU concepts
 * with no DOM equivalent, so they are no-ops.
 */
export class DomTexture extends Texture {
  setFilters(_minFilter: TextureFilter, _magFilter: TextureFilter): void {}
  setWraps(_uWrap: TextureWrap, _vWrap: TextureWrap): void {}
  dispose(): void {}
}

export interface RegionImage {
  /**
   * URL of the unpacked (rotation-restored) region pixels: a blob URL minted
   * by unpackRegions, the page image URL itself when the region covers its
   * whole page, or anything the caller put there in a hand-built map.
   */
  url: string;
  /** Unpacked width in atlas pixels. */
  width: number;
  /** Unpacked height in atlas pixels. */
  height: number;
}

/**
 * Blob URLs minted by unpackRegions, i.e. the ones this module owns.
 *
 * Ownership has to be tracked because a RegionImage map is not necessarily
 * ours: callers may hand the renderer a map built from their own URLs (loose
 * part PNGs need no unpacking at all). revokeRegions() therefore frees only
 * what is listed here and leaves caller-owned URLs untouched.
 */
const ownedUrls = new Set<string>();

/** Revokes `url` if unpackRegions minted it. Idempotent, caller-safe. */
function revokeOwned(url: string): void {
  if (!ownedUrls.delete(url)) return;
  URL.revokeObjectURL(url);
}

/**
 * Backing pixels the cuts still waiting for their PNG encode may hold at once.
 *
 * A started cut keeps its canvas alive until `toBlob` calls back, so starting
 * every region at once peaks at Σ(region area) of canvas backing — on top of
 * the decoded pages, which stay resident throughout. Measured by counting the
 * simultaneously-alive cut canvases and their backing at `toBlob` (chromium):
 * the demo's 40-region 1024×256 atlas peaks at all 40 cuts and 194,742 px
 * (0.19 Mpx ≈ 0.74 MiB), which is nothing; a synthetic 256-region atlas on
 * four 2048×2048 pages peaks at 16.78 Mpx ≈ 64 MiB, which doubles that
 * atlas's resident cost for the length of the load.
 *
 * So the cuts are started against a budget rather than all at once. 4 Mpx is
 * one 2048×2048 page's worth (≈ 16 MiB at 4 bytes/px): small atlases still run
 * every region concurrently (spineboy: all 40, budget never engaged), and the
 * synthetic one runs 64 cuts at a time — 4 waves instead of 256 serial
 * encodes, for a quarter of the peak. A single region bigger than the budget
 * is started anyway when nothing else is in flight, so the budget can never
 * starve a cut.
 */
const CUT_BACKING_BUDGET_PX = 4 * 1024 * 1024;

/**
 * One region's bitmap: the whole-page pass-through, or a cut canvas encoded to
 * a blob URL this module then owns.
 *
 * Everything before the `toBlob` await runs synchronously, so calling this is
 * what "starts" a cut: the canvas is painted and the encode is handed to the
 * browser before control comes back.
 */
async function cutRegion(
  region: TextureAtlasRegion,
  pageImages: Map<string, HTMLImageElement>,
): Promise<RegionImage> {
  const image = pageImages.get(region.page.name);
  if (!image) throw new Error(`Missing page image: ${region.page.name}`);

  const w = region.width;
  const h = region.height;

  // Whole-page pass-through: an unrotated region covering its entire page
  // would be cut into a pixel-for-pixel copy of the page image, so reuse
  // the page URL instead — no canvas, no PNG re-encode, no second decoded
  // copy in memory, and nothing to revoke afterwards. Atlases written as
  // one part per page (the loose-part-PNG workflow, where every part is
  // declared its own page) hit this for every single region.
  //
  // The test is against the image, not the atlas `size:` line: a page
  // declared at the wrong size still goes through the cut, since the cut
  // is what the region's coordinates actually describe.
  if (
    region.degrees === 0 &&
    region.x === 0 &&
    region.y === 0 &&
    w === image.naturalWidth &&
    h === image.naturalHeight
  ) {
    return { url: image.src, width: w, height: h };
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  if (region.degrees === 90) {
    // The region is packed rotated: it occupies an h×w rect in the page.
    // Rotate it back so the bitmap is in artwork orientation.
    ctx.translate(0, h);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(image, region.x, region.y, h, w, 0, 0, h, w);
  } else {
    ctx.drawImage(image, region.x, region.y, w, h, 0, 0, w, h);
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  const url = URL.createObjectURL(blob);
  ownedUrls.add(url);
  return { url, width: w, height: h };
}

/**
 * Cuts every atlas region out of the page image into its own bitmap once at
 * load time, restoring 90° packing rotation, so the per-frame path never
 * touches a canvas. Returns image URLs keyed by region name.
 *
 * This is a loading-pipeline step, not a rendering step: after this runs,
 * rendering is pure DOM (one <img> per slot, one CSS matrix write per frame).
 *
 * A region that covers its whole page unrotated skips the cut and reuses the
 * page image URL — see the pass-through in cutRegion.
 *
 * **The cuts run concurrently.** PNG encoding is asynchronous and the browser
 * does it off the main thread, so the encodes are started together and awaited
 * together instead of one `toBlob` per iteration: awaited in series a load
 * costs the *sum* of every encode, which a throttled document turns into one
 * full throttle period per region (measured: a single 8×8 `toBlob` took 7.5 s
 * to call back in a hidden desktop Chromium pane). How many run at once is
 * bounded by CUT_BACKING_BUDGET_PX above, not by an option.
 *
 * Concurrency changes nothing a caller can observe:
 *
 * - **Order.** The returned map is keyed in `atlas.regions` order whatever
 *   order the blobs arrive in — the map is built after the cuts settle, from
 *   the region list, not from the arrivals.
 * - **Duplicate names.** The last region of a given name in atlas order wins,
 *   and the shadowed URL is revoked (and dropped from the ledger) rather than
 *   stranded.
 * - **Failure.** Every URL this call minted is revoked before the error
 *   propagates, *including cuts that were still in flight when the first
 *   failure happened* — their blobs arrive later, and a load that walked away
 *   from them would mint owned URLs nobody could ever revoke. So a failure
 *   stops new cuts from starting but still waits for the started ones, and the
 *   error it raises is the one from the earliest region in atlas order (what
 *   the serial loop used to throw). Nothing here rejects unobserved.
 *
 * The blob URLs stay alive until revokeRegions() frees them — a document-wide
 * allocation the GC cannot reclaim on its own. Callers that load and unload
 * skeletons repeatedly (cutscenes, level transitions) must pair every
 * unpackRegions() with a revokeRegions(); a caller that loads once for the
 * page lifetime can ignore it.
 */
export async function unpackRegions(
  atlas: TextureAtlas,
  pageImages: Map<string, HTMLImageElement>,
): Promise<Map<string, RegionImage>> {
  const regions: TextureAtlasRegion[] = atlas.regions;
  const cuts = new Array<RegionImage | undefined>(regions.length);

  // The earliest-in-atlas-order failure is the one that propagates, so that a
  // broken atlas reports the same region whichever encode happens to land
  // first.
  let failedIndex = -1;
  let failure: unknown;

  /** One in-flight cut: `done` is set before its promise resolves. */
  interface Job {
    promise: Promise<void>;
    done: boolean;
  }
  let inFlight: Job[] = [];
  let inFlightPixels = 0;

  for (let index = 0; index < regions.length && failedIndex === -1; index++) {
    const region = regions[index];
    if (!region) continue;
    // A pass-through allocates no canvas, but it also resolves without waiting
    // for anything, so charging it the region's area costs at most one drain.
    const pixels = region.width * region.height;

    while (inFlight.length > 0 && inFlightPixels + pixels > CUT_BACKING_BUDGET_PX) {
      await Promise.race(inFlight.map((job) => job.promise));
      inFlight = inFlight.filter((job) => !job.done);
      if (failedIndex !== -1) break;
    }
    if (failedIndex !== -1) break;

    inFlightPixels += pixels;
    const job: Job = { done: false, promise: Promise.resolve() };
    // Jobs settle, they never reject: the failure is recorded here so that
    // nothing is left for an unhandled-rejection handler to find.
    job.promise = (async () => {
      try {
        cuts[index] = await cutRegion(region, pageImages);
      } catch (error) {
        if (failedIndex === -1 || index < failedIndex) {
          failedIndex = index;
          failure = error;
        }
      } finally {
        inFlightPixels -= pixels;
        job.done = true;
      }
    })();
    inFlight.push(job);
  }

  // Every cut this call started is settled after this, so the cleanup below
  // reaches the blobs that arrived after the first failure too.
  await Promise.all(inFlight.map((job) => job.promise));

  if (failedIndex !== -1) {
    for (const cut of cuts) if (cut) revokeOwned(cut.url);
    throw failure;
  }

  const result = new Map<string, RegionImage>();
  for (let index = 0; index < regions.length; index++) {
    const region = regions[index];
    const cut = cuts[index];
    if (!region || !cut) continue;
    // Duplicate region names would otherwise strand the shadowed URL in the
    // ledger with nothing left pointing at it. Map.set keeps the key where it
    // first appeared, so atlas order survives the overwrite.
    const shadowed = result.get(region.name);
    if (shadowed) revokeOwned(shadowed.url);
    result.set(region.name, cut);
  }
  return result;
}

/**
 * Frees the blob URLs unpackRegions minted for `images` — the counterpart of
 * unpackRegions, to call once the skeletons using them are gone (after
 * `renderer.dispose()`, since a live <img> would keep pointing at a dead URL).
 *
 * Only URLs this module created are revoked: entries the caller supplied
 * itself (a hand-built map of loose part PNGs) and page images reused
 * verbatim by the whole-page pass-through are left alone. Idempotent —
 * revoking twice is a no-op, so it is safe on a map that is shared or
 * partially reused.
 *
 * The map keeps its entries; drop the reference (or reload) afterwards, since
 * the URLs no longer resolve.
 */
export function revokeRegions(images: Map<string, RegionImage>): void {
  for (const image of images.values()) revokeOwned(image.url);
}
