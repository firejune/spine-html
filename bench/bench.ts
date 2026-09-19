import {
  AnimationState,
  AnimationStateData,
  Skeleton,
  type SkeletonData,
  TextureAtlas,
} from '@esotericsoftware/spine-core';
import {
  GLTexture,
  ManagedWebGLRenderingContext,
  SceneRenderer,
} from '@esotericsoftware/spine-webgl';

/** `Physics` is absent from 4.1's and 4.0's root entry — see `advance()`. */
import { advanceSkeleton } from '../src/coreOptional';
import { DomTexture, type RegionImage, unpackRegions } from '../src/DomTexture';
import { loadSkeletonJson } from '../src/loadSkeletonAssets';
import { type MeshBackend, SpineHtmlRenderer } from '../src/SpineHtmlRenderer';

/**
 * The side-by-side benchmark page — an instrument for a person, not a test.
 *
 * ## What it is for
 *
 * The suite's oracle (`tests/oracle.spec.ts`) answers "do the two runtimes draw
 * the same picture". This answers the other half of #39: what the DOM approach
 * costs next to the runtime everyone else uses. It is a *page* rather than a
 * spec because the answer cannot be taken in CI — headless numbers are not
 * evidence here (headless WebKit is a software rasterizer, measured up to 28×
 * off real Safari) and nothing in this repository asserts a millisecond. The
 * perf oracle is a stats line read on a real device, and this page is a stats
 * line for each runtime, side by side, on one.
 *
 * `scripts/bench.mjs` drives it in a *headed* browser and writes the numbers
 * out with the conditions attached; Safari stays manual, which is what the
 * clickable stats line is for.
 *
 * ## Why the fps reading is per runtime and not per pane
 *
 * `requestAnimationFrame` has one cadence per document, so two panes animating
 * in one page report *the same* fps — the page's, not either runtime's. A
 * side-by-side of that number would be a comparison of nothing. So
 * `?runtime=dom` and `?runtime=reference` each give the whole frame budget to
 * one side, which is what the script drives, and `?runtime=both` (the default)
 * animates both for eyeballing and says so on every stats line, so a reading
 * copied out of that mode cannot be mistaken for a measurement.
 *
 * ## Scenes
 *
 * - `mesh` — spineboy-pro animating: the deform tier working every frame.
 * - `held` — the same rig with the pose frozen: this package's dirty-skip home
 *   ground, where an unchanged mesh reuses its raster and the reference redraws
 *   regardless.
 * - `rigid` — spineboy-ess: region attachments only, pure `<img>` and CSS
 *   matrices on this side.
 * - `many` — `?count=N` independent players, each its own skeleton, renderer
 *   and (on the reference side) its own WebGL context. Browsers cap contexts at
 *   ~16, so this scene is also the one that demonstrates the architectural
 *   difference: the reference needs one per player and this package shares a
 *   single module-level context however many there are. The page counts the
 *   contexts it failed to get and the ones the browser took back, and says so
 *   in the header instead of dying.
 */

const params = new URLSearchParams(location.search);

/**
 * The rig. Defaults to the repository's own spineboy exports; `?atlas=` and
 * `?skel=` point it at anything else the server is holding, which is how
 * `scripts/bench.mjs --corpus <dir>` runs real-world rigs that never enter this
 * repository — the page needs no knowledge of them, only their URLs.
 */
const atlasPath = params.get('atlas') ?? '/spineboy/spineboy.atlas';

type SceneName = 'mesh' | 'held' | 'rigid' | 'many';
type RuntimeMode = 'both' | 'dom' | 'reference';

interface SceneSpec {
  skeleton: 'ess' | 'pro';
  /** Overrides `skeleton` when a corpus rig names its own export. */
  skeletonUrl?: string;
  animation: string;
  timeScale: number;
  /** Players per side. */
  count: number;
  /** Stage scale per player. */
  scale: number;
}

const SCENE_NAMES: SceneName[] = ['mesh', 'held', 'rigid', 'many'];

function readScene(): { name: SceneName; spec: SceneSpec } {
  const raw = params.get('scene');
  const name: SceneName = SCENE_NAMES.includes(raw as SceneName) ? (raw as SceneName) : 'mesh';
  const count = Math.min(64, Math.max(1, Number(params.get('count')) || (name === 'many' ? 8 : 1)));
  const specs: Record<SceneName, SceneSpec> = {
    mesh: { skeleton: 'pro', animation: 'hoverboard', timeScale: 1, count, scale: 0.42 },
    held: { skeleton: 'pro', animation: 'hoverboard', timeScale: 0, count, scale: 0.42 },
    rigid: { skeleton: 'ess', animation: 'walk', timeScale: 1, count, scale: 0.42 },
    many: { skeleton: 'pro', animation: 'walk', timeScale: 1, count, scale: 0.16 },
  };
  const spec = { ...specs[name] };
  // A corpus rig names its own export and animation; the scene still decides
  // count, scale and whether the pose is held.
  const skelUrl = params.get('skel');
  if (skelUrl) spec.skeletonUrl = skelUrl;
  const animation = params.get('anim');
  if (animation) spec.animation = animation;
  const scaleParam = params.get('scale');
  if (scaleParam) spec.scale = Number(scaleParam) || spec.scale;
  return { name, spec };
}

const { name: sceneName, spec: scene } = readScene();
const runtime: RuntimeMode = ((): RuntimeMode => {
  const raw = params.get('runtime');
  return raw === 'dom' || raw === 'reference' ? raw : 'both';
})();
const backend: MeshBackend = params.get('backend') === 'canvas2d' ? 'canvas2d' : 'webgl';
const dprOverride = params.get('dpr') !== null ? Number(params.get('dpr')) || 1 : null;

/** How many WebGL contexts the reference could not get, or lost afterwards. */
let contextsRefused = 0;
let contextsLost = 0;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${url}`));
    image.src = url;
  });
}

/**
 * The reference's generation seam — 4.2 takes the alpha convention on the draw
 * call, 4.3 on the texture. Read off the live object, never a version string;
 * the same detection as `tests/oracleStage.ts`, which explains it in full.
 */
interface PrePoseGLTextureCtor {
  new (context: ManagedWebGLRenderingContext, image: HTMLImageElement): GLTexture;
}
interface PrePoseSceneRenderer {
  drawSkeleton(skeleton: Skeleton, premultipliedAlpha: boolean): void;
}

function makeReferenceTexture(
  renderer: SceneRenderer,
  context: ManagedWebGLRenderingContext,
  image: HTMLImageElement,
  pma: boolean,
): GLTexture {
  if ('premultipliedAlpha' in renderer.skeletonRenderer) {
    return new (GLTexture as unknown as PrePoseGLTextureCtor)(context, image);
  }
  return new GLTexture(context, image, pma);
}

function drawReferenceSkeleton(
  renderer: SceneRenderer,
  skeleton: Skeleton,
  pma: boolean,
): void {
  if ('premultipliedAlpha' in renderer.skeletonRenderer) {
    (renderer as unknown as PrePoseSceneRenderer).drawSkeleton(skeleton, pma);
    return;
  }
  renderer.drawSkeleton(skeleton);
}

interface Player {
  skeleton: Skeleton;
  state: AnimationState;
}

function makePlayer(data: SkeletonData, index: number): Player {
  const skeleton = new Skeleton(data);
  const state = new AnimationState(new AnimationStateData(data));
  state.setAnimation(0, scene.animation, true);
  // Desync so N players are not one stamped sprite — except a held pose, which
  // wants every instance on the same frozen frame.
  state.update(scene.timeScale === 0 ? 1.2 : (index * 0.37) % 2);
  state.timeScale = scene.timeScale;
  return { skeleton, state };
}

function advance(players: Player[], delta: number): void {
  for (const player of players) {
    player.state.update(delta);
    player.state.apply(player.skeleton);
    advanceSkeleton(player.skeleton, delta);
  }
}

/** Where player `i` of `n` sits inside a stage of `width` × `height`. */
function slot(index: number, n: number, width: number, height: number): { x: number; y: number } {
  if (n === 1) return { x: width / 2, y: height * 0.96 };
  const columns = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / columns);
  const col = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: (width * (col + 0.5)) / columns,
    y: (height * (row + 1)) / rows - 8,
  };
}

interface Side {
  /** Runs one frame; returns nothing. Both sides advance their own players. */
  frame(delta: number): void;
  /** The stats string for this side, given the fps the loop measured. */
  stats(fps: number, updateMs: number, renderMs: number, frames: number): string;
  /** Recomputed on resize. */
  layout(): void;
}

/** Page images sit beside the atlas, whichever directory that is. */
const assetBase = atlasPath.slice(0, atlasPath.lastIndexOf('/'));
const skeletonUrl = (): string =>
  scene.skeletonUrl ?? `${assetBase}/spineboy-${scene.skeleton}.json`;

async function domSide(stageEl: HTMLDivElement): Promise<Side> {
  const atlasText = await (await fetch(atlasPath)).text();
  const atlas = new TextureAtlas(atlasText);
  const pageImages = new Map<string, HTMLImageElement>();
  for (const page of atlas.pages) {
    const image = await loadImage(`${assetBase}/${page.name}`);
    page.setTexture(new DomTexture(image));
    pageImages.set(page.name, image);
  }
  const regionImages: Map<string, RegionImage> = await unpackRegions(atlas, pageImages);
  const data = await loadSkeletonJson({ atlas }, skeletonUrl());

  const players: Player[] = [];
  const roots: HTMLDivElement[] = [];
  const renderers: SpineHtmlRenderer[] = [];
  for (let i = 0; i < scene.count; i++) {
    const root = document.createElement('div');
    root.className = 'skeleton-root';
    stageEl.append(root);
    const renderer = new SpineHtmlRenderer(root, regionImages);
    renderer.meshBackend = backend;
    players.push(makePlayer(data, i));
    roots.push(root);
    renderers.push(renderer);
  }

  const layout = (): void => {
    const box = stageEl.getBoundingClientRect();
    for (let i = 0; i < roots.length; i++) {
      const at = slot(i, scene.count, box.width, box.height);
      roots[i].style.left = `${at.x}px`;
      roots[i].style.top = `${at.y}px`;
      roots[i].style.transform = `scale(${scene.scale})`;
      // Raster at the resolution the stage shows at — a plain devicePixelRatio
      // would oversample by 1/scale², which is its own (documented) trap.
      renderers[i].pixelRatio = (dprOverride ?? window.devicePixelRatio ?? 1) * scene.scale;
    }
  };
  layout();

  return {
    frame(delta: number): void {
      advance(players, delta);
      for (let i = 0; i < renderers.length; i++) renderers[i].render(players[i].skeleton);
    },
    stats(fps, updateMs, renderMs, frames): string {
      let meshes = 0;
      let reused = 0;
      let triangles = 0;
      let backing = 0;
      let reallocs = 0;
      for (const renderer of renderers) {
        meshes += renderer.meshCount;
        reused += renderer.meshReuseCount;
        triangles += renderer.triangleCount;
        backing += renderer.meshBackingPixels;
        reallocs += renderer.canvasReallocCount;
      }
      const meshNote =
        meshes + reused
          ? ` · mesh ${meshes} drawn (${triangles} tris) / ${reused} reused` +
            (reallocs ? ` / ${reallocs} realloc'd` : '') +
            ` · backing ${(backing / 1e6).toFixed(1)} Mpx`
          : '';
      const active = renderers[0]?.meshBackendActive ?? backend;
      return (
        `${scene.count} × ${fps.toFixed(0)} fps · skeleton ${(updateMs / frames).toFixed(2)}ms · ` +
        `render ${(renderMs / frames).toFixed(2)}ms/frame${meshNote} · ${active}`
      );
    },
    layout,
  };
}

async function referenceSide(stageEl: HTMLDivElement): Promise<Side> {
  const atlasText = await (await fetch(atlasPath)).text();

  interface RefPlayer extends Player {
    canvas: HTMLCanvasElement;
    context: ManagedWebGLRenderingContext | null;
    renderer: SceneRenderer | null;
    pma: boolean;
  }

  const players: RefPlayer[] = [];
  for (let i = 0; i < scene.count; i++) {
    const canvas = document.createElement('canvas');
    stageEl.append(canvas);
    let context: ManagedWebGLRenderingContext | null = null;
    let renderer: SceneRenderer | null = null;
    let pma = false;
    let data: SkeletonData | null = null;
    try {
      context = new ManagedWebGLRenderingContext(canvas, {
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: false,
      });
      if (!context.gl) throw new Error('no WebGL context');
      renderer = new SceneRenderer(canvas, context);
      // Each player gets its own atlas: a GLTexture belongs to one context.
      const atlas = new TextureAtlas(atlasText);
      for (const page of atlas.pages) {
        const image = await loadImage(`${assetBase}/${page.name}`);
        page.setTexture(makeReferenceTexture(renderer, context, image, page.pma));
        pma = page.pma;
      }
      data = await loadSkeletonJson({ atlas }, skeletonUrl());
    } catch {
      // The browser's context cap, most likely. Count it and keep the page
      // alive — a benchmark that dies at the cap cannot report reaching it.
      contextsRefused++;
      context = null;
      renderer = null;
    }
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      contextsLost++;
      showWarnings();
    });
    if (!data) {
      // Still needs a skeleton to keep the arrays parallel; read it against a
      // texture-less atlas, which poses fine and simply never draws.
      const atlas = new TextureAtlas(atlasText);
      data = await loadSkeletonJson({ atlas }, skeletonUrl());
    }
    players.push({ ...makePlayer(data, i), canvas, context, renderer, pma });
  }
  showWarnings();

  const layout = (): void => {
    const box = stageEl.getBoundingClientRect();
    const dpr = dprOverride ?? window.devicePixelRatio ?? 1;
    // One canvas per player, sized to its own cell — the same pixels the DOM
    // side's per-part canvases cover, so neither side is handed a bigger target.
    const columns = scene.count === 1 ? 1 : Math.ceil(Math.sqrt(scene.count));
    const rows = Math.ceil(scene.count / columns);
    const cellW = box.width / columns;
    const cellH = box.height / rows;
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      const col = scene.count === 1 ? 0 : i % columns;
      const row = scene.count === 1 ? 0 : Math.floor(i / columns);
      player.canvas.style.left = `${col * cellW}px`;
      player.canvas.style.top = `${row * cellH}px`;
      player.canvas.style.width = `${cellW}px`;
      player.canvas.style.height = `${cellH}px`;
      player.canvas.width = Math.max(1, Math.round(cellW * dpr));
      player.canvas.height = Math.max(1, Math.round(cellH * dpr));
      const renderer = player.renderer;
      if (!renderer) continue;
      // Same mapping the oracle derives: the skeleton origin sits at the cell's
      // bottom centre, world units scaled by `scene.scale`.
      const originX = cellW / 2;
      const originY = cellH - 8;
      renderer.camera.viewportWidth = cellW / scene.scale;
      renderer.camera.viewportHeight = cellH / scene.scale;
      renderer.camera.position.x = (cellW / 2 - originX) / scene.scale;
      renderer.camera.position.y = (originY - cellH / 2) / scene.scale;
      renderer.camera.position.z = 0;
    }
  };
  layout();

  let drawCalls = 0;
  return {
    frame(delta: number): void {
      advance(players, delta);
      drawCalls = 0;
      for (const player of players) {
        const renderer = player.renderer;
        const context = player.context;
        if (!renderer || !context) continue;
        const gl = context.gl;
        if (gl.isContextLost()) continue;
        gl.viewport(0, 0, player.canvas.width, player.canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        renderer.begin();
        drawReferenceSkeleton(renderer, player.skeleton, player.pma);
        renderer.end();
        drawCalls += renderer.batcher.getDrawCalls();
      }
    },
    stats(fps, updateMs, renderMs, frames): string {
      const live = players.filter((p) => p.renderer && !p.context?.gl.isContextLost()).length;
      return (
        `${live}/${scene.count} × ${fps.toFixed(0)} fps · skeleton ${(updateMs / frames).toFixed(2)}ms · ` +
        `draw ${(renderMs / frames).toFixed(2)}ms/frame · ${drawCalls} draw calls`
      );
    },
    layout,
  };
}

const warnEl = document.getElementById('warn') as HTMLDivElement;

function showWarnings(): void {
  const notes: string[] = [];
  if (contextsRefused) {
    notes.push(
      `${contextsRefused}/${scene.count} reference players got no WebGL context ` +
        `(browsers cap contexts at ~16; spine-html shares one)`,
    );
  }
  if (contextsLost) notes.push(`${contextsLost} reference context(s) lost`);
  warnEl.textContent = notes.join(' · ');
}

/**
 * The stats each side publishes, also on `window.spineHtmlBench` so
 * `scripts/bench.mjs` can read them without scraping the DOM.
 */
export interface BenchReading {
  scene: SceneName;
  runtime: RuntimeMode;
  count: number;
  backend: MeshBackend;
  devicePixelRatio: number;
  /** Frames the loop has completed since the page loaded. */
  frames: number;
  domStats: string;
  referenceStats: string;
  /** rAF-cadence fps over the last window, per side that ran. */
  domFps: number | null;
  referenceFps: number | null;
  contextsRefused: number;
  contextsLost: number;
}

declare global {
  interface Window {
    spineHtmlBench: {
      reading(): BenchReading;
      /** Resolves once `frames` frames have run since the call. */
      run(frames: number): Promise<BenchReading>;
    };
  }
}

async function main(): Promise<void> {
  const domStage = document.getElementById('dom-stage') as HTMLDivElement;
  const refStage = document.getElementById('ref-stage') as HTMLDivElement;
  const domStatsEl = document.getElementById('dom-stats') as HTMLDivElement;
  const refStatsEl = document.getElementById('ref-stats') as HTMLDivElement;
  const domTitle = document.getElementById('dom-title') as HTMLHeadingElement;
  const refTitle = document.getElementById('ref-title') as HTMLHeadingElement;
  const sceneEl = document.getElementById('scene') as HTMLDivElement;

  const runDom = runtime !== 'reference';
  const runRef = runtime !== 'dom';
  const [dom, reference] = await Promise.all([
    runDom ? domSide(domStage) : Promise.resolve(null),
    runRef ? referenceSide(refStage) : Promise.resolve(null),
  ]);

  const modeNote =
    runtime === 'both'
      ? 'both animating — one rAF cadence for the page, so these fps are the PAGE’s, not either runtime’s'
      : `only ${runtime} is animating — this side has the frame budget to itself`;
  sceneEl.textContent =
    `scene=${sceneName} count=${scene.count} backend=${backend} runtime=${runtime} ` +
    `dpr=${(dprOverride ?? window.devicePixelRatio ?? 1).toFixed(2)} · ${modeNote}`;
  if (!runDom) domTitle.innerHTML = 'spine-html (DOM) <span class="idle">— idle</span>';
  if (!runRef) refTitle.innerHTML = 'spine-webgl (reference) <span class="idle">— idle</span>';

  for (const el of [domStatsEl, refStatsEl]) {
    el.title = 'click to copy';
    el.addEventListener('click', () => {
      void navigator.clipboard?.writeText(el.textContent ?? '');
    });
  }

  window.addEventListener('resize', () => {
    dom?.layout();
    reference?.layout();
  });

  let last = performance.now();
  let statsAt = last;
  let frames = 0;
  let totalFrames = 0;
  let domUpdateMs = 0;
  let domRenderMs = 0;
  let refUpdateMs = 0;
  let refRenderMs = 0;
  let domFps: number | null = null;
  let refFps: number | null = null;
  let domStats = runDom ? '—' : 'idle';
  let refStats = runRef ? '—' : 'idle';
  const waiters: Array<{ until: number; resolve: (reading: BenchReading) => void }> = [];

  const reading = (): BenchReading => ({
    scene: sceneName,
    runtime,
    count: scene.count,
    backend,
    devicePixelRatio: dprOverride ?? window.devicePixelRatio ?? 1,
    frames: totalFrames,
    domStats,
    referenceStats: refStats,
    domFps,
    referenceFps: refFps,
    contextsRefused,
    contextsLost,
  });

  function frame(now: number): void {
    const delta = Math.min((now - last) / 1000, 1 / 15);
    last = now;

    if (dom) {
      const t0 = performance.now();
      dom.frame(delta);
      domRenderMs += performance.now() - t0;
    }
    if (reference) {
      const t0 = performance.now();
      reference.frame(delta);
      refRenderMs += performance.now() - t0;
    }
    frames++;
    totalFrames++;

    if (now - statsAt >= 500 && frames > 0) {
      const fps = (frames * 1000) / (now - statsAt);
      if (dom) {
        domFps = fps;
        domStats = dom.stats(fps, domUpdateMs, domRenderMs, frames);
        domStatsEl.textContent = domStats;
      }
      if (reference) {
        refFps = fps;
        refStats = reference.stats(fps, refUpdateMs, refRenderMs, frames);
        refStatsEl.textContent = refStats;
      }
      domUpdateMs = domRenderMs = refUpdateMs = refRenderMs = 0;
      frames = 0;
      statsAt = now;
    }

    for (let i = waiters.length - 1; i >= 0; i--) {
      if (totalFrames >= waiters[i].until) {
        waiters[i].resolve(reading());
        waiters.splice(i, 1);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.spineHtmlBench = {
    reading,
    run: (count: number) =>
      new Promise<BenchReading>((resolve) => {
        waiters.push({ until: totalFrames + count, resolve });
      }),
  };
}

main().catch((error: unknown) => {
  const sceneEl = document.getElementById('scene');
  if (sceneEl) {
    sceneEl.textContent = `failed: ${String(error)} — did you run bun run fetch-assets?`;
  }
  console.error(error);
});
