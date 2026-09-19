import { RegionAttachment } from '@esotericsoftware/spine-core';
import type {
  Attachment,
  Bone,
  ClippingAttachment,
  MeshAttachment,
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
 * ## What the three shapes are
 *
 * **4.3** split every animatable object into data + poses: `Skeleton.drawOrder`
 * became a `DrawOrder` carrying an `appliedPose`, a slot's current attachment
 * and colour moved onto a `SlotPose`, a bone's world transform onto a
 * `BonePose`, and a region attachment's per-frame UVs and vertex offsets onto
 * the `Sequence`. Everything this renderer reads is one of those. Before 4.3
 * the same values sit directly on the `Slot`, the `Bone` and the attachment —
 * so the **pre-pose shape needs no wrapper object at all**: a `Slot` *is* its
 * own pose view and a `Bone` *is* its own bone-pose view. That is what keeps
 * the seam free of per-frame allocation.
 *
 * **4.1 and 4.2** are that pre-pose shape.
 *
 * **4.0** is the pre-pose shape minus sequences, which arrived in 4.1 and moved
 * exactly one call: `RegionAttachment.computeWorldVertices` takes the **slot**
 * from 4.1 on, because it may have to step the sequence on the way, and took
 * the **bone** before that. Nothing else the renderer reads moved — a 4.0
 * attachment simply has no `sequence` and a 4.0 slot no `sequenceIndex`, which
 * the shared table already answers with "no sequence" rather than by reading an
 * absent property. So the third table is the second one with that single member
 * replaced, and it is written that way.
 *
 * ## How the shape is chosen
 *
 * Once per renderer, by looking at the live objects ({@link coreCompatFor}) —
 * never per slot by try/catch, and never by reading a version string, which a
 * bundled, patched or vendored copy need not carry. The result is one of the
 * three tables below, so a render loop pays one property load per call and
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

/**
 * Which shape the installed spine-core has, named after the feature that moved
 * rather than after a version: `poses` is 4.3's pose split, `sequences` is the
 * pre-pose shape as 4.1 and 4.2 have it, and `pre-sequences` is 4.0, before
 * sequences existed. A consumer's copy may be vendored, patched or renamed, so
 * these are what was *detected*, never what a package.json said.
 */
export type CoreShape = 'poses' | 'sequences' | 'pre-sequences';

/** The spine-core access seam. One table per shape, chosen once. */
export interface CoreCompat {
  /**
   * Which shape this table is for. Exposed so a test can say which one it
   * measured — a column that quietly fell back to another shape would otherwise
   * look exactly like a column that is passing — and so a probe that must
   * *construct* spine-core objects (rather than read them) can build the right
   * ones.
   */
  readonly shape: CoreShape;
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

/**
 * A pre-4.3 `RegionAttachment`: its `computeWorldVertices` takes no offsets —
 * they live on the attachment, written by `updateRegion()` (4.1, 4.2) or by
 * `updateOffset()` (4.0).
 *
 * The first argument is `unknown` because it is the one thing that moved inside
 * the pre-pose range: 4.1 and 4.2 want the **slot** (the call may step a
 * sequence), 4.0 wants the **bone**. The two tables below differ by which they
 * hand it, and by nothing else.
 */
interface PrePoseRegion {
  computeWorldVertices(
    slotOrBone: unknown,
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
  shape: 'poses',
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
 *
 * Every member here is also 4.0's, bar one — see {@link PRE_SEQUENCE_CORE}. The
 * sequence reads are written as "if there is a sequence", not as "if this is
 * 4.1 or newer", so a core that never had the feature needs no branch of its
 * own: a 4.0 attachment has no `sequence`, {@link CoreCompat.sequenceIndex}
 * answers -1 before it would touch the absent `slot.sequenceIndex`, and
 * `regionAt` reads the attachment's own region the way 4.0's own renderer does.
 */
const PRE_POSE_CORE: CoreCompat = {
  shape: 'sequences',
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
 * The seam for 4.0 — the pre-pose shape before sequences existed.
 *
 * One member differs, and it is spelled out here rather than branched inside
 * the shared one: `RegionAttachment.computeWorldVertices` took the **bone**
 * until 4.1 gave it the **slot**, because from 4.1 on the call may have to step
 * a sequence and a bone cannot reach one. Handing a 4.0 core a slot is silent
 * and total — the method reads `worldX`/`worldY`/`a`/`b`/`c`/`d` straight off
 * its argument, a `Slot` has none of them, and every rigid corner comes out
 * `NaN`, so nothing throws and nothing draws. That is the mutant the 4.0
 * column exists to catch.
 *
 * Written as a spread because the relationship *is* "the same table with that
 * one call changed", and a copy would be a second place to keep in step. It is
 * built once at module load, not per renderer and not per frame.
 */
const PRE_SEQUENCE_CORE: CoreCompat = {
  ...PRE_POSE_CORE,
  shape: 'pre-sequences',
  regionWorldVertices: (attachment, slot, _pose, out) => {
    (attachment as unknown as PrePoseRegion).computeWorldVertices(slot.bone, out, 0, 2);
  },
};

/**
 * Whether the installed `RegionAttachment` is 4.1's or newer.
 *
 * Sequences arrived in 4.1, and the same release replaced the pair
 * `setRegion()` + `updateOffset()` with a single `updateRegion()` *and* changed
 * `computeWorldVertices` from taking a bone to taking a slot. One release, one
 * boundary: the presence of `updateRegion` on the prototype is therefore a test
 * of the argument this seam has to get right, not a proxy for a version number.
 * (`slot.sequenceIndex` is the same boundary seen from the data side, but a
 * skeleton with no slots could not be asked, and the prototype always can be.)
 *
 * Read once, at module load, off the live class — not from a version string,
 * which a vendored or bundled copy need not carry.
 */
const REGION_TAKES_SLOT = 'updateRegion' in RegionAttachment.prototype;

/**
 * Picks the seam for the spine-core that produced `skeleton`.
 *
 * The first test is the pose split itself: 4.3's `Skeleton.drawOrder` is a
 * `DrawOrder` object carrying an `appliedPose` array, where every earlier
 * generation has a plain `Slot[]`. A version string would be the wrong oracle —
 * what matters is the object graph, not the label on it. The second splits the
 * pre-pose range at the arrival of sequences; see {@link REGION_TAKES_SLOT}.
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
  if (posed) return POSE_CORE;
  return REGION_TAKES_SLOT ? PRE_POSE_CORE : PRE_SEQUENCE_CORE;
}
