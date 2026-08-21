<p align="center">
  <img src="assets/banner.svg" alt="spine-html - DOM-first Spine 2D runtime" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/spine-html"><img src="https://img.shields.io/npm/v/spine-html.svg?style=flat-square&color=FF6B4A" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/spine-html"><img src="https://img.shields.io/npm/dm/spine-html.svg?style=flat-square&color=EC4899" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-38BDF8.svg?style=flat-square" alt="license" /></a>
</p>

Render [Spine](https://esotericsoftware.com/) skeletal animations as **plain DOM** — one
absolutely-positioned `<img>` per slot, posed with a single CSS `matrix()` write per frame.
No canvas, no WebGL for the rigid tier.

## Why

Every Spine web runtime rasterizes into a canvas. But `spine-core` is fully
renderer-independent: it computes bone world transforms — and even deformed mesh
vertices — on the CPU. For **region attachments** (the rigid parts of a skeleton), a bone
transform is a plain affine map, and CSS `transform: matrix()` expresses that *exactly*.
So the rigid tier of a Spine skeleton can live in the DOM, composited by the browser,
inspectable in devtools, styled with CSS.

The idea has been floated on the official forum three times since 2014 and was never
built — the blockers named were meshes, clipping, and DOM update overhead. This project
is the experiment: how far does the DOM actually go, and how cheap is it?

Measured so far (PoC, Apple silicon — headless and on-device numbers are labeled,
they do **not** substitute for each other):

- Rigid only (spineboy-ess), headless Chromium: 10 skeletons / 180 slot images at
  **~0.03 ms skeleton math + ~0.22 ms DOM writes per frame** — about 1.5% of a
  60 fps frame budget. On-device Safari: 10 rigid skeletons hold **60 fps**.
- With meshes (spineboy-pro), headless Chromium: 1 skeleton = **~0.05 ms + ~0.5 ms
  render** (8 mesh canvases, 323 triangles); 10 running skeletons = **~3.5 ms/frame**
  total, smooth.
- Dirty-skip: 10 *static* skeletons (pose held) = **~0.4 ms/frame** headless and
  **~0.6 ms** on-device Safari — unchanged meshes reuse their raster, so idle or
  held parts cost nothing anywhere.
- Real Safari (on-device), canvas2d mesh backend: in-callback JS stays **~4–5
  ms/frame** for 10 running meshed skeletons — but the rAF rate tells the real
  story: **meshed ×1 = 37 fps, meshed ×10 = 3–4 fps** (rigid-only ×10 = 60 fps).
  The cost lives outside the frame callback, in the compositor/GPU process:
  Safari antialiases canvas2d **clip paths**, so every triangle pays for an AA
  mask. Chromium doesn't antialias clips and stays smooth. This is what the
  optional WebGL mesh backend (below) removes.
- Real Safari (on-device), **webgl mesh backend**: meshed ×1 holds **60 fps**
  (vs 37 on canvas2d), and the meshed ×10 stress scene jumps **3–4 → 45 fps** —
  80 mesh canvases / 3230 triangles redrawn every frame (0 reused, the worst
  case), in-callback JS ~5.8 ms at dpr=1. The per-triangle clip-AA tax is gone;
  the remaining gap to 60 is the blit/compositing cost of a 10-skeleton stress
  scene, not a per-triangle cost.
- Headless-WebKit numbers are a **software rasterizer** and measured up to 28×
  off real Safari in both directions — useful for visual regression only, never
  as Safari perf evidence.

## Status

**Production.** The questions this started as a PoC to answer — how far does the
DOM actually go, and how cheap is it — are answered with on-device numbers: the
practical scenario (a character or two, mostly holding pose, a few parts
deforming) holds **60 fps on every engine measured**, and the 10-skeleton
stress scene holds 45 fps on the weakest one (Safari, webgl backend). Ships
with a self-contained test suite (backend visual parity + invariants) and CI.

- ✅ Region attachments (rigid parts): exact affine mapping, draw-order via `z-index`,
  attachment swaps, alpha
- ✅ Atlas unpacking at load time (90°-packed regions restored), so the rigid per-frame
  path never touches a canvas
- ✅ Mesh attachments (deform tier): small per-part canvases sized to the mesh's world
  bounds, interleaved with the rigid `<img>` slots in one stacking context — the DOM
  handles the bones, a rasterizer handles the warps
- ✅ Blend modes via `mix-blend-mode` (additive = `plus-lighter`)
- ✅ Crack-free mesh seams on clip-antialiasing browsers (Safari): each triangle's
  clip polygon is expanded 0.5px from its centroid so neighbours overlap — the
  texture is continuous across shared edges, so the overlap is invisible
  (`?expand=0` shows the cracks for comparison)
- ✅ RGB tinting (skeleton × slot × attachment color) via an SVG `feColorMatrix`
  reference filter per element — an exact channel multiply that works identically on
  `<img>` and `<canvas>` without touching the raster (needs reference-filter support,
  Safari 15+; verified pixel-level on Chromium and WebKit). Dark/two-color tint is
  not expressible this way and stays out of scope
- ✅ DPR-aware mesh canvas backing store: `renderer.pixelRatio` (defaults to
  `devicePixelRatio`; if you scale the root element, fold that scale in)
- ✅ Dirty-skip: a mesh whose canvas-space vertices didn't change reuses last frame's
  raster — the CSS translate still tracks it, so parts that hold a pose (or move by
  whole pixels) pay zero raster. 10 frozen spineboys: WebKit ~141 → ~0.5 ms/frame
- ⬜ Clipping — deliberately unsupported (counted and skipped); layered transparent
  parts + `overflow: hidden` cover the practical cases
- ✅ Safari mesh cost root-caused by on-device triangulation (two corrections deep):
  the early "~15× slower per-triangle path" was a **headless-WebKit artifact**
  (software rasterization), and the follow-up "on par with Chromium" held only for
  in-callback JS time. Real-Safari rAF rates — rigid ×10 = 60 fps, meshed ×1 =
  37 fps, meshed ×10 = 3–4 fps with JS flat at ~4–5 ms — put the real cost in the
  GPU process: Safari antialiases canvas2d **clip paths**, so the per-triangle clip
  mapping pays a per-triangle AA-mask tax (the same AA that caused the seam cracks)
- ✅ Optional WebGL blit backend for the mesh tier: `renderer.meshBackend =
  'webgl'` (default stays `'canvas2d'`). All dirty meshes are shelf-packed into
  **one shared offscreen WebGL context** (module-level — browsers cap contexts at
  ~16), drawn as textured triangles with premultiplied alpha, then rect-blitted
  onto the same per-part canvases with an unclipped `drawImage` — cheap on Safari.
  Everything element-level is unchanged: z-index interleave, tint filter,
  `mix-blend-mode`, dirty-skip, grow-only backing. GL rasterizes shared triangle
  edges seamlessly, so this path needs no crack overdraw. Falls back to canvas2d
  when WebGL is unavailable or the context is lost. Backend parity verified by
  headless Chromium+WebKit screenshot diffs (glow / clipping / tint scenes;
  sub-pixel edge differences only). On-device Safari, meshed ×10 with every mesh
  redrawn per frame: **3–4 fps (canvas2d) → 45 fps (webgl)**

## Install

```bash
npm i spine-html @esotericsoftware/spine-core
```

```ts
import { TextureAtlas, AtlasAttachmentLoader, SkeletonJson, Skeleton,
  AnimationState, AnimationStateData, Physics } from '@esotericsoftware/spine-core';
import { SpineHtmlRenderer, DomTexture, unpackRegions } from 'spine-html';

// Load: parse the atlas, attach page images, unpack per-region bitmaps once.
const atlas = new TextureAtlas(atlasText);
const pageImages = new Map<string, HTMLImageElement>();
for (const page of atlas.pages) {
  const image = await loadImage(page.name); // your loader
  page.setTexture(new DomTexture(image));
  pageImages.set(page.name, image);
}
const regionImages = await unpackRegions(atlas, pageImages);
const data = new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(jsonText);

// A positioned element becomes the skeleton origin (Spine is Y-up: the
// skeleton grows upward from it).
const skeleton = new Skeleton(data);
const state = new AnimationState(new AnimationStateData(data));
state.setAnimation(0, 'walk', true);
const renderer = new SpineHtmlRenderer(rootElement, regionImages);
// Mesh canvases raster at devicePixelRatio by default; if you scale the
// root element, fold that scale in so the raster matches the screen:
// renderer.pixelRatio = devicePixelRatio * rootScale;
// Mesh rasterizer: 'canvas2d' (default) or 'webgl' — same output, but on
// Safari heavy deforming scenes should use 'webgl' (see Measured above).
// Falls back to canvas2d automatically when WebGL is unavailable.
// renderer.meshBackend = 'webgl';

function frame(delta: number) {
  state.update(delta);
  state.apply(skeleton);
  skeleton.update(delta);
  skeleton.updateWorldTransform(Physics.update);
  renderer.render(skeleton);
}
```

`spine-html` is a third-party renderer and is not affiliated with or endorsed by
Esoteric Software.

## Demo (this repository)

```bash
bun install
bun run dev
```

The official spineboy example assets are downloaded automatically on first `dev`/`build`
(they are owned by Esoteric Software and not redistributed in this repository — see
[NOTICE.md](NOTICE.md)); `bun run fetch-assets` runs the same idempotent step manually.

Debug knobs (query string): `?skel=pro|ess` `?anim=walk` `?count=10` pick the scene,
`?tint=ff8080` tints the whole skeleton, `?dpr=2` overrides the mesh-canvas backing
ratio, `?timescale=0` freezes the pose (every mesh should report "reused"),
`?expand=0` disables the crack-closing clip overdraw, `?backend=webgl` rasterizes
meshes through the shared WebGL blitter (also a live header select; the stats line
names the active backend), and `?time=1.2` seeks every instance to the same pose
for deterministic captures.

## Tests

```bash
bun run test   # builds + serves the demo, then runs chromium + webkit
```

Playwright drives the demo (`tests/`, config in `playwright.config.ts`; CI
runs the same suite on ubuntu). The visual check is **A/B within one run**:
no golden snapshots are committed (they rot across platforms/GPUs) — instead
the same deterministic pose (`?time` + `?timescale=0`) is screenshotted with
`?backend=canvas2d` and `?backend=webgl` in the same engine and the buffers
are diffed directly with a shift-tolerant comparison, so missing parts,
wrong colors, and tint/blend divergence fail regardless of platform.
Hairline seams are guarded by a deterministic canary (`?expand=0` must
change the canvas2d raster), and counter tests pin the dirty-skip /
grow-only-backing / clip-skip invariants plus spine-core's region corner
order (BL, UL, UR, BR).

Standing rule: **headless numbers are never Safari performance evidence** —
nothing in the suite asserts timing, and headless-WebKit fps/ms readings do
not transfer (software rasterizer, measured up to 28× off real Safari). The
perf oracle is the demo's stats line on a real device.

## How it works

1. `@esotericsoftware/spine-core` loads the skeleton and drives `AnimationState`,
   constraints, and physics — all CPU-side, renderer-agnostic.
2. At load time each atlas region is cut into its own bitmap (rotation restored), one
   blob URL per region.
3. Per frame, for each slot in draw order: `computeWorldVertices` yields the region's
   four corners in world space (order **BL, UL, UR, BR** — note the comments inside
   `computeWorldVertices` are stale). Flip Y (Spine is Y-up), derive the affine from
   three corners, write one `matrix()` string. That's the whole render path.

## License

The code in this repository is MIT licensed.

It depends on the [Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes)
(`@esotericsoftware/spine-core`), which are licensed under the
[Spine Runtimes License](https://esotericsoftware.com/spine-runtimes-license):
**integrating the Spine Runtimes — including through this project — requires each user
to have their own valid Spine Editor license.** See [NOTICE.md](NOTICE.md).

Example assets (spineboy) are owned by Esoteric Software and are fetched from the
official repository at setup time, not redistributed here.
