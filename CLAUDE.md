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
  (drawn / reused / realloc'd / clips skipped) instead.

## Architecture invariants

- `@esotericsoftware/spine-core` is the only math source; renderers only draw.
- Rigid-tier corner order from `computeWorldVertices` is **BL, UL, UR, BR**
  (verified by execution on 4.2.98 and 4.3.13; the br/bl/ul/ur comments inside
  the upstream function are stale). A node-side test guards this against
  upstream reorderings.
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
  dirty-skip, backing policy) are backend-agnostic. Keep them out of the raster
  backends.
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
