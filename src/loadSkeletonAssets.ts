import {
  AtlasAttachmentLoader,
  type SkeletonData,
  SkeletonJson,
  TextureAtlas,
} from '@esotericsoftware/spine-core';
import { DomTexture, type RegionImage, revokeRegions, unpackRegions } from './DomTexture';

/**
 * Optional convenience loader: fetch a skeleton export and its atlas, attach
 * the page images, unpack the regions.
 *
 * It exists because every consumer was copying the same twenty lines. It is
 * deliberately the *only* thing this module does — it owns no frame loop, no
 * AnimationState, no layout, and it is not on the renderer's path, so the
 * low-level route (TextureAtlas + DomTexture + unpackRegions by hand) stays
 * the way to do anything this does not cover: sharing one atlas across
 * several skeletons, binary (.skel) exports, images that come from somewhere
 * other than a URL. Nothing else in the package imports this file, so a
 * bundler drops it when it is unused.
 */

export interface LoadSkeletonAssetsOptions {
  /** URL of the atlas (.atlas) export. */
  atlasUrl: string;
  /** URL of the skeleton JSON (.json) export. */
  skeletonUrl: string;
  /**
   * Maps an atlas page name to the URL its image lives at. Defaults to
   * resolving the page name against the atlas URL's directory, which is what
   * a Spine editor export next to its atlas needs.
   */
  resolvePage?: (pageName: string, atlasUrl: string) => string;
  /** SkeletonJson.scale — scales the skeleton as it is read. */
  scale?: number;
  /**
   * crossOrigin attribute for the page images. Needed when the images come
   * from another origin: the region cut reads them into a canvas, and a
   * tainted canvas cannot be exported (SecurityError from toBlob).
   */
  crossOrigin?: string;
  /** fetch implementation, for custom headers or a test double. */
  fetch?: typeof globalThis.fetch;
}

export interface SkeletonAssets {
  /** Parsed skeleton data — construct one `new Skeleton(data)` per instance. */
  data: SkeletonData;
  /** Unpacked per-region bitmaps, ready for `new SpineHtmlRenderer(root, …)`. */
  regionImages: Map<string, RegionImage>;
  /** The parsed atlas, page textures attached. */
  atlas: TextureAtlas;
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

async function fetchText(fetchImpl: typeof globalThis.fetch, url: string): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
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
 * Loads everything the renderer needs from two URLs.
 *
 * ```ts
 * const assets = await loadSkeletonAssets({
 *   atlasUrl: '/spineboy/spineboy.atlas',
 *   skeletonUrl: '/spineboy/spineboy-pro.json',
 * });
 * const skeleton = new Skeleton(assets.data);
 * const renderer = new SpineHtmlRenderer(root, assets.regionImages);
 * // …later: renderer.dispose(); assets.dispose();
 * ```
 *
 * Page images load in parallel. If anything fails part-way, no blob URL is
 * left behind.
 */
export async function loadSkeletonAssets(
  options: LoadSkeletonAssetsOptions,
): Promise<SkeletonAssets> {
  const { atlasUrl, skeletonUrl, crossOrigin, scale } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const resolvePage = options.resolvePage ?? resolveAgainstAtlas;

  const [atlasText, skeletonText] = await Promise.all([
    fetchText(fetchImpl, atlasUrl),
    fetchText(fetchImpl, skeletonUrl),
  ]);

  const atlas = new TextureAtlas(atlasText);
  const pageImages = new Map<string, HTMLImageElement>();
  await Promise.all(
    atlas.pages.map(async (page) => {
      const image = await loadImage(resolvePage(page.name, atlasUrl), crossOrigin);
      page.setTexture(new DomTexture(image));
      pageImages.set(page.name, image);
    }),
  );

  const regionImages = await unpackRegions(atlas, pageImages);
  let data: SkeletonData;
  try {
    const json = new SkeletonJson(new AtlasAttachmentLoader(atlas));
    if (scale !== undefined) json.scale = scale;
    data = json.readSkeletonData(skeletonText);
  } catch (error) {
    // Reading the skeleton is the one step after the regions exist, so it is
    // the one step that could strand them.
    revokeRegions(regionImages);
    throw error;
  }

  let disposed = false;
  return {
    atlas,
    data,
    regionImages,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      revokeRegions(regionImages);
    },
  };
}
