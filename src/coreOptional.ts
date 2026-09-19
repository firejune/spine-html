import type { Skeleton } from '@esotericsoftware/spine-core';
import * as core from '@esotericsoftware/spine-core';

/**
 * Members spine-core only has on *some* supported generations, and the pose
 * call that depends on one of them.
 *
 * ## Why this is not `coreCompat.ts`
 *
 * `src/coreCompat.ts` is the seam the *renderer* reads a posed skeleton
 * through. Nothing here is on that path: posing a skeleton is the caller's job,
 * and this package never does it. What needs it is everything around the
 * library — the demo (`src/main.ts`), the browser harness, the pixel oracle's
 * stage and the benchmark page — all of which drive a skeleton the way a
 * consumer does. So this file is **excluded from the library build**
 * (`tsconfig.build.json`, next to `src/main.ts`) and ships nothing: the list of
 * emitted modules that `tests/package.spec.ts` pins does not contain it, and
 * the day a shipped file imports it that test goes red rather than a stray
 * module going out unnoticed.
 *
 * ## Why the reads go through a string key
 *
 * `Physics` is absent from the root entry of spine-core 4.1 and 4.0. A *named*
 * import of it is a link error there — the whole reason those two runtimes were
 * out of scope before #53 — and `core.Physics` written out is resolved
 * statically by the bundler, which then warns `"Physics" is not exported by …`
 * on every build against them. True of the core, misleading about this code.
 * Read by key off the namespace object, there is nothing for a bundler to
 * resolve and nothing to warn about, and the answer is the same one a feature
 * test would give: the member, or `undefined`.
 */
function optionalExport<T>(name: string): T | undefined {
  return (core as unknown as Record<string, T | undefined>)[name];
}

/**
 * `Physics.update`, or `undefined` on a core that predates physics (4.0, 4.1).
 *
 * Read once, at module load, off the live namespace — never from a version
 * string, which a vendored or bundled copy need not carry.
 */
export const PHYSICS_UPDATE = optionalExport<{ update: unknown }>('Physics')?.update;

/**
 * `Sequence`, or `undefined` where the root entry does not export it.
 *
 * Absent from 4.0 (the feature did not exist) and, measured, missing from the
 * root entry of 4.1 and 4.2 although the class is there — only 4.3 exports it.
 * Used by the region-geometry probe, which has to *construct* spine-core
 * objects; the renderer never does.
 */
export const OPTIONAL_SEQUENCE = optionalExport<new (count: number, wrap: boolean) => unknown>(
  'Sequence',
);

/**
 * Applies a skeleton's world transform, on whichever spine-core is installed.
 *
 * Two calls moved across the supported range:
 *
 * - `Skeleton.update` is 4.2's physics step. 4.1 has no such method at all, and
 *   4.0's is an unrelated clock that only advances `skeleton.time`, so it is
 *   called optionally and is harmless where it exists for the other reason.
 * - `updateWorldTransform` takes a `Physics` from 4.2 on and took nothing
 *   before it, where the extra argument is simply ignored.
 */
export function advanceSkeleton(skeleton: Skeleton, delta = 0): void {
  skeleton.update?.(delta);
  (skeleton.updateWorldTransform as (physics?: unknown) => void)(PHYSICS_UPDATE);
}
