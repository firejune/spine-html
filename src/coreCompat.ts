import type {
  Attachment,
  Bone,
  ClippingAttachment,
  MeshAttachment,
  RegionAttachment,
  Skeleton,
  Slot,
  SlotPose,
  TextureAtlasRegion,
  VertexAttachment,
} from '@esotericsoftware/spine-core';

/**
 * The one place that knows which spine-core generation is installed.
 *
 * ## Why this exists
 *
 * A Spine runtime is locked to the editor version that exported the data:
 * spine-core 4.3 will not read most 4.2 exports, and — worse than a clean
 * failure — an older export that *does* parse under it loads **zero** of its
 * constraints, because 4.3 reads one top-level `constraints` array where 4.2
 * and older write separate `ik`/`transform`/`path`/`physics` ones. So
 * "supporting 4.2 data" cannot mean converting anything: it means the consumer
 * installs the spine-core that matches their editor, and this package draws
 * from whichever one that is. spine-core is a peer dependency precisely so that
 * choice is the consumer's.
 *
 * ## What the two shapes are
 *
 * 4.3 split every animatable object into data + poses: `Skeleton.drawOrder`
 * became a `DrawOrder` carrying an `appliedPose`, a slot's current attachment
 * and colour moved onto a `SlotPose`, a bone's world transform onto a
 * `BonePose`, and a region attachment's per-frame UVs and vertex offsets onto
 * the `Sequence`. Everything this renderer reads is one of those. Before 4.3
 * the same values sit directly on the `Slot`, the `Bone` and the attachment —
 * so the **pre-pose shape needs no wrapper object at all**: a `Slot` *is* its
 * own pose view and a `Bone` *is* its own bone-pose view. That is what keeps
 * the seam free of per-frame allocation.
 *
 * ## How the shape is chosen
 *
 * Once per renderer, by looking at the live objects ({@link coreCompatFor}) —
 * never per slot by try/catch, and never by reading a version string, which a
 * bundled, patched or vendored copy need not carry. The result is one of the
 * two tables below, so a render loop pays one property load per call and
 * allocates nothing.
 *
 * ## What this package still compiles against
 *
 * 4.3, and only 4.3 — `@esotericsoftware/spine-core` stays a single
 * devDependency and `dist/*.d.ts` keeps describing 4.3 types. The pre-pose
 * shape is described by the small structural interfaces below and reached
 * through the casts in this file, so nothing untyped leaves it. Older columns
 * of the CI matrix therefore build with vite and skip `tsc --noEmit`: an older
 * core's `.d.ts` cannot satisfy code written against 4.3, and is not supposed
 * to. Which minors are supported is decided by that matrix and recorded in
 * `peerDependencies`; see README.md.
 */

/**
 * What the renderer reads off a slot's current pose.
 *
 * Deliberately structural rather than 4.3's `SlotPose`: a pre-4.3 `Slot`
 * satisfies it as it stands, so `pose(slot)` returns the slot itself and the
 * seam allocates nothing per slot per frame.
 */
export interface SlotPoseView {
  attachment: Attachment | null;
  readonly color: { r: number; g: number; b: number; a: number };
  sequenceIndex: number;
}

/**
 * The applied world transform of a bone — 4.3's `BonePose`, and a pre-4.3
 * `Bone` itself. (Spine's convention: X = a·vx + b·vy + worldX.)
 */
export interface BonePoseView {
  a: number;
  b: number;
  c: number;
  d: number;
  worldX: number;
  worldY: number;
}

/** The spine-core access seam. One table per generation, chosen once. */
export interface CoreCompat {
  /**
   * True on the pre-4.3 shape. Exposed so a test can say which shape it
   * measured, and so a probe that must *construct* spine-core objects (rather
   * than read them) can build the right ones.
   */
  readonly prePose: boolean;
  /** The draw order to render: 4.3's applied pose, or the array itself. */
  drawOrder(skeleton: Skeleton): Slot[];
  /** The slot's current pose view — the slot itself on the pre-pose shape. */
  pose(slot: Slot): SlotPoseView;
  /** The bone's applied world transform — the bone itself on the pre-pose shape. */
  bonePose(bone: Bone): BonePoseView;
  /**
   * The resolved `Sequence` frame index for this attachment, or -1 when it has
   * no sequence. Feeds both {@link regionAt} and the mesh dirty signature, so a
   * sequence that steps to another frame re-rasters.
   */
  sequenceIndex(attachment: RegionAttachment | MeshAttachment, pose: SlotPoseView): number;
  /**
   * The atlas region to draw. On the pre-pose shape this is also what *applies*
   * the sequence (`Sequence.apply` writes `attachment.region` and recomputes
   * the attachment's UVs and offsets), so it must be called before the vertex
   * and UV reads below — which is the order the renderer uses anyway, since a
   * region with no image means there is nothing to draw.
   */
  regionAt(
    attachment: RegionAttachment | MeshAttachment,
    slot: Slot,
    index: number,
  ): TextureAtlasRegion | null;
  /** The mesh's UVs for `index`, normalized over the whole page. */
  meshUVs(attachment: MeshAttachment, index: number): ArrayLike<number>;
  /** The region attachment's four world corners, written as `out[0..7]`. */
  regionWorldVertices(
    attachment: RegionAttachment,
    slot: Slot,
    pose: SlotPoseView,
    out: Float32Array,
  ): void;
  /** A mesh's or clip polygon's world vertices — the `VertexAttachment` path. */
  vertexWorldVertices(
    attachment: VertexAttachment,
    skeleton: Skeleton,
    slot: Slot,
    start: number,
    count: number,
    out: Float32Array,
    offset: number,
    stride: number,
  ): void;
  /**
   * Whether the clip keeps what is OUTSIDE its polygon. Inverse clipping
   * arrived in 4.3; older data cannot express it and older cores carry no such
   * property, so the pre-pose shape answers false rather than reading an absent
   * one.
   */
  inverse(clip: ClippingAttachment): boolean;
}

// --- pre-4.3 structural views ------------------------------------------------
//
// Everything below describes spine-core as it was before the pose split. The
// casts into these types are the only untyped step in the package, and none of
// them leaves this file.

interface PrePoseSequence {
  regions: Array<unknown>;
  setupIndex: number;
  apply(slot: unknown, attachment: unknown): void;
}

/** A pre-4.3 `RegionAttachment` or `MeshAttachment`. */
interface PrePoseTextured {
  /** Absent in 4.0, which predates sequences entirely. */
  sequence?: PrePoseSequence | null;
  region: unknown;
  /** `MeshAttachment` only: UVs over the whole page, recomputed with the region. */
  uvs?: ArrayLike<number>;
}

/** A pre-4.3 `RegionAttachment`: its `computeWorldVertices` takes no offsets. */
interface PrePoseRegion {
  computeWorldVertices(
    slot: unknown,
    worldVertices: Float32Array,
    offset: number,
    stride: number,
  ): void;
}

/** A pre-4.3 `VertexAttachment`: its `computeWorldVertices` takes no skeleton. */
interface PrePoseVertex {
  computeWorldVertices(
    slot: unknown,
    start: number,
    count: number,
    worldVertices: Float32Array,
    offset: number,
    stride: number,
  ): void;
}

const textured = (a: RegionAttachment | MeshAttachment): PrePoseTextured =>
  a as unknown as PrePoseTextured;

/**
 * The seam for 4.3 and newer: read the applied pose, and let the `Sequence`
 * own the per-frame regions, UVs and vertex offsets.
 */
const POSE_CORE: CoreCompat = {
  prePose: false,
  drawOrder: (skeleton) => skeleton.drawOrder.appliedPose,
  pose: (slot) => slot.appliedPose,
  bonePose: (bone) => bone.appliedPose,
  sequenceIndex: (attachment, pose) => attachment.sequence.resolveIndex(pose as SlotPose),
  regionAt: (attachment, _slot, index) =>
    (attachment.sequence.regions[index] ?? null) as TextureAtlasRegion | null,
  meshUVs: (attachment, index) => attachment.sequence.getUVs(index),
  regionWorldVertices: (attachment, slot, pose, out) => {
    attachment.computeWorldVertices(slot, attachment.getOffsets(pose as SlotPose), out, 0, 2);
  },
  vertexWorldVertices: (attachment, skeleton, slot, start, count, out, offset, stride) => {
    attachment.computeWorldVertices(skeleton, slot, start, count, out, offset, stride);
  },
  inverse: (clip) => clip.inverse,
};

/**
 * The seam for the pre-4.3 shape: the slot and the bone are their own poses,
 * and the attachment carries the region, the UVs and the vertex offsets that
 * 4.3 moved onto the `Sequence`.
 *
 * The sequence is applied in {@link CoreCompat.regionAt}, which is what
 * spine-core itself does from inside `computeWorldVertices`. `Sequence.apply`
 * is idempotent — it rewrites `attachment.region` only when the frame actually
 * changed — so doing it a beat earlier costs one comparison and lets the
 * renderer keep resolving the region before it commits to drawing.
 */
const PRE_POSE_CORE: CoreCompat = {
  prePose: true,
  drawOrder: (skeleton) => skeleton.drawOrder as unknown as Slot[],
  pose: (slot) => slot as unknown as SlotPoseView,
  bonePose: (bone) => bone as unknown as BonePoseView,
  sequenceIndex: (attachment, pose) => {
    const sequence = textured(attachment).sequence;
    if (!sequence) return -1;
    // `Sequence.apply`, to the letter: -1 means the setup frame, and an index
    // past the end holds on the last one.
    let index = pose.sequenceIndex;
    if (index === -1) index = sequence.setupIndex;
    if (index >= sequence.regions.length) index = sequence.regions.length - 1;
    return index;
  },
  regionAt: (attachment, slot, _index) => {
    const pre = textured(attachment);
    // Writes `attachment.region` — and its UVs and offsets — for this frame.
    pre.sequence?.apply(slot, attachment);
    return (pre.region ?? null) as TextureAtlasRegion | null;
  },
  // Recomputed by the region write above, so the array is already this frame's.
  // The fallback is unreachable on a mesh spine-core loaded — both readers
  // compute the UVs, and this is only called once a region has resolved.
  meshUVs: (attachment) => textured(attachment).uvs ?? [],
  regionWorldVertices: (attachment, slot, _pose, out) => {
    (attachment as unknown as PrePoseRegion).computeWorldVertices(slot, out, 0, 2);
  },
  vertexWorldVertices: (attachment, _skeleton, slot, start, count, out, offset, stride) => {
    (attachment as unknown as PrePoseVertex).computeWorldVertices(
      slot,
      start,
      count,
      out,
      offset,
      stride,
    );
  },
  inverse: () => false,
};

/**
 * Picks the seam for the spine-core that produced `skeleton`.
 *
 * The test is the pose split itself: 4.3's `Skeleton.drawOrder` is a
 * `DrawOrder` object carrying an `appliedPose` array, where every earlier
 * generation has a plain `Slot[]`. A version string would be the wrong oracle —
 * what matters is the object graph, not the label on it.
 *
 * Called once per renderer, on the first skeleton it is handed.
 */
export function coreCompatFor(skeleton: Skeleton): CoreCompat {
  const drawOrder: unknown = skeleton.drawOrder;
  const posed =
    !!drawOrder &&
    typeof drawOrder === 'object' &&
    !Array.isArray(drawOrder) &&
    Array.isArray((drawOrder as { appliedPose?: unknown }).appliedPose);
  return posed ? POSE_CORE : PRE_POSE_CORE;
}
