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
 * ## Fairness: the two sides have to draw the same picture, each on its own
 * home ground
 *
 * The first runs of this page were unfair in *both* directions, and neither
 * defect showed up as an error — only as a number (#39, first-run report):
 *
 * 1. **Against this package.** Every reference player drew into a cell-sized
 *    `<canvas>`, so whatever fell outside its cell was discarded by the
 *    viewport for free, while the DOM rigs were composited past their cells and
 *    over their neighbours. The two sides were not drawing the same visible
 *    picture, and the DOM side was carrying overlapping layers the reference
 *    never paid for. The rule now is one line: **a DOM rig is clipped to
 *    exactly the rect the reference canvas for that rig covers** — the cell
 *    when the reference has one canvas per player, the whole pane when it
 *    shares one. `overflow: hidden` on a box, which is how a page embeds a
 *    player; deliberately *not* `contain: layout paint`. Read off the
 *    containment spec rather than assumed: paint containment clips "to the
 *    overflow clip edge", which is the clip `overflow: hidden` already applies,
 *    and what it adds past that is a stacking context, an absolute/fixed
 *    containing block and an independent formatting context — structural
 *    changes to this side alone. It is *not* the "skip whatever is outside the
 *    box" hint one might reach for; that is `content-visibility`. Nor is there
 *    layout inside the box to contain, since every slot element is absolutely
 *    positioned already. So it would buy no clipping and change how this side
 *    is composited, which is tuning it rather than embedding it.
 * 2. **Against the reference.** Every scene got one WebGL context per rig.
 *    That is right for `many`, which is *about* independent players and the
 *    browser's ~16-context cap. It is wrong for "N rigs on one page": a
 *    spine-webgl application draws N skeletons into **one** canvas through one
 *    `SceneRenderer`, batched — its home ground — and one context per rig
 *    instead lost every rig past the cap, so past 16 the rows compared a full
 *    grid against a partial one. So the reference has two modes, chosen by the
 *    scene and named on its stats line: `shared canvas` (one context, one
 *    `begin()`/`end()` pair, N skeletons, N draw calls batched down to a
 *    handful) and `context per player` (`many` only, which keeps counting the
 *    contexts it was refused and the ones it lost).
 *
 * Both fixes rest on the two sides placing rigs identically, so placement is
 * derived once, in `layoutFor()`, and read by both — and then *checked* rather
 * than assumed: each side reports `originDelta`, the largest gap in CSS px
 * between where the grid puts a rig's origin and where that side actually drew
 * it. It is a counter, not a picture, so it survives being read on any machine.
 * (It is also how the count-1 placement bug was found: the DOM side put a lone
 * rig's feet at 96% of the pane's height and the reference put them 8 px above
 * its bottom — 18 px apart at this window size, in the one scene most likely to
 * be read.)
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
 *
 * `mesh`, `held` and `rigid` take a count too, and that is where a crossover
 * can be looked for: on a fast desktop GPU a single rig sits at the display's
 * refresh rate on both sides, which says nothing. `bench/scenes.json` steps
 * them.
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
/** How the reference draws N rigs — see the fairness note above. */
type ReferenceMode = 'shared' | 'per-player';

const REFERENCE_MODE_LABEL: Record<ReferenceMode, string> = {
  shared: 'shared canvas',
  'per-player': 'context per player',
};

interface SceneSpec {
  skeleton: 'ess' | 'pro';
  /** Overrides `skeleton` when a corpus rig names its own export. */
  skeletonUrl?: string;
  animation: string;
  timeScale: number;
  /** Players per side. */
  count: number;
  /**
   * Stage scale for **one rig filling the pane**. A grid divides it by the
   * column count (`layoutFor`), so a rig keeps the same size relative to its
   * cell however dense the grid gets and a count sweep varies the number of
   * rigs rather than how much of each one is cropped away.
   */
  scale: number;
  /** Which shape the reference takes for this scene. */
  reference: ReferenceMode;
}

const SCENE_NAMES: SceneName[] = ['mesh', 'held', 'rigid', 'many'];

/**
 * The cap on `count`. 64 rigs is 8 columns of 8 on this page's grid, which at
 * a 1280-wide window leaves each cell about 80 CSS px across — small enough
 * that the next step would be measuring thumbnails. It is a page limit, not a
 * library one.
 */
const MAX_COUNT = 64;

/** Where a rig's feet sit inside its cell, as a fraction of the cell's height. */
const FLOOR = 0.96;

function readScene(): { name: SceneName; spec: SceneSpec } {
  const raw = params.get('scene');
  const name: SceneName = SCENE_NAMES.includes(raw as SceneName) ? (raw as SceneName) : 'mesh';
  const count = Math.min(
    MAX_COUNT,
    Math.max(1, Number(params.get('count')) || (name === 'many' ? 8 : 1)),
  );
  const specs: Record<SceneName, SceneSpec> = {
    mesh: { skeleton: 'pro', animation: 'hoverboard', timeScale: 1, count, scale: 0.42, reference: 'shared' },
    held: { skeleton: 'pro', animation: 'hoverboard', timeScale: 0, count, scale: 0.42, reference: 'shared' },
    rigid: { skeleton: 'ess', animation: 'walk', timeScale: 1, count, scale: 0.42, reference: 'shared' },
    many: { skeleton: 'pro', animation: 'walk', timeScale: 1, count, scale: 0.42, reference: 'per-player' },
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
  // Freezing any scene is what an equal-picture check needs: two runtimes can
  // only be diffed on one frame, and `held` is the only scene frozen by
  // definition. `?timescale=0` freezes the others without inventing a scene.
  const timeScaleParam = params.get('timescale');
  if (timeScaleParam !== null) spec.timeScale = Number(timeScaleParam) || 0;
  return { name, spec };
}

const { name: sceneName, spec: scene } = readScene();
const referenceMode: ReferenceMode = scene.reference;
/**
 * What a rig is clipped to, on both sides: the rect the reference's canvas for
 * that rig covers. One canvas over the pane means the pane; a canvas per player
 * means its cell.
 */
const CLIP_TARGET: 'pane' | 'cell' = referenceMode === 'shared' ? 'pane' : 'cell';
const runtime: RuntimeMode = ((): RuntimeMode => {
  const raw = params.get('runtime');
  return raw === 'dom' || raw === 'reference' ? raw : 'both';
})();
const backend: MeshBackend = params.get('backend') === 'canvas2d' ? 'canvas2d' : 'webgl';
const dprOverride = params.get('dpr') !== null ? Number(params.get('dpr')) || 1 : null;
const pixelRatio = (): number => dprOverride ?? window.devicePixelRatio ?? 1;

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

/** Poses every player. Returns the ms it took, so the loop can split the two costs. */
function advance(players: Player[], delta: number): number {
  const t0 = performance.now();
  for (const player of players) {
    player.state.update(delta);
    player.state.apply(player.skeleton);
    advanceSkeleton(player.skeleton, delta);
  }
  return performance.now() - t0;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Cell extends Rect {
  /** Where this rig's skeleton origin sits, in stage px. */
  originX: number;
  originY: number;
}

interface Layout {
  columns: number;
  rows: number;
  /** Stage scale per rig — the scene's one-per-pane scale over the columns. */
  scale: number;
  cells: Cell[];
  /** The rect the reference's canvas for a rig covers, and so the rig's clip. */
  clipOf(index: number): Rect;
  /** `pane` when the reference shares one canvas, `cell` when it does not. */
  clipTarget: 'pane' | 'cell';
}

/**
 * Where the N rigs go — **one derivation, read by both sides**.
 *
 * Both sides used to compute this separately and agreed everywhere except at
 * `count === 1`, where they disagreed by 18 px. A benchmark whose two sides
 * draw in different places is not comparing runtimes, so there is one function
 * now and each side reports how far its drawing landed from what this says.
 */
function layoutFor(width: number, height: number): Layout {
  const n = scene.count;
  const columns = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / columns);
  const cellW = width / columns;
  const cellH = height / rows;
  const cells: Cell[] = [];
  for (let i = 0; i < n; i++) {
    const left = (i % columns) * cellW;
    const top = Math.floor(i / columns) * cellH;
    cells.push({
      left,
      top,
      width: cellW,
      height: cellH,
      originX: left + cellW / 2,
      originY: top + cellH * FLOOR,
    });
  }
  const pane: Rect = { left: 0, top: 0, width, height };
  return {
    columns,
    rows,
    scale: scene.scale / columns,
    cells,
    clipOf: (index) => (CLIP_TARGET === 'pane' ? pane : cells[index]),
    clipTarget: CLIP_TARGET,
  };
}

interface Side {
  /** Runs one frame; returns the ms spent posing skeletons (the rest is draw). */
  frame(delta: number): number;
  /** The stats string for this side, given the fps the loop measured. */
  stats(fps: number, updateMs: number, renderMs: number, frames: number): string;
  /** Recomputed on resize. */
  layout(): void;
  /** Largest gap, in CSS px, between the grid's origin for a rig and this side's. */
  originDelta(): number;
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
  /**
   * The clip boxes — one per rect, mirroring the reference exactly: one box
   * over the pane when it shares a canvas, one box per cell when it does not.
   * The box *is* the embedding: a page puts a player in a box, and this one
   * covers the same rect the reference's canvas does. See the fairness note at
   * the top for why it is `overflow: hidden` and not `contain: layout paint`.
   */
  const clipBoxes: HTMLDivElement[] = [];
  const boxOfPlayer: number[] = [];
  for (let i = 0; i < scene.count; i++) {
    const boxIndex = CLIP_TARGET === 'pane' ? 0 : i;
    if (!clipBoxes[boxIndex]) {
      const box = document.createElement('div');
      box.className = 'cell-clip';
      stageEl.append(box);
      clipBoxes[boxIndex] = box;
    }
    const root = document.createElement('div');
    root.className = 'skeleton-root';
    clipBoxes[boxIndex].append(root);
    const renderer = new SpineHtmlRenderer(root, regionImages);
    renderer.meshBackend = backend;
    players.push(makePlayer(data, i));
    roots.push(root);
    boxOfPlayer.push(boxIndex);
    renderers.push(renderer);
  }

  let originDelta = 0;
  const layout = (): void => {
    const box = stageEl.getBoundingClientRect();
    const grid = layoutFor(box.width, box.height);
    for (let i = 0; i < roots.length; i++) {
      const cell = grid.cells[i];
      const clipRect = grid.clipOf(i);
      const box = clipBoxes[boxOfPlayer[i]];
      box.style.left = `${clipRect.left}px`;
      box.style.top = `${clipRect.top}px`;
      box.style.width = `${clipRect.width}px`;
      box.style.height = `${clipRect.height}px`;
      roots[i].style.left = `${cell.originX - clipRect.left}px`;
      roots[i].style.top = `${cell.originY - clipRect.top}px`;
      roots[i].style.transform = `scale(${grid.scale})`;
      // Raster at the resolution the stage shows at — a plain devicePixelRatio
      // would oversample by 1/scale², which is its own (documented) trap.
      renderers[i].pixelRatio = pixelRatio() * grid.scale;
    }
    // Read back where the rigs actually landed. A slot element is absolutely
    // positioned, so a root has a zero-sized box sitting exactly on its origin
    // — and `transform-origin: 0 0` leaves that point where it is under the
    // scale. One forced layout per resize, never per frame.
    originDelta = 0;
    for (let i = 0; i < roots.length; i++) {
      const rect = roots[i].getBoundingClientRect();
      const cell = grid.cells[i];
      originDelta = Math.max(
        originDelta,
        Math.hypot(rect.left - box.left - cell.originX, rect.top - box.top - cell.originY),
      );
    }
  };
  layout();

  return {
    frame(delta: number): number {
      const updateMs = advance(players, delta);
      for (let i = 0; i < renderers.length; i++) renderers[i].render(players[i].skeleton);
      return updateMs;
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
        `${scene.count}/${scene.count} × ${fps.toFixed(0)} fps · ` +
        `skeleton ${(updateMs / frames).toFixed(2)}ms · ` +
        `render ${(renderMs / frames).toFixed(2)}ms/frame${meshNote} · ${active} · ` +
        `clipped to ${CLIP_TARGET}`
      );
    },
    layout,
    originDelta: () => originDelta,
  };
}

/**
 * The reference, in whichever of its two shapes this scene asked for.
 *
 * `shared` is the one a spine-webgl application writes: one canvas over the
 * pane, one context, one atlas whose pages are uploaded once, and one
 * `begin()`/`end()` pair per frame with every skeleton drawn inside it so the
 * batcher can merge them. The grid is carried by the skeletons' own
 * `x`/`y` — written at layout time and never per frame, so a physics
 * constraint sees a standing offset rather than a rig being dragged — against
 * a single camera, which is what keeps the batch a batch. A scissor per cell
 * would need a flush per cell and would hand back exactly the batching this
 * mode exists to give it; it is not needed either, because the DOM side clips
 * to this canvas's rect rather than to the cells.
 *
 * `per-player` is `many`'s: a canvas and a context per player, which is the
 * architecture that meets the browser's ~16-context cap. It counts what it was
 * refused instead of dying, because a benchmark that dies at the cap cannot
 * report reaching it.
 */
async function referenceSide(stageEl: HTMLDivElement): Promise<Side> {
  const atlasText = await (await fetch(atlasPath)).text();

  interface RefPlayer extends Player {
    /** `per-player` only; the shared mode has one canvas for every player. */
    canvas: HTMLCanvasElement | null;
    context: ManagedWebGLRenderingContext | null;
    renderer: SceneRenderer | null;
    pma: boolean;
  }

  const players: RefPlayer[] = [];

  /** Builds a context + renderer + its own atlas over `canvas`, or reports the refusal. */
  async function attach(canvas: HTMLCanvasElement): Promise<{
    context: ManagedWebGLRenderingContext | null;
    renderer: SceneRenderer | null;
    data: SkeletonData | null;
    pma: boolean;
  }> {
    try {
      const context = new ManagedWebGLRenderingContext(canvas, {
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: false,
      });
      if (!context.gl) throw new Error('no WebGL context');
      const renderer = new SceneRenderer(canvas, context);
      // A GLTexture belongs to one context, so an atlas does too.
      const atlas = new TextureAtlas(atlasText);
      let pma = false;
      for (const page of atlas.pages) {
        const image = await loadImage(`${assetBase}/${page.name}`);
        page.setTexture(makeReferenceTexture(renderer, context, image, page.pma));
        pma = page.pma;
      }
      const data = await loadSkeletonJson({ atlas }, skeletonUrl());
      return { context, renderer, data, pma };
    } catch {
      // The browser's context cap, most likely. Count it and keep the page
      // alive — a benchmark that dies at the cap cannot report reaching it.
      contextsRefused++;
      return { context: null, renderer: null, data: null, pma: false };
    }
  }

  /** A skeleton that poses fine and never draws — keeps the arrays parallel. */
  async function orphanData(): Promise<SkeletonData> {
    return loadSkeletonJson({ atlas: new TextureAtlas(atlasText) }, skeletonUrl());
  }

  /**
   * A canvas with no live context stops being shown at all.
   *
   * Not cosmetics: Chromium paints its own broken-canvas placeholder — a white
   * box with an icon — over a canvas whose context it took back, which past the
   * cap covers a whole row of cells. That is the browser's error UI, not
   * anything spine-webgl drew, and leaving it on screen charges the reference
   * for pixels it never asked for and puts a picture in the pane that neither
   * runtime produced. The refusals and losses are still counted, still in the
   * header, and still in the `alive/total` on the stats line — which is where
   * a reader should learn that five players went dark, rather than from five
   * white rectangles.
   */
  function hide(canvas: HTMLCanvasElement): void {
    canvas.style.visibility = 'hidden';
  }

  function watchLoss(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      contextsLost++;
      hide(canvas);
      showWarnings();
    });
  }

  let shared: {
    canvas: HTMLCanvasElement;
    context: ManagedWebGLRenderingContext | null;
    renderer: SceneRenderer | null;
    pma: boolean;
  } | null = null;

  if (referenceMode === 'shared') {
    const canvas = document.createElement('canvas');
    stageEl.append(canvas);
    watchLoss(canvas);
    const attached = await attach(canvas);
    if (!attached.renderer) hide(canvas);
    shared = {
      canvas,
      context: attached.context,
      renderer: attached.renderer,
      pma: attached.pma,
    };
    const data = attached.data ?? (await orphanData());
    for (let i = 0; i < scene.count; i++) {
      players.push({ ...makePlayer(data, i), canvas: null, context: null, renderer: null, pma: attached.pma });
    }
  } else {
    for (let i = 0; i < scene.count; i++) {
      const canvas = document.createElement('canvas');
      stageEl.append(canvas);
      watchLoss(canvas);
      const attached = await attach(canvas);
      if (!attached.renderer) hide(canvas);
      const data = attached.data ?? (await orphanData());
      players.push({
        ...makePlayer(data, i),
        canvas,
        context: attached.context,
        renderer: attached.renderer,
        pma: attached.pma,
      });
    }
  }
  showWarnings();

  /**
   * Points a camera at `rect` so that stage point (`originX`, `originY`) is
   * where world (`worldX`, `worldY`) lands.
   *
   * An ortho camera maps world x to `rect.width/2 + (x − cx)·scale` inside its
   * canvas, and the framebuffer's Y is up, so y lands at
   * `rect.height/2 − (y − cy)·scale`. Setting those equal to the stage point
   * the grid asked for and solving gives the two positions below — the same
   * derivation `tests/oracleStage.ts` carries for the pixel oracle, which is
   * the other half of #39 and the reason it is not repeated by eye here.
   */
  function aim(
    renderer: SceneRenderer,
    rect: Rect,
    scale: number,
    origin: { originX: number; originY: number },
    world: { x: number; y: number },
  ): void {
    renderer.camera.viewportWidth = rect.width / scale;
    renderer.camera.viewportHeight = rect.height / scale;
    renderer.camera.position.x = world.x - (origin.originX - rect.left - rect.width / 2) / scale;
    renderer.camera.position.y = world.y + (origin.originY - rect.top - rect.height / 2) / scale;
    renderer.camera.position.z = 0;
  }

  /**
   * Maps a world point through the camera `aim()` just set, back to stage px.
   *
   * It inverts the same derivation, so what it can catch is the grid and the
   * camera disagreeing — which is exactly what `count === 1` was — and not a
   * wrong convention shared by both. Proving the convention is the pixel
   * check's job (README, and `tests/oracle.spec.ts` for the same mapping).
   */
  function landsAt(
    renderer: SceneRenderer,
    rect: Rect,
    scale: number,
    world: { x: number; y: number },
  ): { x: number; y: number } {
    return {
      x: rect.left + rect.width / 2 + (world.x - renderer.camera.position.x) * scale,
      y: rect.top + rect.height / 2 - (world.y - renderer.camera.position.y) * scale,
    };
  }

  function sizeCanvas(canvas: HTMLCanvasElement, rect: Rect): void {
    const dpr = pixelRatio();
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  let originDelta = 0;
  const layout = (): void => {
    const box = stageEl.getBoundingClientRect();
    const grid = layoutFor(box.width, box.height);
    const pane: Rect = { left: 0, top: 0, width: box.width, height: box.height };
    originDelta = 0;

    if (shared) {
      sizeCanvas(shared.canvas, pane);
      const renderer = shared.renderer;
      if (!renderer) return;
      // One camera over the pane, world origin at its centre; each rig carries
      // its own place in the grid on its skeleton, which is how N of them stay
      // inside one batch.
      aim(renderer, pane, grid.scale, { originX: box.width / 2, originY: box.height / 2 }, { x: 0, y: 0 });
      for (let i = 0; i < players.length; i++) {
        const cell = grid.cells[i];
        players[i].skeleton.x = (cell.originX - box.width / 2) / grid.scale;
        players[i].skeleton.y = (box.height / 2 - cell.originY) / grid.scale;
        const at = landsAt(renderer, pane, grid.scale, {
          x: players[i].skeleton.x,
          y: players[i].skeleton.y,
        });
        originDelta = Math.max(originDelta, Math.hypot(at.x - cell.originX, at.y - cell.originY));
      }
      return;
    }

    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      const cell = grid.cells[i];
      if (!player.canvas) continue;
      sizeCanvas(player.canvas, cell);
      const renderer = player.renderer;
      if (!renderer) continue;
      player.skeleton.x = 0;
      player.skeleton.y = 0;
      aim(renderer, cell, grid.scale, cell, { x: 0, y: 0 });
      const at = landsAt(renderer, cell, grid.scale, { x: 0, y: 0 });
      originDelta = Math.max(originDelta, Math.hypot(at.x - cell.originX, at.y - cell.originY));
    }
  };
  layout();

  let drawCalls = 0;

  function drawShared(): void {
    if (!shared) return;
    const { canvas, context, renderer, pma } = shared;
    if (!renderer || !context) return;
    const gl = context.gl;
    if (gl.isContextLost()) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // One begin/end for every skeleton on the pane: the batcher merges them,
    // which is the whole point of this mode.
    renderer.begin();
    for (const player of players) drawReferenceSkeleton(renderer, player.skeleton, pma);
    renderer.end();
    drawCalls = renderer.batcher.getDrawCalls();
  }

  function drawPerPlayer(): void {
    drawCalls = 0;
    for (const player of players) {
      const renderer = player.renderer;
      const context = player.context;
      const canvas = player.canvas;
      if (!renderer || !context || !canvas) continue;
      const gl = context.gl;
      if (gl.isContextLost()) continue;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.begin();
      drawReferenceSkeleton(renderer, player.skeleton, player.pma);
      renderer.end();
      drawCalls += renderer.batcher.getDrawCalls();
    }
  }

  /** Rigs the reference is actually drawing this frame. */
  function alive(): number {
    if (shared) {
      const live = shared.renderer && !shared.context?.gl.isContextLost();
      return live ? scene.count : 0;
    }
    return players.filter((p) => p.renderer && !p.context?.gl.isContextLost()).length;
  }

  return {
    frame(delta: number): number {
      const updateMs = advance(players, delta);
      if (shared) drawShared();
      else drawPerPlayer();
      return updateMs;
    },
    stats(fps, updateMs, renderMs, frames): string {
      return (
        `${alive()}/${scene.count} × ${fps.toFixed(0)} fps · ` +
        `skeleton ${(updateMs / frames).toFixed(2)}ms · ` +
        `draw ${(renderMs / frames).toFixed(2)}ms/frame · ${drawCalls} draw calls · ` +
        `${REFERENCE_MODE_LABEL[referenceMode]}`
      );
    },
    layout,
    originDelta: () => originDelta,
  };
}

const warnEl = document.getElementById('warn') as HTMLDivElement;

function showWarnings(): void {
  const notes: string[] = [];
  if (contextsRefused && referenceMode === 'shared') {
    notes.push("the reference's shared canvas got no WebGL context — it is drawing nothing");
  } else if (contextsRefused) {
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
  /** Which shape the reference is in — see the fairness note in this file. */
  referenceMode: ReferenceMode;
  /** What a rig is clipped to on both sides: the reference canvas's own rect. */
  clipTarget: 'pane' | 'cell';
  /** The grid both sides place rigs on, and the per-rig stage scale. */
  columns: number;
  rows: number;
  cellScale: number;
  /**
   * Largest gap in CSS px between where the grid puts a rig's origin and where
   * a side drew it. Both sides near zero is what makes the comparison a
   * comparison; it is a counter rather than a timing, so it reads the same on
   * any machine. Null for a side that is not running.
   */
  domOriginDeltaPx: number | null;
  referenceOriginDeltaPx: number | null;
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
  const grid = layoutFor(domStage.clientWidth || 1, domStage.clientHeight || 1);
  sceneEl.textContent =
    `scene=${sceneName} count=${scene.count} (${grid.columns}×${grid.rows}, scale ` +
    `${grid.scale.toFixed(3)}, clipped to ${grid.clipTarget}) backend=${backend} ` +
    `runtime=${runtime} reference=${REFERENCE_MODE_LABEL[referenceMode]} ` +
    `dpr=${pixelRatio().toFixed(2)} · ${modeNote}`;
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

  const reading = (): BenchReading => {
    const current = layoutFor(domStage.clientWidth || 1, domStage.clientHeight || 1);
    return {
      scene: sceneName,
      runtime,
      count: scene.count,
      backend,
      devicePixelRatio: pixelRatio(),
      referenceMode,
      clipTarget: current.clipTarget,
      columns: current.columns,
      rows: current.rows,
      cellScale: current.scale,
      domOriginDeltaPx: dom ? Math.round(dom.originDelta() * 1000) / 1000 : null,
      referenceOriginDeltaPx: reference ? Math.round(reference.originDelta() * 1000) / 1000 : null,
      frames: totalFrames,
      domStats,
      referenceStats: refStats,
      domFps,
      referenceFps: refFps,
      contextsRefused,
      contextsLost,
    };
  };

  function frame(now: number): void {
    const delta = Math.min((now - last) / 1000, 1 / 15);
    last = now;

    if (dom) {
      const t0 = performance.now();
      const updateMs = dom.frame(delta);
      domUpdateMs += updateMs;
      domRenderMs += performance.now() - t0 - updateMs;
    }
    if (reference) {
      const t0 = performance.now();
      const updateMs = reference.frame(delta);
      refUpdateMs += updateMs;
      refRenderMs += performance.now() - t0 - updateMs;
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
