# Third-party notices

## Spine Runtimes

This project depends on `@esotericsoftware/spine-core`, part of the
[Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes),
Copyright (c) 2013-2025 Esoteric Software LLC, licensed under the
[Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license).

Key obligation that propagates to users of this project: integration of the Spine
Runtimes into software (including via this renderer) is permitted **provided that each
user of the resulting product obtains their own Spine Editor license**, and any
redistribution includes the Spine Runtimes license and copyright notice.

`@esotericsoftware/spine-webgl`, the official WebGL runtime, is part of the same
Spine Runtimes and carries the same licence. It is a **development-only
dependency of this repository** and is never shipped: the pixel oracle draws the
same skeleton with it and diffs the two pictures (`tests/oracle.spec.ts`), and
the benchmark page puts the two runtimes side by side (`bench/`). It appears in
`devDependencies` only — not in `dependencies`, not in `peerDependencies` — and
`tests/package.spec.ts` asserts that nothing the published package contains so
much as names it, so installing `spine-html` never brings a second runtime with
it.

## Example assets

The spineboy skeleton exports (JSON and binary), atlas, and images used by the demo
and the tests are owned by Esoteric Software. They are **not redistributed** in this
repository; `scripts/fetch-assets.sh` downloads them from the official spine-runtimes
repository for local evaluation.
