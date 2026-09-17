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
- **One shared WebGL context** at module level — browsers cap WebGL contexts at
  ~16; never create one per renderer/mesh.
- The mesh dirty-signature cache must stay **Float64** — storing the compared
  f64 values in a Float32Array rounds some of them and leaves those meshes
  permanently re-rastering.
- Mesh canvas backing is **grow-only, quantized, with 25% slack** — writing
  `canvas.width` recreates the GPU surface, and doing that per frame stalled
  real Safari to ~3 fps — except on a `pixelRatio` change, which reallocates
  every canvas anyway and therefore re-sizes from the new need alone, so a
  lowered ratio actually shrinks.
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
- The loaders (`loadAtlasAssets.ts`, `loadSkeletonAssets.ts`) are a convenience
  layer, not a dependency: nothing else in `src/` imports them — only
  `loadSkeletonAssets.ts` imports `loadAtlasAssets.ts` — so both tree-shake
  away. Keep it that way, and keep the low-level path (TextureAtlas +
  DomTexture + unpackRegions) fully usable on its own — the shapes they do not
  cover are real (in-memory images, an atlas that is not fetched from a URL).
  `loadAtlasAssets.ts` must not import a skeleton reader: it is the seam a
  binary loader would sit on, and its users must not carry the JSON parser.

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
- Keep `@playwright/test` pinned to a version whose browser revisions match the
  machine's `~/Library/Caches/ms-playwright` before bumping it.

## Workflow

- Conventional Commits, English subject and body. Commit each finished unit
  immediately. The subjects are load-bearing now: release-please reads them to
  pick the next version and to write CHANGELOG.md.
- Pushing to origin is fine (owner-confirmed). Releases are not ours to cut:
  pushing to `main` makes `release.yml` open a `release: vX.Y.Z` pull request,
  and **merging that pull request is the owner's click**. Never merge it, and
  never run `npm version` or `npm publish` by hand — the npm publish happens in
  CI over OIDC. See RELEASING.md.

## Known backlog

- Linux WebKit is the remaining parity outlier, and it is not the texel offset
  (fixing that halved its raw diff but left the shift-tolerant count alone:
  1049 → 1042 bad pixels on hoverboard, maxDelta ~233). Those pixels have no
  in-tolerance match anywhere in the other backend's 3×3, so something real
  differs between canvas2d and GL under that software rasterizer — additive
  blend and premultiplied alpha are the obvious suspects, unmeasured. Its
  badRatio limit stays 26× looser than everyone else's until this is known.
  Numbers: ubuntu CI run 32580117738.
- The loaders read JSON exports only. Binary (`.skel`) would mean importing
  `SkeletonBinary`, which every user of the loader would then carry — so it
  belongs in a separate entry point rather than a branch, and the seam for it
  already exists: `loadAtlasAssets` for the atlas half, a `loadSkeletonBinary`
  beside `loadSkeletonJson` for the read.
