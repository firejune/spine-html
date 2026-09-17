import { TextureAtlas } from '@esotericsoftware/spine-core';
import { DomTexture, type RegionImage, revokeRegions, unpackRegions } from './DomTexture.js';

/**
 * Optional convenience loader, atlas half: fetch an atlas export, attach the
 * page images, unpack the regions — once, for however many skeletons share it.
 *
 * It is deliberately the *only* thing this module does, and it deliberately
 * knows nothing about skeleton exports: it must not drag a skeleton reader
 * (SkeletonJson or SkeletonBinary) into the bundle of a consumer that only
 * wanted the atlas. Reading a skeleton against these assets is
 * `loadSkeletonJson` in loadSkeletonAssets.ts or `loadSkeletonBinary` in
 * binary.ts, both of which sit on this seam.
 *
 * Nothing on the renderer's path imports this file, so a bundler drops it when
 * it is unused.
 */

export interface LoadAtlasAssetsOptions {
  /** URL of the atlas (.atlas) export. */
  atlasUrl: string;
  /**
   * Maps an atlas page name to the URL its image lives at. Defaults to
   * resolving the page name against the atlas URL's directory, which is what
   * a Spine editor export next to its atlas needs.
   */
  resolvePage?: (pageName: string, atlasUrl: string) => string;
  /**
   * crossOrigin attribute for the page images. Needed when the images come
   * from another origin: the region cut reads them into a canvas, and a
   * tainted canvas cannot be exported (SecurityError from toBlob).
   */
  crossOrigin?: string;
  /** fetch implementation, for custom headers or a test double. */
  fetch?: typeof globalThis.fetch;
}

export interface AtlasAssets {
  /** The parsed atlas, page textures attached. */
  atlas: TextureAtlas;
  /** Unpacked per-region bitmaps, ready for `new SpineHtmlRenderer(root, …)`. */
  regionImages: Map<string, RegionImage>;
  /**
   * Frees the blob URLs this load created (see revokeRegions). Idempotent.
   * Call it after the renderers using these images are disposed — a live
   * <img> would be left pointing at a dead URL.
   */
  dispose(): void;
}

function resolveAgainstAtlas(pageName: string, atlasUrl: string): string {
  return new URL(pageName, new URL(atlasUrl, document.baseURI)).href;
}

/** @internal Shared with loadSkeletonAssets.ts; not part of the package API. */
export async function fetchText(fetchImpl: typeof globalThis.fetch, url: string): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

/**
 * @internal Shared with binary.ts; not part of the package API. Same HTTP
 * failure message as fetchText, so both skeleton readers reject alike.
 */
export async function fetchBytes(
  fetchImpl: typeof globalThis.fetch,
  url: string,
): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function loadImage(url: string, crossOrigin?: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (crossOrigin !== undefined) image.crossOrigin = crossOrigin;
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load atlas page image: ${url}`));
    image.src = url;
  });
}

/**
 * Loads an atlas and its regions once, to be shared by several skeletons.
 *
 * ```ts
 * const shared = await loadAtlasAssets({ atlasUrl: '/spineboy/spineboy.atlas' });
 * const [ess, pro] = await Promise.all([
 *   loadSkeletonJson(shared, '/spineboy/spineboy-ess.json'),
 *   loadSkeletonJson(shared, '/spineboy/spineboy-pro.json'),
 * ]);
 * // …later, after every renderer using them is disposed: shared.dispose();
 * ```
 *
 * The caller owns the result: reading a skeleton against it never disposes it,
 * and one `regionImages` map is meant to be handed to several renderers.
 *
 * Page images load in parallel. If anything fails part-way, no blob URL is
 * left behind.
 */
export async function loadAtlasAssets(options: LoadAtlasAssetsOptions): Promise<AtlasAssets> {
  const { atlasUrl, crossOrigin } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const resolvePage = options.resolvePage ?? resolveAgainstAtlas;

  const atlas = new TextureAtlas(await fetchText(fetchImpl, atlasUrl));
  const pageImages = new Map<string, HTMLImageElement>();
  await Promise.all(
    atlas.pages.map(async (page) => {
      const image = await loadImage(resolvePage(page.name, atlasUrl), crossOrigin);
      page.setTexture(new DomTexture(image));
      pageImages.set(page.name, image);
    }),
  );

  const regionImages = await unpackRegions(atlas, pageImages);

  let disposed = false;
  return {
    atlas,
    regionImages,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      revokeRegions(regionImages);
    },
  };
}
