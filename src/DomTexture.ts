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
 * Cuts every atlas region out of the page image into its own bitmap once at
 * load time, restoring 90° packing rotation, so the per-frame path never
 * touches a canvas. Returns image URLs keyed by region name.
 *
 * This is a loading-pipeline step, not a rendering step: after this runs,
 * rendering is pure DOM (one <img> per slot, one CSS matrix write per frame).
 *
 * A region that covers its whole page unrotated skips the cut and reuses the
 * page image URL — see the pass-through below.
 *
 * The blob URLs stay alive until revokeRegions() frees them — a document-wide
 * allocation the GC cannot reclaim on its own. Callers that load and unload
 * skeletons repeatedly (cutscenes, level transitions) must pair every
 * unpackRegions() with a revokeRegions(); a caller that loads once for the
 * page lifetime can ignore it. If this function throws part-way through,
 * everything it already minted is revoked before the error propagates.
 */
export async function unpackRegions(
  atlas: TextureAtlas,
  pageImages: Map<string, HTMLImageElement>,
): Promise<Map<string, RegionImage>> {
  const result = new Map<string, RegionImage>();
  // Duplicate region names would otherwise strand the shadowed URL in the
  // ledger with nothing left pointing at it.
  const put = (name: string, entry: RegionImage): void => {
    const shadowed = result.get(name);
    if (shadowed) revokeOwned(shadowed.url);
    result.set(name, entry);
  };

  try {
    for (const region of atlas.regions) {
      const atlasRegion = region as TextureAtlasRegion;
      const image = pageImages.get(atlasRegion.page.name);
      if (!image) throw new Error(`Missing page image: ${atlasRegion.page.name}`);

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
        atlasRegion.x === 0 &&
        atlasRegion.y === 0 &&
        w === image.naturalWidth &&
        h === image.naturalHeight
      ) {
        put(atlasRegion.name, { url: image.src, width: w, height: h });
        continue;
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
        ctx.drawImage(image, atlasRegion.x, atlasRegion.y, h, w, 0, 0, h, w);
      } else {
        ctx.drawImage(image, atlasRegion.x, atlasRegion.y, w, h, 0, 0, w, h);
      }

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
      });
      const url = URL.createObjectURL(blob);
      ownedUrls.add(url);
      put(atlasRegion.name, { url, width: w, height: h });
    }
  } catch (error) {
    revokeRegions(result);
    throw error;
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
