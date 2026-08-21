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

## Testing

- `bun run test` — Playwright, chromium + webkit projects; the config builds and
  serves the demo itself (port 4321).
- Parity strategy: **A/B canvas2d-vs-webgl within one run, no golden snapshot
  files** (goldens rot across platforms). The `?expand=0` canary covers seam
  cracks, which sit below the statistical noise floor.
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
