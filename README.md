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
- ✅ Atlas unpacking at load time (90°-packed regions restored to the orientation
  spine-core's UVs name, held by the pixel oracle on exports whose packer rotated),
  so the rigid per-frame path never touches a canvas — a region that covers its whole
  page is passed through uncut, and `revokeRegions()` frees the rest when a skeleton
  is unloaded
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
- ✅ Clipping attachments as element-level CSS `clip-path`: spine-core's semantics
  (one active clip at a time, applied from the clip's slot through its end slot
  inclusive), with the polygon expressed in each element's own local frame — the
  inverse of the `<img>` matrix for rigid slots, the canvas translate for mesh
  slots. Covers **part masks** (a clip with a real end slot, like this repository's
  own `portal` animation) and **whole-skeleton clips** (an end slot that never
  arrives, which takes a fast path: one `clip-path` on the root instead of one per
  element). **Inverse clips** are supported too: the region they keep has a hole
  in it, so it needs two rings, and `polygon()` carries only one — a box and a
  polygon listed inside one `polygon()` become a single self-intersecting ring
  whose even-odd fill leaves a wedge along the seam between them (measured, on a
  corner of spineboy's boot). So an inverse clip is written as a two-subpath
  `path(evenodd, …)` whose outer ring is the element's own box. The whole feature
  is element-level, so both mesh backends see the same thing and neither raster
  path knows clipping exists; `renderer.clipping = false`
  restores the old counted-and-skipped behaviour. Concave polygons go to CSS as
  authored — the convex decomposition spine's CPU clipper performs exists to feed a
  triangle rasterizer and has no job here. Two things this does not do: Spine's
  clipper convexifies an *inverse* polygon (convex hull) where CSS clips it as
  authored, so the two agree exactly when that polygon is convex — which is the
  shape `inverse` is meant for; and the cost of many simultaneous `clip-path`s on
  real-device Safari is **not measured** (the headless numbers that exist are not
  Safari evidence — see Measured above)
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
import { Skeleton, AnimationState, AnimationStateData, Physics }
  from '@esotericsoftware/spine-core';
import { loadSkeletonAssets, SpineHtmlRenderer } from 'spine-html';

const assets = await loadSkeletonAssets({
  atlasUrl: '/spineboy/spineboy.atlas',
  skeletonUrl: '/spineboy/spineboy-pro.json',
});

// A positioned element becomes the skeleton origin (Spine is Y-up: the
// skeleton grows upward from it). Layout and scaling are the caller's.
const skeleton = new Skeleton(assets.data);
const state = new AnimationState(new AnimationStateData(assets.data));
state.setAnimation(0, 'walk', true);
const renderer = new SpineHtmlRenderer(rootElement, assets.regionImages);

function frame(delta: number) {
  state.update(delta);
  state.apply(skeleton);
  skeleton.update(delta);
  skeleton.updateWorldTransform(Physics.update);
  renderer.render(skeleton);
}

// Unloading (a cutscene ends, a level swaps): elements first, bitmaps second.
// The unpacked regions are blob URLs — nothing else frees them.
renderer.dispose();
assets.dispose();
```

`spine-html` is a third-party renderer and is not affiliated with or endorsed by
Esoteric Software.

### Which spine-core to install

> **Install the `@esotericsoftware/spine-core` that matches the Spine editor
> version your data was exported from.**

A Spine runtime reads only the data its own generation exported, so this is
never a choice between "newest" and "oldest" — it is decided by your `.json` or
`.skel` files. `spine-core` is a **peer** dependency here precisely so the
decision stays yours, and `spine-html` draws from either generation:

| `@esotericsoftware/spine-core` | `spine-html` |
| --- | --- |
| **4.3.x** | ✅ supported |
| **4.2.x** | ✅ supported |
| **4.1.x** | ✅ supported — browser/bundler only, see the Node note below |
| **4.0.x** | ✅ supported — browser/bundler only, see the Node note below |
| 3.8.x and older | ❌ not supported — no runtime is published under this package name |

*Supported* means one specific thing: a column of this repository's CI runs the
**whole** test suite on that minor, against **that version's own** example
exports, with the pixel oracle drawing the same poses through
`@esotericsoftware/spine-webgl` of the same generation. `peerDependencies` is
that set and nothing wider. Nothing in the API above changes with the version —
the difference is absorbed internally, in one file, chosen once per renderer by
looking at the objects spine-core hands over.

> **Node note, for 4.1 and 4.0 only.** Those two releases of `spine-core`
> cannot be imported by plain Node: they ship extensionless relative specifiers
> in their own `dist/`, and 4.0 also omits `"type": "module"`. Every bundler
> resolves them (so do CDNs such as esm.sh), which is how a browser consumer
> meets them, and `spine-html` itself is unaffected — but `import` of either
> package from a Node process fails, so **SSR and Node-side tooling cannot load
> them**. It is upstream's defect and not fixable from here. 4.1 has one more:
> a single extensionless specifier inside its own `.d.ts` makes it fail a
> `moduleResolution: "nodenext"` typecheck. 4.2 and 4.3 have neither problem.

**Worth knowing, because it is silent.** If you point a 4.3 runtime at older
data, the bad outcome is not the one that throws. 4.3 reads constraints from a
single top-level `constraints` array, where 4.2 and older write separate
`ik` / `transform` / `path` / `physics` ones — so an older export that still
parses loads **none of its constraints at all**, and the skeleton animates on
bones alone: no IK, no path, no physics, no error. Measured over a real-world
corpus of 267 skeletons (88% of them 4.2 exports): 40% failed to parse under
4.3.13 outright, and across those that did parse, **0 of 7,065** constraints and
**0 of 5,704** physics constraints were loaded. If a skeleton renders but goes
limp, this is why — and installing the matching `spine-core` is the whole fix.

**If your data was exported by 4.1 or 4.0, install the matching runtime.**
Since 0.8.0 both are supported columns, and installing spine-core 4.2 for such
data is **not** a substitute — the failure is the quiet kind again. Read off
`SkeletonJson` in each generation:

- 4.0 and 4.1 write a bone's inheritance mode as `transform`
  (`noRotationOrReflection`, `onlyTranslation`, …); 4.2 reads `inherit` and
  nothing else, so every such bone falls back to `Normal`.
- 4.0 writes mesh deform timelines under the animation's `deform`; 4.1 and 4.2
  read `attachments` and never look at `deform`, so those timelines are dropped.

Neither throws. Over a real-world corpus of shipped web skeletons, 96 of 418
exports made by 4.0 and 20 of 101 made by 4.1 carry such bones (643 of them),
and 91 of the 4.0 exports carry 1,031 deform timelines between them — all of it
lost without a message under 4.2, while the file parses, every constraint
loads, and the rig renders without an error.

Spine's own spineboy export carries both, which is why every CI column checks
this rather than trusting it: four bones at `noRotationOrReflection` and four
mesh deform timelines, declared under the key that branch's exporter writes, and
asserted to have arrived in the parsed `SkeletonData`.

> **Correction.** The README shipped with 0.7.1, and the 0.7.0 release notes,
> said "install spine-core 4.2" for 4.1 / 4.0 data — on the strength of exactly
> the evidence that looks conclusive: every export parsed, all 14,022
> constraints loaded, a 60-rig sample rendered cleanly. That evidence was real
> and the conclusion was wrong, because **parsing without an error says nothing
> about keys a newer reader no longer looks for.** The same corpus holds 19
> Spine 3.8 exports that also parse cleanly under a 4.x runtime — and then pose
> most of their bones at non-finite transforms (3.8 writes a rotate key as
> `angle` and a curve as scalars; 4.0 reads `value` and an array). The test that
> would have caught this is a diff of the keys each generation's reader
> consumes, which is what the list above is. 0.7.1 corrected the advice to "4.2
> is not a stand-in, and 4.1 / 4.0 are not supported"; 0.8.0 supports them, so
> the advice is now simply the rule at the top of this section.

Spine 3.8 and older are out of scope: they are not published under this package
name.

### One atlas, several skeletons

Skeletons that share an atlas — a character's `-ess` and `-pro` exports, a whole
cast packed onto one page — load in two steps instead. Calling
`loadSkeletonAssets` once per skeleton would fetch and unpack the same pages
again and mint a second set of region blob URLs:

```ts
import { loadAtlasAssets, loadSkeletonJson, SpineHtmlRenderer } from 'spine-html';

const shared = await loadAtlasAssets({ atlasUrl: '/spineboy/spineboy.atlas' });
const [essData, proData] = await Promise.all([
  loadSkeletonJson(shared, '/spineboy/spineboy-ess.json'),
  loadSkeletonJson(shared, '/spineboy/spineboy-pro.json'),
]);

const ess = new SpineHtmlRenderer(essRoot, shared.regionImages);
const pro = new SpineHtmlRenderer(proRoot, shared.regionImages);

// Unloading: every renderer first, then the one dispose() that owns the bitmaps.
ess.dispose();
pro.dispose();
shared.dispose();
```

`loadAtlasAssets` takes the atlas half of the options above (`resolvePage`,
`crossOrigin`, `fetch`) and `loadSkeletonJson` the skeleton half (`scale`,
`fetch`). Ownership is the thing to keep straight: the atlas assets belong to
the caller, reading a skeleton against them never frees them, and one
`regionImages` map is meant to be handed to several renderers — so there is
exactly one `dispose()` for however many skeletons were read. `loadSkeletonJson`
asks only for `{ atlas }`, so a caller that built its atlas by hand (below) can
still use it for the read. `loadSkeletonAssets` is these two calls with the
atlas half kept private: use it for one atlas and one skeleton, this for the
rest.

### Binary exports (`.skel`)

Binary exports are read by a second parser, `SkeletonBinary`, which is as big as
the JSON one. It lives behind its own entry point so that consumers who only
ever read `.json` never carry it:

```ts
import { loadAtlasAssets, SpineHtmlRenderer } from 'spine-html';
import { loadSkeletonBinary } from 'spine-html/binary';

const shared = await loadAtlasAssets({ atlasUrl: '/spineboy/spineboy.atlas' });
const data = await loadSkeletonBinary(shared, '/spineboy/spineboy-pro.skel');

const renderer = new SpineHtmlRenderer(rootElement, shared.regionImages);
// Unloading, as above: renderer.dispose(); shared.dispose();
```

`loadSkeletonBinary` is `loadSkeletonJson` with the parser swapped: same
arguments, the same `{ scale, fetch }` options, the same ownership rule — it
never frees `assets`, whichever way it ends. Those two calls are the binary path
in full. There is no one-call `loadSkeletonAssetsBinary`, because the atlas half
is precisely what a caller reading binary usually wants kept in hand, and hiding
it again would only earn back a line.

The subpath is the whole mechanism, so import it as written: pulling
`loadSkeletonBinary` out of `'spine-html'` is not possible, by design. Worth
knowing about the format itself: binary exports are version-locked to the
runtime that reads them, so a `.skel` written by an editor newer than your
installed `@esotericsoftware/spine-core` fails in the read, not in the fetch.

### Loading it yourself

`loadSkeletonAssets` is optional sugar over five `spine-core` calls, and the
package works without it. Drop to the low-level path whenever you need
something no loader does — images that are already in memory, an atlas that is
not fetched from a URL at all:

```ts
import { TextureAtlas, AtlasAttachmentLoader, SkeletonJson }
  from '@esotericsoftware/spine-core';
import { DomTexture, unpackRegions, revokeRegions } from 'spine-html';

const atlas = new TextureAtlas(atlasText);
const pageImages = new Map<string, HTMLImageElement>();
for (const page of atlas.pages) {
  const image = await loadImage(page.name); // your loader
  page.setTexture(new DomTexture(image));
  pageImages.set(page.name, image);
}
const regionImages = await unpackRegions(atlas, pageImages);
const data = new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(jsonText);

// …and on unload, after every renderer using them is disposed:
revokeRegions(regionImages);
```

A region the packer stored turned (`rotate: 90`) is cut upright again, and which
way round that is comes from spine-core's own UVs rather than from the cut: such
a region's corners carry `(u2, v2), (u, v2), (u, v), (u2, v)` in the order
BL, UL, UR, BR, so the artwork's top-left corner sits at the packed rect's
bottom-left and unpacking it is a clockwise turn. Every release up to 0.7.0
turned it the other way and drew rotated rigid parts 180° round (#49); if you
worked around that by re-packing an atlas without rotation, you can stop.

`unpackRegions` mints one blob URL per region; `revokeRegions` is its
counterpart. It only frees URLs `unpackRegions` created, so a map you built
yourself (below) and page images reused by the whole-page pass-through survive
it — and calling it twice is a no-op. Load once for the page's lifetime and you
can ignore it; load and unload repeatedly without it and you leak an atlas per
cycle.

### Pages that ship at another resolution

A page image may ship at a resolution its atlas does not declare — a
half-resolution texture build, or an @2x variant, with the `size:` line left as
the packer wrote it. Nothing here needs a flag for that. A region's bounds are
read **relative to the declared page size** and scaled onto the image's natural
size, which is exactly how `spine-core` derives the UVs the mesh tier samples
with (`region.u = region.x / page.width`), so both tiers land on the same
pixels at any resolution:

```
hero.png
size: 4096, 4096     # what the packer wrote
                     # hero.png itself ships 2048×2048
```

Each unpacked bitmap comes out at the **native resolution of the pixels it was
cut from** — half-resolution pages cost a quarter of the cut pixels, and
nothing is upscaled back — while `RegionImage.width`/`height` stay in **atlas
units**. Those two numbers are the `<img>` layout box and the denominator of
its CSS matrix, so the skeleton poses identically and the browser scales the
smaller bitmap into the same box, the way a GPU samples a smaller texture
through the same UVs. Ship one atlas and swap the images per device if you
like.

The corollary: a `size:` line that is simply **wrong** is now wrong for the
whole renderer rather than for the mesh tier alone. Bounds are read against
what the atlas declares, so a page declared at a size its artwork was not
packed at reads every region from the wrong place in both tiers — correct the
`size:` line, which is what every other Spine runtime needs too.

### Premultiplied pages (`pma: true`)

The Spine texture packer premultiplies alpha by default, and says so with a page
line:

```
hero.png
size: 2048, 2048
pma: true
```

Such a page's RGB is already multiplied by its alpha, and nothing is asked of
you: the flag is read off the atlas and each tier is handed the page in the
convention it actually consumes. The `webgl` mesh backend uploads the texels
unconverted (its blend already expects premultiplied source — lossless). The DOM
and canvas2d tiers cannot: an `<img>` and `drawImage` composite straight alpha by
definition, so they read a straight-alpha derivation of the page —
`rgb = round(rgb * 255 / a)`, computed once and shared by the region cuts and
the mesh raster. Without it every semi-transparent texel is multiplied by its
alpha a second time and draws darker than it was authored: soft edges, soft
shadows, glows.

What it costs: **one page-sized canvas per premultiplied page image**
(width × height × 4 bytes — 1 MiB for a 1024×256 page, 16 MiB for a 2048×2048
one), alive as long as you hold the page image and released with it; the cache
is weak, so there is nothing to free by hand. A page with no `pma:` line derives
nothing and takes exactly the path it always did. The division is 8-bit and
starts from a canvas read, which has itself quantized a premultiplied texel, so
a very transparent texel can land a few levels off — exact at alpha 0 and 255,
within one level of 255 above alpha 128, and a little more below that, by an
amount that belongs to the browser's canvas rather than to this package (some
rasterizers round premultiplied storage several times more coarsely than
others). It is bounded by what that canvas already costs, and it is invisible
wherever the texel is: a texel at alpha 11 is ~4% opaque. The `webgl` backend,
having no such step, is exact.

One consequence worth knowing if your atlas is one part per page: a whole-page
region on a premultiplied page is **cut** rather than handed through, because
the page's own URL holds premultiplied pixels (see below).

### What unloading frees

`revokeRegions()` — and `assets.dispose()`, which just calls it — frees the blob
URLs `unpackRegions` minted, and nothing else. The rest is pinned by objects you
own: an atlas **page image** is held by the `DomTexture` you attached to its
page, and `SkeletonData` reaches that same image through every attachment
(`region.texture.getImage()`), so a page is released only once the atlas, the
skeleton data and every renderer drawing from them are gone. `atlas.dispose()`
does not do it — `DomTexture.dispose()` is a no-op, because the image is yours.
With the `webgl` mesh backend the shared blitter also uploads each page image on
first use, but that GL texture is not the module's forever: every renderer
drawing the page holds a reference to it, `renderer.dispose()` hands those back,
and the texture is deleted once the last renderer using that page is disposed —
a later frame that needs the page uploads it again. The cache is keyed weakly by
the page image, so a renderer dropped without `dispose()` costs GPU memory until
the context is lost, but never keeps the image itself alive.

A meshed skeleton samples the page bitmap every frame, so its decoded form stays
in use: a floor on the order of `page width × page height × 4` bytes per page —
1 MiB for spineboy's single 1024×256 page. A rigid-only skeleton draws nothing
from the page after `unpackRegions`, and what a merely reachable, undrawn image
costs is up to the browser, not measurable from script.

Unload in this order:

1. `renderer.dispose()`, for every renderer using the images.
2. `revokeRegions(regionImages)` (or `assets.dispose()`).
3. Drop your references to the atlas and the skeleton data.

### One part per page (loose part PNGs)

Not every pipeline runs the Spine editor's texture packer. If your parts are
loose PNGs, declare each one as its own atlas page — a blank line closes a page
block, the next line opens the next:

```
head.png
size: 512, 512
head
bounds: 0, 0, 512, 512

torso.png
size: 640, 480
torso
bounds: 0, 0, 640, 480
```

`spine-core` parses this as a normal multi-page atlas and nothing here needs a
flag. Two things to know:

- **`size:` is the frame every coordinate is read in**, so each page's
  `bounds` must be written against the `size:` above them. The two need not be
  the PNG's pixel size — that is the point of the section above, and a
  half-resolution `head.png` under `size: 512, 512` works — but a `size:` that
  matches neither the bounds nor the artwork reads every region from the wrong
  place, in both tiers.
- Regions like these cover their whole page, so `unpackRegions` hands the page
  image straight through instead of cutting and re-encoding it — at any image
  resolution, since covering the page is a statement about the declared size.
  Load cost for this atlas shape is just the image loads. The exception is a
  page marked `pma: true`: its URL holds premultiplied pixels, which an `<img>`
  would composite as straight alpha, so those regions are cut from the
  straight-alpha derivation like any other (and the blob is revoked by
  `revokeRegions` like any other).

For a **rigid-only** skeleton you can skip atlas unpacking altogether and hand
the renderer a map you build yourself — meshes cannot, because the deform tier
samples the page bitmap through the atlas region:

```ts
const regionImages = new Map([
  ['head', { url: '/parts/head.png', width: 512, height: 512 }],
]);
const renderer = new SpineHtmlRenderer(rootElement, regionImages);
```

### Runtime knobs and what they cost

- `renderer.pixelRatio` — mesh-canvas backing pixels per CSS pixel (defaults to
  `devicePixelRatio`; if you scale the root element, fold that scale in so the
  raster matches the screen: `devicePixelRatio * rootScale`). **Writing it
  reallocates every mesh canvas backing store on the next frame**, and each
  reallocation recreates a GPU surface — the cost that took real Safari to ~3 fps
  when it happened per frame. Each canvas is then sized from what the new ratio
  needs, in both directions: lowering the ratio gives the backing pixels back
  (the backing is grow-only *within* a ratio, not across a change of one). Set
  it when a layout settles, never per frame:
  debounce resize drags and quantize the value instead of tracking it
  continuously. `renderer.canvasReallocCount` is the check — it must fall back to
  zero within a second or two.
- `renderer.syncPixelRatio()` — measures the root's effective on-screen scale
  and sets `pixelRatio` to `devicePixelRatio × scale`, returning the ratio now
  in effect. It appends a hidden 100 px box to the root, reads its box once and
  removes it (the root itself is usually 0×0), so it is **one forced layout per
  call** — which is exactly why the renderer never calls it for you: there is no
  per-frame layout read anywhere in this library. Call it when a zoom or a
  layout *settles* (gesture end, debounced resize), not during the drag. A
  change under 0.1% is ignored, so layout jitter cannot churn GPU surfaces, and
  a root that is not laid out (a `display: none` ancestor) leaves the ratio
  alone. Under an ancestor rotation the measured box is inflated and the ratio
  errs high — oversampling costs pixels, undersampling costs picture.
- `renderer.meshBackingPixels` — allocated mesh-canvas backing pixels
  (Σ width × height), computed on demand. This is what `pixelRatio` moves
  quadratically, and the cheapest way to see an oversampling stage; the demo
  prints it in the stats line as `backing N Mpx`.
- `renderer.meshBackend` — `'canvas2d'` (default) or `'webgl'`; same output, but
  heavy deforming scenes on Safari want `'webgl'` (see Measured above). Falls back
  to canvas2d automatically when WebGL is unavailable. Switching re-rasters every
  mesh once (no reallocation), so it is fine to expose as a user setting.
- `renderer.triangleExpand` — clip overdraw in px that closes antialiased mesh
  seams (default 0.5). Also re-rasters every mesh once when changed.
- `renderer.clipping` — apply clipping attachments (default `true`). What it
  writes is one CSS `clip-path` per element the active clip covers, in that
  element's own local frame; nothing reaches the raster backends, and a clip is
  not part of the mesh dirty signature, so a mesh that held still keeps reusing
  its raster under a moving clip. **Writes happen on change only**: each
  clip-path is cached exactly as `transform` is, coordinates are quantized to
  1/1000 of a local unit so float jitter cannot defeat that cache, and a static
  polygon over a static pose therefore costs **zero style writes per frame after
  the first** — `renderer.clipWriteCount` is the check, alongside
  `clipCount` (applied) and `clipSkipCount` (not applied: switched off, a second
  clip met while one was active, an inactive bone, a degenerate polygon).
  **The whole-skeleton fast path**: when the clip starts before anything has been
  drawn and never ends, one `clip-path` goes on the root instead of one per
  element. The root is *your* element, so its inline `clip-path` is **borrowed,
  not taken** — saved on the first write and put back verbatim when the clip
  stops covering the frame, when `clipping` goes `false`, and by `dispose()`.
  Per-element clip-paths and the root clip-path are never both in force for the
  same clip. Two things to know about that path: the polygon is written in the
  root's **border box** frame, which is where absolutely-positioned slot elements
  start too *unless the root has a CSS border* (a border would offset the
  whole-skeleton clip by its width — keep borders off the render root, which is
  the normal shape for a 0×0 origin element); and an inverse clip never takes it,
  because its CSS form needs an outer ring around a box and the root has none.
  One further consequence of that path: a `clip-path` other than `none` makes an
  element a stacking context (CSS Masking), so a whole-skeleton clip isolates
  `mix-blend-mode` slots from backdrops *outside* the root — which a root
  carrying a `transform` (the usual pan/zoom stage) already does. Per-element
  clips do not change blending, since a blended slot is its own stacking context
  either way. Setting `clipping = false` removes every clip-path this renderer
  wrote.

**A zoomable stage.** The mesh tier rasters at `world × pixelRatio` in the
root's own coordinates, and it cannot see a CSS transform above the root — so
the most natural pan/zoom stage, `transform: scale(zoom)` on an ancestor, makes
it oversample by `1/zoom²` in backing pixels until the zoom is folded in. The
picture stays correct throughout, which is what makes this easy to ship: only
the allocation and the frame rate move. Call `syncPixelRatio()` when the zoom
settles, or set `pixelRatio = devicePixelRatio * zoom` yourself. Measured
on-device (Chromium, dpr 2, stage under `scale(0.25)`, ~2.2 M CSS px on screen):

| scene | `pixelRatio` | `meshBackingPixels` | fps |
| --- | --- | --- | --- |
| 57 meshes | `devicePixelRatio` (2) | 139.1 Mpx | 14–21 |
| 57 meshes | `dpr × zoom` (0.5) | 9.1 Mpx | 61 |
| 92 meshes | `devicePixelRatio` (2) | 141.1 Mpx | 36–39 |
| 92 meshes | `dpr × zoom` (0.5) | 9.1 Mpx | 60–61 |

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
names the active backend), `?clipping=0` turns clipping attachments back off (they
are then counted and skipped, as before v0.6 — try it on `?anim=portal`), and
`?time=1.2` seeks every instance to the same pose for deterministic captures.

## Tests

```bash
bun run test   # builds + serves the demo, then runs chromium + webkit
```

Playwright drives the demo (`tests/`, config in `playwright.config.ts`; CI
runs the same suite on ubuntu, **once per supported spine-core minor**). That
matrix is what the compatibility table above is made of: each column installs
that minor over the lockfile's, fetches the matching spine-runtimes branch's
example exports, and runs everything. `SPINE_ASSETS_BRANCH=4.2 bun run
fetch-assets` gets those exports locally, and `SPINE_CORE_MINOR` tells the run
which minor it is against — anything but the typed one builds without
`tsc --noEmit`, since the package is typed against one generation and runs on
several. Two checks in `tests/package.spec.ts` are skipped, with the reason
printed, where the **installed peer alone** already fails them: importing
`spine-core` 4.0 in plain Node, and typechecking a consumer of `spine-core` 4.1
under `nodenext`. Both are the upstream packaging defect described in the
compatibility section, both are probed rather than keyed on a version, and
nothing is relaxed in the columns that can run them. The visual check is
**A/B within one run**:
no golden snapshots are committed (they rot across platforms/GPUs) — instead
the same deterministic pose (`?time` + `?timescale=0`) is screenshotted with
`?backend=canvas2d` and `?backend=webgl` in the same engine and the buffers
are diffed directly with a shift-tolerant comparison, so missing parts,
wrong colors, and tint/blend divergence fail regardless of platform.
Hairline seams are guarded by a deterministic canary (`?expand=0` must
change the canvas2d raster), and counter tests pin the dirty-skip /
grow-only-backing / clip-counter invariants plus spine-core's region corner
order (BL, UL, UR, BR).

Clipping gets its own oracle (`tests/clipping.spec.ts`), because a clip-path
that went through the wrong transform still parses and still counts as applied.
A clipped capture is compared against the **unclipped** capture of the same
slots masked in **screen space** by the world polygon — built once through the
stage transform, never through an element's local frame, so the check cannot
agree with the renderer by sharing its mistake. What it asserts is occupancy,
not pixel values: outside a 3 px band around the polygon's outline (where the
browser's clip-path antialiasing and the canvas `ctx.clip()` the oracle uses
legitimately differ), **no artwork may survive where the polygon excludes it
and none may go missing where it does not** — both counts absolute, no budget.
Pixel values are logged but not asserted, because a clipped element is drawn
through a mask and its silhouettes come out a shade different all over the
picture; a control capture, clipped by a polygon that removes nothing, pins
that down by coming back byte-identical to the unclipped one.

The loading path is not observable in a rendered frame, so it gets its own
page (`tests/harness.html`, a second build entry) that exposes the library to
the specs directly. Its oracle is the browser: a revoked object URL stops
resolving, so blob ownership — every unpacked URL freed, nothing the caller
owns touched, nothing stranded by a failed load — is asserted rather than
assumed.

### The pixel oracle: a reference that is not us

Everything above compares this package against itself. That catches one mesh
backend drifting from the other and, by construction, cannot catch a defect
they **share** — which is what happened with `pma: true` pages, drawn one
multiply too dark in every tier while the suite stayed green for months.

So `tests/oracle.spec.ts` compares against the official runtime. The same
export, the same frozen pose, the same size, the same atlas page, drawn by
`@esotericsoftware/spine-webgl` into a canvas whose orthographic camera is
solved to land world space on exactly the pixels the DOM stage lands it on —
then both are screenshotted and diffed. Thirteen cells: the rigid tier, the mesh
tier on both backends, the exporter's own premultiplied page (`spineboy-pma`)
on all three, a clipping pose, an additive-blend pose, a mesh-deform pose on
both backends, a per-slot rgba/alpha pose, and a whole-skeleton tint.

It earned its keep on the first run: the rigid tier was drawing every
90°-packed atlas region 180° round (#49), in every release up to 0.7.0, and no
comparison of this package against itself could have seen it. Rotated packing is
held there now — the example exports rotate 17 regions on the 4.0 and 4.1
branches and ten on the 4.2 branch where the 4.3 branch's rotate none, so the
older columns are what keep the restore honest, and each cell logs how many
regions its atlas rotated so a green run on an unrotated one cannot be mistaken
for the proof.

The deform cell is the one chosen for what the *data* carries rather than for a
feature of the renderer: `hoverboard` is the only animation in spineboy-pro with
mesh deform keys, it is the section whose JSON key moved between 4.0 and 4.1,
and the pose drives two of the four bones whose inheritance mode moved between
4.1 and 4.2. On the older columns it is therefore a deformed mesh posed through
bones only the matching runtime reads, diffed against that runtime's own
reference.

Two things make it evidence rather than decoration. The camera match is
**derived** — solved against the DOM mapping, not fitted to a picture — and
then **proved by driving it**: a deliberate one-world-unit offset of one side
must change the diff, which it does by 3.3× and 6.5×. And what is forgiven is
antialiasing and texture filtering and nothing else, so the stage sits where
one atlas texel is one CSS pixel and neither runtime resamples. Limits are
ratios of drawn content, plus a darker-minus-lighter excess on the
premultiplied cells, because that defect class can only go one way — never an
absolute per-pixel precision number, which is a platform's number and not a
package's.

spine-webgl is a **development dependency**. It is named by one file under
`tests/`, it is in neither `dependencies` nor `peerDependencies`, and
`tests/package.spec.ts` asserts that nothing the published package contains so
much as mentions it.

## Benchmark: side by side with the official runtime

```bash
bun run bench:dev     # the page, for a person to watch (and for Safari)
bun run bench         # drives it in a headed Chromium and writes a report
```

`bench/` is a separate vite project — not part of the library, and not part of
what `bun run build` emits — that runs the same skeleton in both runtimes side
by side, each with its own stats line in the demo's style. Scenes by query
string: `?scene=mesh` (the deform tier working every frame), `?scene=held` (a
frozen pose, where unchanged meshes reuse their raster and the reference
redraws regardless), `?scene=rigid`, and `?scene=many&count=N` independent
players — which is also where the architectural difference shows, since the
reference needs one WebGL context per player against browsers' cap of ~16 and
this package shares a single one however many there are. The page reports
reaching that cap rather than dying at it.

`scripts/bench.mjs` walks `bench/scenes.json`, opens each scene in a **headed**
Chromium (a hidden page throttles `requestAnimationFrame`, so a headless
reading would be the browser's power policy rather than either runtime's cost),
runs a fixed number of frames per runtime — one at a time, because rAF has a
single cadence per document — and writes JSON plus a markdown table with the
conditions attached: browser version, device pixel ratio, window size, GPU
string, and the load average before and after. Over a threshold it stamps the
whole report `INVALID: load average too high` and exits non-zero, because a
benchmark on a busy machine measures the machine. `--corpus <dir>` points it at
local rigs that never enter this repository.

> **Numbers pending.** No comparison table is published yet, and one taken on a
> loaded CI runner or in a headless browser would not be worth reading. The
> table will be taken the way every other number in this README was: the two
> stats lines read on a real device, on a quiet machine, per scene and per
> engine — including Safari, which stays manual because no automation preserves
> what is being measured there. Until then the instrument exists and the
> measurement does not.

The server is part of the test: a run tests whatever is being served on its
port. Two checkouts of this repository on one machine (a worktree, a second
clone) default to the same port 4321 and reuse an existing server, so the
second run quietly tests the first one's build — green, and about the wrong
tree. Give each concurrent checkout its own port with `TEST_PORT`
(`TEST_PORT=4333 bun run test`); setting it also disables server reuse, so a
busy port fails the run instead of being borrowed. Unset, nothing changes:
port 4321, reuse unless `CI`.

Standing rule: **headless numbers are never Safari performance evidence** —
nothing in the suite asserts timing, and headless-WebKit fps/ms readings do
not transfer (software rasterizer, measured up to 28× off real Safari). The
perf oracle is the demo's stats line on a real device.

## How it works

1. `@esotericsoftware/spine-core` loads the skeleton and drives `AnimationState`,
   constraints, and physics — all CPU-side, renderer-agnostic.
2. At load time each atlas region is cut into its own bitmap (rotation restored), one
   blob URL per region — except regions that already cover their whole page, which are
   used as they are.
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
