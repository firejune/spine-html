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
- **One shared WebGL context** at module level — browsers cap WebGL contexts at
  ~16; never create one per renderer/mesh.
- The mesh dirty-signature cache must stay **Float64** — storing the compared
  f64 values in a Float32Array rounds some of them and leaves those meshes
  permanently re-rastering.
- Mesh canvas backing is **grow-only, quantized, with 25% slack** — writing
  `canvas.width` recreates the GPU surface, and doing that per frame stalled
  real Safari to ~3 fps.
- Element-level features (z-index draw order, SVG-filter tint, mix-blend-mode,
  dirty-skip, backing policy) are backend-agnostic. Keep them out of the raster
  backends.
- **A RegionImage map belongs to the caller, not to a renderer.** Its URLs may
  be blobs from `unpackRegions`, an atlas page passed through whole, or the
  caller's own part PNGs — and one map is normally shared by several renderers
  (the demo does it). So only `revokeRegions` frees anything, and only URLs
  this package minted (the `ownedUrls` ledger in DomTexture.ts). Never revoke
  from `dispose()`.
- `loadSkeletonAssets` is a convenience layer, not a dependency: nothing else
  in `src/` imports it, so it tree-shakes away. Keep it that way, and keep the
  low-level path (TextureAtlas + DomTexture + unpackRegions) fully usable on
  its own — the shapes it does not cover are real (one atlas across several
  skeletons, in-memory images).

## Testing

- `bun run test` — Playwright, chromium + webkit projects; the config builds and
  serves the demo itself (port 4321).
- Parity strategy: **A/B canvas2d-vs-webgl within one run, no golden snapshot
  files** (goldens rot across platforms). The `?expand=0` canary covers seam
  cracks, which sit below the statistical noise floor.
- Rendering is tested through the demo; the **loading path is tested through
  `tests/harness.html`** (a second vite build entry that exposes the library on
  `window.spineHtmlHarness`). Blob-URL ownership has no visual signature, so
  its oracle is the browser: a revoked object URL stops resolving. Keep test
  hooks in the harness, out of the demo.
- Keep `@playwright/test` pinned to a version whose browser revisions match the
  machine's `~/Library/Caches/ms-playwright` before bumping it.

## Workflow

- Conventional Commits, English subject and body. Commit each finished unit
  immediately.
- Pushing to origin is fine (owner-confirmed). `npm version` and `npm publish`
  only on the owner's explicit call — publishing requires the owner's 2FA, so
  stop at the EOTP gate and hand over.

## Known backlog

- Texel-addressing mismatch between backends: the canvas2d path maps UVs with
  `uv * (page.width - 1)` while the GL blitter samples at `uv * page.width` — a
  systematic sub-texel offset, invisible at demo scale but the dominant residue
  in A/B parity diffs. Align on the GL convention when next touching the raster
  paths (and expect parity-test tolerances to tighten).
- `loadSkeletonAssets` reads JSON exports only. Binary (`.skel`) would mean
  importing `SkeletonBinary`, which every user of the loader would then carry —
  worth a separate entry point rather than a branch, if it is ever asked for.
- `loadSkeletonAssets` is one atlas per skeleton. Sharing one atlas across
  several skeletons (what the demo does) still needs the low-level path; a
  `skeletonUrls: string[]` variant would cover it without double-unpacking.
- The mesh tier keeps a page image alive per atlas page (it samples the page
  bitmap every frame), so unloading a skeleton frees the region blobs but not
  the pages. Nothing leaks — the images are the caller's and drop with the
  atlas — but a consumer counting bytes should know the pages are the floor.
