import {
  RegionAttachment,
  type Skeleton,
  type Slot,
  type TextureAtlasRegion,
} from '@esotericsoftware/spine-core';
import type { RegionImage } from './DomTexture';

const worldVertices = new Float32Array(8);

interface SlotElement {
  img: HTMLImageElement;
  /** Region name currently shown, to skip src rewrites when unchanged. */
  regionName: string;
  visible: boolean;
  zIndex: number;
  opacity: number;
}

/**
 * Renders a spine-core Skeleton as plain DOM: one absolutely-positioned <img>
 * per slot, posed with a single CSS matrix() write per frame. Only region
 * attachments are drawn (the rigid subset); mesh attachments are counted and
 * skipped — they are the deform tier that belongs on a per-part canvas.
 *
 * Coordinate mapping: Spine is Y-up, CSS is Y-down. computeWorldVertices
 * yields the four corners (br, bl, ul, ur) in world space; negating Y and
 * deriving the affine from three corners maps the unpacked region bitmap
 * exactly — no approximation, since bone transforms are affine.
 */
export class SpineHtmlRenderer {
  /** Number of mesh attachments encountered (visible but unsupported). */
  meshSkipCount = 0;

  private readonly slotElements = new Map<Slot, SlotElement>();

  /**
   * @param root Positioned element (e.g. position:absolute) that becomes the
   *   skeleton origin. The renderer only appends slot images to it — layout
   *   and scaling of the root belong to the caller.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly regionImages: Map<string, RegionImage>,
  ) {}

  render(skeleton: Skeleton): void {
    this.meshSkipCount = 0;
    const drawOrder = skeleton.drawOrder.appliedPose;
    const skeletonAlpha = skeleton.color.a;

    for (let i = 0, n = drawOrder.length; i < n; i++) {
      const slot = drawOrder[i];
      const pose = slot.appliedPose;
      const attachment = pose.attachment;

      if (!slot.bone.active || !(attachment instanceof RegionAttachment)) {
        if (attachment && !(attachment instanceof RegionAttachment)) this.meshSkipCount++;
        this.hide(slot);
        continue;
      }

      const sequence = attachment.sequence;
      const region = sequence.regions[sequence.resolveIndex(pose)] as TextureAtlasRegion | null;
      if (!region) {
        this.hide(slot);
        continue;
      }
      const regionImage = this.regionImages.get(region.name);
      if (!regionImage) {
        this.hide(slot);
        continue;
      }

      const el = this.element(slot, regionImage, region.name);

      attachment.computeWorldVertices(slot, attachment.getOffsets(pose), worldVertices, 0, 2);
      // Corner order from spine-core is BL, UL, UR, BR — derived from
      // computeUVs, whose per-vertex UVs are (u,v2), (u,v), (u2,v), (u2,v2).
      // (The br/bl/ul/ur comments inside computeWorldVertices are stale.)
      // Flip Y for CSS (Spine is Y-up).
      const blx = worldVertices[0], bly = -worldVertices[1];
      const ulx = worldVertices[2], uly = -worldVertices[3];
      const urx = worldVertices[4], ury = -worldVertices[5];

      const w = regionImage.width;
      const h = regionImage.height;
      const a = (urx - ulx) / w;
      const b = (ury - uly) / w;
      const c = (blx - ulx) / h;
      const d = (bly - uly) / h;

      el.img.style.transform = `matrix(${a},${b},${c},${d},${ulx},${uly})`;

      if (el.zIndex !== i) {
        el.zIndex = i;
        el.img.style.zIndex = String(i);
      }

      // Alpha only; RGB tinting has no cheap DOM equivalent and is out of
      // scope for the rigid tier.
      const alpha = skeletonAlpha * pose.color.a * attachment.color.a;
      if (el.opacity !== alpha) {
        el.opacity = alpha;
        el.img.style.opacity = alpha === 1 ? '' : String(alpha);
      }

      if (!el.visible) {
        el.visible = true;
        el.img.style.display = '';
      }
    }
  }

  dispose(): void {
    for (const el of this.slotElements.values()) el.img.remove();
    this.slotElements.clear();
  }

  private element(slot: Slot, regionImage: RegionImage, regionName: string): SlotElement {
    let el = this.slotElements.get(slot);
    if (!el) {
      const img = document.createElement('img');
      img.draggable = false;
      img.style.position = 'absolute';
      img.style.left = '0';
      img.style.top = '0';
      img.style.transformOrigin = '0 0';
      img.style.pointerEvents = 'none';
      img.style.userSelect = 'none';
      el = { img, regionName: '', visible: false, zIndex: -1, opacity: 1 };
      el.img.style.display = 'none';
      this.slotElements.set(slot, el);
      this.root.appendChild(img);
    }
    if (el.regionName !== regionName) {
      el.regionName = regionName;
      el.img.src = regionImage.url;
      el.img.width = regionImage.width;
      el.img.height = regionImage.height;
    }
    return el;
  }

  private hide(slot: Slot): void {
    const el = this.slotElements.get(slot);
    if (el && el.visible) {
      el.visible = false;
      el.img.style.display = 'none';
    }
  }
}
