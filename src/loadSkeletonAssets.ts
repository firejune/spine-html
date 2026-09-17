import {
  AtlasAttachmentLoader,
  type SkeletonData,
  SkeletonJson,
  TextureAtlas,
} from '@esotericsoftware/spine-core';
import type { RegionImage } from './DomTexture';
import { fetchText, type LoadAtlasAssetsOptions, loadAtlasAssets } from './loadAtlasAssets';

/**
 * Optional convenience loader: fetch a skeleton export and its atlas, attach
 * the page images, unpack the regions.
 *
 * It exists because every consumer was copying the same twenty lines. It is
 * deliberately the *only* thing this module does — it owns no frame loop, no
 * AnimationState, no layout, and it is not on the renderer's path, so the
 * low-level route (TextureAtlas + DomTexture + unpackRegions by hand) stays
 * the way to do anything this does not cover: binary (.skel) exports, images
 * that come from somewhere other than a URL. Sharing one atlas across several
 * skeletons has its own seam: `loadAtlasAssets` (loadAtlasAssets.ts) plus one
 * `loadSkeletonJson` per skeleton, which is what this function is built on.
 * Nothing else in the package imports this file, so a bundler drops it when it
 * is unused.
 */

export interface LoadSkeletonAssetsOptions extends LoadAtlasAssetsOptions {
  /** URL of the skeleton JSON (.json) export. */
  skeletonUrl: string;
  /** SkeletonJson.scale — scales the skeleton as it is read. */
  scale?: number;
}

export interface LoadSkeletonJsonOptions {
  /** SkeletonJson.scale — scales the skeleton as it is read. */
  scale?: number;
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

function readSkeletonData(atlas: TextureAtlas, text: string, scale?: number): SkeletonData {
  const json = new SkeletonJson(new AtlasAttachmentLoader(atlas));
  if (scale !== undefined) json.scale = scale;
  return json.readSkeletonData(text);
}

/**
 * Reads one skeleton JSON export against already-loaded atlas assets — the
 * second step of the shared-atlas path.
 *
 * ```ts
 * const shared = await loadAtlasAssets({ atlasUrl: '/spineboy/spineboy.atlas' });
 * const [ess, pro] = await Promise.all([
 *   loadSkeletonJson(shared, '/spineboy/spineboy-ess.json'),
 *   loadSkeletonJson(shared, '/spineboy/spineboy-pro.json'),
 * ]);
 * ```
 *
 * `assets` needs nothing but a parsed atlas with its page textures attached,
 * so a caller on the low-level path can pass its own `{ atlas }`. Ownership
 * stays with the caller: this never disposes `assets`, whether it succeeds or
 * throws, because the same assets normally back several skeletons.
 */
export async function loadSkeletonJson(
  assets: { atlas: TextureAtlas },
  skeletonUrl: string,
  options: LoadSkeletonJsonOptions = {},
): Promise<SkeletonData> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const text = await fetchText(fetchImpl, skeletonUrl);
  return readSkeletonData(assets.atlas, text, options.scale);
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
 * One atlas, one skeleton. Several skeletons sharing one atlas is the two-step
 * path instead (`loadAtlasAssets` + `loadSkeletonJson`), which this is built
 * on — calling this once per skeleton would refetch and re-unpack the atlas.
 *
 * Page images load in parallel, and the skeleton export downloads alongside
 * the atlas half. If anything fails part-way, no blob URL is left behind.
 */
export async function loadSkeletonAssets(
  options: LoadSkeletonAssetsOptions,
): Promise<SkeletonAssets> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  // Started before the atlas half is awaited, so the two downloads overlap.
  const skeletonText = fetchText(fetchImpl, options.skeletonUrl);
  // The atlas half can throw first and leave this rejection unobserved until
  // the catch below, which is an unhandled rejection in between. A no-op
  // handler marks it observed; the value/error is still read from the promise.
  skeletonText.catch(() => {});

  const assets = await loadAtlasAssets(options);
  let data: SkeletonData;
  try {
    data = readSkeletonData(assets.atlas, await skeletonText, options.scale);
  } catch (error) {
    // The regions exist by now, so the skeleton half is the one step that
    // could strand them — whether the fetch failed or the read did.
    assets.dispose();
    throw error;
  }

  return {
    atlas: assets.atlas,
    data,
    regionImages: assets.regionImages,
    dispose(): void {
      assets.dispose();
    },
  };
}
