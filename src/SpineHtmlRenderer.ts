import {
  BlendMode,
  ClippingAttachment,
  MeshAttachment,
  RegionAttachment,
  type Sequence,
  type Skeleton,
  type Slot,
  type SlotPose,
  type TextureAtlasRegion,
} from '@esotericsoftware/spine-core';
import type { RegionImage } from './DomTexture.js';
import { getMeshGlBlitter, type MeshBlitJob } from './MeshGlBlitter.js';

/** Rasterizer used for the mesh (deform) tier. */
export type MeshBackend = 'canvas2d' | 'webgl';

const regionVertices = new Float32Array(8);
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Unique tint-filter ids across renderer instances (ids are document-global). */
let tintFilterSeq = 0;
/** Edge length of the throwaway box syncPixelRatio() measures the root with. */
const SCALE_PROBE_PX = 100;
/**
 * Relative change below which syncPixelRatio() leaves `pixelRatio` alone.
 * Layout reads are quantized (1/64 px in Blink), so a 100 px probe carries
 * ~0.016% of measurement noise — 6× under this band, which in turn is 10×
 * under the smallest zoom step a UI realistically takes (1%). Inside the band
 * the sampling error is worth ~0.2% of backing pixels; outside it, a rewrite
 * of `pixelRatio` recreates every mesh canvas's GPU surface.
 */
const PIXEL_RATIO_DEADBAND = 1e-3;

/** Push a point away from (cx, cy) by `amount` pixels. */
function expandPoint(x: number, y: number, cx: number, cy: number, amount: number): [number, number] {
  const dx = x - cx;
  const dy = y - cy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return [x, y];
  const s = amount / len;
  return [x + dx * s, y + dy * s];
}

type SlotKind = 'image' | 'canvas';

interface SlotView {
  kind: SlotKind;
  el: HTMLImageElement | HTMLCanvasElement;
  /** Region name currently shown (image kind), to skip src rewrites. */
  regionName: string;
  visible: boolean;
  zIndex: number;
  opacity: number;
  blendMode: BlendMode;
  /** Last transform string written, to skip no-op style writes. */
  transform: string;
  /** Current RGB tint; (1,1,1) means untinted (no filter applied). */
  tintR: number;
  tintG: number;
  tintB: number;
  /** Lazily created SVG reference filter for non-white tints. */
  tintId: string;
  tintMatrix: SVGFEColorMatrixElement | null;
  /** Canvas kind: allocated backing-store size (grow-only, quantized). */
  canvasW: number;
  canvasH: number;
  /** Canvas kind: pixelRatio the backing/CSS sizing was computed with. */
  meshRatio: number;
  /** Canvas kind: shape signature of the last raster, for dirty-skipping. */
  meshAttachment: MeshAttachment | null;
  meshSequenceIndex: number;
  meshExpand: number;
  meshVertexCount: number;
  /** Backend that produced the last raster — a backend switch re-dirties. */
  meshBackendDrawn: MeshBackend | '';
  /**
   * Canvas-space (bbox-relative) vertices of the last raster. Float64: the
   * compared values are f64 (f32 world vertex minus integer bbox origin);
   * storing them as f32 would round some of them and leave those meshes
   * permanently "dirty".
   */
  meshVertices: Float64Array;
}

const BLEND_CSS: Record<BlendMode, string> = {
  [BlendMode.Normal]: '',
  [BlendMode.Additive]: 'plus-lighter',
  [BlendMode.Multiply]: 'multiply',
  [BlendMode.Screen]: 'screen',
};

/**
 * Renders a spine-core Skeleton as DOM, split by slot type:
 *
 * - Region attachments (rigid parts) become one absolutely-positioned <img>
 *   posed with a single CSS matrix() write per frame — exact, since bone
 *   transforms are affine.
 * - Mesh attachments (deform parts) each get a small per-part <canvas> sized
 *   to the mesh's world bounding box, redrawn per frame — either with the
 *   standard per-triangle clip+transform+drawImage mapping (default), or via
 *   a shared offscreen WebGL canvas that rect-blits into the same per-part
 *   canvases (meshBackend = 'webgl'). Frames where the canvas-space vertices
 *   are unchanged reuse the previous raster on both backends.
 *
 * Both element kinds share one stacking context, so draw order interleaves
 * freely via z-index (rear hair canvas < torso img < front hair canvas).
 * RGB tint (skeleton × slot × attachment color) is applied per element with
 * an SVG feColorMatrix reference filter — exact channel multiply, works the
 * same on <img> and <canvas>. Dark (two-color) tint is not expressible that
 * way and is unsupported. Clipping attachments are deliberately unsupported
 * (transparent layered parts make them unnecessary); they are counted in
 * clipSkipCount.
 *
 * Coordinate mapping: Spine is Y-up, CSS is Y-down — world Y is negated.
 * spine-core computes everything (bones, constraints, physics, deformed
 * vertices) on the CPU; this class only draws.
 */
export class SpineHtmlRenderer {
  /** Clipping attachments encountered (visible but unsupported). */
  clipSkipCount = 0;
  /** Mesh canvases rasterized last frame. */
  meshCount = 0;
  /** Mesh canvases that reused their previous raster last frame. */
  meshReuseCount = 0;
  /**
   * Mesh canvas backing stores (re)allocated last frame. Should drop to zero
   * once an animation reaches its steady state; a persistent nonzero value
   * means GPU surfaces are being recreated per frame (a Safari killer).
   */
  canvasReallocCount = 0;
  /** Triangles rasterized last frame. */
  triangleCount = 0;
  /**
   * How far (px) each triangle's clip polygon is expanded from its centroid.
   * Closes antialiased-clip cracks between adjacent triangles (Safari);
   * set to 0 to see them.
   */
  triangleExpand = 0.5;
  /**
   * Mesh-canvas backing-store pixels per CSS pixel. Defaults to the device
   * pixel ratio. If the caller scales the root element, fold that scale in
   * (e.g. devicePixelRatio * rootScale) so the raster matches the on-screen
   * resolution instead of over- or under-sampling — syncPixelRatio() measures
   * that scale and folds it in for you.
   */
  pixelRatio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  /**
   * Rasterizer for the mesh (deform) tier. 'canvas2d' (default) maps each
   * triangle with clip+transform+drawImage directly on the per-part canvas.
   * 'webgl' rasterizes every dirty mesh into one shared offscreen WebGL
   * canvas and rect-blits each mesh back onto its per-part canvas — the DOM
   * structure and all element-level behavior (z-index interleave, tint
   * filter, mix-blend-mode, dirty-skip) are identical, only the raster step
   * changes. Motivation: Safari antialiases canvas2d clip paths, so the
   * per-triangle clip mapping pays a per-triangle AA-mask cost in the GPU
   * process that rAF-limits heavy scenes; GL rasterizes shared edges
   * seamlessly (no clip, no crack overdraw) and the blit is an unclipped
   * rect copy. Falls back to 'canvas2d' when WebGL is unavailable or the
   * shared context is lost — see meshBackendActive.
   */
  meshBackend: MeshBackend = 'canvas2d';
  /** Backend that actually rasterized the mesh tier during the last render(). */
  meshBackendActive: MeshBackend = 'canvas2d';

  private readonly views = new Map<Slot, SlotView>();
  private readonly pendingJobs: MeshBlitJob[] = [];
  private readonly pendingViews: SlotView[] = [];
  /**
   * Atlas page images this renderer has retained from the shared blitter,
   * one retain each. Allocated on the first webgl mesh job, so a renderer
   * that never leaves canvas2d holds nothing and gives nothing back.
   */
  private glPages: Set<HTMLImageElement> | null = null;
  private scratchVertices = new Float32Array(256);
  private tintDefs: SVGSVGElement | null = null;

  /**
   * @param root Positioned element (e.g. position:absolute) that becomes the
   *   skeleton origin. The renderer only appends slot elements to it — layout
   *   and scaling of the root belong to the caller.
   * @param regionImages Unpacked per-region bitmaps (for the rigid tier).
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly regionImages: Map<string, RegionImage>,
  ) {}

  /**
   * Backing-store pixels currently allocated across the mesh canvases
   * (Σ width × height). Computed on demand from the views — nothing is
   * tracked per frame — so reading it is cheap but not free; the demo reads it
   * with the other counters, twice a second.
   *
   * This is the quantity `pixelRatio` moves quadratically, and the one that
   * makes an oversampling stage visible before the frame rate does: a root
   * scaled down by CSS without that scale folded into `pixelRatio` holds
   * 1/scale² of the backing it needs. Hidden slots are included — their
   * canvases keep their allocation.
   */
  get meshBackingPixels(): number {
    let total = 0;
    for (const view of this.views.values()) {
      if (view.kind === 'canvas') total += view.canvasW * view.canvasH;
    }
    return total;
  }

  /**
   * Re-derives `pixelRatio` from the root's effective on-screen scale, so the
   * mesh tier rasters at the resolution the screen actually shows.
   *
   * Mesh canvases are sized in the root's own coordinates, and a CSS transform
   * anywhere above the root — the natural way to build a pan/zoom stage is
   * `transform: scale(zoom)` on an ancestor — rescales them on screen without
   * the renderer seeing it. At zoom z the raster is then oversampled by 1/z per
   * axis, 1/z² in backing pixels: GPU memory and fill rate, not correctness.
   * This folds the measured scale in, `devicePixelRatio × scale`.
   *
   * One layout read per call. The root itself is usually 0×0 (slot elements are
   * absolutely positioned and posed by transforms), so there is no box to
   * measure: a hidden 100×100 px child is appended, measured once with
   * getBoundingClientRect(), and removed again — nothing of it is left behind.
   * It cannot disturb the slot elements either: they interleave by z-index,
   * which applyCommon() writes explicitly on every visible one, so DOM order is
   * not what orders them; and the probe is `visibility: hidden` and gone before
   * anything can paint.
   *
   * The scale is the larger axis of the measured box. An ancestor rotation
   * inflates that axis-aligned box, so the ratio errs high — the safe side:
   * oversampling costs pixels, undersampling costs picture.
   *
   * A move smaller than 0.1% (see PIXEL_RATIO_DEADBAND) changes nothing, and a
   * root that is not laid out (a `display: none` ancestor — the probe measures
   * 0) changes nothing either. Both matter because writing `pixelRatio`
   * reallocates every mesh canvas on the next frame.
   *
   * The renderer never calls this itself. It is a forced synchronous layout,
   * which has no business in a render path — and there is no per-frame layout
   * read anywhere in this class. Call it when a zoom or a layout settles: after
   * a wheel/pinch gesture ends, on a debounced resize, not during the drag.
   *
   * @returns the pixel ratio now in effect (the current one if nothing moved).
   */
  syncPixelRatio(): number {
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.left = '0';
    probe.style.top = '0';
    probe.style.width = `${SCALE_PROBE_PX}px`;
    probe.style.height = `${SCALE_PROBE_PX}px`;
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    this.root.appendChild(probe);
    let width = 0;
    let height = 0;
    try {
      const rect = probe.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
    } finally {
      probe.remove();
    }

    const scale = Math.max(width, height) / SCALE_PROBE_PX;
    // Not laid out (display:none ancestor, detached root): no measurement, so
    // no decision — keep whatever the caller has.
    if (!(scale > 0)) return this.pixelRatio;

    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const next = dpr * scale;
    const current = this.pixelRatio;
    if (current > 0 && Math.abs(next - current) < current * PIXEL_RATIO_DEADBAND) return current;
    this.pixelRatio = next;
    return next;
  }

  render(skeleton: Skeleton): void {
    this.clipSkipCount = 0;
    this.meshCount = 0;
    this.meshReuseCount = 0;
    this.canvasReallocCount = 0;
    this.triangleCount = 0;
    const blitter = this.meshBackend === 'webgl' ? getMeshGlBlitter() : null;
    this.meshBackendActive = blitter ? 'webgl' : 'canvas2d';
    const drawOrder = skeleton.drawOrder.appliedPose;

    for (let i = 0, n = drawOrder.length; i < n; i++) {
      const slot = drawOrder[i];
      const pose = slot.appliedPose;
      const attachment = pose.attachment;

      if (!slot.bone.active) {
        this.hide(slot);
        continue;
      }
      if (attachment instanceof RegionAttachment) {
        this.renderRegion(skeleton, slot, pose, attachment, i);
      } else if (attachment instanceof MeshAttachment) {
        this.renderMesh(skeleton, slot, pose, attachment, i);
      } else {
        if (attachment instanceof ClippingAttachment) this.clipSkipCount++;
        this.hide(slot);
      }
    }

    if (this.pendingJobs.length) {
      if (!blitter || !blitter.flush(this.pendingJobs)) {
        // Context lost mid-frame: rasterize this batch on the 2d path so the
        // frame stays complete; the next render() re-selects the backend.
        for (let i = 0; i < this.pendingJobs.length; i++) {
          const job = this.pendingJobs[i];
          this.pendingViews[i].meshBackendDrawn = 'canvas2d';
          this.rasterizeMesh2d(job.canvas, job.page, job.vertices, job.uvs, job.triangles, job.ratio);
        }
      }
      this.pendingJobs.length = 0;
      this.pendingViews.length = 0;
    }
  }

  /**
   * Removes every element this renderer added to the root (slot elements and
   * the tint filter defs), and hands the atlas pages it uploaded back to the
   * shared GL blitter — the one resource here that outlives the instance, so
   * the one that has to be given back explicitly (GPU memory, and no garbage
   * collector feels pressure from it). The pages are reference-counted there:
   * a page another live renderer still draws stays uploaded, and the texture
   * is deleted only when the last user of it is disposed.
   *
   * The region bitmaps are deliberately untouched: the map is the caller's,
   * and one map is normally shared by many renderers (disposing one instance
   * must not blind the others). Free the unpacked blob URLs with
   * revokeRegions() once no renderer needs them.
   *
   * Idempotent: the retained-page ledger is cleared here, so a second call
   * releases nothing a second time.
   */
  dispose(): void {
    for (const view of this.views.values()) view.el.remove();
    this.views.clear();
    this.tintDefs?.remove();
    this.tintDefs = null;
    if (this.glPages) {
      const blitter = getMeshGlBlitter();
      if (blitter) for (const page of this.glPages) blitter.release(page);
      this.glPages = null;
    }
  }

  // --- rigid tier -----------------------------------------------------------

  private renderRegion(
    skeleton: Skeleton,
    slot: Slot,
    pose: SlotPose,
    attachment: RegionAttachment,
    zIndex: number,
  ): void {
    const sequence = attachment.sequence;
    const region = sequence.regions[sequence.resolveIndex(pose)] as TextureAtlasRegion | null;
    const regionImage = region && this.regionImages.get(region.name);
    if (!regionImage) {
      this.hide(slot);
      return;
    }

    const view = this.view(slot, 'image');
    const img = view.el as HTMLImageElement;
    if (view.regionName !== region.name) {
      view.regionName = region.name;
      img.src = regionImage.url;
      img.width = regionImage.width;
      img.height = regionImage.height;
    }

    attachment.computeWorldVertices(slot, attachment.getOffsets(pose), regionVertices, 0, 2);
    // Corner order from spine-core is BL, UL, UR, BR — derived from
    // computeUVs, whose per-vertex UVs are (u,v2), (u,v), (u2,v), (u2,v2).
    // (The br/bl/ul/ur comments inside computeWorldVertices are stale.)
    // Flip Y for CSS (Spine is Y-up).
    const blx = regionVertices[0], bly = -regionVertices[1];
    const ulx = regionVertices[2], uly = -regionVertices[3];
    const urx = regionVertices[4], ury = -regionVertices[5];

    const w = regionImage.width;
    const h = regionImage.height;
    const a = (urx - ulx) / w;
    const b = (ury - uly) / w;
    const c = (blx - ulx) / h;
    const d = (bly - uly) / h;
    this.setTransform(view, `matrix(${a},${b},${c},${d},${ulx},${uly})`);

    this.applyCommon(view, slot, pose, attachment.color, skeleton, zIndex);
  }

  // --- deform tier ----------------------------------------------------------

  private renderMesh(
    skeleton: Skeleton,
    slot: Slot,
    pose: SlotPose,
    attachment: MeshAttachment,
    zIndex: number,
  ): void {
    const sequence: Sequence = attachment.sequence;
    const sequenceIndex = sequence.resolveIndex(pose);
    const region = sequence.regions[sequenceIndex] as TextureAtlasRegion | null;
    const page = region?.texture?.getImage() as HTMLImageElement | undefined;
    if (!page) {
      this.hide(slot);
      return;
    }

    const count = attachment.worldVerticesLength;
    if (this.scratchVertices.length < count) this.scratchVertices = new Float32Array(count);
    const vertices = this.scratchVertices;
    attachment.computeWorldVertices(skeleton, slot, 0, count, vertices, 0, 2);

    // World bounds (in CSS coords: Y negated).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let v = 0; v < count; v += 2) {
      const x = vertices[v];
      const y = -vertices[v + 1];
      vertices[v + 1] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = 1;
    minX = Math.floor(minX) - pad;
    minY = Math.floor(minY) - pad;
    const w = Math.ceil(maxX) + pad - minX;
    const h = Math.ceil(maxY) + pad - minY;
    if (w <= 0 || h <= 0) {
      this.hide(slot);
      return;
    }

    const view = this.view(slot, 'canvas');
    const canvas = view.el as HTMLCanvasElement;
    const ratio = this.pixelRatio;
    let dirty =
      view.meshAttachment !== attachment ||
      view.meshSequenceIndex !== sequenceIndex ||
      view.meshExpand !== this.triangleExpand ||
      view.meshVertexCount !== count ||
      view.meshBackendDrawn !== this.meshBackendActive;
    // The backing store only grows, in 32-device-px steps. Setting
    // canvas.width recreates the GPU surface, and a deforming mesh changes
    // its bbox every frame — reallocating every mesh canvas per frame
    // stalled real Safari to ~3 fps while the JS split showed ~4 ms (the
    // cost lives in the compositor, invisible to in-callback timing). With
    // grow-only quantized backing, steady-state animation reallocates
    // nothing. A pixelRatio change is the one exception to grow-only: it
    // reallocates every mesh canvas anyway, so the new size comes from the
    // new need alone. Keeping the old size as a floor there would make a
    // ratio *drop* pay the reallocation and keep every oversized pixel — the
    // backing would never come back down to what that ratio needs. The CSS
    // size mirrors the whole backing so the pixel mapping stays 1:1; the mesh
    // draws into the top-left w×h logical region and the rest stays
    // transparent.
    const needW = Math.max(1, Math.round(w * ratio));
    const needH = Math.max(1, Math.round(h * ratio));
    const ratioChanged = view.meshRatio !== ratio;
    if (needW > view.canvasW || needH > view.canvasH || ratioChanged) {
      // 25% slack: at low fps the animation is sampled sparsely, so new bbox
      // maxima keep being discovered for many seconds — allocate ahead of the
      // curve instead of chasing it.
      const step = 32;
      const floorW = ratioChanged ? 0 : view.canvasW;
      const floorH = ratioChanged ? 0 : view.canvasH;
      view.canvasW = Math.ceil(Math.max(needW * 1.25, floorW) / step) * step;
      view.canvasH = Math.ceil(Math.max(needH * 1.25, floorH) / step) * step;
      view.meshRatio = ratio;
      canvas.width = view.canvasW;
      canvas.height = view.canvasH;
      canvas.style.width = `${view.canvasW / ratio}px`;
      canvas.style.height = `${view.canvasH / ratio}px`;
      this.canvasReallocCount++;
      dirty = true;
    }

    // Canvas-space vertices: identical values mean last frame's raster is
    // still exact (static pose, or the part moved by whole pixels), so the
    // per-triangle redraw can be skipped — the CSS translate below keeps
    // tracking the part. This is the main WebKit cost lever: idle skeletons
    // stop paying the raster entirely.
    if (view.meshVertices.length < count) {
      view.meshVertices = new Float64Array(count);
      dirty = true;
    }
    const rel = view.meshVertices;
    for (let v = 0; v < count; v += 2) {
      const x = vertices[v] - minX;
      const y = vertices[v + 1] - minY;
      if (rel[v] !== x || rel[v + 1] !== y) dirty = true;
      rel[v] = x;
      rel[v + 1] = y;
    }

    this.setTransform(view, `translate(${minX}px,${minY}px)`);

    if (!dirty) {
      this.meshReuseCount++;
    } else {
      view.meshAttachment = attachment;
      view.meshSequenceIndex = sequenceIndex;
      view.meshExpand = this.triangleExpand;
      view.meshVertexCount = count;
      view.meshBackendDrawn = this.meshBackendActive;

      const uvs = sequence.getUVs(sequenceIndex);
      const triangles = attachment.triangles;
      if (this.meshBackendActive === 'webgl') {
        // Queued, not drawn: render() flushes the whole batch through the
        // shared GL context once the slot loop is done. `rel` is this view's
        // own signature array — nothing mutates it before the flush.
        this.pendingJobs.push({
          canvas,
          page,
          vertices: rel,
          uvs,
          triangles,
          ratio,
          width: Math.min(view.canvasW, Math.ceil(w * ratio)),
          height: Math.min(view.canvasH, Math.ceil(h * ratio)),
        });
        this.pendingViews.push(view);
        this.retainPage(page);
      } else {
        this.rasterizeMesh2d(canvas, page, rel, uvs, triangles, ratio);
      }
      this.meshCount++;
      this.triangleCount += triangles.length / 3;
    }

    this.applyCommon(view, slot, pose, attachment.color, skeleton, zIndex);
  }

  /**
   * Declares this renderer a user of `page` with the shared blitter, once per
   * page — the counterpart of the release in dispose(). The set is this
   * renderer's own ledger, so sharing one page across renderers works by
   * counting rather than by guessing. On the render path this costs one
   * Set.has per queued mesh job and allocates nothing after the first page.
   */
  private retainPage(page: HTMLImageElement): void {
    const pages = (this.glPages ??= new Set<HTMLImageElement>());
    if (pages.has(page)) return;
    // Null only if the context died between the backend pick and here; the
    // flush then fails too and the batch falls back to canvas2d.
    const blitter = getMeshGlBlitter();
    if (!blitter) return;
    pages.add(page);
    blitter.retain(page);
  }

  /** The canvas2d raster path: clear the backing, map each triangle. */
  private rasterizeMesh2d(
    canvas: HTMLCanvasElement,
    page: HTMLImageElement,
    vertices: Float64Array,
    uvs: ArrayLike<number>,
    triangles: ArrayLike<number>,
    ratio: number,
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Clear the full backing: the previous frame's bbox (and so its drawn
    // region) may have been larger than today's.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Texel addressing, shared with the GL blitter: a normalized UV maps to
    // `uv * size` in the continuous texture frame where the page spans
    // [0, size] and texel i covers [i, i+1). drawImage-under-a-transform and
    // texture2D() both read that frame, so both backends land on the same
    // source pixels. (No half-texel term: the affine below *maps* corners, it
    // does not sample — see drawTriangle.)
    const uw = page.width;
    const uh = page.height;
    for (let t = 0; t < triangles.length; t += 3) {
      const i0 = triangles[t] * 2;
      const i1 = triangles[t + 1] * 2;
      const i2 = triangles[t + 2] * 2;
      this.drawTriangle(
        ctx, page,
        vertices[i0], vertices[i0 + 1], uvs[i0] * uw, uvs[i0 + 1] * uh,
        vertices[i1], vertices[i1 + 1], uvs[i1] * uw, uvs[i1 + 1] * uh,
        vertices[i2], vertices[i2 + 1], uvs[i2] * uw, uvs[i2 + 1] * uh,
      );
    }
  }

  /**
   * Standard canvas triangle texture mapping (same math as the official
   * spine-canvas renderer): derive the affine that sends the triangle's
   * texture-space corners to its screen-space corners, clip, draw the page —
   * but only the part of the page this triangle can show (see below).
   *
   * The clip polygon is expanded outward from the centroid by a fraction of
   * a pixel. Browsers that antialias clip paths (Safari) otherwise leave
   * hairline cracks between adjacent triangles; the expanded clips overlap
   * into the neighbouring triangle, and since the texture is continuous
   * across the shared edge the overlap draws the same pixels — cracks close
   * with no visible cost. The texture-mapping affine itself stays exact.
   *
   * ## Why a source sub-rect instead of the whole page
   *
   * The draw is a 9-argument `drawImage` whose source rect covers exactly what
   * the clip can reveal, placed at the same texture-space position, so the
   * mapping is identical to drawing the whole page — the same affine, the same
   * texels, only fewer of them offered to the rasterizer.
   *
   * That is not an optimization. Linux WebKit — the software rasterizer, the
   * only engine this has been observed on; Chromium and macOS WebKit never show
   * it — garbles individual triangles when the whole page is drawn under a
   * steep per-triangle affine: read off the parity dump, head/goggles/foot
   * triangles land with displaced texture while the webgl capture of the same
   * pose stays clean. Switching this one call to a source sub-rect — the only
   * variable changed — took that platform's bad-pixel counts from 1042 to 2
   * (hoverboard), 231 to 4 (portal) and 803 to 3 (walk + tint), and left every
   * Chromium capture byte-identical. [measured on the ubuntu CI runner through
   * PARITY_DUMP: first with a fixed 2-texel pad (run 35209262693), then with
   * the derived rect below — the same counts (run 35213286993).] WHY that
   * rasterizer garbles the whole-page form is not identified; steep affines
   * making whole-page coordinates large is a suspicion, not a measurement. The
   * sub-rect sidesteps it. (Moving `clip()` before `transform()` was tried as a
   * separate one-variable experiment: every number came back identical, so the
   * clip path is not the cause.)
   *
   * ## How the sub-rect is derived
   *
   * It must provably cover everything the clip can reveal, which is the
   * *expanded* polygon, not the triangle. So each clip corner's canvas-space
   * displacement is pushed back through the inverse of the 2×2 affine into
   * texture space, the bounding box is taken over the displaced corners, one
   * texel of bilinear support is added, and the result is floor/ceil'd to texel
   * boundaries (so the sub-rect itself resamples nothing) and clamped to the
   * page. A fixed pad would not do: the texture-space reach of the expansion is
   * `triangleExpand` times the local texels-per-canvas-unit, which on the
   * demo's own meshes ranges from ~0.26 texels on a typical triangle to ~8.6 on
   * a foreshortened one. Under-padding lets the rim of the overdraw sample
   * nothing, which brings back the very seams the overdraw exists to close.
   *
   * No half-texel offset is applied to the incoming u/v: the `(i + 0.5) / size`
   * texel-centre convention belongs to *sampling* (landing inside the intended
   * texel instead of on a filter boundary). This solves for the affine that
   * sends three source corners to three destination corners; the rasterizer
   * then samples continuously along that map. Biasing all three corners by
   * half a texel would translate the texture against the geometry — the very
   * class of offset the `uv * size` addressing removes.
   */
  private drawTriangle(
    ctx: CanvasRenderingContext2D, img: HTMLImageElement,
    x0: number, y0: number, u0: number, v0: number,
    x1: number, y1: number, u1: number, v1: number,
    x2: number, y2: number, u2: number, v2: number,
  ): void {
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const expand = this.triangleExpand;
    const [px0, py0] = expandPoint(x0, y0, cx, cy, expand);
    const [px1, py1] = expandPoint(x1, y1, cx, cy, expand);
    const [px2, py2] = expandPoint(x2, y2, cx, cy, expand);
    ctx.beginPath();
    ctx.moveTo(px0, py0);
    ctx.lineTo(px1, py1);
    ctx.lineTo(px2, py2);
    ctx.closePath();

    // Edge vectors, in canvas space and in texture space.
    const ex1 = x1 - x0, ey1 = y1 - y0;
    const ex2 = x2 - x0, ey2 = y2 - y0;
    const eu1 = u1 - u0, ev1 = v1 - v0;
    const eu2 = u2 - u0, ev2 = v2 - v0;

    let det = eu1 * ev2 - eu2 * ev1;
    if (det === 0) return;
    det = 1 / det;

    const a = (ev2 * ex1 - ev1 * ex2) * det;
    const b = (ev2 * ey1 - ev1 * ey2) * det;
    const c = (eu1 * ex2 - eu2 * ex1) * det;
    const d = (eu1 * ey2 - eu2 * ey1) * det;
    const e = x0 - a * u0 - c * v0;
    const f = y0 - b * u0 - d * v0;

    // Texture-space bounds of the clip polygon. The triangle's own corners
    // first, then the three expansion offsets carried back through the inverse
    // of [[a, c], [b, d]] — the clip reaches exactly that far and no further.
    let minU = Math.min(u0, u1, u2);
    let maxU = Math.max(u0, u1, u2);
    let minV = Math.min(v0, v1, v2);
    let maxV = Math.max(v0, v1, v2);
    const detM = a * d - b * c;
    if (detM !== 0) {
      const im = 1 / detM;
      const ia = d * im, ic = -c * im, ib = -b * im, id = a * im;
      let gx = px0 - x0, gy = py0 - y0;
      let tu = u0 + ia * gx + ic * gy, tv = v0 + ib * gx + id * gy;
      minU = Math.min(minU, tu); maxU = Math.max(maxU, tu);
      minV = Math.min(minV, tv); maxV = Math.max(maxV, tv);
      gx = px1 - x1; gy = py1 - y1;
      tu = u1 + ia * gx + ic * gy; tv = v1 + ib * gx + id * gy;
      minU = Math.min(minU, tu); maxU = Math.max(maxU, tu);
      minV = Math.min(minV, tv); maxV = Math.max(maxV, tv);
      gx = px2 - x2; gy = py2 - y2;
      tu = u2 + ia * gx + ic * gy; tv = v2 + ib * gx + id * gy;
      minU = Math.min(minU, tu); maxU = Math.max(maxU, tu);
      minV = Math.min(minV, tv); maxV = Math.max(maxV, tv);
    }
    // One texel of bilinear support on every side, snapped outward to texel
    // boundaries, clamped to the page. Source rect and destination rect are the
    // same rect in texture space, so the affine below maps it exactly as it
    // mapped the whole page.
    const sx = Math.max(0, Math.floor(minU - 1));
    const sy = Math.max(0, Math.floor(minV - 1));
    const sw = Math.min(img.width, Math.ceil(maxU + 1)) - sx;
    const sh = Math.min(img.height, Math.ceil(maxV + 1)) - sy;
    if (!(sw > 0) || !(sh > 0)) return;

    ctx.save();
    ctx.transform(a, b, c, d, e, f);
    ctx.clip();
    ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
    ctx.restore();
  }

  // --- shared plumbing -------------------------------------------------------

  private setTransform(view: SlotView, transform: string): void {
    if (view.transform !== transform) {
      view.transform = transform;
      view.el.style.transform = transform;
    }
  }

  private applyCommon(
    view: SlotView,
    slot: Slot,
    pose: SlotPose,
    attachmentColor: { r: number; g: number; b: number; a: number },
    skeleton: Skeleton,
    zIndex: number,
  ): void {
    const sc = skeleton.color;
    const pc = pose.color;
    if (view.zIndex !== zIndex) {
      view.zIndex = zIndex;
      view.el.style.zIndex = String(zIndex);
    }
    const alpha = sc.a * pc.a * attachmentColor.a;
    if (view.opacity !== alpha) {
      view.opacity = alpha;
      view.el.style.opacity = alpha === 1 ? '' : String(alpha);
    }
    // RGB tint (uniform per slot) rides an feColorMatrix reference filter:
    // scaling the channels is an exact multiply, applies to <img> and
    // <canvas> alike, and never touches the raster. Needs reference-filter
    // support (Safari 15+).
    const r = sc.r * pc.r * attachmentColor.r;
    const g = sc.g * pc.g * attachmentColor.g;
    const b = sc.b * pc.b * attachmentColor.b;
    if (view.tintR !== r || view.tintG !== g || view.tintB !== b) {
      view.tintR = r;
      view.tintG = g;
      view.tintB = b;
      if (r === 1 && g === 1 && b === 1) {
        view.el.style.filter = '';
      } else {
        this.tintMatrixFor(view).setAttribute(
          'values',
          `${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0`,
        );
        view.el.style.filter = `url(#${view.tintId})`;
      }
    }
    const blendMode = slot.data.blendMode;
    if (view.blendMode !== blendMode) {
      view.blendMode = blendMode;
      view.el.style.mixBlendMode = BLEND_CSS[blendMode];
    }
    if (!view.visible) {
      view.visible = true;
      view.el.style.display = '';
    }
  }

  private tintMatrixFor(view: SlotView): SVGFEColorMatrixElement {
    if (view.tintMatrix) return view.tintMatrix;
    if (!this.tintDefs) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      this.root.appendChild(svg);
      this.tintDefs = svg;
    }
    const filter = document.createElementNS(SVG_NS, 'filter');
    view.tintId = `spine-html-tint-${tintFilterSeq++}`;
    filter.setAttribute('id', view.tintId);
    // Filter math must happen in sRGB to match Spine's color multiply
    // (SVG filters default to linearRGB).
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const matrix = document.createElementNS(SVG_NS, 'feColorMatrix');
    matrix.setAttribute('in', 'SourceGraphic');
    matrix.setAttribute('type', 'matrix');
    filter.appendChild(matrix);
    this.tintDefs.appendChild(filter);
    view.tintMatrix = matrix;
    return matrix;
  }

  private view(slot: Slot, kind: SlotKind): SlotView {
    let view = this.views.get(slot);
    if (view && view.kind !== kind) {
      view.el.remove();
      view.tintMatrix?.parentElement?.remove();
      view = undefined;
    }
    if (!view) {
      const el = kind === 'image' ? document.createElement('img') : document.createElement('canvas');
      if (el instanceof HTMLImageElement) el.draggable = false;
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.top = '0';
      el.style.transformOrigin = '0 0';
      el.style.pointerEvents = 'none';
      el.style.userSelect = 'none';
      el.style.display = 'none';
      view = {
        kind,
        el,
        regionName: '',
        visible: false,
        zIndex: -1,
        opacity: 1,
        blendMode: BlendMode.Normal,
        transform: '',
        tintR: 1,
        tintG: 1,
        tintB: 1,
        tintId: '',
        tintMatrix: null,
        canvasW: 0,
        canvasH: 0,
        meshRatio: -1,
        meshAttachment: null,
        meshSequenceIndex: -1,
        meshExpand: -1,
        meshVertexCount: -1,
        meshBackendDrawn: '',
        meshVertices: new Float64Array(0),
      };
      this.views.set(slot, view);
      this.root.appendChild(el);
    }
    return view;
  }

  private hide(slot: Slot): void {
    const view = this.views.get(slot);
    if (view && view.visible) {
      view.visible = false;
      view.el.style.display = 'none';
    }
  }
}
