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
  backingProbe(): Promise<BackingProbeResult>;
  loaderHttpFailureProbe(): Promise<LoaderHttpFailureProbeResult>;
  sharedAtlasProbe(): Promise<SharedAtlasProbeResult>;
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

window.spineHtmlHarness = {
  unpackProbe,
  passThroughProbe,
  unpackFailureProbe,
  loaderProbe,
  loaderFailureProbe,
  backingProbe,
  loaderHttpFailureProbe,
  sharedAtlasProbe,
};
