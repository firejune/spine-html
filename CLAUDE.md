# CLAUDE.md

Guidance for AI-assisted sessions working on this repository.

## What this is

spine-html renders Spine skeletons as plain DOM — rigid slots as `<img>` posed by
CSS `matrix()`, mesh slots on small per-part canvases (canvas2d or WebGL-blit
backend), interleaved in one stacking context. Production since v0.3.0. Read
README.md for architecture and measured numbers.

## Measurement rules (hard-won — do not relearn these)

- **Headless WebKit is a software rasterizer.** Never cite its timings as Safari
  performance evidence — measured up to 28× off real Safari, in both directions.
  Headless is for visual regression only.
- **The perf oracle is the demo stats line read on a real device** (it shows
  rAF-cadence fps; clicking it copies it). In-callback ms cannot see
  compositor/GPU cost: the Safari clip-AA incident reported 4 ms JS while the
  screen ran at 4 fps.
- Safari antialiases canvas2d **clip paths**, so the per-triangle clip mapping
  pays a per-triangle AA-mask tax in the GPU process. That is why the webgl mesh
  backend exists — switch backends rather than micro-optimizing the canvas2d
  triangle path for Safari.
- Never assert absolute milliseconds in tests; assert the deterministic counters
  (drawn / reused / realloc'd / clips applied / clips skipped / clip-path
  writes) instead.

## Architecture invariants

- `@esotericsoftware/spine-core` is the only math source; renderers only draw.
- **Every spine-core member the renderer reads goes through `src/coreCompat.ts`,
  and the package still compiles against one core.** A Spine runtime reads only
  its own generation's data — 4.3 either refuses an older export or parses it and
  loads **zero** constraints, since it reads one `constraints` array where 4.2
  and older write `ik`/`transform`/`path`/`physics` (measured on a real-world
  corpus: 40% unparseable, 0 of 7,065 constraints loaded across the rest). So
  supporting 4.2 *data* means running on the 4.2 *runtime*, and the peer
  dependency is how the consumer says which. The seam has two shapes: 4.3's pose
  split (`drawOrder.appliedPose`, `slot.appliedPose`, `bone.appliedPose`,
  `Sequence.resolveIndex`/`getUVs`, `RegionAttachment.getOffsets`, the `skeleton`
  argument to `VertexAttachment.computeWorldVertices`, `ClippingAttachment.inverse`)
  and the pre-4.3 one, where all of that sits on the slot, the bone and the
  attachment. **The pre-4.3 shape therefore needs no wrapper object** — a `Slot`
  *is* its own pose view, a `Bone` its own bone pose — which is what keeps the
  seam out of the allocation path; do not "tidy" it into returning literals. The
  shape is picked **once per renderer, from the live objects** (`drawOrder`
  carrying an `appliedPose` array), never per slot by try/catch and never from a
  version string, which a vendored copy need not carry. spine-core stays a single
  4.3 devDependency and `dist/*.d.ts` keeps describing 4.3: the older shape is
  typed by local structural interfaces reached through casts that never leave
  that file, so `tsc --noEmit` is meaningful only in the typed column
  (`SPINE_CORE_MINOR`, playwright.config.ts) while the *shipped* types are
  checked against every column by `tests/package.spec.ts`. **Supported = a green
  CI column against that version's own exports**, and `peerDependencies` is that
  set and nothing wider — widening one without the other is the bug the matrix in
  `.github/workflows/ci.yml` exists to prevent. Two upstream facts that are not
  ours to fix and that decided the range: `Sequence` is absent from 4.2's root
  entry (4.3 exports it), so a *value* import of it is a link error there — see
  `tests/invariants.spec.ts`; and 4.1 and older ship extensionless relative
  specifiers in their own `dist/`, so plain node cannot import 4.0 at all and
  4.1's `.d.ts` fails a nodenext consumer typecheck — which is #16's defect, in
  spine-core.
- Rigid-tier corner order from `computeWorldVertices` is **BL, UL, UR, BR**
  (verified by execution on 4.2.98, 4.2.120 and 4.3.13; the br/bl/ul/ur comments
  inside the upstream function are stale). A node-side test guards this against
  upstream reorderings, on both generations — it is the one place that has to
  *construct* spine-core objects rather than read them, and the constructors
  differ where the seam's reads do not, so it detects the shape itself.
- **Both raster backends address texels as `uv * size`**, the continuous frame
  where the page spans `[0, size]` — `drawImage` under an affine and
  `texture2D()` read the same frame. `uv * (size - 1)` (a discrete
  pixel-index frame) is the bug fixed in #1; it was worth 15–250× in parity
  residue, depending on the scene. No half-texel term: the per-triangle affine
  maps corners, it does not sample.
- **The rigid cut reads the page in that same frame** — the region's bounds
  relative to the declared page size (`region.page.width/height`), times the
  image's natural size, rounded per *edge* so neighbouring cuts keep tiling
  exactly. That is what lets a page ship at a resolution its `size:` line does
  not mention (half-res builds, @2x): spine-core normalizes UVs against the
  declared size and a sampler does not care what resolution the texture has, so
  the mesh tier never noticed, and cutting in declared pixels was the rigid
  tier's private bug (#32). A cut bitmap is therefore the **native resolution**
  of its rect, never upscaled, while `RegionImage.width`/`height` are **atlas
  units whatever the bitmap's resolution** — they are the `<img>` layout box
  and the matrix denominator, so `renderRegion` needs to know nothing about the
  page. The page's declared size missing or zero still means "the image is its
  own declared size". `tests/regions.spec.ts` holds it, on artwork painted
  three times at 0.5×/1×/2× rather than resampled.
- **Alpha convention is per tier, keyed off `page.pma`** (#37). The exporter
  premultiplies by default, so most consumer atlases carry `pma: true` and the
  file's RGB is already multiplied by its alpha. GL then uploads it *without*
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` (its blend already wants premultiplied
  source — lossless); the DOM and canvas2d tiers cannot take it at all, since
  an `<img>` and `drawImage` composite straight alpha by definition, so they
  read one weakly-cached un-premultiplied derivation per page image, shared by
  the region cuts and the canvas2d mesh raster (`straightAlphaSource` in
  DomTexture.ts). Deriving per consumer, or per frame, is the thing to not do.
  The whole-page pass-through never fires for a `pma` page — its URL holds
  premultiplied pixels and would go straight into an `<img>`. The caller's
  image is never mutated, and the derivation is weak, so it needs no free.
  The un-premultiply is 8-bit and starts from a canvas read that has already
  quantized the texel, so it carries a residue no rewrite of the arithmetic
  removes — and **how big that residue is belongs to the rasterizer, not to
  this package**: Linux WebKit reads a premultiplied page several times more
  coarsely than macOS does, and it does not even hold the same numbers in two
  kinds of canvas — the same decoded image read through a `willReadFrequently`
  context and through a plain one differed by one level on 561 channels on the
  CI runner, which the un-premultiply's `× 255/a` carries to 8 (identical on
  Chromium). So `tests/pma.spec.ts` asserts nothing absolute about it, and
  whatever it compares with the derived canvas is made on the library's kind of
  canvas (`libraryKindContext` in the harness), never the harness's usual one.
  It measures that platform's own storage in the same run as **controls** — the
  read side (texels drawn in and read back) and the write side (`putImageData`
  of the value class the un-premultiply produces, read back) — and bounds our
  numbers *relative to them*: the derivation may add `read control + 2` (0.5
  for `round(rgb * 255 / a)` arriving back through × a/255, plus 1 for the
  canvas's own premultiply), may drift no more than the write control at that
  alpha (arithmetic term zero), and a cut the same carried through the
  division's `× 255/a`. **Linux WebKit reddened this spec in CI three runs in a
  row with the repair working perfectly**: twice on an absolute ceiling
  calibrated on macOS — a per-texel precision number read off one platform is
  a platform's number, whatever it is derived from, and the first sweep had
  converted the numbers that had already failed rather than every number of
  that kind — and once on the relative bound that replaced them, because its
  control sat on the other kind of canvas. That platform exists on the CI
  runner only, so what settled it was a one-variable dispatch there, not a
  fourth argument. What is asserted exactly, because it holds anywhere: opaque
  texels are untouched (premultiplying by 255/255 is the identity), alpha is
  never divided, alpha 0 keeps no colour, the derived canvas reads back the
  same as a scratch canvas of its own kind given the same values, and the
  direction — a doubled premultiply can only darken, so the tiers count darker
  and lighter pixels separately, assert that the darker side does not outweigh
  the lighter one, and budget each as a ratio of drawn content, the way the
  parity suite budgets a diff.
- **The canvas2d path draws a per-triangle source sub-rect, never the whole
  page.** Linux WebKit garbles whole-page `drawImage` under steep per-triangle
  affines — measured (displaced texture on head/goggles/foot triangles while
  webgl stayed clean; hoverboard bad pixels 1042 → 2 with the source rect as
  the only variable), mechanism not identified. The rect is derived from the
  clip, not fixed: the expanded clip polygon is carried back through the
  inverse of the per-triangle affine, plus one texel of bilinear support,
  snapped outward to texel boundaries. A fixed pad is wrong because the
  expansion's reach in texture space is `triangleExpand` × the local
  texels-per-canvas-unit, ~0.26 to 8.6 texels across the demo's own meshes.
  The overdraw canary in `tests/parity.spec.ts` is what holds this.
- **Relative imports in `src/` carry `.js`** — `from './DomTexture.js'`, never
  `from './DomTexture'`. TypeScript resolves the `.js` specifier back to the
  `.ts` file under `moduleResolution: "bundler"`, and vite does the same for
  both build entries, so nothing in development notices either way. What
  notices is node: `tsc` emits the specifier *unchanged*, and node's ESM
  resolver requires the extension, so extensionless specifiers shipped a
  package that no plain `node` could import (#16 — `ERR_MODULE_NOT_FOUND`,
  invisible to every bundler and to esm.sh). Building under `NodeNext` is not
  an escape: it does not rewrite specifiers either, it just refuses to compile
  without the `.js` (TS2835). The guard is `tests/package.spec.ts`.
- **One shared WebGL context** at module level — browsers cap WebGL contexts at
  ~16; never create one per renderer/mesh. Because it outlives every renderer,
  its page textures are reference-counted per page (retained as a mesh job is
  queued, released by `dispose()`, deleted at the last release — #15), and the
  cache is keyed weakly by the page image so a forgotten `dispose()` never pins
  the caller's image. A context loss drops both the cache and the count: every
  handle is dead, and the next frames re-upload.
- The mesh dirty-signature cache must stay **Float64** — storing the compared
  f64 values in a Float32Array rounds some of them and leaves those meshes
  permanently re-rastering.
- Mesh canvas backing is **grow-only, quantized, with 25% slack** — writing
  `canvas.width` recreates the GPU surface, and doing that per frame stalled
  real Safari to ~3 fps — except on a `pixelRatio` change, which reallocates
  every canvas anyway and therefore re-sizes from the new need alone, so a
  lowered ratio actually shrinks.
- **`syncPixelRatio()` is caller-invoked only.** It is a forced layout (a hidden
  probe box appended to the root, measured, removed), and the renderer performs
  no layout read per frame — keep it that way. Automatic re-measurement would
  mean one per frame, which is why `pixelRatio: 'auto'` was dropped rather than
  built.
- Element-level features (z-index draw order, SVG-filter tint, mix-blend-mode,
  dirty-skip, backing policy, clipping) are backend-agnostic. Keep them out of
  the raster backends.
- **Clipping is an element-level CSS `clip-path`, written in each element's own
  local frame** — the world polygon through the inverse of the `<img>` matrix
  for rigid slots, minus the canvas translate for mesh slots (`transform-origin`
  is `0 0` on every slot element, which is what lets the matrix be inverted with
  no origin term). Semantics are spine-core's, taken from the official draw
  loops rather than inferred: one active clip at a time, applied through the end
  slot inclusive, and an end slot that is the clip's OWN slot never ends it —
  `clipEnd(slot)` runs *before* `clipStart` on the starting slot and the loop
  then `continue`s past the trailing `clipEnd`, so the starting slot is never
  offered to it (spine-core 4.3.13 `dist/SkeletonRendererCore.js`, and
  `dist/SkeletonRenderer.js` of `@esotericsoftware/spine-webgl` 4.3.13). That
  own-slot case is the whole-skeleton clip, and it takes the **root fast path**:
  one `clip-path` on the root, whose inline value is borrowed and restored (the
  root is the caller's element) — never both root and per-element for one clip.
  Writes are cached per element like `transform`, with coordinates quantized to
  1/1000 of a local unit, so a static clip over a static pose costs zero writes
  per frame. An **inverse** clip keeps a region with a hole in it, which needs
  two rings — `polygon()` is one closed ring and silently turns a box plus a
  polygon into a self-intersecting one whose even-odd fill leaves a wedge along
  the seam, so inverse clips are a two-subpath `path(evenodd, …)` instead.
  Neither raster backend knows any of this exists, and **the mesh
  dirty signature must never start depending on the clip** — a mesh that held
  still has to keep reusing its raster under a moving clip. `tests/clipping.spec.ts`
  holds it, against a screen-space oracle that never touches the local-frame math.
- **A RegionImage map belongs to the caller, not to a renderer.** Its URLs may
  be blobs from `unpackRegions`, an atlas page passed through whole, or the
  caller's own part PNGs — and one map is normally shared by several renderers
  (the demo does it). So only `revokeRegions` frees anything, and only URLs
  this package minted (the `ownedUrls` ledger in DomTexture.ts). Never revoke
  from `dispose()`. The same boundary covers atlas pages — the page image is
  the caller's too, so nothing here nulls `page.texture` or drops a page to
  reclaim memory (the reason step 2 of #7 was declined); a page goes when the
  caller drops the atlas and the skeleton data that reach it.
- **`unpackRegions` starts the region cuts concurrently**, so a failure has to
  account for cuts still in flight: their blobs arrive *after* the error is
  known, and turning those into owned URLs nobody can revoke is a leak with no
  visual signature. The cleanup therefore waits for every started cut before
  revoking and throwing, and the map is built from `atlas.regions` once they
  settle — never from the arrivals — so atlas order and last-duplicate-wins
  survive out-of-order delivery. How many cuts run at once is a private
  backing-pixel budget in DomTexture.ts (a measurement, not a knob: every
  started cut holds its canvas until its blob lands). `tests/regions.spec.ts`
  holds all of it by wrapping `toBlob` — overlap is a count, arrival order is
  chosen rather than raced, and nothing there is timed.
- The loaders (`loadAtlasAssets.ts`, `loadSkeletonAssets.ts`, `binary.ts`) are a
  convenience layer, not a dependency: nothing else in `src/` imports them —
  `loadSkeletonAssets.ts` and `binary.ts` import `loadAtlasAssets.ts`, and that
  is the whole graph — so they all tree-shake away. Keep it that way, and keep
  the low-level path (TextureAtlas + DomTexture + unpackRegions) fully usable on
  its own — the shapes they do not cover are real (in-memory images, an atlas
  that is not fetched from a URL). `loadAtlasAssets.ts` must not import a
  skeleton reader of either kind: it is the seam both readers sit on, and its
  users must not carry a parser they did not ask for.
- **`src/binary.ts` is a separate package entry point** (`spine-html/binary`,
  the `./binary` key in the `exports` map). It is the only file that imports
  `SkeletonBinary`, and **`index.ts` must never re-export it** — that subpath is
  the entire mechanism keeping the second parser out of a JSON-only consumer's
  bundle, and one re-export line undoes it. `tests/package.spec.ts` holds that
  now: it walks the import graph of a freshly built `dist/index.js` and fails if
  anything reachable from it names `SkeletonBinary` or imports `./binary`. A
  re-export costs bundle size, not behaviour, so this used to be a review item
  and a walk to run by hand — it is neither any more.

## Testing

- `bun run test` — Playwright, chromium + webkit projects; the config builds and
  serves the demo itself (port 4321, and it reuses a server already on that port
  outside CI). So concurrent checkouts — worktrees, a second clone — must each
  export their own `TEST_PORT`, or the second run borrows the first one's server
  and tests the wrong tree without going red. `TEST_PORT` also turns reuse off,
  so a busy port fails loudly, and a malformed value is rejected rather than
  silently defaulted back to 4321.
- Parity strategy: **A/B canvas2d-vs-webgl within one run, no golden snapshot
  files** (goldens rot across platforms). Seam cracks get the deterministic
  `?expand=0` canary rather than a screenshot threshold — they score below any
  limit the statistical diff can carry.
- Rendering is tested through the demo; the **loading path is tested through
  `tests/harness.html`** (a second vite build entry that exposes the library on
  `window.spineHtmlHarness`). Blob-URL ownership has no visual signature, so
  its oracle is the browser: a revoked object URL stops resolving. Keep test
  hooks in the harness, out of the demo.
- What npm ships is tested by **`tests/package.spec.ts`, node-side, no
  browser**: it builds the library to a temp directory, assembles a throwaway
  `node_modules/spine-html` there (real manifest, peer symlinked) and imports
  both entry points *by package name* through node's own resolver — the only
  way to exercise the `exports` map, which a relative import of `dist/` would
  bypass entirely. It must **never** build into the repository's own `dist/`:
  during a run `vite preview` is serving the demo out of `dist/` and
  `build:lib` opens with `rm -rf dist`, so a lib build there would pull the
  ground out from under every other spec in the same run. It also pins the
  exact set of files that build emits, because an unreachable file has no other
  signature: `src/main.ts` is the demo's entry, `tsconfig.build.json` compiled
  all of `src/`, and so `dist/main.*` shipped in 0.4.1 and 0.5.0 without any
  resolver, import walk or consumer ever noticing (#24).
- Keep `@playwright/test` pinned to a version whose browser revisions match the
  machine's `~/Library/Caches/ms-playwright` before bumping it.
- **CI runs the whole suite once per supported spine-core minor**, each column
  installing that minor over the lockfile's (`bun add --no-save` — writes
  node_modules, leaves `package.json` and `bun.lock` alone, and the column
  asserts both) and fetching that spine-runtimes branch's exports
  (`SPINE_ASSETS_BRANCH`, which also stamps `public/spineboy` so a branch switch
  refetches from clean rather than mixing two generations). Locally:
  `SPINE_ASSETS_BRANCH=4.2 bun run fetch-assets`, `bun add --no-save
  '@esotericsoftware/spine-core@4.2'`, then `SPINE_CORE_MINOR=4.2 bun run test`
  — and `bun install --frozen-lockfile` afterwards to put 4.3 back. **Do not
  fork an expectation per version to make a column green.** The spineboy export
  is structurally identical on all four branches (52 slots, 66 region + 12 mesh +
  1 clipping attachment, the same 11 animations including `portal`), so slot
  counts, mesh counts and animation names need no keying at all; what genuinely
  moves is the *pose*, which is why the part-mask cell's non-vacuity guard is a
  proportion of drawn content rather than a pixel count — it alone clips with the
  asset's own polygon. An absent *feature* gets a feature test, not a version key
  (`INVERSE_CLIPPING` in `tests/clipping.spec.ts`).

## Workflow

- Conventional Commits, English subject and body. Commit each finished unit
  immediately. The subjects are load-bearing now: release-please reads them to
  pick the next version and to write CHANGELOG.md.
- Pushing to origin is fine (owner-confirmed), and **so is merging** (owner
  decision, 2026-09-18; until v0.4.1 the release was the owner's click, and
  v0.5.0 was the first cut made under this rule): a feature pull request once
  its checks are green, and the `release: vX.Y.Z` pull request `release.yml`
  keeps open after every push to `main`. Merging that one is the cut, and the
  call belongs to the session that landed the work. Make it from the tree, not
  from the generated diff: what `npm pack --dry-run` ships, whether the headline
  change is reachable by a consumer, whether the release reversed itself — get a
  green on the release commit first (RELEASING.md says how), and say in the
  release notes what was not measured. Read the checks, then merge as a separate
  command; never chain the two. After the cut, verify the published artifact,
  not the workflow's word: the registry version, the provenance attestation, and
  an import of both entry points by package name from a clean directory. What
  stays the owner's: issues filed by outside contributors, and anything that
  leaves the repository (posts, contacts, spending). Never run `npm version` or
  `npm publish` by hand — the publish happens in CI over OIDC.

## Known backlog

- Linux WebKit is no longer a parity outlier — it was canvas2d drawing the
  whole atlas page per triangle, and the source sub-rect above retired both the
  residue and that platform's 26×-looser badRatio limit. What stays open is
  **why**: the mechanism inside that rasterizer is not identified, and it
  reproduces on the CI runner only. `PARITY_DUMP=1` is the instrument if it
  resurfaces.
