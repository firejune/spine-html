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
  scaledPageProbe(): Promise<ScaledPageProbeResult>;
  halfResRenderProbe(): Promise<HalfResRenderProbeResult>;
  clipPartMaskProbe(): Promise<ClipPartMaskProbeResult>;
  clipRigidProbe(): Promise<ClipRigidProbeResult>;
  clipRootProbe(): Promise<ClipRootProbeResult>;
  clipCountersProbe(): Promise<ClipCountersProbeResult>;
  clipInverseProbe(): Promise<ClipInverseProbeResult>;
  cutRuleStage(options: CutRuleStageOptions): Promise<CutRuleStageResult>;
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

/**
 * Pages that ship at a resolution their atlas does not declare.
 *
 * Half-resolution texture builds and @2x variants leave the `size:` line
 * alone, so the declared page size and the image's pixel size disagree. The
 * mesh tier never noticed — spine-core's UVs are normalized against the
 * declared size and both raster backends address texels as `uv * size` off the
 * actual image — while the rigid cut used to take the region's bounds as image
 * pixels, so every rigid part of such a skeleton came out of the wrong
 * rectangle. Pixels are the oracle here: each region is a distinct flat
 * colour, so a cut from the wrong rect mixes colours and a rotation read the
 * wrong way is the wrong aspect or transparent.
 */

/**
 * Four regions tiling one page (one of them packed rotated), one whole-page
 * page for the pass-through, and one page whose interior boundary lands
 * mid-pixel at half resolution.
 */
const SCALED_PAGE_ATLAS = `art.png
size: 64, 32
tl
bounds: 0, 0, 32, 16
tr
bounds: 32, 0, 32, 16
rot
bounds: 0, 16, 16, 32
rotate: true
br
bounds: 32, 16, 32, 16

whole.png
size: 24, 16
whole
bounds: 0, 0, 24, 16

odd.png
size: 64, 32
odd-left
bounds: 0, 0, 31, 32
odd-right
bounds: 31, 0, 33, 32
`;

/** One flat colour per region of SCALED_PAGE_ATLAS. */
const SCALED_PAGE_COLORS: Record<string, string> = {
  tl: '#ff0000',
  tr: '#00ff00',
  rot: '#0000ff',
  br: '#ffff00',
  whole: '#ff00ff',
  'odd-left': '#00ffff',
  'odd-right': '#ffffff',
};

export interface ScaledCutEntry {
  name: string;
  /** RegionImage.width/height: atlas units, whatever the page ships at. */
  width: number;
  height: number;
  /** Natural size of the bitmap behind RegionImage.url. */
  pixelWidth: number;
  pixelHeight: number;
  /** '#rrggbbaa' of the bitmap's first pixel. */
  color: string;
  /** Whether every other pixel of it matches that one. */
  uniform: boolean;
  /** True when the URL is the page image's own — the whole-page pass-through. */
  passedThrough: boolean;
}

export interface ScaledPageSample {
  /** Pixel size each page image was actually painted at, by page name. */
  pageSizes: Record<string, { width: number; height: number }>;
  /** URLs unpackRegions minted for this resolution. */
  mintedCount: number;
  regions: ScaledCutEntry[];
}

export interface ScaledPageProbeResult {
  /** The declared page sizes, straight off the parsed atlas. */
  declared: Record<string, { width: number; height: number }>;
  half: ScaledPageSample;
  natural: ScaledPageSample;
  double: ScaledPageSample;
}

/**
 * Paints one page of SCALED_PAGE_ATLAS at `scale` × its declared size.
 *
 * Each region's *packed* rect is filled with its own colour, snapped to whole
 * pixels the way a packer exporting at this scale would have to. Every
 * resolution is painted from the region table, never resampled from another
 * one, so a bitmap that came out of the wrong rectangle cannot be excused as a
 * filtering artefact.
 */
async function paintScaledPage(
  page: {
    width: number;
    height: number;
    regions: ReadonlyArray<{
      name: string;
      x: number;
      y: number;
      width: number;
      height: number;
      degrees: number;
    }>;
  },
  scale: number,
): Promise<{ image: HTMLImageElement; url: string; width: number; height: number }> {
  const width = Math.round(page.width * scale);
  const height = Math.round(page.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  for (const region of page.regions) {
    const rotated = region.degrees === 90;
    const packedW = rotated ? region.height : region.width;
    const packedH = rotated ? region.width : region.height;
    const x0 = Math.round(region.x * scale);
    const y0 = Math.round(region.y * scale);
    ctx.fillStyle = SCALED_PAGE_COLORS[region.name] ?? '#000000';
    ctx.fillRect(
      x0,
      y0,
      Math.round((region.x + packedW) * scale) - x0,
      Math.round((region.y + packedH) * scale) - y0,
    );
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  const url = URL.createObjectURL(blob);
  return { image: await loadImage(url), url, width, height };
}

/** Reads a bitmap back: its natural size, its first pixel, and whether it is flat. */
async function readBitmap(
  url: string,
): Promise<{ width: number; height: number; color: string; uniform: boolean }> {
  const image = await loadImage(url);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  const hex = (offset: number): string =>
    [...data.slice(offset, offset + 4)]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('');
  let uniform = true;
  for (let offset = 4; offset < data.length; offset += 4) {
    if (
      data[offset] !== data[0] ||
      data[offset + 1] !== data[1] ||
      data[offset + 2] !== data[2] ||
      data[offset + 3] !== data[3]
    ) {
      uniform = false;
      break;
    }
  }
  return { width, height, color: `#${hex(0)}`, uniform };
}

async function scaledPageProbe(): Promise<ScaledPageProbeResult> {
  async function measure(scale: number): Promise<ScaledPageSample> {
    const atlas = new TextureAtlas(SCALED_PAGE_ATLAS);
    const pageImages = new Map<string, HTMLImageElement>();
    const pageUrls: string[] = [];
    const pageSizes: Record<string, { width: number; height: number }> = {};
    for (const page of atlas.pages) {
      const painted = await paintScaledPage(page, scale);
      page.setTexture(new DomTexture(painted.image));
      pageImages.set(page.name, painted.image);
      pageUrls.push(painted.url);
      pageSizes[page.name] = { width: painted.width, height: painted.height };
    }

    const unpacked = await trackObjectUrls(() => unpackRegions(atlas, pageImages));
    const pageUrlSet = new Set(pageUrls);
    const regions: ScaledCutEntry[] = [];
    for (const [name, region] of unpacked.result) {
      const bitmap = await readBitmap(region.url);
      regions.push({
        name,
        width: region.width,
        height: region.height,
        pixelWidth: bitmap.width,
        pixelHeight: bitmap.height,
        color: bitmap.color,
        uniform: bitmap.uniform,
        passedThrough: pageUrlSet.has(region.url),
      });
    }

    revokeRegions(unpacked.result);
    for (const url of pageUrls) URL.revokeObjectURL(url);
    return { pageSizes, mintedCount: unpacked.created.length, regions };
  }

  const declared: Record<string, { width: number; height: number }> = {};
  for (const page of new TextureAtlas(SCALED_PAGE_ATLAS).pages) {
    declared[page.name] = { width: page.width, height: page.height };
  }

  return {
    declared,
    half: await measure(0.5),
    natural: await measure(1),
    double: await measure(2),
  };
}

export interface RigidBox {
  /** The <img> width/height content attributes — its layout box. */
  attrWidth: number;
  attrHeight: number;
  /** The bitmap actually behind it. */
  naturalWidth: number;
  naturalHeight: number;
  /** Its on-screen box, in the root's own coordinates. */
  rect: { x: number; y: number; width: number; height: number };
}

export interface HalfResRenderProbeResult {
  /** Declared page size, and the pixel size each run's page image shipped at. */
  declared: { width: number; height: number };
  fullPage: { width: number; height: number };
  halfPage: { width: number; height: number };
  full: RigidBox[];
  half: RigidBox[];
}

/**
 * The rigid tier through the public render path, against a page image shipped
 * at half the declared size.
 *
 * The demo's own atlas, its page repainted at 0.5× — the shape a project ships
 * when it exports textures at half resolution and leaves the atlas untouched.
 * `renderRegion` writes `RegionImage.width/height` onto the <img> and divides
 * the world corners by them, so as long as those stay in atlas units the
 * layout box and the CSS matrix cannot move; only the bitmap inside them gets
 * smaller. That is the claim this measures, rather than assuming it.
 */
async function halfResRenderProbe(): Promise<HalfResRenderProbeResult> {
  const fullPage = await loadImage('/spineboy/spineboy.png');
  const halfCanvas = document.createElement('canvas');
  halfCanvas.width = Math.round(fullPage.naturalWidth / 2);
  halfCanvas.height = Math.round(fullPage.naturalHeight / 2);
  const halfCtx = halfCanvas.getContext('2d');
  if (!halfCtx) throw new Error('2d context unavailable');
  halfCtx.drawImage(fullPage, 0, 0, halfCanvas.width, halfCanvas.height);
  const halfBlob = await new Promise<Blob>((resolve, reject) => {
    halfCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  const halfPageUrl = URL.createObjectURL(halfBlob);

  const root = document.createElement('div');
  root.style.cssText = 'position: absolute; left: 0; top: 0';
  document.body.append(root);

  async function run(resolvePage?: () => string): Promise<RigidBox[]> {
    const assets = await loadAtlasAssets({
      atlasUrl: '/spineboy/spineboy.atlas',
      ...(resolvePage ? { resolvePage } : {}),
    });
    const data = await loadSkeletonJson(assets, '/spineboy/spineboy-ess.json');
    const skeleton = new Skeleton(data);
    const state = new AnimationState(new AnimationStateData(data));
    state.setAnimation(0, 'walk', true);
    state.update(1.2);
    state.apply(skeleton);
    skeleton.update(1.2);
    skeleton.updateWorldTransform(Physics.update);
    const renderer = new SpineHtmlRenderer(root, assets.regionImages);
    renderer.render(skeleton);

    const images = [...root.querySelectorAll('img')];
    // naturalWidth is 0 until the blob decodes, and it is half of the point.
    await Promise.all(images.map((image) => image.decode().catch(() => {})));
    const rootBox = root.getBoundingClientRect();
    const round = (value: number): number => Math.round(value * 1000) / 1000;
    const boxes = images.map((image) => {
      const box = image.getBoundingClientRect();
      return {
        attrWidth: image.width,
        attrHeight: image.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        rect: {
          x: round(box.x - rootBox.x),
          y: round(box.y - rootBox.y),
          width: round(box.width),
          height: round(box.height),
        },
      };
    });

    renderer.dispose();
    root.replaceChildren();
    assets.dispose();
    return boxes;
  }

  const full = await run();
  const half = await run(() => halfPageUrl);
  root.remove();
  URL.revokeObjectURL(halfPageUrl);

  const atlasPage = new TextureAtlas(await (await fetch('/spineboy/spineboy.atlas')).text())
    .pages[0];

  return {
    declared: { width: atlasPage?.width ?? 0, height: atlasPage?.height ?? 0 },
    fullPage: { width: fullPage.naturalWidth, height: fullPage.naturalHeight },
    halfPage: { width: halfCanvas.width, height: halfCanvas.height },
    full,
    half,
  };
}

// --- how a cut locates its pixels on a rescaled page (#35) -----------------

/**
 * A capturable stage for comparing cut rules against the 1:1 page.
 *
 * When a page ships at a resolution its atlas does not declare, a region's
 * rect on the image is fractional. `planCut` rounds each *edge* of it to a
 * whole image pixel: every cut stays a lossless 1:1 copy and neighbours keep
 * tiling exactly, at the price of up to half an image pixel of placement (and
 * the matching slight stretch, since the bitmap is laid into an atlas-unit
 * box). The other rule available is the one normalized UVs describe — sample
 * the fractional rect with interpolation: exact placement, paid for with a
 * resample of the whole bitmap.
 *
 * Which one lands closer to the truth is a measurement, and this is the
 * instrument: the same frozen rigid-only pose, in the same stage, drawn from
 * the page at 1:1 (the reference) and from a rescaled page under each rule, so
 * the only variable is where the cut read its pixels. The DOM geometry is
 * identical across all of them — `renderRegion` reads atlas units and nothing
 * about the bitmap — so what a diff of two captures sees is texture placement
 * and nothing else.
 *
 * `shifted` is the control: the shipped rule with every rect displaced one
 * whole image pixel. It has to score clearly worse than both real rules, or
 * the instrument cannot see placement at all and no verdict from it means
 * anything.
 *
 * The specs screenshot `#cut-rule-stage` between calls, so each call opens by
 * tearing down what the previous one left there.
 */

/** The shipped rule, the alternative, and the deliberately wrong control. */
export type CutRule = 'edge' | 'fractional' | 'shifted';

export interface CutRuleStageOptions {
  /** Page image resolution, as a multiple of the declared size. 1 = as shipped. */
  pageScale: number;
  rule: CutRule;
  /** Frozen pose: an animation of spineboy-ess, seeked to `time`. */
  animation: string;
  time: number;
}

export interface CutRuleStageResult {
  /** The atlas `size:` line, which no page scale changes. */
  declaredPage: { width: number; height: number };
  /** What the page image this run cut from actually measures. */
  pageSize: { width: number; height: number };
  /** Slots drawn, and Σ of the natural pixels behind them. */
  imageCount: number;
  bitmapPixels: number;
  /** Union of the slot boxes, in stage coordinates — the stage must contain it. */
  contentBox: { x: number; y: number; width: number; height: number };
}

/** Stage geometry. The pose is drawn at half scale, so a 0.5× page maps ~1:1. */
const CUT_RULE_STAGE = {
  width: 400,
  height: 440,
  /** Skeleton origin (the feet) inside the stage. */
  originX: 180,
  originY: 420,
  scale: 0.5,
  background: '#14161a',
};

/** Fetched once: the atlas text and the page image as it ships. */
let cutRuleSource: Promise<{ atlasText: string; page: HTMLImageElement }> | null = null;

/**
 * Page images by scale, minted once per document.
 *
 * Every rule at a given scale therefore cuts from the *same bytes* — a
 * repainted page would put a second variable in the comparison — and the
 * rescale itself is the one a project's texture build does: a high-quality
 * draw of the whole page into a canvas of the target size.
 */
const cutRulePages = new Map<number, Promise<HTMLImageElement>>();

/** What the stage is holding, to be torn down before the next render. */
let cutRuleLive: { renderer: SpineHtmlRenderer; release: () => void } | null = null;
let cutRuleStageEl: HTMLDivElement | null = null;

function cutRuleAssets(): Promise<{ atlasText: string; page: HTMLImageElement }> {
  if (!cutRuleSource) {
    cutRuleSource = (async () => ({
      atlasText: await (await fetch('/spineboy/spineboy.atlas')).text(),
      page: await loadImage('/spineboy/spineboy.png'),
    }))();
  }
  return cutRuleSource;
}

function cutRulePageImage(scale: number): Promise<HTMLImageElement> {
  const cached = cutRulePages.get(scale);
  if (cached) return cached;
  const built = (async () => {
    const { page } = await cutRuleAssets();
    if (scale === 1) return page;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(page.naturalWidth * scale);
    canvas.height = Math.round(page.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(page, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
    // Kept for the document's lifetime on purpose: the image is the cache.
    return await loadImage(URL.createObjectURL(blob));
  })();
  cutRulePages.set(scale, built);
  return built;
}

/**
 * One region's bitmap under a rule that is not the shipped one.
 *
 * Both variants start from the same fractional rect the shipped rule rounds —
 * the region's bounds relative to the declared page size, times the image's
 * natural size. `fractional` hands that rect to `drawImage` as it is and lets
 * the rasterizer interpolate; `shifted` rounds it exactly as `planCut` does and
 * then displaces the read by one whole image pixel (clamped to stay on the
 * image, so it is a displacement and never a transparent margin).
 *
 * Canvas sizes stay at the rect's native resolution either way, and the
 * rotation restore is the shipped one.
 */
async function cutRuleRegion(
  region: TextureAtlas['regions'][number],
  image: HTMLImageElement,
  rule: 'fractional' | 'shifted',
): Promise<string> {
  const iw = image.naturalWidth;
  const ih = image.naturalHeight;
  const pageW = region.page.width > 0 ? region.page.width : iw;
  const pageH = region.page.height > 0 ? region.page.height : ih;
  const rotated = region.degrees === 90;
  const packedW = rotated ? region.height : region.width;
  const packedH = rotated ? region.width : region.height;
  const scaleX = iw / pageW;
  const scaleY = ih / pageH;

  const fx = region.x * scaleX;
  const fy = region.y * scaleY;
  const fw = packedW * scaleX;
  const fh = packedH * scaleY;

  let sx = fx;
  let sy = fy;
  let sw = fw;
  let sh = fh;
  let dw = Math.max(1, Math.round(fw));
  let dh = Math.max(1, Math.round(fh));
  if (rule === 'shifted') {
    const x0 = Math.round(fx);
    const y0 = Math.round(fy);
    sw = Math.max(1, Math.round(fx + fw) - x0);
    sh = Math.max(1, Math.round(fy + fh) - y0);
    dw = sw;
    dh = sh;
    sx = Math.min(x0 + 1, Math.max(0, iw - sw));
    sy = Math.min(y0 + 1, Math.max(0, ih - sh));
  }

  const canvas = document.createElement('canvas');
  canvas.width = rotated ? dh : dw;
  canvas.height = rotated ? dw : dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (rotated) {
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, dw, dh);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  return URL.createObjectURL(blob);
}

/** Every region of `atlas` under `rule`, plus the way to free what it minted. */
async function cutRuleRegions(
  atlas: TextureAtlas,
  pageImages: Map<string, HTMLImageElement>,
  rule: CutRule,
): Promise<{ images: Map<string, RegionImage>; release: () => void }> {
  if (rule === 'edge') {
    const images = await unpackRegions(atlas, pageImages);
    return { images, release: () => revokeRegions(images) };
  }
  const urls: string[] = [];
  const images = new Map<string, RegionImage>();
  const cuts = await Promise.all(
    atlas.regions.map(async (region) => {
      const image = pageImages.get(region.page.name);
      if (!image) throw new Error(`Missing page image: ${region.page.name}`);
      return { region, url: await cutRuleRegion(region, image, rule) };
    }),
  );
  for (const cut of cuts) {
    urls.push(cut.url);
    images.set(cut.region.name, {
      url: cut.url,
      width: cut.region.width,
      height: cut.region.height,
    });
  }
  return {
    images,
    release: () => {
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}

function cutRuleStageElement(): HTMLDivElement {
  if (cutRuleStageEl) return cutRuleStageEl;
  const stage = document.createElement('div');
  stage.id = 'cut-rule-stage';
  stage.style.cssText =
    `position: absolute; left: 0; top: 0; overflow: hidden;` +
    `width: ${CUT_RULE_STAGE.width}px; height: ${CUT_RULE_STAGE.height}px;` +
    `background: ${CUT_RULE_STAGE.background};`;
  document.body.append(stage);
  cutRuleStageEl = stage;
  return stage;
}

async function cutRuleStage(options: CutRuleStageOptions): Promise<CutRuleStageResult> {
  // The screenshot of the previous render happens between two calls, so this
  // is the only place its renderer and bitmaps can be let go of.
  if (cutRuleLive) {
    cutRuleLive.renderer.dispose();
    cutRuleLive.release();
    cutRuleLive = null;
  }

  const { atlasText } = await cutRuleAssets();
  const image = await cutRulePageImage(options.pageScale);
  const atlas = new TextureAtlas(atlasText);
  const pageImages = new Map<string, HTMLImageElement>();
  for (const page of atlas.pages) {
    page.setTexture(new DomTexture(image));
    pageImages.set(page.name, image);
  }
  const cut = await cutRuleRegions(atlas, pageImages, options.rule);
  const data = await loadSkeletonJson({ atlas }, '/spineboy/spineboy-ess.json');

  const stage = cutRuleStageElement();
  stage.replaceChildren();
  const root = document.createElement('div');
  root.style.cssText =
    `position: absolute; left: ${CUT_RULE_STAGE.originX}px; top: ${CUT_RULE_STAGE.originY}px;` +
    `transform-origin: 0 0; transform: scale(${CUT_RULE_STAGE.scale});`;
  stage.append(root);

  const skeleton = new Skeleton(data);
  const state = new AnimationState(new AnimationStateData(data));
  state.setAnimation(0, options.animation, true);
  state.update(options.time);
  state.apply(skeleton);
  skeleton.update(options.time);
  skeleton.updateWorldTransform(Physics.update);
  const renderer = new SpineHtmlRenderer(root, cut.images);
  renderer.render(skeleton);
  cutRuleLive = { renderer, release: cut.release };

  const images = [...root.querySelectorAll('img')];
  // The bitmap is the whole point, and naturalWidth is 0 until it decodes.
  await Promise.all(images.map((img) => img.decode().catch(() => {})));
  // …and a decoded bitmap is not yet a settled raster. Chromium paints the
  // first frame of a freshly decoded image scaled down by more than ~2 with a
  // cheaper filter and re-rasters it a frame or two later (measured: the first
  // capture of a 1.5× page differed from the second and third by 23,612
  // pixels, while the second and third were bit-identical). Whether a capture
  // lands before or after that re-raster is a race, and a race in the
  // instrument reads as a difference between rules. Several frames of settling
  // is what closes it.
  for (let frame = 0; frame < 8; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  const stageBox = stage.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let bitmapPixels = 0;
  for (const img of images) {
    const box = img.getBoundingClientRect();
    minX = Math.min(minX, box.left - stageBox.left);
    minY = Math.min(minY, box.top - stageBox.top);
    maxX = Math.max(maxX, box.right - stageBox.left);
    maxY = Math.max(maxY, box.bottom - stageBox.top);
    bitmapPixels += img.naturalWidth * img.naturalHeight;
  }
  const round = (value: number): number => Math.round(value * 100) / 100;

  const declaredPage = atlas.pages[0];
  return {
    declaredPage: { width: declaredPage?.width ?? 0, height: declaredPage?.height ?? 0 },
    pageSize: { width: image.naturalWidth, height: image.naturalHeight },
    imageCount: images.length,
    bitmapPixels,
    contentBox: {
      x: round(minX),
      y: round(minY),
      width: round(maxX - minX),
      height: round(maxY - minY),
    },
  };
}

/* --- clipping attachments -------------------------------------------------
 *
 * Clipping has no counter that can prove it is CORRECT — a clip-path that is
 * off by a transform still produces a string and still counts as applied. So
 * the oracle for these probes is pixels, and the specs build it without
 * touching the renderer's local-frame math: the clipped capture must equal the
 * UNCLIPPED capture of the same slots, masked in screen space by the world
 * polygon these probes hand back.
 *
 * Each pixel probe therefore leaves two capture boxes in the DOM for the spec
 * to screenshot — same size, same origin, same scale — differing in nothing
 * but `renderer.clipping`.
 */

import {
  ClippingAttachment,
  type Slot,
  type SlotData,
} from '@esotericsoftware/spine-core';

const CLIP_PRO = {
  atlasUrl: '/spineboy/spineboy.atlas',
  skeletonUrl: '/spineboy/spineboy-pro.json',
};
const CLIP_ESS = {
  atlasUrl: '/spineboy/spineboy.atlas',
  skeletonUrl: '/spineboy/spineboy-ess.json',
};
/** Root scale, capture box and root origin shared by every clipping capture. */
const CLIP_SCALE = 0.4;
const CLIP_BOX = { width: 420, height: 340, originX: 210, originY: 320 };
/**
 * Capture boxes are left TRANSPARENT and screenshotted with `omitBackground`,
 * so "is there artwork at this pixel" is a question about alpha rather than
 * about how close a color is to a backdrop. Spineboy's outfit is nearly black,
 * and against an opaque dark box the two answers are not the same question.
 */
const CLIP_BG = 'transparent';

export interface ClipCapture {
  /** DOM id of the element the spec screenshots. */
  id: string;
  width: number;
  height: number;
  /** Root origin inside the capture box, in capture pixels. */
  originX: number;
  originY: number;
  /** Scale from root (CSS world) units to capture pixels. */
  scale: number;
  /** Always 'transparent': the boxes are captured with `omitBackground`. */
  background: string;
}

export interface ClipElementReport {
  slot: string;
  tag: 'img' | 'canvas';
  visible: boolean;
  /** Inline clip-path, '' when the element carries none. */
  clipPath: string;
  /** Whether the clip's slot range covers this slot. */
  inRange: boolean;
}

export interface ClipCounters {
  clipCount: number;
  clipSkipCount: number;
  clipWriteCount: number;
}

export interface ClipPartMaskProbeResult {
  startSlot: string;
  endSlot: string | null;
  inRangeSlots: string[];
  outOfRangeSlots: string[];
  /** The clip polygon in the root's CSS frame (Y negated), flat x,y. */
  polygon: number[];
  counters: ClipCounters;
  /** The full render — nothing hidden — one entry per slot element. */
  elements: ClipElementReport[];
  /** Must stay '': a part mask is not the whole-skeleton fast path. */
  rootClipPath: string;
  clipped: ClipCapture;
  unclipped: ClipCapture;
}

export interface ClipRigidProbeResult {
  /**
   * The control capture: the same pose, clipped by a polygon so large it
   * removes NOTHING. Geometrically it is the unclipped picture; what it has
   * that `unclipped` lacks is a `clip-path` on every element. So whatever it
   * and `unclipped` disagree about is the cost of the clip-path's presence in
   * the rasterizer — not of where the clip was put. Without this, that floor
   * cannot be told apart from a clip landing in the wrong place.
   */
  control: ClipCapture;
  /** Slots carrying a clip-path, and drawn slots carrying none. */
  clippedSlots: string[];
  unclippedSlots: string[];
  /** Drawn rigid elements whose matrix is neither axis-aligned nor unit. */
  rotatedOrScaled: number;
  /** Must stay '': the end slot lies ahead, so the fast path is closed. */
  rootClipPath: string;
  counters: ClipCounters;
  polygon: number[];
  clipped: ClipCapture;
  unclipped: ClipCapture;
}

export interface ClipRootStyleContract {
  /** What the caller had on the root before the renderer ever ran. */
  before: string;
  /** While the whole-skeleton clip is in force. */
  duringClip: string;
  /** After the clip stops covering the frame. */
  afterClipEnds: string;
  /** While a second whole-skeleton clip is in force again. */
  duringSecondClip: string;
  afterDispose: string;
}

export interface ClipRootProbeResult {
  /** The root's clip-path under the fast path — a polygon(). */
  rootClipPath: string;
  /** Must be 0: the fast path writes the root INSTEAD of the elements. */
  elementsWithClipPath: number;
  drawnElements: number;
  counters: ClipCounters;
  styleContract: ClipRootStyleContract;
  polygon: number[];
  clipped: ClipCapture;
  unclipped: ClipCapture;
}

export interface ClipCounterStep {
  clipWriteCount: number;
  clipCount: number;
  clipSkipCount: number;
  elementsWithClipPath: number;
  /** Slots whose clip-path string changed during this step. */
  changedSlots: string[];
}

export interface ClipCountersProbeResult {
  /** Drawn elements the clip covers — the ceiling for a per-element sweep. */
  inRangeElements: number;
  /** The slot the single-bone nudge is expected to move, and nothing else. */
  movedSlot: string;
  firstRender: ClipCounterStep;
  /** Same pose, same polygon: the write cache must carry all of it. */
  secondRender: ClipCounterStep;
  /** Polygon moved: every covered element's local polygon changed. */
  polygonMoved: ClipCounterStep;
  /** One bone nudged: only that element's local polygon changed. */
  oneSlotMoved: ClipCounterStep;
  /** clipping = false: every clip-path removed, the clip counted as skipped. */
  disabled: ClipCounterStep;
  /** clipping = true again: re-applied without any other change. */
  reEnabled: ClipCounterStep;
  /** A second clipping attachment met while the first is active. */
  nested: ClipCounterStep;
}

export interface ClipInverseProbeResult {
  /** The even-odd string the renderer wrote for a drawn element. */
  sampleClipPath: string;
  elementsWithClipPath: number;
  /** Must stay '': an inverse clip never takes the root fast path. */
  rootClipPath: string;
  counters: ClipCounters;
  polygon: number[];
  clipped: ClipCapture;
  unclipped: ClipCapture;
}

/** One deterministic pose of a named animation. */
function posedFor(assets: LoadedAssets, animation: string, time: number): Skeleton {
  const skeleton = new Skeleton(assets.data);
  const state = new AnimationState(new AnimationStateData(assets.data));
  state.setAnimation(0, animation, true);
  state.update(time);
  state.apply(skeleton);
  skeleton.update(time);
  skeleton.updateWorldTransform(Physics.update);
  return skeleton;
}

/** A capture box with a renderer root at a known origin and scale inside it. */
function openClipCapture(id: string, top: number): {
  root: HTMLElement;
  capture: ClipCapture;
} {
  const container = document.createElement('div');
  container.id = id;
  container.style.position = 'absolute';
  container.style.left = '0';
  container.style.top = `${top}px`;
  container.style.width = `${CLIP_BOX.width}px`;
  container.style.height = `${CLIP_BOX.height}px`;
  container.style.overflow = 'hidden';
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = `${CLIP_BOX.originX}px`;
  root.style.top = `${CLIP_BOX.originY}px`;
  root.style.transformOrigin = '0 0';
  root.style.transform = `scale(${CLIP_SCALE})`;
  container.appendChild(root);
  document.body.appendChild(container);
  return {
    root,
    capture: { id, ...CLIP_BOX, scale: CLIP_SCALE, background: CLIP_BG },
  };
}

function clipRenderer(root: HTMLElement, assets: LoadedAssets): SpineHtmlRenderer {
  const renderer = new SpineHtmlRenderer(root, assets.regionImages);
  // The root is scaled, so fold that in rather than rastering meshes at 1:1.
  renderer.pixelRatio = CLIP_SCALE;
  return renderer;
}

function clipCounters(renderer: SpineHtmlRenderer): ClipCounters {
  return {
    clipCount: renderer.clipCount,
    clipSkipCount: renderer.clipSkipCount,
    clipWriteCount: renderer.clipWriteCount,
  };
}

/** The slot elements of one root, identified by the z-index the renderer wrote. */
function clipElements(
  root: HTMLElement,
  drawOrder: Slot[],
  startIndex: number,
  endIndex: number,
): ClipElementReport[] {
  const out: ClipElementReport[] = [];
  for (const el of Array.from(root.children)) {
    if (!(el instanceof HTMLImageElement) && !(el instanceof HTMLCanvasElement)) continue;
    const z = Number(el.style.zIndex);
    const slot = Number.isInteger(z) ? drawOrder[z] : undefined;
    out.push({
      slot: slot ? slot.data.name : `z:${el.style.zIndex}`,
      tag: el instanceof HTMLImageElement ? 'img' : 'canvas',
      visible: el.style.display !== 'none',
      clipPath: el.style.clipPath,
      inRange: z > startIndex && z <= endIndex,
    });
  }
  return out;
}

/** The clip polygon in the root's CSS frame — the spec's oracle input. */
function clipWorldPolygon(skeleton: Skeleton, slot: Slot, clip: ClippingAttachment): number[] {
  const n = clip.worldVerticesLength;
  const world = new Float32Array(n);
  clip.computeWorldVertices(skeleton, slot, 0, n, world, 0, 2);
  const polygon: number[] = [];
  // Spine is Y-up, CSS is Y-down — the same negation the renderer applies.
  for (let v = 0; v < n; v += 2) polygon.push(world[v], -world[v + 1]);
  return polygon;
}

/**
 * A clip polygon is stored in its slot's bone space, and every spineboy slot
 * hangs off an animated bone — so these tests author the quad in world space
 * and carry it into the host bone's frame through the inverse of that bone's
 * applied transform. Where the clip lands is then a property of the test
 * rather than of the pose. (Spine's bone convention: X = a·vx + b·vy + worldX,
 * Y = c·vx + d·vy + worldY.)
 */
function clipVerticesFromWorld(slot: Slot, world: number[]): number[] {
  const bone = slot.bone.appliedPose;
  const det = bone.a * bone.d - bone.b * bone.c;
  if (det === 0) throw new Error('clip host bone has a singular transform');
  const inv = 1 / det;
  const out: number[] = [];
  for (let i = 0; i < world.length; i += 2) {
    const dx = world[i] - bone.worldX;
    const dy = world[i + 1] - bone.worldY;
    out.push((bone.d * dx - bone.b * dy) * inv, (bone.a * dy - bone.c * dx) * inv);
  }
  return out;
}

function makeClip(
  name: string,
  slot: Slot,
  worldVertices: number[],
  endSlot: SlotData | null,
): ClippingAttachment {
  const clip = new ClippingAttachment(name);
  clip.vertices = clipVerticesFromWorld(slot, worldVertices);
  clip.worldVerticesLength = clip.vertices.length;
  clip.endSlot = endSlot;
  return clip;
}

/** A quad, tilted so the rigid tier's inverse-matrix path has real work to do. */
function tiltedQuad(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  degrees: number,
): number[] {
  const t = (degrees * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const out: number[] = [];
  for (const [x, y] of [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ]) {
    out.push(cx + x * cos - y * sin, cy + x * sin + y * cos);
  }
  return out;
}

/**
 * The repository's own part mask: spineboy-pro's `portal` animation carries a
 * clipping attachment in the `clipping` slot that ends at `head-bb`, so it
 * covers the character and leaves the portal artwork around it alone.
 *
 * The two captures hide everything OUT of that range, so the only difference
 * between them is the clip itself — which is what lets the spec mask one and
 * compare it to the other.
 */
async function clipPartMaskProbe(): Promise<ClipPartMaskProbeResult> {
  const assets = await loadSkeletonAssets(CLIP_PRO);
  const skeleton = posedFor(assets, 'portal', 1.2);
  const drawOrder = skeleton.drawOrder.appliedPose;
  const startIndex = drawOrder.findIndex(
    (slot) => slot.appliedPose.attachment instanceof ClippingAttachment,
  );
  if (startIndex < 0) throw new Error('the portal animation has no clipping attachment');
  const startSlot = drawOrder[startIndex];
  const clip = startSlot.appliedPose.attachment as ClippingAttachment;
  const ahead = clip.endSlot
    ? drawOrder.findIndex((slot, i) => i > startIndex && slot.data === clip.endSlot)
    : -1;
  const endIndex = ahead === -1 ? drawOrder.length - 1 : ahead;

  const inRangeSlots: string[] = [];
  const outOfRangeSlots: string[] = [];
  drawOrder.forEach((slot, i) => {
    if (i === startIndex) return;
    (i > startIndex && i <= endIndex ? inRangeSlots : outOfRangeSlots).push(slot.data.name);
  });

  // Full render first — the DOM report needs the out-of-range slots present.
  const full = openClipCapture('clip-part-full', CLIP_BOX.height * 2);
  const fullRenderer = clipRenderer(full.root, assets);
  fullRenderer.render(skeleton);
  const elements = clipElements(full.root, drawOrder, startIndex, endIndex);
  const rootClipPath = full.root.style.clipPath;

  const polygon = clipWorldPolygon(skeleton, startSlot, clip);

  // Now drop everything outside the clip's range, so the captures differ in
  // nothing but the clip.
  drawOrder.forEach((slot, i) => {
    if (i !== startIndex && !(i > startIndex && i <= endIndex)) {
      slot.appliedPose.attachment = null;
    }
  });

  const clipped = openClipCapture('clip-part-a', 0);
  const clippedRenderer = clipRenderer(clipped.root, assets);
  clippedRenderer.render(skeleton);

  const unclipped = openClipCapture('clip-part-b', CLIP_BOX.height);
  const unclippedRenderer = clipRenderer(unclipped.root, assets);
  unclippedRenderer.clipping = false;
  unclippedRenderer.render(skeleton);

  return {
    startSlot: startSlot.data.name,
    endSlot: clip.endSlot ? clip.endSlot.name : null,
    inRangeSlots,
    outOfRangeSlots,
    polygon,
    counters: clipCounters(clippedRenderer),
    elements,
    rootClipPath,
    clipped: clipped.capture,
    unclipped: unclipped.capture,
  };
}

/**
 * The rigid tier under a tilted clip: spineboy-ess is region attachments only,
 * so every element here is an `<img>` posed by a full matrix and every
 * clip-path has to come back through that matrix's inverse.
 *
 * The clip sits in the first slot and ends at the LAST one, so it covers every
 * drawn element (which is what makes the whole capture maskable) while the
 * root fast path stays shut — the end slot lies ahead.
 */
async function clipRigidProbe(): Promise<ClipRigidProbeResult> {
  const assets = await loadSkeletonAssets(CLIP_ESS);
  const skeleton = posedFor(assets, 'walk', 1.2);
  const drawOrder = skeleton.drawOrder.appliedPose;
  const host = drawOrder[0];
  const last = drawOrder[drawOrder.length - 1];

  // The control first: clipped by a quad far larger than the skeleton, so
  // every element carries a clip-path and none of them loses a pixel.
  host.appliedPose.attachment = makeClip(
    'probe-covering',
    host,
    tiltedQuad(0, 350, 20000, 20000, 0),
    last.data,
  );
  const control = openClipCapture('clip-rigid-c', CLIP_BOX.height * 2);
  const controlRenderer = clipRenderer(control.root, assets);
  controlRenderer.render(skeleton);

  const clip = makeClip('probe-tilted', host, tiltedQuad(40, 380, 200, 130, 22), last.data);
  host.appliedPose.attachment = clip;

  const polygon = clipWorldPolygon(skeleton, host, clip);

  const clipped = openClipCapture('clip-rigid-a', 0);
  const clippedRenderer = clipRenderer(clipped.root, assets);
  clippedRenderer.render(skeleton);

  const unclipped = openClipCapture('clip-rigid-b', CLIP_BOX.height);
  const unclippedRenderer = clipRenderer(unclipped.root, assets);
  unclippedRenderer.clipping = false;
  unclippedRenderer.render(skeleton);

  const reports = clipElements(clipped.root, drawOrder, 0, drawOrder.length - 1);
  let rotatedOrScaled = 0;
  for (const el of Array.from(clipped.root.children)) {
    if (!(el instanceof HTMLImageElement) || el.style.display === 'none') continue;
    const m = /matrix\(([^)]+)\)/.exec(el.style.transform);
    if (!m) continue;
    const [a, b, c, d] = m[1].split(',').map(Number);
    // Anything but the identity 2×2 means the inverse below is doing work.
    if (Math.abs(a - 1) > 1e-6 || Math.abs(d - 1) > 1e-6 || b !== 0 || c !== 0) {
      rotatedOrScaled++;
    }
  }

  return {
    control: control.capture,
    clippedSlots: reports.filter((r) => r.clipPath !== '').map((r) => r.slot),
    unclippedSlots: reports.filter((r) => r.visible && r.clipPath === '').map((r) => r.slot),
    rotatedOrScaled,
    rootClipPath: clipped.root.style.clipPath,
    counters: clipCounters(clippedRenderer),
    polygon,
    clipped: clipped.capture,
    unclipped: unclipped.capture,
  };
}

/**
 * The whole-skeleton shape: an axis-aligned rectangle in the first slot whose
 * end slot is its OWN slot. The official draw loops never offer the starting
 * slot to clipEnd (they `continue` past it), so that clip never ends and
 * covers every element — which is the case the root fast path exists for.
 *
 * The style contract gets its own throwaway root: the root is the caller's
 * element, so the inline clip-path found there has to come back.
 */
async function clipRootProbe(): Promise<ClipRootProbeResult> {
  const assets = await loadSkeletonAssets(CLIP_ESS);
  const skeleton = posedFor(assets, 'walk', 1.2);
  const drawOrder = skeleton.drawOrder.appliedPose;
  const host = drawOrder[0];
  const original = host.appliedPose.attachment;
  // A screen-shaped window over the character, the consumer shape this serves.
  const rect = [-120, 100, 220, 100, 220, 520, -120, 520];
  const clip = makeClip('probe-window', host, rect, host.data);
  host.appliedPose.attachment = clip;

  const polygon = clipWorldPolygon(skeleton, host, clip);

  const clipped = openClipCapture('clip-root-a', 0);
  const clippedRenderer = clipRenderer(clipped.root, assets);
  clippedRenderer.render(skeleton);

  const unclipped = openClipCapture('clip-root-b', CLIP_BOX.height);
  const unclippedRenderer = clipRenderer(unclipped.root, assets);
  unclippedRenderer.clipping = false;
  unclippedRenderer.render(skeleton);

  const reports = clipElements(clipped.root, drawOrder, 0, drawOrder.length);
  const counters = clipCounters(clippedRenderer);

  // The borrowed-style contract, on a root that already carries one.
  const contract = openClipCapture('clip-root-style', CLIP_BOX.height * 2);
  contract.root.style.clipPath = 'inset(0px)';
  // Read it back rather than trusting the literal: what has to come back is
  // whatever the engine serialized, which is what the renderer saved.
  const before = contract.root.style.clipPath;
  const contractRenderer = clipRenderer(contract.root, assets);
  contractRenderer.render(skeleton);
  const duringClip = contract.root.style.clipPath;
  host.appliedPose.attachment = original;
  contractRenderer.render(skeleton);
  const afterClipEnds = contract.root.style.clipPath;
  host.appliedPose.attachment = clip;
  contractRenderer.render(skeleton);
  const duringSecondClip = contract.root.style.clipPath;
  contractRenderer.dispose();
  const afterDispose = contract.root.style.clipPath;

  return {
    rootClipPath: clipped.root.style.clipPath,
    elementsWithClipPath: reports.filter((r) => r.clipPath !== '').length,
    drawnElements: reports.filter((r) => r.visible).length,
    counters,
    styleContract: { before, duringClip, afterClipEnds, duringSecondClip, afterDispose },
    polygon,
    clipped: clipped.capture,
    unclipped: unclipped.capture,
  };
}

/**
 * Writes-on-change, the disable switch, and the nested-clip rule — all on one
 * renderer, because each step's meaning is "what changed since the last one".
 * No pixels here: every number below is a deterministic counter.
 */
async function clipCountersProbe(): Promise<ClipCountersProbeResult> {
  const assets = await loadSkeletonAssets(CLIP_ESS);
  const skeleton = posedFor(assets, 'walk', 1.2);
  const drawOrder = skeleton.drawOrder.appliedPose;
  const host = drawOrder[0];
  const last = drawOrder[drawOrder.length - 1];
  const clip = makeClip('probe-counters', host, tiltedQuad(40, 380, 200, 130, 22), last.data);
  host.appliedPose.attachment = clip;

  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  document.body.appendChild(root);
  const renderer = clipRenderer(root, assets);

  let previous = new Map<string, string>();
  function step(): ClipCounterStep {
    renderer.render(skeleton);
    const reports = clipElements(root, drawOrder, 0, drawOrder.length - 1);
    const now = new Map(reports.map((r) => [r.slot, r.clipPath]));
    const changedSlots: string[] = [];
    for (const [slot, value] of now) {
      if (previous.get(slot) !== value) changedSlots.push(slot);
    }
    previous = now;
    return {
      clipWriteCount: renderer.clipWriteCount,
      clipCount: renderer.clipCount,
      clipSkipCount: renderer.clipSkipCount,
      elementsWithClipPath: reports.filter((r) => r.clipPath !== '').length,
      changedSlots,
    };
  }

  const firstRender = step();
  const inRangeElements = firstRender.elementsWithClipPath;
  const secondRender = step();

  // Move the polygon itself: every covered element's local polygon changes.
  const moved = clip.vertices as number[];
  for (let i = 0; i < moved.length; i++) moved[i] += 7;
  const polygonMoved = step();

  // Nudge one bone's APPLIED world transform. Nothing recomputes the
  // hierarchy afterwards, so no child bone follows and exactly the slots on
  // that bone move — and this one is picked because it carries exactly one
  // slot that is actually drawn (a bone whose only slot is undrawn would move
  // nothing at all and make the assertion pass for the wrong reason).
  const drawn = drawOrder.filter(
    (slot) => slot !== host && previous.get(slot.data.name) !== undefined,
  );
  const movedSlot = drawn.find(
    (slot) => drawn.filter((other) => other.bone === slot.bone).length === 1,
  );
  if (!movedSlot) throw new Error('no drawn slot is alone on its bone');
  movedSlot.bone.appliedPose.worldX += 13;
  const oneSlotMoved = step();

  renderer.clipping = false;
  const disabled = step();
  renderer.clipping = true;
  const reEnabled = step();

  // A second clipping attachment while the first is still active: spine-core's
  // clipStart ignores it, so it is counted, not nested.
  const second = drawOrder[3];
  second.appliedPose.attachment = makeClip(
    'probe-second',
    second,
    tiltedQuad(0, 300, 120, 120, 0),
    last.data,
  );
  const nested = step();

  renderer.dispose();
  root.remove();

  return {
    inRangeElements,
    movedSlot: movedSlot.data.name,
    firstRender,
    secondRender,
    polygonMoved,
    oneSlotMoved,
    disabled,
    reEnabled,
    nested,
  };
}

/**
 * An inverse clip: everything OUTSIDE the polygon stays visible. CSS says that
 * with an even-odd polygon whose outer ring is the element's own box, so the
 * shape is expressible per element — and never on the root, which is a 0×0
 * origin element with no box to ring.
 */
async function clipInverseProbe(): Promise<ClipInverseProbeResult> {
  const assets = await loadSkeletonAssets(CLIP_ESS);
  const skeleton = posedFor(assets, 'walk', 1.2);
  const drawOrder = skeleton.drawOrder.appliedPose;
  const host = drawOrder[0];
  const clip = makeClip('probe-inverse', host, tiltedQuad(40, 380, 160, 110, 22), host.data);
  clip.inverse = true;
  host.appliedPose.attachment = clip;

  const polygon = clipWorldPolygon(skeleton, host, clip);

  const clipped = openClipCapture('clip-inverse-a', 0);
  const clippedRenderer = clipRenderer(clipped.root, assets);
  clippedRenderer.render(skeleton);

  const unclipped = openClipCapture('clip-inverse-b', CLIP_BOX.height);
  const unclippedRenderer = clipRenderer(unclipped.root, assets);
  unclippedRenderer.clipping = false;
  unclippedRenderer.render(skeleton);

  const reports = clipElements(clipped.root, drawOrder, 0, drawOrder.length);
  const sample = reports.find((r) => r.visible && r.clipPath !== '');

  return {
    sampleClipPath: sample ? sample.clipPath : '',
    elementsWithClipPath: reports.filter((r) => r.clipPath !== '').length,
    rootClipPath: clipped.root.style.clipPath,
    counters: clipCounters(clippedRenderer),
    polygon,
    clipped: clipped.capture,
    unclipped: unclipped.capture,
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
  scaledPageProbe,
  halfResRenderProbe,
  clipPartMaskProbe,
  clipRigidProbe,
  clipRootProbe,
  clipCountersProbe,
  clipInverseProbe,
  cutRuleStage,
};
