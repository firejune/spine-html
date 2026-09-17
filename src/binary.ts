import {
  AtlasAttachmentLoader,
  type SkeletonData,
  SkeletonBinary,
  type TextureAtlas,
} from '@esotericsoftware/spine-core';
import { fetchBytes } from './loadAtlasAssets.js';

/**
 * Binary (.skel) skeleton exports — a separate package entry point.
 *
 * `SkeletonBinary` is a second parser, and every consumer that imports it
 * carries it. Branching inside `loadSkeletonJson` would put it in the bundle
 * of every loader user, including the ones who only ever read JSON, so the
 * split is at the module boundary instead: this file is reachable only as
 * `spine-html/binary`, and `src/index.ts` must never re-export it.
 *
 * ```ts
 * import { loadAtlasAssets } from 'spine-html';
 * import { loadSkeletonBinary } from 'spine-html/binary';
 * ```
 *
 * There is no one-call `loadSkeletonAssetsBinary`. The seam `loadAtlasAssets`
 * introduced is the API: the atlas half is done once, and a skeleton read is
 * one call against it, whichever format it is in. A one-call sugar for binary
 * would only re-hide the atlas half that shared-atlas callers need exposed.
 */

export interface LoadSkeletonBinaryOptions {
  /** SkeletonBinary.scale — scales the skeleton as it is read. */
  scale?: number;
  /** fetch implementation, for custom headers or a test double. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Reads one skeleton binary export against already-loaded atlas assets — the
 * exact mirror of `loadSkeletonJson`, for `.skel` instead of `.json`.
 *
 * ```ts
 * const shared = await loadAtlasAssets({ atlasUrl: '/spineboy/spineboy.atlas' });
 * const data = await loadSkeletonBinary(shared, '/spineboy/spineboy-pro.skel');
 * ```
 *
 * `assets` needs nothing but a parsed atlas with its page textures attached,
 * so a caller on the low-level path can pass its own `{ atlas }`. Ownership
 * stays with the caller: this never disposes `assets`, whether it succeeds or
 * throws, because the same assets normally back several skeletons.
 *
 * Binary exports are version-locked to the runtime that reads them: a `.skel`
 * written by a Spine editor newer than the installed `@esotericsoftware/spine-core`
 * fails here, in the read, not in the fetch.
 */
export async function loadSkeletonBinary(
  assets: { atlas: TextureAtlas },
  skeletonUrl: string,
  options: LoadSkeletonBinaryOptions = {},
): Promise<SkeletonData> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const bytes = await fetchBytes(fetchImpl, skeletonUrl);
  const binary = new SkeletonBinary(new AtlasAttachmentLoader(assets.atlas));
  if (options.scale !== undefined) binary.scale = options.scale;
  return binary.readSkeletonData(bytes);
}
