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
  /** Blob URL of the unpacked (rotation-restored) region pixels. */
  url: string;
  /** Unpacked width in atlas pixels. */
  width: number;
  /** Unpacked height in atlas pixels. */
  height: number;
}

/**
 * Cuts every atlas region out of the page image into its own bitmap once at
 * load time, restoring 90° packing rotation, so the per-frame path never
 * touches a canvas. Returns blob URLs keyed by region name.
 *
 * This is a loading-pipeline step, not a rendering step: after this runs,
 * rendering is pure DOM (one <img> per slot, one CSS matrix write per frame).
 */
export async function unpackRegions(
  atlas: TextureAtlas,
  pageImages: Map<string, HTMLImageElement>,
): Promise<Map<string, RegionImage>> {
  const result = new Map<string, RegionImage>();

  for (const region of atlas.regions) {
    const atlasRegion = region as TextureAtlasRegion;
    const image = pageImages.get(atlasRegion.page.name);
    if (!image) throw new Error(`Missing page image: ${atlasRegion.page.name}`);

    const w = region.width;
    const h = region.height;
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
    result.set(atlasRegion.name, { url: URL.createObjectURL(blob), width: w, height: h });
  }

  return result;
}
