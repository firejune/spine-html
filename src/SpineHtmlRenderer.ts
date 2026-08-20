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
import type { RegionImage } from './DomTexture';

const regionVertices = new Float32Array(8);

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
  /** Canvas kind: current bitmap size, to avoid re-allocating each frame. */
  canvasW: number;
  canvasH: number;
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
 *   to the mesh's world bounding box, redrawn per frame with the standard
 *   per-triangle clip+transform+drawImage mapping.
 *
 * Both element kinds share one stacking context, so draw order interleaves
 * freely via z-index (rear hair canvas < torso img < front hair canvas).
 * Clipping attachments are deliberately unsupported (transparent layered
 * parts make them unnecessary); they are counted in clipSkipCount.
 *
 * Coordinate mapping: Spine is Y-up, CSS is Y-down — world Y is negated.
 * spine-core computes everything (bones, constraints, physics, deformed
 * vertices) on the CPU; this class only draws.
 */
export class SpineHtmlRenderer {
  /** Clipping attachments encountered (visible but unsupported). */
  clipSkipCount = 0;
  /** Mesh canvases drawn last frame. */
  meshCount = 0;
  /** Triangles rasterized last frame. */
  triangleCount = 0;

  private readonly views = new Map<Slot, SlotView>();
  private meshVertices = new Float32Array(256);

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

  render(skeleton: Skeleton): void {
    this.clipSkipCount = 0;
    this.meshCount = 0;
    this.triangleCount = 0;
    const drawOrder = skeleton.drawOrder.appliedPose;
    const skeletonAlpha = skeleton.color.a;

    for (let i = 0, n = drawOrder.length; i < n; i++) {
      const slot = drawOrder[i];
      const pose = slot.appliedPose;
      const attachment = pose.attachment;

      if (!slot.bone.active) {
        this.hide(slot);
        continue;
      }
      if (attachment instanceof RegionAttachment) {
        this.renderRegion(slot, pose, attachment, i, skeletonAlpha);
      } else if (attachment instanceof MeshAttachment) {
        this.renderMesh(skeleton, slot, pose, attachment, i, skeletonAlpha);
      } else {
        if (attachment instanceof ClippingAttachment) this.clipSkipCount++;
        this.hide(slot);
      }
    }
  }

  dispose(): void {
    for (const view of this.views.values()) view.el.remove();
    this.views.clear();
  }

  // --- rigid tier -----------------------------------------------------------

  private renderRegion(
    slot: Slot,
    pose: SlotPose,
    attachment: RegionAttachment,
    zIndex: number,
    skeletonAlpha: number,
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
    img.style.transform = `matrix(${a},${b},${c},${d},${ulx},${uly})`;

    this.applyCommon(view, slot, zIndex, skeletonAlpha * pose.color.a * attachment.color.a);
  }

  // --- deform tier ----------------------------------------------------------

  private renderMesh(
    skeleton: Skeleton,
    slot: Slot,
    pose: SlotPose,
    attachment: MeshAttachment,
    zIndex: number,
    skeletonAlpha: number,
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
    if (this.meshVertices.length < count) this.meshVertices = new Float32Array(count);
    const vertices = this.meshVertices;
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
    // NOTE: 1x backing store for the PoC; the example atlas is 0.5-scale
    // anyway. DPR-aware backing is a follow-up.
    if (view.canvasW !== w || view.canvasH !== h) {
      view.canvasW = w;
      view.canvasH = h;
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.transform = `translate(${minX}px,${minY}px)`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const uvs = sequence.getUVs(sequenceIndex);
    const triangles = attachment.triangles;
    const uw = page.width - 1;
    const uh = page.height - 1;

    for (let t = 0; t < triangles.length; t += 3) {
      const i0 = triangles[t] * 2;
      const i1 = triangles[t + 1] * 2;
      const i2 = triangles[t + 2] * 2;
      this.drawTriangle(
        ctx, page,
        vertices[i0] - minX, vertices[i0 + 1] - minY, uvs[i0] * uw, uvs[i0 + 1] * uh,
        vertices[i1] - minX, vertices[i1 + 1] - minY, uvs[i1] * uw, uvs[i1 + 1] * uh,
        vertices[i2] - minX, vertices[i2 + 1] - minY, uvs[i2] * uw, uvs[i2 + 1] * uh,
      );
    }
    this.meshCount++;
    this.triangleCount += triangles.length / 3;

    this.applyCommon(view, slot, zIndex, skeletonAlpha * pose.color.a * attachment.color.a);
  }

  /**
   * Standard canvas triangle texture mapping (same math as the official
   * spine-canvas renderer): derive the affine that sends the triangle's
   * texture-space corners to its screen-space corners, clip, draw the page.
   * Chromium does not antialias clip paths, so adjacent triangles meet
   * without visible cracks there; overdraw compensation is a follow-up for
   * browsers that do.
   */
  private drawTriangle(
    ctx: CanvasRenderingContext2D, img: HTMLImageElement,
    x0: number, y0: number, u0: number, v0: number,
    x1: number, y1: number, u1: number, v1: number,
    x2: number, y2: number, u2: number, v2: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.closePath();

    x1 -= x0; y1 -= y0;
    x2 -= x0; y2 -= y0;
    u1 -= u0; v1 -= v0;
    u2 -= u0; v2 -= v0;

    let det = u1 * v2 - u2 * v1;
    if (det === 0) return;
    det = 1 / det;

    const a = (v2 * x1 - v1 * x2) * det;
    const b = (v2 * y1 - v1 * y2) * det;
    const c = (u1 * x2 - u2 * x1) * det;
    const d = (u1 * y2 - u2 * y1) * det;
    const e = x0 - a * u0 - c * v0;
    const f = y0 - b * u0 - d * v0;

    ctx.save();
    ctx.transform(a, b, c, d, e, f);
    ctx.clip();
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  // --- shared plumbing -------------------------------------------------------

  private applyCommon(view: SlotView, slot: Slot, zIndex: number, alpha: number): void {
    if (view.zIndex !== zIndex) {
      view.zIndex = zIndex;
      view.el.style.zIndex = String(zIndex);
    }
    // Alpha only; RGB tinting has no cheap DOM equivalent (out of scope).
    if (view.opacity !== alpha) {
      view.opacity = alpha;
      view.el.style.opacity = alpha === 1 ? '' : String(alpha);
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

  private view(slot: Slot, kind: SlotKind): SlotView {
    let view = this.views.get(slot);
    if (view && view.kind !== kind) {
      view.el.remove();
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
        canvasW: 0,
        canvasH: 0,
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
