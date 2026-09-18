import {
  AnimationState,
  AnimationStateData,
  Physics,
  Skeleton,
  TextureAtlas,
} from '@esotericsoftware/spine-core';
import {
  DomTexture,
  loadAtlasAssets,
  loadSkeletonAssets,
  loadSkeletonJson,
  type RegionImage,
  revokeRegions,
  SpineHtmlRenderer,
  unpackRegions,
} from '../src/index';
import type { SkeletonData } from '@esotericsoftware/spine-core';
import { loadSkeletonBinary } from '../src/binary';
import { getMeshGlBlitter } from '../src/MeshGlBlitter';

/**
 * Browser-side test harness (see harness.html).
 *
 * The specs drive the library through `window.spineHtmlHarness` instead of
 * reading the demo's stats line, because the loading path — blob URL
 * ownership above all — is not observable from a rendered frame. Each probe
 * returns a plain JSON-serializable result; the assertions live in the specs.
 */

/** One atlas page, two regions, neither covering the page. */
const CUT_ATLAS = `part.png
size: 64, 32
half-left
bounds: 0, 0, 32, 32
half-right
bounds: 32, 0, 32, 32
`;

/**
 * Whole-page regions (the one-part-per-page shape) plus the two cases that
 * must still be cut: a sub-rect, and a rotated region covering its page.
 */
const WHOLE_PAGE_ATLAS = `part.png
size: 64, 32
whole
bounds: 0, 0, 64, 32
sub
bounds: 0, 0, 32, 32

rot.png
size: 32, 64
whole-rotated
bounds: 0, 0, 64, 32
rotate: true
`;

/** Second page has no image, so unpackRegions throws after minting the first. */
const MISSING_PAGE_ATLAS = `part.png
size: 64, 32
half-left
bounds: 0, 0, 32, 32

missing.png
size: 64, 32
orphan
bounds: 0, 0, 32, 32
`;

export interface RegionEntry {
  name: string;
  url: string;
  width: number;
  height: number;
}

export interface UnpackProbeResult {
  /** Page image URL, created by the harness — i.e. caller-owned. */
  pageUrl: string;
  /** Object URLs created while unpackRegions ran. */
  createdUrls: string[];
  /** Object URLs revoked by revokeRegions(), which is called twice. */
  revokedUrls: string[];
  regions: RegionEntry[];
  /** Whether each URL still resolves, sampled before/after revokeRegions(). */
  aliveBefore: Record<string, boolean>;
  aliveAfter: Record<string, boolean>;
}

export interface PassThroughProbeResult {
  /** Page image URLs by page name, all caller-owned. */
  pageUrls: Record<string, string>;
  createdUrls: string[];
  regions: RegionEntry[];
  aliveAfter: Record<string, boolean>;
}

export interface UnpackFailureProbeResult {
  /** Message of the error unpackRegions threw ('' if it did not throw). */
  message: string;
  createdUrls: string[];
  revokedUrls: string[];
  aliveAfter: Record<string, boolean>;
}

export interface LoaderProbeResult {
  animations: string[];
  pageCount: number;
  regionCount: number;
  /** Region URLs the loader minted, and what its dispose() revoked. */
  createdUrls: string[];
  revokedUrls: string[];
  /** Elements the renderer put in the root for one rendered frame. */
  imageCount: number;
  canvasCount: number;
  /** Root children left after renderer.dispose(). */
  rootChildrenAfterDispose: number;
  aliveAfter: Record<string, boolean>;
}

export interface LoaderFailureProbeResult {
  message: string;
  createdUrls: string[];
  revokedUrls: string[];
}

/** Mesh-canvas backing sizes and counters read right after one render(). */
export interface BackingSnapshot {
  /** Backing store of each mesh canvas, in root child (draw) order. */
  backing: Array<{ width: number; height: number }>;
  /** CSS size written alongside it, same order. */
  css: Array<{ width: string; height: string }>;
  /** canvasReallocCount / meshCount of the render that produced this. */
  reallocCount: number;
  meshDrawnCount: number;
}

export interface BackingProbeResult {
  meshCanvasCount: number;
  /** Live renderer: ratio 2, then 0.5 written on it, then the same pose again. */
  liveHigh: BackingSnapshot;
  liveShrunk: BackingSnapshot;
  liveShrunkAgain: BackingSnapshot;
  /** Fresh renderer given 0.5 before its first render — the oracle. */
  freshLow: BackingSnapshot;
  /** Other direction: a live 0.5 → 2 switch, against a fresh renderer at 2. */
  liveGrown: BackingSnapshot;
  freshHigh: BackingSnapshot;
  /** Grow-only control: ratio held, every mesh bbox shrunk instead. */
  holdBefore: BackingSnapshot;
  holdAfter: BackingSnapshot;
}

export interface SpineHtmlHarness {
  unpackProbe(): Promise<UnpackProbeResult>;
  passThroughProbe(): Promise<PassThroughProbeResult>;
  unpackFailureProbe(): Promise<UnpackFailureProbeResult>;
  loaderProbe(): Promise<LoaderProbeResult>;
  loaderFailureProbe(): Promise<LoaderFailureProbeResult>;
  glTextureProbe(): Promise<GlTextureProbeResult>;
  backingProbe(): Promise<BackingProbeResult>;
  scaledStageProbe(): Promise<ScaledStageProbeResult>;
  loaderHttpFailureProbe(): Promise<LoaderHttpFailureProbeResult>;
  sharedAtlasProbe(): Promise<SharedAtlasProbeResult>;
  binaryProbe(): Promise<BinaryProbeResult>;
  cutConcurrencyProbe(): Promise<CutConcurrencyProbeResult>;
  cutOrderProbe(): Promise<CutOrderProbeResult>;
  cutFlightFailureProbe(): Promise<CutFlightFailureProbeResult>;
}

declare global {
  interface Window {
    spineHtmlHarness: SpineHtmlHarness;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${url}`));
    image.src = url;
  });
}

/**
 * Paints a synthetic atlas page and hands back a *caller-owned* blob URL for
 * it — the control case for "revokeRegions must not touch what it did not
 * create".
 */
async function makePageImage(
  width: number,
  height: number,
): Promise<{ image: HTMLImageElement; url: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.fillStyle = '#3aa0ff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ff5a3a';
  ctx.fillRect(0, 0, width / 2, height / 2);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  const url = URL.createObjectURL(blob);
  return { image: await loadImage(url), url };
}

/** Records every object URL created/revoked while `fn` runs. */
async function trackObjectUrls<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; created: string[]; revoked: string[] }> {
  const created: string[] = [];
  const revoked: string[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (object: Blob | MediaSource): string => {
    const url = realCreate.call(URL, object);
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url);
    realRevoke.call(URL, url);
  };
  try {
    return { result: await fn(), created, revoked };
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
}

/** A revoked blob URL stops resolving — that is the leak/no-leak oracle. */
async function alive(urls: string[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const url of urls) {
    try {
      const response = await fetch(url);
      result[url] = response.ok;
    } catch {
      result[url] = false;
    }
  }
  return result;
}

function entries(images: Map<string, RegionImage>): RegionEntry[] {
  return [...images].map(([name, image]) => ({
    name,
    url: image.url,
    width: image.width,
    height: image.height,
  }));
}

async function unpackProbe(): Promise<UnpackProbeResult> {
  const page = await makePageImage(64, 32);
  const atlas = new TextureAtlas(CUT_ATLAS);
  for (const atlasPage of atlas.pages) atlasPage.setTexture(new DomTexture(page.image));
  const pageImages = new Map([['part.png', page.image]]);

  const unpacked = await trackObjectUrls(() => unpackRegions(atlas, pageImages));
  const regions = entries(unpacked.result);
  const urls = [page.url, ...regions.map((region) => region.url)];
  const aliveBefore = await alive(urls);

  // Twice: revoking is documented as idempotent, and a double free would
  // show up as a duplicate in revokedUrls.
  const revoke = await trackObjectUrls(async () => {
    revokeRegions(unpacked.result);
    revokeRegions(unpacked.result);
  });

  return {
    pageUrl: page.url,
    createdUrls: unpacked.created,
    revokedUrls: revoke.revoked,
    regions,
    aliveBefore,
    aliveAfter: await alive(urls),
  };
}

async function passThroughProbe(): Promise<PassThroughProbeResult> {
  const part = await makePageImage(64, 32);
  const rot = await makePageImage(32, 64);
  const atlas = new TextureAtlas(WHOLE_PAGE_ATLAS);
  const pageImages = new Map([
    ['part.png', part.image],
    ['rot.png', rot.image],
  ]);
  for (const atlasPage of atlas.pages) {
    const image = pageImages.get(atlasPage.name);
    if (image) atlasPage.setTexture(new DomTexture(image));
  }

  const unpacked = await trackObjectUrls(() => unpackRegions(atlas, pageImages));
  const regions = entries(unpacked.result);
  revokeRegions(unpacked.result);

  return {
    pageUrls: { 'part.png': part.url, 'rot.png': rot.url },
    createdUrls: unpacked.created,
    regions,
    aliveAfter: await alive([part.url, rot.url, ...regions.map((region) => region.url)]),
  };
}

async function unpackFailureProbe(): Promise<UnpackFailureProbeResult> {
  const page = await makePageImage(64, 32);
  const atlas = new TextureAtlas(MISSING_PAGE_ATLAS);
  const pageImages = new Map([['part.png', page.image]]);
  const first = atlas.pages[0];
  if (first) first.setTexture(new DomTexture(page.image));

  const attempt = await trackObjectUrls(async () => {
    try {
      await unpackRegions(atlas, pageImages);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  return {
    message: attempt.result,
    createdUrls: attempt.created,
    revokedUrls: attempt.revoked,
    aliveAfter: await alive(attempt.created),
  };
}

/** End-to-end: the convenience loader against the real spineboy export. */
async function loaderProbe(): Promise<LoaderProbeResult> {
  const load = await trackObjectUrls(() =>
    loadSkeletonAssets({
      atlasUrl: '/spineboy/spineboy.atlas',
      skeletonUrl: '/spineboy/spineboy-pro.json',
    }),
  );
  const assets = load.result;

  // One rendered frame proves the pieces are wired to each other, not just
  // present: page textures on the atlas (mesh tier) and region images on the
  // renderer (rigid tier).
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  const skeleton = new Skeleton(assets.data);
  const state = new AnimationState(new AnimationStateData(assets.data));
  state.setAnimation(0, 'walk', true);
  state.update(1.2);
  state.apply(skeleton);
  skeleton.update(1.2);
  skeleton.updateWorldTransform(Physics.update);
  const renderer = new SpineHtmlRenderer(root, assets.regionImages);
  renderer.render(skeleton);
  const imageCount = root.querySelectorAll('img').length;
  const canvasCount = root.querySelectorAll('canvas').length;
  renderer.dispose();

  // Twice: dispose() is documented as idempotent.
  const release = await trackObjectUrls(async () => {
    assets.dispose();
    assets.dispose();
  });

  return {
    animations: assets.data.animations.map((animation) => animation.name),
    pageCount: assets.atlas.pages.length,
    regionCount: assets.regionImages.size,
    createdUrls: load.created,
    revokedUrls: release.revoked,
    imageCount,
    canvasCount,
    rootChildrenAfterDispose: root.childElementCount,
    aliveAfter: await alive(load.created),
  };
}

/** The skeleton URL is not JSON, so the read throws after the unpack. */
async function loaderFailureProbe(): Promise<LoaderFailureProbeResult> {
  const attempt = await trackObjectUrls(async () => {
    try {
      await loadSkeletonAssets({
        atlasUrl: '/spineboy/spineboy.atlas',
        skeletonUrl: '/spineboy/spineboy.atlas',
      });
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  return {
    message: attempt.result,
    createdUrls: attempt.created,
    revokedUrls: attempt.revoked,
  };
}

/**
 * Mesh-canvas backing sizing across a pixelRatio change.
 *
 * Not observable from a rendered frame either: the picture stays correct
 * whatever the backing size is (the CSS size mirrors it, so the mapping stays
 * 1:1) — only the allocated pixels differ. The oracle is A/B inside one run:
 * a renderer whose ratio changed on the fly must end up with exactly the
 * backing a renderer freshly given that ratio allocates, canvas by canvas. It
 * is an equality, so it needs no threshold and no platform-dependent number.
 *
 * The pose is the deterministic one loaderProbe uses (walk, t = 1.2), and the
 * counters are read right after the render they describe — render() resets
 * them on entry.
 */
async function backingProbe(): Promise<BackingProbeResult> {
  const assets = await loadSkeletonAssets({
    atlasUrl: '/spineboy/spineboy.atlas',
    skeletonUrl: '/spineboy/spineboy-pro.json',
  });
  const skeleton = new Skeleton(assets.data);
  const state = new AnimationState(new AnimationStateData(assets.data));
  state.setAnimation(0, 'walk', true);
  state.update(1.2);
  state.apply(skeleton);
  skeleton.update(1.2);
  skeleton.updateWorldTransform(Physics.update);

  const roots: HTMLElement[] = [];
  const renderers: SpineHtmlRenderer[] = [];

  /** A renderer with its own root element, ratio set before the first render. */
  function open(ratio: number): { renderer: SpineHtmlRenderer; root: HTMLElement } {
    const root = document.createElement('div');
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    document.body.appendChild(root);
    const renderer = new SpineHtmlRenderer(root, assets.regionImages);
    renderer.pixelRatio = ratio;
    roots.push(root);
    renderers.push(renderer);
    return { renderer, root };
  }

  function snapshot(renderer: SpineHtmlRenderer, root: HTMLElement): BackingSnapshot {
    const canvases = [...root.querySelectorAll('canvas')];
    return {
      backing: canvases.map((canvas) => ({ width: canvas.width, height: canvas.height })),
      css: canvases.map((canvas) => ({ width: canvas.style.width, height: canvas.style.height })),
      reallocCount: renderer.canvasReallocCount,
      meshDrawnCount: renderer.meshCount,
    };
  }

  // A ratio drop on a live renderer, then the same pose once more (the switch
  // must settle: no second reallocation).
  const live = open(2);
  live.renderer.render(skeleton);
  const liveHigh = snapshot(live.renderer, live.root);
  live.renderer.pixelRatio = 0.5;
  live.renderer.render(skeleton);
  const liveShrunk = snapshot(live.renderer, live.root);
  live.renderer.render(skeleton);
  const liveShrunkAgain = snapshot(live.renderer, live.root);

  // The oracle: a renderer that never saw the high ratio.
  const fresh = open(0.5);
  fresh.renderer.render(skeleton);
  const freshLow = snapshot(fresh.renderer, fresh.root);

  // The other direction, against its own fresh oracle.
  const grown = open(0.5);
  grown.renderer.render(skeleton);
  grown.renderer.pixelRatio = 2;
  grown.renderer.render(skeleton);
  const liveGrown = snapshot(grown.renderer, grown.root);
  const freshTwo = open(2);
  freshTwo.renderer.render(skeleton);
  const freshHigh = snapshot(freshTwo.renderer, freshTwo.root);

  // Grow-only control, last because it re-poses the skeleton: the ratio never
  // moves and every mesh bbox shrinks, so the backing must not follow it down.
  const hold = open(1);
  hold.renderer.render(skeleton);
  const holdBefore = snapshot(hold.renderer, hold.root);
  skeleton.scaleX = 0.5;
  skeleton.scaleY = 0.5;
  skeleton.updateWorldTransform(Physics.update);
  hold.renderer.render(skeleton);
  const holdAfter = snapshot(hold.renderer, hold.root);

  const meshCanvasCount = live.root.querySelectorAll('canvas').length;
  for (const renderer of renderers) renderer.dispose();
  for (const root of roots) root.remove();
  assets.dispose();

  return {
    meshCanvasCount,
    liveHigh,
    liveShrunk,
    liveShrunkAgain,
    freshLow,
    liveGrown,
    freshHigh,
    holdBefore,
    holdAfter,
  };
}

export interface LoaderHttpFailureProbeResult {
  /** What the static server actually answers a missing path with. */
  status: number;
  /** Attempt 1 — the missing URL, exactly as this server answers it. */
  missingMessage: string;
  missingCreatedUrls: string[];
  missingRevokedUrls: string[];
  missingAliveAfter: Record<string, boolean>;
  /** URLs attempt 2's fetch double was asked for, in the order it was asked. */
  fetchOrder: string[];
  /** Attempt 2 — a fetch double answering the skeleton URL with 404. */
  httpMessage: string;
  httpCreatedUrls: string[];
  httpRevokedUrls: string[];
  httpAliveAfter: Record<string, boolean>;
}

export interface SharedAtlasProbeResult {
  /** Object URLs minted while loadAtlasAssets ran — one atlas, cut once. */
  createdUrls: string[];
  /** Object URLs minted while the two skeletons were read against it. */
  skeletonCreatedUrls: string[];
  regionCount: number;
  /** Animation names from each skeleton, proving both actually parsed. */
  essAnimations: string[];
  proAnimations: string[];
  /** <img>/<canvas> each renderer put in its own root for one frame. */
  essElementCount: number;
  proElementCount: number;
  essCanvasCount: number;
  proCanvasCount: number;
  /** Message from a read that fails against the shared assets ('' if it did not). */
  badReadMessage: string;
  /** What that failed read revoked — the caller's assets, so: nothing. */
  badReadRevokedUrls: string[];
  /** Object URLs revoked by shared.dispose(), which is called twice. */
  revokedUrls: string[];
  aliveBefore: Record<string, boolean>;
  aliveAfter: Record<string, boolean>;
}

/** Runs a load that must fail, and reports what it left behind. */
async function failedLoad(
  skeletonUrl: string,
  fetchImpl?: typeof globalThis.fetch,
): Promise<{ message: string; created: string[]; revoked: string[] }> {
  const attempt = await trackObjectUrls(async () => {
    try {
      await loadSkeletonAssets({
        atlasUrl: '/spineboy/spineboy.atlas',
        skeletonUrl,
        fetch: fetchImpl,
      });
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  return { message: attempt.result, created: attempt.created, revoked: attempt.revoked };
}

/**
 * A skeleton that never arrives, in both shapes the web has: the URL a static
 * server cannot resolve, and a real HTTP error.
 *
 * Which of the two a missing path produces is the server's choice, not the
 * library's — a preview server with an SPA fallback answers 200 with an HTML
 * body, which reaches the JSON read rather than the status check. So the
 * status is reported, and the error branch is reached deterministically with a
 * fetch double instead of by guessing at the server.
 *
 * Either way the regions are already unpacked when the skeleton half fails,
 * which is the one moment a load can strand them.
 */
async function loaderHttpFailureProbe(): Promise<LoaderHttpFailureProbeResult> {
  const status = (await fetch('/spineboy/does-not-exist.json')).status;
  const missing = await failedLoad('/spineboy/does-not-exist.json');

  // The double also records the order it is called in. The skeleton URL being
  // asked for before the atlas URL is what "both halves are in flight" looks
  // like from outside: a loader that read the atlas first would ask for it
  // first.
  const fetchOrder: string[] = [];
  const notFound: typeof globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    fetchOrder.push(url);
    if (url.endsWith('.json')) {
      return Promise.resolve(new Response('', { status: 404, statusText: 'Not Found' }));
    }
    return fetch(input, init);
  };
  const http = await failedLoad('/spineboy/spineboy-pro.json', notFound);

  return {
    status,
    fetchOrder,
    missingMessage: missing.message,
    missingCreatedUrls: missing.created,
    missingRevokedUrls: missing.revoked,
    missingAliveAfter: await alive(missing.created),
    httpMessage: http.message,
    httpCreatedUrls: http.created,
    httpRevokedUrls: http.revoked,
    httpAliveAfter: await alive(http.created),
  };
}

/** Poses a skeleton for one frame into `root` and reports what landed there. */
function renderOnce(
  root: HTMLElement,
  skeleton: Skeleton,
  regionImages: Map<string, RegionImage>,
): { elementCount: number; canvasCount: number } {
  const state = new AnimationState(new AnimationStateData(skeleton.data));
  state.setAnimation(0, 'walk', true);
  state.update(1.2);
  state.apply(skeleton);
  skeleton.update(1.2);
  skeleton.updateWorldTransform(Physics.update);
  const renderer = new SpineHtmlRenderer(root, regionImages);
  renderer.render(skeleton);
  const counts = {
    elementCount: root.querySelectorAll('img, canvas').length,
    canvasCount: root.querySelectorAll('canvas').length,
  };
  renderer.dispose();
  return counts;
}

/**
 * One atlas, two skeletons: loadAtlasAssets once, loadSkeletonJson per
 * skeleton. What is under test is that the regions are cut exactly once and
 * that the one map backs both renderers — the shape calling loadSkeletonAssets
 * twice cannot have.
 */
async function sharedAtlasProbe(): Promise<SharedAtlasProbeResult> {
  const load = await trackObjectUrls(() =>
    loadAtlasAssets({ atlasUrl: '/spineboy/spineboy.atlas' }),
  );
  const shared = load.result;

  // Reading a skeleton owns nothing, so these two must mint no URL at all.
  const read = await trackObjectUrls(() =>
    Promise.all([
      loadSkeletonJson(shared, '/spineboy/spineboy-ess.json'),
      loadSkeletonJson(shared, '/spineboy/spineboy-pro.json'),
    ]),
  );
  const [essData, proData] = read.result;

  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  // The second root is created here rather than in harness.html: it belongs to
  // this probe, and every other probe must still see the page it knows.
  const secondRoot = document.createElement('div');
  secondRoot.style.cssText = 'position: absolute; left: 0; top: 0';
  document.body.append(secondRoot);

  const ess = renderOnce(root, new Skeleton(essData), shared.regionImages);
  const pro = renderOnce(secondRoot, new Skeleton(proData), shared.regionImages);
  secondRoot.remove();

  // Ownership: the assets are the caller's, so a read that throws must not
  // take them with it — the skeletons already read from them are still using
  // them. The alive sample below is taken after this failure, not before it.
  const badRead = await trackObjectUrls(async () => {
    try {
      await loadSkeletonJson(shared, '/spineboy/spineboy.atlas');
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  const aliveBefore = await alive(load.created);
  // Twice: dispose() is documented as idempotent.
  const release = await trackObjectUrls(async () => {
    shared.dispose();
    shared.dispose();
  });

  return {
    createdUrls: load.created,
    skeletonCreatedUrls: read.created,
    regionCount: shared.regionImages.size,
    essAnimations: essData.animations.map((animation) => animation.name),
    proAnimations: proData.animations.map((animation) => animation.name),
    essElementCount: ess.elementCount,
    proElementCount: pro.elementCount,
    essCanvasCount: ess.canvasCount,
    proCanvasCount: pro.canvasCount,
    badReadMessage: badRead.result,
    badReadRevokedUrls: badRead.revoked,
    revokedUrls: release.revoked,
    aliveBefore,
    aliveAfter: await alive(load.created),
  };
}

/** Mesh-canvas backing and ratio state read right after one render(). */
export interface ScaledStageSnapshot {
  /** Backing store of each mesh canvas, in root child (draw) order. */
  backing: Array<{ width: number; height: number }>;
  /** Σ width × height read back from the DOM. */
  domBackingPixels: number;
  /** What renderer.meshBackingPixels reported at the same moment. */
  reportedBackingPixels: number;
  reallocCount: number;
  meshDrawnCount: number;
  pixelRatio: number;
}

/** What one syncPixelRatio() call did to the root's children. */
export interface SyncResidue {
  childCountBefore: number;
  childCountAfter: number;
  /** Slot element tags in root child order, before and after. */
  tagsBefore: string[];
  tagsAfter: string[];
  /** Element-by-element identity (===), in order — a left-behind probe breaks it. */
  sameElements: boolean;
}

/** A syncPixelRatio() call that must change nothing, plus the render after it. */
export interface HeldRatioCase {
  ratioBefore: number;
  returned: number;
  ratioAfter: number;
  /** The harness's own 100 px probe of that root, in CSS px (0 = not laid out). */
  measuredPx: number;
  after: ScaledStageSnapshot;
}

export interface ScaledStageProbeResult {
  devicePixelRatio: number;
  zoom: number;
  meshCanvasCount: number;
  /** The harness's own probe of the scaled root: 100 px × zoom. */
  scaledMeasuredPx: number;
  /** Default ratio under the scaled wrapper — the oversampling state. */
  scaledDefault: ScaledStageSnapshot;
  syncedRatio: number;
  syncedRatioAgain: number;
  /** Right after the sync, before the render that acts on it. */
  afterSync: ScaledStageSnapshot;
  /** The render after the sync, and the render after the second sync. */
  scaledSynced: ScaledStageSnapshot;
  scaledSyncedAgain: ScaledStageSnapshot;
  /** Oracle: a fresh renderer given the synced ratio before its first render. */
  freshScaled: ScaledStageSnapshot;
  residue: SyncResidue;
  /** display:none wrapper: nothing to measure, so nothing may move. */
  hidden: HeldRatioCase;
  /** Negative control: an unscaled root must come back to devicePixelRatio. */
  unscaled: HeldRatioCase;
  /** A ratio a hair off the measured one — inside the deadband, so it holds. */
  deadband: HeldRatioCase;
}

/**
 * syncPixelRatio() against a CSS-scaled stage.
 *
 * Invisible in a rendered frame, like the backing probe above and for the same
 * reason: the picture is correct at any ratio — only the allocated pixels
 * differ. So the oracle is A/B inside one run again. A renderer that synced its
 * ratio under a `scale(z)` wrapper must hold exactly the backing a renderer
 * freshly given that ratio allocates, canvas by canvas; an equality, no
 * threshold, nothing platform-dependent. The residue and the not-laid-out and
 * unscaled controls are what stop that equality from passing vacuously.
 *
 * Pose: the deterministic one the other probes use (walk, t = 1.2).
 */
async function scaledStageProbe(): Promise<ScaledStageProbeResult> {
  const assets = await loadSkeletonAssets({
    atlasUrl: '/spineboy/spineboy.atlas',
    skeletonUrl: '/spineboy/spineboy-pro.json',
  });
  const skeleton = new Skeleton(assets.data);
  const state = new AnimationState(new AnimationStateData(assets.data));
  state.setAnimation(0, 'walk', true);
  state.update(1.2);
  state.apply(skeleton);
  skeleton.update(1.2);
  skeleton.updateWorldTransform(Physics.update);

  const ZOOM = 0.25;
  const PROBE_PX = 100;
  const wrappers: HTMLElement[] = [];
  const renderers: SpineHtmlRenderer[] = [];

  /**
   * A renderer on its own root, inside a wrapper carrying the CSS transform —
   * the shape a pan/zoom stage has: the renderer is handed the inner element
   * and never sees the scale.
   */
  function open(transform: string, display = ''): { renderer: SpineHtmlRenderer; root: HTMLElement } {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.left = '0';
    wrapper.style.top = '0';
    wrapper.style.transformOrigin = '0 0';
    wrapper.style.transform = transform;
    wrapper.style.display = display;
    const root = document.createElement('div');
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    wrapper.appendChild(root);
    document.body.appendChild(wrapper);
    const renderer = new SpineHtmlRenderer(root, assets.regionImages);
    wrappers.push(wrapper);
    renderers.push(renderer);
    return { renderer, root };
  }

  /**
   * The harness's own copy of the measurement, independent of the renderer's:
   * it says what the root's on-screen scale really is, which is what keeps the
   * scaled and not-laid-out cases from passing for the wrong reason.
   */
  function measurePx(root: HTMLElement): number {
    const box = document.createElement('div');
    box.style.position = 'absolute';
    box.style.left = '0';
    box.style.top = '0';
    box.style.width = `${PROBE_PX}px`;
    box.style.height = `${PROBE_PX}px`;
    box.style.visibility = 'hidden';
    root.appendChild(box);
    const rect = box.getBoundingClientRect();
    box.remove();
    return Math.max(rect.width, rect.height);
  }

  function snapshot(renderer: SpineHtmlRenderer, root: HTMLElement): ScaledStageSnapshot {
    const canvases = [...root.querySelectorAll('canvas')];
    const backing = canvases.map((canvas) => ({ width: canvas.width, height: canvas.height }));
    return {
      backing,
      domBackingPixels: backing.reduce((sum, size) => sum + size.width * size.height, 0),
      reportedBackingPixels: renderer.meshBackingPixels,
      reallocCount: renderer.canvasReallocCount,
      meshDrawnCount: renderer.meshCount,
      pixelRatio: renderer.pixelRatio,
    };
  }

  /** Sync a ratio that must not move, then render once more. */
  function held(renderer: SpineHtmlRenderer, root: HTMLElement): HeldRatioCase {
    const ratioBefore = renderer.pixelRatio;
    const measuredPx = measurePx(root);
    const returned = renderer.syncPixelRatio();
    const ratioAfter = renderer.pixelRatio;
    renderer.render(skeleton);
    return { ratioBefore, returned, ratioAfter, measuredPx, after: snapshot(renderer, root) };
  }

  // The stage: a renderer that knows nothing about the wrapper's scale, so its
  // first frame rasters at devicePixelRatio and oversamples by 1/ZOOM.
  const live = open(`scale(${ZOOM})`);
  live.renderer.render(skeleton);
  const scaledDefault = snapshot(live.renderer, live.root);
  const scaledMeasuredPx = measurePx(live.root);

  // Residue: the slot elements must be the same elements, in the same order,
  // on both sides of the call.
  const before = [...live.root.children];
  const syncedRatio = live.renderer.syncPixelRatio();
  const after = [...live.root.children];
  const residue: SyncResidue = {
    childCountBefore: before.length,
    childCountAfter: after.length,
    tagsBefore: before.map((el) => el.tagName.toLowerCase()),
    tagsAfter: after.map((el) => el.tagName.toLowerCase()),
    sameElements:
      before.length === after.length && before.every((el, index) => el === after[index]),
  };
  const afterSync = snapshot(live.renderer, live.root);

  live.renderer.render(skeleton);
  const scaledSynced = snapshot(live.renderer, live.root);
  const syncedRatioAgain = live.renderer.syncPixelRatio();
  live.renderer.render(skeleton);
  const scaledSyncedAgain = snapshot(live.renderer, live.root);

  // The oracle: same scale, same pose, that ratio from the start.
  const fresh = open(`scale(${ZOOM})`);
  fresh.renderer.pixelRatio = syncedRatio;
  fresh.renderer.render(skeleton);
  const freshScaled = snapshot(fresh.renderer, fresh.root);

  // Not laid out: the marker ratio is one nothing could measure, so a sync that
  // "measured" anything at all would overwrite it.
  const hiddenStage = open(`scale(${ZOOM})`, 'none');
  hiddenStage.renderer.pixelRatio = 3;
  hiddenStage.renderer.render(skeleton);
  const hidden = held(hiddenStage.renderer, hiddenStage.root);

  // Negative control: no transform above the root at all.
  const plain = open('');
  plain.renderer.render(skeleton);
  const unscaled = held(plain.renderer, plain.root);

  // Deadband: 0.04% off the measured ratio — a real difference, too small to
  // be worth recreating every GPU surface for.
  const near = open(`scale(${ZOOM})`);
  near.renderer.pixelRatio = syncedRatio * 1.0004;
  near.renderer.render(skeleton);
  const deadband = held(near.renderer, near.root);

  const meshCanvasCount = live.root.querySelectorAll('canvas').length;
  for (const renderer of renderers) renderer.dispose();
  for (const wrapper of wrappers) wrapper.remove();
  assets.dispose();

  return {
    devicePixelRatio: window.devicePixelRatio,
    zoom: ZOOM,
    meshCanvasCount,
    scaledMeasuredPx,
    scaledDefault,
    syncedRatio,
    syncedRatioAgain,
    afterSync,
    scaledSynced,
    scaledSyncedAgain,
    freshScaled,
    residue,
    hidden,
    unscaled,
    deadband,
  };
}

// --- webgl page-texture lifetime -------------------------------------------

/**
 * The shared GL blitter outlives every renderer, so its page textures are the
 * one thing a consumer cannot free by dropping objects. They are
 * reference-counted per page instead, and this probe drives the lifetime from
 * the outside: load, render, dispose, and read the blitter's live-texture
 * count at each step. The count is the oracle because GPU memory is not
 * observable from script — see tests/gl-textures.spec.ts for the assertions.
 */

const GL_SKELETON = {
  atlasUrl: '/spineboy/spineboy.atlas',
  skeletonUrl: '/spineboy/spineboy-pro.json',
};

type LoadedAssets = Awaited<ReturnType<typeof loadSkeletonAssets>>;

export interface GlCycleSample {
  before: number;
  afterRender: number;
  afterRendererDispose: number;
  afterAssetsDispose: number;
  backendActive: string;
  meshPixels: number;
}

export interface GlSharingSample {
  afterBothRendered: number;
  /** Read before the survivor redraws: the page must still be uploaded. */
  afterFirstDispose: number;
  afterSecondRender: number;
  afterSecondDispose: number;
  pixelsBeforeFirstDispose: number;
  pixelsAfterFirstDispose: number;
  /** Meshes the survivor re-rasterized — 0 would mean the redraw was skipped. */
  meshesRedrawn: number;
}

export interface GlIdempotenceSample {
  afterBothRendered: number;
  afterFirstDispose: number;
  afterFirstDisposedTwice: number;
  afterSecondDispose: number;
  loneAfterRender: number;
  loneAfterDisposedTwice: number;
}

export interface GlCanvas2dSample {
  before: number;
  afterRender: number;
  afterDispose: number;
  backendActive: string;
  meshPixels: number;
}

export interface GlReuseSample {
  beforeNewRenderer: number;
  afterNewRendererRender: number;
  afterDispose: number;
  backendActive: string;
  meshPixels: number;
}

export interface GlTextureProbeResult {
  /** False when this engine has no WebGL at all — the spec then skips loudly. */
  webglAvailable: boolean;
  /** Live page textures before the probe ran (0 on a fresh page). */
  baseline: number;
  cycles: GlCycleSample[];
  sharing: GlSharingSample | null;
  idempotence: GlIdempotenceSample | null;
  canvas2dOnly: GlCanvas2dSample | null;
  reuse: GlReuseSample | null;
  /** Live page textures once every renderer above is disposed. */
  final: number;
}

/** Live GL page textures, or -1 if the shared context died mid-probe. */
function liveGlTextures(): number {
  return getMeshGlBlitter()?.liveTextureCount ?? -1;
}

/** One deterministic pose — the same one the loader probe renders. */
function posedSkeleton(assets: LoadedAssets): Skeleton {
  const skeleton = new Skeleton(assets.data);
  const state = new AnimationState(new AnimationStateData(assets.data));
  state.setAnimation(0, 'walk', true);
  state.update(1.2);
  state.apply(skeleton);
  skeleton.update(1.2);
  skeleton.updateWorldTransform(Physics.update);
  return skeleton;
}

/** A root per renderer: several are alive at once here, unlike #root. */
function makeGlRoot(): HTMLElement {
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  document.body.appendChild(root);
  return root;
}

/**
 * Non-transparent pixels across a root's mesh canvases. "The renderer still
 * draws" has no counter, so this is its oracle: a released-too-early page
 * texture would blank (or change) the raster.
 */
function meshPixels(root: HTMLElement): number {
  let count = 0;
  for (const canvas of root.querySelectorAll('canvas')) {
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) count++;
  }
  return count;
}

async function glTextureProbe(): Promise<GlTextureProbeResult> {
  if (!getMeshGlBlitter()) {
    return {
      webglAvailable: false,
      baseline: 0,
      cycles: [],
      sharing: null,
      idempotence: null,
      canvas2dOnly: null,
      reuse: null,
      final: 0,
    };
  }
  const baseline = liveGlTextures();

  // Load → render → dispose, three times, each with its own page image: on a
  // blitter that never releases, the count climbs by one per cycle.
  const cycles: GlCycleSample[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = liveGlTextures();
    const assets = await loadSkeletonAssets(GL_SKELETON);
    const root = makeGlRoot();
    const renderer = new SpineHtmlRenderer(root, assets.regionImages);
    renderer.meshBackend = 'webgl';
    renderer.render(posedSkeleton(assets));
    const afterRender = liveGlTextures();
    const backendActive = renderer.meshBackendActive;
    const pixels = meshPixels(root);
    renderer.dispose();
    const afterRendererDispose = liveGlTextures();
    assets.dispose();
    const afterAssetsDispose = liveGlTextures();
    root.remove();
    cycles.push({
      before,
      afterRender,
      afterRendererDispose,
      afterAssetsDispose,
      backendActive,
      meshPixels: pixels,
    });
  }

  // One load for everything below: sharing, idempotence and re-use all turn
  // on several renderers meeting on the same page image.
  const assets = await loadSkeletonAssets(GL_SKELETON);

  // Sharing: disposing one user must not take the page from the other.
  const rootA = makeGlRoot();
  const rootB = makeGlRoot();
  const rendererA = new SpineHtmlRenderer(rootA, assets.regionImages);
  const rendererB = new SpineHtmlRenderer(rootB, assets.regionImages);
  rendererA.meshBackend = 'webgl';
  rendererB.meshBackend = 'webgl';
  const skeletonB = posedSkeleton(assets);
  rendererA.render(posedSkeleton(assets));
  rendererB.render(skeletonB);
  const sharingAfterBoth = liveGlTextures();
  const pixelsBeforeFirstDispose = meshPixels(rootB);
  rendererA.dispose();
  const sharingAfterFirstDispose = liveGlTextures();
  // Re-dirty every mesh first: reusing last frame's raster would prove
  // nothing about the texture still being there.
  rendererB.triangleExpand = 0;
  rendererB.render(skeletonB);
  const meshesRedrawn = rendererB.meshCount;
  const pixelsAfterFirstDispose = meshPixels(rootB);
  const sharingAfterSecondRender = liveGlTextures();
  rendererB.dispose();
  const sharingAfterSecondDispose = liveGlTextures();
  rootA.remove();
  rootB.remove();

  // Idempotence, with a second user present so a double release is visible:
  // without one, the second decrement would find nothing to delete anyway.
  const rootC = makeGlRoot();
  const rootD = makeGlRoot();
  const rendererC = new SpineHtmlRenderer(rootC, assets.regionImages);
  const rendererD = new SpineHtmlRenderer(rootD, assets.regionImages);
  rendererC.meshBackend = 'webgl';
  rendererD.meshBackend = 'webgl';
  rendererC.render(posedSkeleton(assets));
  rendererD.render(posedSkeleton(assets));
  const idemAfterBoth = liveGlTextures();
  rendererC.dispose();
  const idemAfterFirstDispose = liveGlTextures();
  rendererC.dispose();
  const idemAfterFirstDisposedTwice = liveGlTextures();
  rendererD.dispose();
  const idemAfterSecondDispose = liveGlTextures();
  rootC.remove();
  rootD.remove();

  const rootE = makeGlRoot();
  const rendererE = new SpineHtmlRenderer(rootE, assets.regionImages);
  rendererE.meshBackend = 'webgl';
  rendererE.render(posedSkeleton(assets));
  const loneAfterRender = liveGlTextures();
  rendererE.dispose();
  rendererE.dispose();
  const loneAfterDisposedTwice = liveGlTextures();
  rootE.remove();

  // A renderer that never leaves canvas2d retains and releases nothing.
  const canvas2dBefore = liveGlTextures();
  const rootF = makeGlRoot();
  const rendererF = new SpineHtmlRenderer(rootF, assets.regionImages);
  rendererF.render(posedSkeleton(assets));
  const canvas2dAfterRender = liveGlTextures();
  const canvas2dBackend = rendererF.meshBackendActive;
  const canvas2dPixels = meshPixels(rootF);
  rendererF.dispose();
  const canvas2dAfterDispose = liveGlTextures();
  rootF.remove();

  // Re-use after release: the page image is still alive, so a new renderer
  // must simply upload it again and draw.
  const reuseBefore = liveGlTextures();
  const rootG = makeGlRoot();
  const rendererG = new SpineHtmlRenderer(rootG, assets.regionImages);
  rendererG.meshBackend = 'webgl';
  rendererG.render(posedSkeleton(assets));
  const reuseAfterRender = liveGlTextures();
  const reuseBackend = rendererG.meshBackendActive;
  const reusePixels = meshPixels(rootG);
  rendererG.dispose();
  const reuseAfterDispose = liveGlTextures();
  rootG.remove();

  assets.dispose();

  return {
    webglAvailable: true,
    baseline,
    cycles,
    sharing: {
      afterBothRendered: sharingAfterBoth,
      afterFirstDispose: sharingAfterFirstDispose,
      afterSecondRender: sharingAfterSecondRender,
      afterSecondDispose: sharingAfterSecondDispose,
      pixelsBeforeFirstDispose,
      pixelsAfterFirstDispose,
      meshesRedrawn,
    },
    idempotence: {
      afterBothRendered: idemAfterBoth,
      afterFirstDispose: idemAfterFirstDispose,
      afterFirstDisposedTwice: idemAfterFirstDisposedTwice,
      afterSecondDispose: idemAfterSecondDispose,
      loneAfterRender,
      loneAfterDisposedTwice,
    },
    canvas2dOnly: {
      before: canvas2dBefore,
      afterRender: canvas2dAfterRender,
      afterDispose: canvas2dAfterDispose,
      backendActive: canvas2dBackend,
      meshPixels: canvas2dPixels,
    },
    reuse: {
      beforeNewRenderer: reuseBefore,
      afterNewRendererRender: reuseAfterRender,
      afterDispose: reuseAfterDispose,
      backendActive: reuseBackend,
      meshPixels: reusePixels,
    },
    final: liveGlTextures(),
  };
}

/** One skeleton read, described in the terms both formats must agree on. */
export interface BinaryReadSummary {
  /** Animation names, sorted — order is a format detail, the set is not. */
  animations: string[];
  boneCount: number;
  slotCount: number;
  /** Skin names, sorted. */
  skins: string[];
  /** <img>/<canvas> one frame of the deterministic pose put in its own root. */
  imageCount: number;
  canvasCount: number;
}

export interface BinaryProbeResult {
  /** Object URLs minted while loadAtlasAssets ran — the atlas half, cut once. */
  createdUrls: string[];
  /** Object URLs minted while the two skeletons were read: reading owns none. */
  skeletonCreatedUrls: string[];
  regionCount: number;
  /** The A/B pair: the same export read from .skel and from .json. */
  binary: BinaryReadSummary;
  json: BinaryReadSummary;
  /** Bone whose setup length carries the scale check, and what it measured. */
  scaleBone: string;
  scaleFactor: number;
  unscaledBoneLength: number;
  scaledBoneLength: number;
  /** A read whose body is not a .skel: it must reject and revoke nothing. */
  badReadMessage: string;
  badReadRevokedUrls: string[];
  /** The same, through a fetch double answering the skeleton URL with 404. */
  httpMessage: string;
  httpCreatedUrls: string[];
  httpRevokedUrls: string[];
  /** Sampled after both failed reads, so a read that disposed shows up here. */
  aliveBefore: Record<string, boolean>;
  /** Object URLs revoked by shared.dispose(), which is called twice. */
  revokedUrls: string[];
  aliveAfter: Record<string, boolean>;
}

/**
 * Binary (.skel) exports through the separate `spine-html/binary` entry.
 *
 * The oracle is A/B inside one run: the JSON read of the *same* export, against
 * the *same* atlas assets. A binary reader that parsed something subtly
 * different would still produce a plausible skeleton on its own, so nothing
 * here is compared against a recorded number — every claim is an equality
 * between the two formats, except the scale check, which is an equality
 * against the unscaled read of the binary itself.
 *
 * The pose is the deterministic one the other probes use (walk, t = 1.2).
 */
async function binaryProbe(): Promise<BinaryProbeResult> {
  const load = await trackObjectUrls(() =>
    loadAtlasAssets({ atlasUrl: '/spineboy/spineboy.atlas' }),
  );
  const shared = load.result;

  // Reading a skeleton owns no bitmaps, in either format: these mint nothing.
  const read = await trackObjectUrls(() =>
    Promise.all([
      loadSkeletonBinary(shared, '/spineboy/spineboy-pro.skel'),
      loadSkeletonJson(shared, '/spineboy/spineboy-pro.json'),
    ]),
  );
  const [binaryData, jsonData] = read.result;

  /** Poses the data for one frame in a root of its own and describes both. */
  function summarize(data: SkeletonData): BinaryReadSummary {
    const root = document.createElement('div');
    root.style.cssText = 'position: absolute; left: 0; top: 0';
    document.body.append(root);
    const skeleton = new Skeleton(data);
    const state = new AnimationState(new AnimationStateData(data));
    state.setAnimation(0, 'walk', true);
    state.update(1.2);
    state.apply(skeleton);
    skeleton.update(1.2);
    skeleton.updateWorldTransform(Physics.update);
    const renderer = new SpineHtmlRenderer(root, shared.regionImages);
    renderer.render(skeleton);
    const summary = {
      animations: data.animations.map((animation) => animation.name).sort(),
      boneCount: data.bones.length,
      slotCount: data.slots.length,
      skins: data.skins.map((skin) => skin.name).sort(),
      imageCount: root.querySelectorAll('img').length,
      canvasCount: root.querySelectorAll('canvas').length,
    };
    renderer.dispose();
    root.remove();
    return summary;
  }

  const binary = summarize(binaryData);
  const json = summarize(jsonData);

  // scale: a setup length is the concrete number to halve. Bone lengths are
  // read straight off the export, so this is the reader's scale and nothing
  // else — no world transform, no renderer, no layout.
  const scaleBone = 'torso';
  const scaleFactor = 0.5;
  const lengthOf = (data: SkeletonData): number => {
    const bone = data.bones.find((candidate) => candidate.name === scaleBone);
    if (!bone) throw new Error(`bone not found: ${scaleBone}`);
    return bone.length;
  };
  const halfData = await loadSkeletonBinary(shared, '/spineboy/spineboy-pro.skel', {
    scale: scaleFactor,
  });

  // Ownership, both failure shapes: the assets are the caller's, so a read
  // that throws must leave them whole — the skeletons already read from them
  // are still using the bitmaps. aliveBefore is sampled after both failures.
  const badRead = await trackObjectUrls(async () => {
    try {
      await loadSkeletonBinary(shared, '/spineboy/spineboy.atlas');
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  const notFound: typeof globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('.skel')) {
      return Promise.resolve(new Response('', { status: 404, statusText: 'Not Found' }));
    }
    return fetch(input, init);
  };
  const httpRead = await trackObjectUrls(async () => {
    try {
      await loadSkeletonBinary(shared, '/spineboy/spineboy-pro.skel', { fetch: notFound });
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  const aliveBefore = await alive(load.created);
  // Twice: dispose() is documented as idempotent.
  const release = await trackObjectUrls(async () => {
    shared.dispose();
    shared.dispose();
  });

  return {
    createdUrls: load.created,
    skeletonCreatedUrls: read.created,
    regionCount: shared.regionImages.size,
    binary,
    json,
    scaleBone,
    scaleFactor,
    unscaledBoneLength: lengthOf(binaryData),
    scaledBoneLength: lengthOf(halfData),
    badReadMessage: badRead.result,
    badReadRevokedUrls: badRead.revoked,
    httpMessage: httpRead.result,
    httpCreatedUrls: httpRead.created,
    httpRevokedUrls: httpRead.revoked,
    aliveBefore,
    revokedUrls: release.revoked,
    aliveAfter: await alive(load.created),
  };
}

// --- concurrent region cuts -------------------------------------------------

/**
 * unpackRegions starts the region cuts together and awaits them together, so
 * the properties that used to fall out of a serial loop — atlas order,
 * last-duplicate-wins, nothing stranded by a failure — now have to be held
 * deliberately. None of that is visible in a rendered frame either, and none of
 * it can be timed: the oracle is `HTMLCanvasElement.prototype.toBlob` itself,
 * wrapped so the probes can count how many encodes overlap and choose the order
 * the callbacks come back in.
 */

/** Six small regions, none covering its page, so every one of them is cut. */
const CONCURRENT_ATLAS = `part.png
size: 64, 32
a
bounds: 0, 0, 16, 16
b
bounds: 16, 0, 16, 16
c
bounds: 32, 0, 16, 16
d
bounds: 48, 0, 16, 16
e
bounds: 0, 16, 16, 16
f
bounds: 16, 16, 16, 16
`;

/**
 * Six 1024×1024 cuts off one 2048×1024 page — 6.29 Mpx of canvas backing if
 * they all ran at once, which is what makes the backing budget observable.
 * They overlap in the page on purpose; only the cut sizes matter here.
 */
const BUDGET_ATLAS = `wide.png
size: 2048, 1024
w0
bounds: 0, 0, 1024, 1024
w1
bounds: 1, 0, 1024, 1024
w2
bounds: 2, 0, 1024, 1024
w3
bounds: 3, 0, 1024, 1024
w4
bounds: 4, 0, 1024, 1024
w5
bounds: 5, 0, 1024, 1024
`;

/** Six cuts of six different sizes: a blob landing in the wrong slot shows. */
const ORDERED_ATLAS = `part.png
size: 64, 32
r0
bounds: 0, 0, 10, 4
r1
bounds: 0, 5, 11, 5
r2
bounds: 0, 11, 12, 6
r3
bounds: 0, 18, 13, 7
r4
bounds: 20, 0, 14, 8
r5
bounds: 20, 9, 15, 9
`;

/** The same name twice, at different sizes, so the winner is identifiable. */
const DUPLICATE_ATLAS = `part.png
size: 64, 32
dup
bounds: 0, 0, 20, 20
solo
bounds: 24, 0, 12, 12
dup
bounds: 40, 0, 8, 8
`;

/** Four cuts; the first one is the one the trap answers with null. */
const IN_FLIGHT_FAIL_ATLAS = `part.png
size: 64, 32
boom
bounds: 0, 0, 16, 16
held-a
bounds: 16, 0, 16, 16
held-b
bounds: 32, 0, 16, 16
held-c
bounds: 48, 0, 16, 16
`;

/** What one instrumented run saw at HTMLCanvasElement.prototype.toBlob. */
export interface CutTrapReport {
  /** toBlob calls started. */
  callCount: number;
  /** Backing pixels of each canvas at call time, in call order. */
  callPixels: number[];
  /** Highest (started − delivered) reached: 1 means the cuts ran in series. */
  peakInFlight: number;
  /** Highest Σ backing pixels held by those simultaneously in-flight cuts. */
  peakInFlightPixels: number;
  /** Call indices in the order their callbacks were finally delivered. */
  deliveryOrder: number[];
  /** True when a hold-and-reverse trap gave up waiting for every call. */
  deadlineHit: boolean;
}

/** How a trap hands the encoded blobs back to unpackRegions. */
type CutDelivery =
  /** Straight through — the trap only counts. */
  | { kind: 'immediate' }
  /** Hold every blob until `expected` have arrived, then deliver them backwards. */
  | { kind: 'reverse'; expected: number; deadlineMs: number }
  /** Answer call `nullAt` with null at once, hold the rest until release(). */
  | { kind: 'failOne'; nullAt: number };

interface CutTrap {
  /** The counters as they stand right now. */
  snapshot(): CutTrapReport;
  /** Cuts started whose callback has not been delivered yet. */
  inFlight(): number;
  /** Resolves once the nulled callback has been delivered ('failOne'). */
  nulled: Promise<void>;
  /** Delivers everything still held ('failOne'). */
  release(): void;
  restore(): void;
}

function installCutTrap(delivery: CutDelivery): CutTrap {
  const real = HTMLCanvasElement.prototype.toBlob;
  const callPixels: number[] = [];
  const deliveryOrder: number[] = [];
  const held: Array<{ index: number; run: () => void }> = [];
  let inFlight = 0;
  let inFlightPixels = 0;
  let peakInFlight = 0;
  let peakInFlightPixels = 0;
  let deadlineHit = false;
  let released = false;
  let timer = 0;
  let resolveNulled = (): void => {};
  const nulled = new Promise<void>((resolve) => {
    resolveNulled = resolve;
  });

  const send = (index: number, run: () => void): void => {
    deliveryOrder.push(index);
    inFlight--;
    inFlightPixels -= callPixels[index] ?? 0;
    run();
  };

  const flush = (reverse: boolean): void => {
    const batch = held.splice(0, held.length);
    if (reverse) batch.reverse();
    for (const entry of batch) send(entry.index, entry.run);
  };

  HTMLCanvasElement.prototype.toBlob = function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: unknown,
  ): void {
    const index = callPixels.length;
    const pixels = this.width * this.height;
    callPixels.push(pixels);
    inFlight++;
    inFlightPixels += pixels;
    peakInFlight = Math.max(peakInFlight, inFlight);
    peakInFlightPixels = Math.max(peakInFlightPixels, inFlightPixels);

    real.call(
      this,
      (blob) => {
        if (delivery.kind === 'immediate') {
          send(index, () => callback(blob));
          return;
        }
        if (delivery.kind === 'failOne') {
          if (index === delivery.nullAt) {
            send(index, () => callback(null));
            resolveNulled();
            return;
          }
          // Past release() the encodes that had not called back yet are the
          // latest arrivals of all, so they go straight through — holding them
          // would only mean nothing ever delivers them.
          if (released) send(index, () => callback(blob));
          else held.push({ index, run: () => callback(blob) });
          return;
        }
        held.push({ index, run: () => callback(blob) });
        clearTimeout(timer);
        if (held.length >= delivery.expected) {
          flush(true);
          return;
        }
        // A serial implementation never gets `expected` encodes in flight, so
        // the trap must not be able to deadlock it: it delivers what it has.
        timer = window.setTimeout(() => {
          deadlineHit = true;
          flush(true);
        }, delivery.deadlineMs);
      },
      type,
      quality as never,
    );
  } as typeof HTMLCanvasElement.prototype.toBlob;

  return {
    snapshot: () => ({
      callCount: callPixels.length,
      callPixels: [...callPixels],
      peakInFlight,
      peakInFlightPixels,
      deliveryOrder: [...deliveryOrder],
      deadlineHit,
    }),
    inFlight: () => inFlight,
    nulled,
    release: () => {
      released = true;
      flush(false);
    },
    restore: () => {
      clearTimeout(timer);
      HTMLCanvasElement.prototype.toBlob = real;
    },
  };
}

/** Builds a TextureAtlas whose every page is backed by one painted image. */
async function paintAtlas(
  text: string,
  sizes: Record<string, { width: number; height: number }>,
): Promise<{
  atlas: TextureAtlas;
  pageImages: Map<string, HTMLImageElement>;
  pageUrls: string[];
}> {
  const atlas = new TextureAtlas(text);
  const pageImages = new Map<string, HTMLImageElement>();
  const pageUrls: string[] = [];
  for (const page of atlas.pages) {
    const size = sizes[page.name] ?? { width: page.width, height: page.height };
    const painted = await makePageImage(size.width, size.height);
    page.setTexture(new DomTexture(painted.image));
    pageImages.set(page.name, painted.image);
    pageUrls.push(painted.url);
  }
  return { atlas, pageImages, pageUrls };
}

export interface CutConcurrencySample {
  regionCount: number;
  cuts: CutTrapReport;
  /** Σ backing pixels of every cut, i.e. the peak an unbounded run would hit. */
  totalCutPixels: number;
}

export interface CutConcurrencyProbeResult {
  /** Six 16×16 cuts: far under the backing budget, so all of them overlap. */
  small: CutConcurrencySample;
  /** Six 1024×1024 cuts: more backing than the budget allows in flight. */
  budgeted: CutConcurrencySample;
  /** The demo's own atlas, through loadAtlasAssets. */
  spineboy: CutConcurrencySample;
}

/**
 * How many region cuts have a PNG encode in flight at once, and how much canvas
 * backing they hold while they do.
 *
 * The count is the whole defect: awaited one at a time it is 1, and a load then
 * costs the sum of every encode — minutes in a throttled background tab, where
 * one 8×8 toBlob was measured taking 7.5 s to call back. The pixels are the
 * price of fixing it, since every started cut keeps its canvas alive until its
 * blob arrives; they are what the backing budget in DomTexture.ts bounds.
 */
async function cutConcurrencyProbe(): Promise<CutConcurrencyProbeResult> {
  async function measure(
    text: string,
    sizes: Record<string, { width: number; height: number }>,
  ): Promise<CutConcurrencySample> {
    const painted = await paintAtlas(text, sizes);
    const trap = installCutTrap({ kind: 'immediate' });
    let images: Map<string, RegionImage>;
    try {
      images = await unpackRegions(painted.atlas, painted.pageImages);
    } finally {
      trap.restore();
    }
    revokeRegions(images);
    for (const url of painted.pageUrls) URL.revokeObjectURL(url);
    const cuts = trap.snapshot();
    return {
      regionCount: painted.atlas.regions.length,
      cuts,
      totalCutPixels: cuts.callPixels.reduce((sum, pixels) => sum + pixels, 0),
    };
  }

  const small = await measure(CONCURRENT_ATLAS, {});
  const budgeted = await measure(BUDGET_ATLAS, {});

  // The real thing: one 1024×256 page, 40 regions, all of them cut.
  const trap = installCutTrap({ kind: 'immediate' });
  let assets: Awaited<ReturnType<typeof loadAtlasAssets>>;
  try {
    assets = await loadAtlasAssets({ atlasUrl: '/spineboy/spineboy.atlas' });
  } finally {
    trap.restore();
  }
  const spineboyCuts = trap.snapshot();
  const spineboy: CutConcurrencySample = {
    regionCount: assets.atlas.regions.length,
    cuts: spineboyCuts,
    totalCutPixels: spineboyCuts.callPixels.reduce((sum, pixels) => sum + pixels, 0),
  };
  assets.dispose();

  return { small, budgeted, spineboy };
}

export interface CutOrderProbeResult {
  /** Region names in atlas order, and the map's key order beside them. */
  atlasNames: string[];
  mapNames: string[];
  regions: RegionEntry[];
  order: CutTrapReport;
  /** Duplicate-name run, same reversed delivery. */
  dupAtlasNames: string[];
  dupMapNames: string[];
  dupRegions: RegionEntry[];
  dupOrder: CutTrapReport;
  dupCreatedUrls: string[];
  /** Liveness of every URL the duplicate run minted, before anything revoked. */
  dupAliveAfterUnpack: Record<string, boolean>;
}

/**
 * Atlas order and last-duplicate-wins, with the blobs deliberately delivered
 * backwards.
 *
 * Concurrent encodes come back in whatever order the browser finishes them, so
 * "the map is in atlas order" stops being something the loop gives away for
 * free. Hoping for out-of-order delivery would make this a lottery, so the trap
 * forces it: it holds every blob until all of them have arrived, then hands
 * them back last-first.
 */
async function cutOrderProbe(): Promise<CutOrderProbeResult> {
  async function run(
    text: string,
    expected: number,
  ): Promise<{
    atlasNames: string[];
    regions: RegionEntry[];
    report: CutTrapReport;
    created: string[];
    images: Map<string, RegionImage>;
    pageUrls: string[];
  }> {
    const painted = await paintAtlas(text, {});
    const trap = installCutTrap({ kind: 'reverse', expected, deadlineMs: 750 });
    let unpacked: { result: Map<string, RegionImage>; created: string[]; revoked: string[] };
    try {
      unpacked = await trackObjectUrls(() => unpackRegions(painted.atlas, painted.pageImages));
    } finally {
      trap.restore();
    }
    return {
      atlasNames: painted.atlas.regions.map((region) => region.name),
      regions: entries(unpacked.result),
      report: trap.snapshot(),
      created: unpacked.created,
      images: unpacked.result,
      pageUrls: painted.pageUrls,
    };
  }

  const ordered = await run(ORDERED_ATLAS, 6);
  revokeRegions(ordered.images);
  for (const url of ordered.pageUrls) URL.revokeObjectURL(url);

  const dup = await run(DUPLICATE_ATLAS, 3);
  // Sampled before anything is revoked: the shadowed URL must already be dead,
  // freed by unpackRegions when the later region of the same name took over.
  const dupAliveAfterUnpack = await alive(dup.created);
  revokeRegions(dup.images);
  for (const url of dup.pageUrls) URL.revokeObjectURL(url);

  return {
    atlasNames: ordered.atlasNames,
    mapNames: ordered.regions.map((region) => region.name),
    regions: ordered.regions,
    order: ordered.report,
    dupAtlasNames: dup.atlasNames,
    dupMapNames: dup.regions.map((region) => region.name),
    dupRegions: dup.regions,
    dupOrder: dup.report,
    dupCreatedUrls: dup.created,
    dupAliveAfterUnpack,
  };
}

export interface CutFlightFailureProbeResult {
  /** Message unpackRegions rejected with ('' if it resolved). */
  message: string;
  /** Cuts started but not yet delivered when the failing one came back null. */
  inFlightAtFailure: number;
  /** Cuts whose blob was still held when the failure had already been seen. */
  createdUrls: string[];
  revokedUrls: string[];
  /** Sampled after every held callback was delivered and the call settled. */
  aliveAfter: Record<string, boolean>;
  /** unhandledrejection events seen for the whole attempt. */
  unhandledRejections: number;
  cuts: CutTrapReport;
}

/**
 * A cut that fails while the others are still encoding.
 *
 * This is the failure the serial loop could not have: its blobs arrive after
 * the error is already known, and a load that walked away from them would mint
 * owned blob URLs with nothing left to revoke them. The trap answers the first
 * region with null (what a browser does when it cannot encode) and holds the
 * other three until the probe releases them, so the late arrivals are forced
 * rather than raced. Liveness is sampled only after they have landed.
 */
async function cutFlightFailureProbe(): Promise<CutFlightFailureProbeResult> {
  const painted = await paintAtlas(IN_FLIGHT_FAIL_ATLAS, {});

  let unhandledRejections = 0;
  const onUnhandled = (): void => {
    unhandledRejections++;
  };
  window.addEventListener('unhandledrejection', onUnhandled);

  const trap = installCutTrap({ kind: 'failOne', nullAt: 0 });
  let inFlightAtFailure = 0;
  let attempt: { result: string; created: string[]; revoked: string[] };
  try {
    attempt = await trackObjectUrls(async () => {
      const settled = unpackRegions(painted.atlas, painted.pageImages).then(
        () => '',
        (error) => (error instanceof Error ? error.message : String(error)),
      );
      await trap.nulled;
      inFlightAtFailure = trap.inFlight();
      // One macrotask for the failure path to get as far as it can, which is
      // as far as the cuts it still has to wait for.
      await new Promise((resolve) => setTimeout(resolve, 0));
      trap.release();
      return await settled;
    });
  } finally {
    trap.restore();
  }

  // An unhandled rejection is reported a task later than the rejection itself.
  await new Promise((resolve) => setTimeout(resolve, 50));
  window.removeEventListener('unhandledrejection', onUnhandled);

  const aliveAfter = await alive(attempt.created);
  for (const url of painted.pageUrls) URL.revokeObjectURL(url);

  return {
    message: attempt.result,
    inFlightAtFailure,
    createdUrls: attempt.created,
    revokedUrls: attempt.revoked,
    aliveAfter,
    unhandledRejections,
    cuts: trap.snapshot(),
  };
}

window.spineHtmlHarness = {
  unpackProbe,
  passThroughProbe,
  unpackFailureProbe,
  loaderProbe,
  loaderFailureProbe,
  glTextureProbe,
  backingProbe,
  scaledStageProbe,
  loaderHttpFailureProbe,
  sharedAtlasProbe,
  binaryProbe,
  cutConcurrencyProbe,
  cutOrderProbe,
  cutFlightFailureProbe,
};
