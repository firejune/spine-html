import {
  AnimationState,
  AnimationStateData,
  Skeleton,
  type SkeletonData,
  TextureAtlas,
} from '@esotericsoftware/spine-core';
import { GLTexture, ManagedWebGLRenderingContext, SceneRenderer } from '@esotericsoftware/spine-webgl';

import { type CoreShape, coreCompatFor } from '../src/coreCompat';
/** `Physics` is absent from 4.1's and 4.0's root entry — see `posed()` below. */
import { advanceSkeleton } from '../src/coreOptional';
import { DomTexture, type RegionImage, SpineHtmlRenderer, unpackRegions } from '../src/index';
import { loadSkeletonJson } from '../src/loadSkeletonAssets';

/**
 * The pixel oracle's two stages: this package, and the official runtime.
 *
 * ## Why a second runtime is in the tree at all
 *
 * Every visual test here is an A/B between this package's own two mesh
 * backends. That catches one backend drifting from the other and cannot, by
 * construction, catch a defect they share. #37 was exactly that shape — `pma:
 * true` pages drawn one multiply too dark in *every* tier — and the suite
 * stayed green for months while a consumer found it. So the oracle compares
 * against something that is not us: `@esotericsoftware/spine-webgl`, drawing
 * the same export, in the same pose, at the same size, on the same page.
 *
 * It is a **devDependency and nothing else**: this file is the only one that
 * names it, it lives under `tests/`, and nothing in `src/` may reach it —
 * `tsconfig.build.json` compiles all of `src/` and `tests/package.spec.ts`
 * pins the emitted file set, so a reference import that drifted into the
 * library would ship to npm. The dependency runs the other way round on
 * purpose: the harness imports from `src/`, never the reverse.
 *
 * ## The mapping the comparison rests on
 *
 * The two renderers are only comparable if world space lands on the same
 * pixels, so the mapping is derived rather than eyeballed, once, here.
 *
 * The DOM side puts the skeleton root at (`originX`, `originY`) CSS px inside
 * the stage, `transform-origin: 0 0`, `transform: scale(S)`. Spine is Y-up, so
 * a world point (x, y) lands at
 *
 *     px = originX + S·x        py = originY − S·y
 *
 * The reference side draws through an orthographic camera into a canvas of the
 * same W × H. An ortho camera maps world x to NDC `(x − cx) / (vw/2)`, and the
 * viewport maps that to `px = W/2 + (x − cx)·W/vw`; the framebuffer's Y is up,
 * so the screenshot reads `py = H/2 − (y − cy)·H/vh`. Setting those two equal
 * to the DOM pair and solving gives the whole camera:
 *
 *     vw = W / S                cx = (W/2 − originX) / S
 *     vh = H / S                cy = (originY − H/2) / S
 *
 * with the canvas backing store at `W·dpr × H·dpr` and the GL viewport over
 * all of it, which cancels out of both ratios. Nothing here is fitted to a
 * picture — and `tests/oracle.spec.ts` proves the alignment the way this
 * repository proves everything else, by driving it: a deliberate one-world-unit
 * offset on the DOM side has to be *detected*.
 *
 * `scale` is 0.5 because spineboy's atlas was packed at half the skeleton's own
 * units (its pages carry `scale: 0.5`, which spine-core ignores — it is the
 * packer's note to itself), so half scale is where one texel is one CSS pixel
 * and neither side is asked to resample. That keeps the forgivable residue —
 * GL's linear filtering against the browser's image scaling — at its floor
 * instead of inflating it with a downscale neither runtime was asked for.
 *
 * ## What is deliberately shared, and what is not
 *
 * The pose is: both sides run the identical call sequence (`state.update`,
 * `apply`, `skeleton.update`, `updateWorldTransform(Physics.update)`) from the
 * same animation and track time on the same export, so bone transforms and
 * deform are bit-identical float work, not "close enough".
 *
 * The atlas is not, and cannot be: a page needs a `DomTexture` for this package
 * and a `GLTexture` for the reference, so each side parses its own
 * `TextureAtlas` over the same atlas text and the same page image. That is the
 * only divergence above the renderers themselves.
 */

/**
 * Stage geometry — see the mapping derivation above.
 *
 * Sized from the poses the oracle draws rather than guessed, with a 12 px
 * margin: measured against the origin, the union of every cell's slot boxes
 * runs x ∈ [−357.5, +377.0] and y ∈ [−515.9, +140.4] CSS px (`portal` reaches
 * furthest left and up, `shoot` furthest right — its crosshair sits well off
 * the body — and `hoverboard` furthest down). A pose that outgrew the stage
 * would be compared on a crop, which is why `tests/oracle.spec.ts` asserts
 * containment per capture instead of trusting these numbers to stay true.
 */
export const ORACLE_STAGE = {
  width: 760,
  height: 690,
  originX: 370,
  originY: 528,
  scale: 0.5,
  background: '#14161a',
} as const;

const ASSET_BASE = '/spineboy';

export interface OracleStageOptions {
  /** Which runtime draws this capture. */
  side: 'dom' | 'reference';
  /** `plain` is the shipped straight-alpha page; `pma` the exporter's premultiplied twin. */
  page: 'plain' | 'pma';
  skeleton: 'ess' | 'pro';
  animation: string;
  time: number;
  /** Mesh raster backend — the DOM side only; the reference has one path. */
  backend?: 'canvas2d' | 'webgl';
  /** Whole-skeleton tint, 6 hex digits. Multiplies both runtimes' vertex/filter colour. */
  tint?: string | null;
  /** Apply clipping attachments on the DOM side (the reference always clips). */
  clipping?: boolean;
  /**
   * World units added to the skeleton's X on **this** capture. The alignment
   * probe: offsetting one side and nothing else must move the picture.
   */
  offsetX?: number;
}

export interface OracleStageResult {
  /** Which runtime drew, echoed back so a spec cannot mis-attribute a capture. */
  side: 'dom' | 'reference';
  /** Read off the parsed atlas, so a cell cannot silently test the wrong page. */
  pagePma: boolean;
  pageSize: { width: number; height: number };
  /** DOM side: slot elements and the backend that actually rasterized. */
  imageCount: number;
  canvasCount: number;
  backendActive: string;
  meshesDrawn: number;
  /** Reference side: batcher draw calls — zero means nothing reached the GPU. */
  drawCalls: number;
  /** Which spine-webgl generation the reference is running on. */
  referenceShape: 'pre-4.3' | '4.3';
  /**
   * Which seam `src/coreCompat.ts` picked for the installed core, detected from
   * the live objects. Reported so a column cannot pass while drawing through
   * the wrong shape: the 4.0 column's whole point is that it runs
   * `pre-sequences`, and a silent fall-back to `sequences` would draw `NaN`
   * corners — which looks, from a count of slot elements, exactly like success.
   */
  coreShape: CoreShape;
  /** The stage the capture covers, so a spec never hard-codes its size. */
  stage: { width: number; height: number };
  /**
   * How many of the atlas's regions the packer stored rotated (`rotate: 90`).
   *
   * Reported because the oracle found a disagreement that only such a region
   * produces, and a *feature* test is how this repository keys on an absent
   * capability rather than on a version: the spineboy atlas on the 4.3 branch
   * rotates nothing and the one on the 4.2 branch rotates ten, so a version key
   * would say "4.2" where the truth is "this packer rotated something".
   * `tests/oracle.spec.ts` carries what was measured.
   */
  rotatedRegions: number;
  /** Union of the drawn boxes in stage coordinates — the stage must contain it. */
  contentBox: { x: number; y: number; width: number; height: number };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${url}`));
    image.src = url;
  });
}

function atlasUrl(page: 'plain' | 'pma'): string {
  return page === 'pma' ? `${ASSET_BASE}/spineboy-pma.atlas` : `${ASSET_BASE}/spineboy.atlas`;
}

/**
 * The reference's generation seam — the whole of it.
 *
 * spine-webgl moved the alpha convention from the draw call onto the texture
 * between 4.2 and 4.3: 4.2 uploads the page as stored and is told
 * `drawSkeleton(skeleton, premultipliedAlpha)`, while 4.3 normalizes the upload
 * (`UNPACK_PREMULTIPLY_ALPHA_WEBGL = !pma`) and always blends premultiplied, so
 * its `drawSkeleton` has no such argument and `GLTexture` takes the flag
 * instead. Both are correct for both page conventions; only the call shape
 * differs.
 *
 * Which one is installed is read off the live object, the way
 * `src/coreCompat.ts` reads the core's shape: 4.2's `SkeletonRenderer` carries a
 * `premultipliedAlpha` field and 4.3's does not. Not a version string — a
 * vendored or bundled copy need not carry one — and not a try/catch.
 */
interface ReferenceCompat {
  readonly shape: 'pre-4.3' | '4.3';
  makeTexture(context: ManagedWebGLRenderingContext, image: HTMLImageElement, pma: boolean): GLTexture;
  drawSkeleton(renderer: SceneRenderer, skeleton: Skeleton, pma: boolean): void;
}

/** 4.2's shapes, structurally — these casts never leave this file. */
interface PrePoseGLTextureCtor {
  new (context: ManagedWebGLRenderingContext, image: HTMLImageElement): GLTexture;
}
interface PrePoseSceneRenderer {
  drawSkeleton(skeleton: Skeleton, premultipliedAlpha: boolean): void;
}

function referenceCompatFor(renderer: SceneRenderer): ReferenceCompat {
  const prePose = 'premultipliedAlpha' in renderer.skeletonRenderer;
  if (prePose) {
    return {
      shape: 'pre-4.3',
      makeTexture: (context, image) =>
        new (GLTexture as unknown as PrePoseGLTextureCtor)(context, image),
      drawSkeleton: (sceneRenderer, skeleton, pma) =>
        (sceneRenderer as unknown as PrePoseSceneRenderer).drawSkeleton(skeleton, pma),
    };
  }
  return {
    shape: '4.3',
    makeTexture: (context, image, pma) => new GLTexture(context, image, pma),
    drawSkeleton: (sceneRenderer, skeleton) => sceneRenderer.drawSkeleton(skeleton),
  };
}

let stageEl: HTMLDivElement | null = null;
let glCanvas: HTMLCanvasElement | null = null;
let glContext: ManagedWebGLRenderingContext | null = null;
let sceneRenderer: SceneRenderer | null = null;
let compat: ReferenceCompat | null = null;
let domLive: SpineHtmlRenderer | null = null;

function stageElement(): HTMLDivElement {
  if (stageEl) return stageEl;
  const stage = document.createElement('div');
  stage.id = 'oracle-stage';
  stage.style.cssText =
    'position: absolute; left: 0; top: 0; overflow: hidden;' +
    `width: ${ORACLE_STAGE.width}px; height: ${ORACLE_STAGE.height}px;` +
    `background: ${ORACLE_STAGE.background};`;
  document.body.append(stage);
  stageEl = stage;
  return stage;
}

/**
 * One WebGL context for the whole document, like the library's own blitter —
 * browsers cap contexts at ~16 and this page also runs the library's.
 *
 * `preserveDrawingBuffer` because the capture is a screenshot taken after the
 * draw has returned, not a readback inside it; `alpha: false` so the clear
 * colour *is* the backdrop and the two stages share one background rather than
 * compositing over different ones.
 */
function reference(): {
  canvas: HTMLCanvasElement;
  context: ManagedWebGLRenderingContext;
  renderer: SceneRenderer;
  compat: ReferenceCompat;
} {
  if (glCanvas && glContext && sceneRenderer && compat) {
    return { canvas: glCanvas, context: glContext, renderer: sceneRenderer, compat };
  }
  const canvas = document.createElement('canvas');
  canvas.id = 'oracle-reference';
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(ORACLE_STAGE.width * dpr);
  canvas.height = Math.round(ORACLE_STAGE.height * dpr);
  canvas.style.cssText =
    `position: absolute; left: 0; top: 0;` +
    `width: ${ORACLE_STAGE.width}px; height: ${ORACLE_STAGE.height}px;`;
  const context = new ManagedWebGLRenderingContext(canvas, {
    alpha: false,
    preserveDrawingBuffer: true,
    antialias: true,
    premultipliedAlpha: true,
  });
  if (!context.gl) throw new Error('the reference runtime could not get a WebGL context');
  const renderer = new SceneRenderer(canvas, context);
  glCanvas = canvas;
  glContext = context;
  sceneRenderer = renderer;
  compat = referenceCompatFor(renderer);
  return { canvas, context, renderer, compat };
}

/** Atlas, bitmaps and skeleton data for one (side, page, skeleton), built once. */
interface OracleScene {
  atlas: TextureAtlas;
  data: SkeletonData;
  /** DOM side only. */
  regionImages: Map<string, RegionImage>;
  pageImage: HTMLImageElement;
}

const scenes = new Map<string, Promise<OracleScene>>();

/**
 * Kept for the document's lifetime, like the pma stage's: unpacking per capture
 * would hand every screenshot a blob the compositor has never rastered, and a
 * cold-against-warm raster reads as a difference between *captures* rather than
 * between runtimes.
 */
function scene(options: OracleStageOptions): Promise<OracleScene> {
  const key = `${options.side}@${options.page}@${options.skeleton}`;
  const cached = scenes.get(key);
  if (cached) return cached;
  const built = (async (): Promise<OracleScene> => {
    const atlasText = await (await fetch(atlasUrl(options.page))).text();
    const atlas = new TextureAtlas(atlasText);
    const pageImages = new Map<string, HTMLImageElement>();
    let pageImage: HTMLImageElement | null = null;
    for (const page of atlas.pages) {
      const image = await loadImage(`${ASSET_BASE}/${page.name}`);
      pageImage = image;
      pageImages.set(page.name, image);
      if (options.side === 'dom') {
        page.setTexture(new DomTexture(image));
      } else {
        page.setTexture(reference().compat.makeTexture(reference().context, image, page.pma));
      }
    }
    if (!pageImage) throw new Error('the atlas declared no pages');
    const regionImages =
      options.side === 'dom'
        ? await unpackRegions(atlas, pageImages)
        : new Map<string, RegionImage>();
    const data = await loadSkeletonJson(
      { atlas },
      `${ASSET_BASE}/spineboy-${options.skeleton}.json`,
    );
    return { atlas, data, regionImages, pageImage };
  })();
  scenes.set(key, built);
  return built;
}

function parseTint(hex: string | null | undefined): { r: number; g: number; b: number } | null {
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

/**
 * Poses a skeleton. Both sides call this with identical arguments, so any
 * difference in the captures is the renderers' and never the pose's.
 *
 * The last line is the core's own generation seam, read the same way the
 * reference's is — see `src/coreOptional.ts`. Both sides of the oracle go
 * through it, so the two skeletons are posed by one call either way.
 */
function posed(data: SkeletonData, options: OracleStageOptions): Skeleton {
  const skeleton = new Skeleton(data);
  const tint = parseTint(options.tint);
  if (tint) skeleton.color.set(tint.r, tint.g, tint.b, 1);
  skeleton.x = options.offsetX ?? 0;
  const state = new AnimationState(new AnimationStateData(data));
  state.setAnimation(0, options.animation, true);
  state.update(options.time);
  state.apply(skeleton);
  advanceSkeleton(skeleton, options.time);
  return skeleton;
}

const round = (value: number): number => Math.round(value * 100) / 100;

async function drawDom(
  stage: HTMLDivElement,
  scene: OracleScene,
  options: OracleStageOptions,
): Promise<Pick<OracleStageResult, 'imageCount' | 'canvasCount' | 'backendActive' | 'meshesDrawn' | 'contentBox'>> {
  const root = document.createElement('div');
  root.style.cssText =
    `position: absolute; left: ${ORACLE_STAGE.originX}px; top: ${ORACLE_STAGE.originY}px;` +
    `transform-origin: 0 0; transform: scale(${ORACLE_STAGE.scale});`;
  stage.append(root);

  const skeleton = posed(scene.data, options);
  const renderer = new SpineHtmlRenderer(root, scene.regionImages);
  renderer.meshBackend = options.backend ?? 'canvas2d';
  if (options.clipping !== undefined) renderer.clipping = options.clipping;
  // Raster at the resolution the stage shows at, exactly as the demo does.
  renderer.pixelRatio = (window.devicePixelRatio || 1) * ORACLE_STAGE.scale;
  renderer.render(skeleton);
  domLive = renderer;

  const images = [...root.querySelectorAll('img')];
  await Promise.all(images.map((img) => img.decode().catch(() => {})));
  // A freshly decoded bitmap is not yet a settled raster (the cut-rule stage
  // measures chromium raising a scaled image's quality a frame or two in).
  for (let frame = 0; frame < 8; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  const stageBox = stage.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of root.children) {
    const box = el.getBoundingClientRect();
    minX = Math.min(minX, box.left - stageBox.left);
    minY = Math.min(minY, box.top - stageBox.top);
    maxX = Math.max(maxX, box.right - stageBox.left);
    maxY = Math.max(maxY, box.bottom - stageBox.top);
  }

  return {
    imageCount: images.length,
    canvasCount: root.querySelectorAll('canvas').length,
    backendActive: renderer.meshBackendActive,
    meshesDrawn: renderer.meshCount,
    contentBox: {
      x: round(minX),
      y: round(minY),
      width: round(maxX - minX),
      height: round(maxY - minY),
    },
  };
}

async function drawReference(
  stage: HTMLDivElement,
  scene: OracleScene,
  options: OracleStageOptions,
): Promise<Pick<OracleStageResult, 'drawCalls' | 'referenceShape' | 'contentBox'>> {
  const { canvas, context, renderer, compat: seam } = reference();
  stage.append(canvas);

  const gl = context.gl;
  gl.viewport(0, 0, canvas.width, canvas.height);
  const bg = parseTint(ORACLE_STAGE.background.slice(1));
  if (!bg) throw new Error('the stage background is not a 6-digit hex colour');
  gl.clearColor(bg.r, bg.g, bg.b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const camera = renderer.camera;
  camera.viewportWidth = ORACLE_STAGE.width / ORACLE_STAGE.scale;
  camera.viewportHeight = ORACLE_STAGE.height / ORACLE_STAGE.scale;
  camera.position.x = (ORACLE_STAGE.width / 2 - ORACLE_STAGE.originX) / ORACLE_STAGE.scale;
  camera.position.y = (ORACLE_STAGE.originY - ORACLE_STAGE.height / 2) / ORACLE_STAGE.scale;
  camera.position.z = 0;

  const skeleton = posed(scene.data, options);
  const pma = scene.atlas.pages[0]?.pma ?? false;
  renderer.begin();
  seam.drawSkeleton(renderer, skeleton, pma);
  renderer.end();
  const drawCalls = renderer.batcher.getDrawCalls();
  gl.finish();
  // The screenshot is taken by the compositor, so give it the frames the DOM
  // side also gets — same settling, same number of them.
  for (let frame = 0; frame < 8; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  // The reference draws into one canvas, so its "boxes" are that canvas: the
  // spec's stage-containment guard is the DOM side's job, and this keeps the
  // two results one shape.
  return {
    drawCalls,
    referenceShape: seam.shape,
    contentBox: {
      x: 0,
      y: 0,
      width: ORACLE_STAGE.width,
      height: ORACLE_STAGE.height,
    },
  };
}

/**
 * Draws one capture of one runtime into `#oracle-stage`, and returns what the
 * spec needs to know the capture is not vacuous.
 */
export async function oracleStage(options: OracleStageOptions): Promise<OracleStageResult> {
  if (domLive) {
    domLive.dispose();
    domLive = null;
  }
  const built = await scene(options);
  const stage = stageElement();
  stage.replaceChildren();

  const base = {
    coreShape: coreCompatFor(new Skeleton(built.data)).shape,
    side: options.side,
    pagePma: built.atlas.pages[0]?.pma ?? false,
    pageSize: { width: built.pageImage.naturalWidth, height: built.pageImage.naturalHeight },
    imageCount: 0,
    canvasCount: 0,
    backendActive: '',
    meshesDrawn: 0,
    drawCalls: 0,
    referenceShape: '4.3' as const,
    stage: { width: ORACLE_STAGE.width, height: ORACLE_STAGE.height },
    rotatedRegions: built.atlas.regions.filter((region) => region.degrees !== 0).length,
  };

  if (options.side === 'dom') {
    return { ...base, ...(await drawDom(stage, built, options)) };
  }
  return { ...base, ...(await drawReference(stage, built, options)) };
}
