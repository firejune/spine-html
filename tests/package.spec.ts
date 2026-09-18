import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { UNTYPED_CORE } from '../playwright.config';

/**
 * What npm ships, checked the way a consumer meets it — node-side, no browser.
 *
 * The package is DOM-only at *run* time, but an *import* must succeed outside
 * a browser: anything that leaves spine-html external and hands it to Node (a
 * server-side render pass importing a module that imports it, a test runner in
 * a node environment, a plain script) resolves it with Node's ESM resolver,
 * which — unlike every bundler — requires an explicit file extension on a
 * relative specifier. That is issue #16: `dist/*.js` carried extensionless
 * specifiers and `import('spine-html')` died with ERR_MODULE_NOT_FOUND, while
 * the demo, the harness and every browser build resolved it fine.
 *
 * ⚠️ This spec must NEVER build into the repository's own `dist/`. During a
 * Playwright run `vite preview` is serving the demo out of `dist/`, and
 * `build:lib` starts with `rm -rf dist` — a lib build here would pull the
 * ground out from under every other spec in the same run. So the library is
 * built to a temp directory instead, and assembled there into a throwaway
 * installed-package layout (`node_modules/spine-html` + the peer), which is
 * also the only way to exercise the `exports` map: resolution by *package
 * name* is the thing under test, and a relative import of `../dist/index.js`
 * would not touch `exports` at all.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/** The throwaway consumer directory; `node_modules/spine-html` lives under it. */
let sandbox = '';
/** The built package's `dist` inside that sandbox. */
let pkgDist = '';

/**
 * `process.execPath` is the node that runs the Playwright worker — real node
 * even when the suite was launched through `bunx`, which only resolves the
 * CLI. It matters: bun's resolver accepts extensionless specifiers, so
 * spawning bun here would make every assertion below vacuous.
 */
function node(args: string[], cwd: string) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
}

/**
 * Same, but concurrent — the two typecheck passes below are the slow part of
 * this file and they do not touch each other, so they run side by side.
 */
function nodeAsync(args: string[], cwd: string): Promise<{ status: number | null; output: string }> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, args, { cwd });
    let output = '';
    const collect = (chunk: unknown) => {
      output += String(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (status) => settle({ status, output }));
  });
}

/** Writes a probe module into the sandbox and runs it there. */
function probe(name: string, source: string) {
  const file = resolve(sandbox, name);
  writeFileSync(file, source);
  return node([file], sandbox);
}

test.beforeAll(() => {
  sandbox = mkdtempSync(resolve(tmpdir(), 'spine-html-pkg-'));
  const pkgRoot = resolve(sandbox, 'node_modules', 'spine-html');
  pkgDist = resolve(pkgRoot, 'dist');
  mkdirSync(pkgRoot, { recursive: true });

  // One build, shared by every assertion in this file.
  //
  // `--noCheck` outside the typed column: this spec is about what npm *ships*,
  // and under an older spine-core a type check of `src/` reports the generation
  // difference `src/coreCompat.ts` exists to absorb — which would take the
  // whole file down on the one thing it is not asking about. It still emits
  // everything, declarations included, and the emit is the same emit: measured
  // on spine-core 4.2.120, `--noCheck` produced files byte-identical to the
  // fully-checked 4.3 build. So every assertion below — the `exports` map, the
  // import walk, the emitted file set, and the consumer typecheck against the
  // *shipped* `.d.ts` — is a real one in every column. The typed column is
  // unchanged and still fails here on a type error.
  const built = node(
    [
      tscBin,
      '-p',
      resolve(repoRoot, 'tsconfig.build.json'),
      '--outDir',
      pkgDist,
      ...(UNTYPED_CORE ? ['--noCheck'] : []),
    ],
    repoRoot,
  );
  expect(built.status, `tsc -p tsconfig.build.json failed:\n${built.stdout}${built.stderr}`).toBe(0);

  // The repository's real manifest, so the `exports` map under test is the
  // shipped one rather than a copy that can drift from it.
  cpSync(resolve(repoRoot, 'package.json'), resolve(pkgRoot, 'package.json'));

  // The peer, made resolvable from the installed package. 'junction' is
  // ignored on POSIX and is what lets this work on Windows without elevation.
  const scope = resolve(sandbox, 'node_modules', '@esotericsoftware');
  mkdirSync(scope, { recursive: true });
  const peer = resolve(repoRoot, 'node_modules', '@esotericsoftware', 'spine-core');
  try {
    symlinkSync(peer, resolve(scope, 'spine-core'), 'junction');
  } catch {
    cpSync(peer, resolve(scope, 'spine-core'), { recursive: true });
  }

  // Makes the sandbox an ESM package of its own, so nothing above the temp
  // directory can decide how these probes are parsed.
  writeFileSync(
    resolve(sandbox, 'package.json'),
    `${JSON.stringify({ name: 'spine-html-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
});

test.afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test('the package entry resolves by name in node and exposes its public API', () => {
  const run = probe(
    'probe-index.mjs',
    "const m = await import('spine-html');\nconsole.log(JSON.stringify(Object.keys(m).sort()));\n",
  );
  expect(run.status, `import('spine-html') failed:\n${run.stderr}`).toBe(0);
  // Exhaustive on purpose: what the root entry exports is load-bearing, since
  // keeping the binary reader out of it is the whole point of the subpath.
  expect(JSON.parse(run.stdout)).toEqual([
    'DomTexture',
    'SpineHtmlRenderer',
    'loadAtlasAssets',
    'loadSkeletonAssets',
    'loadSkeletonJson',
    'revokeRegions',
    'unpackRegions',
  ]);
});

test('the binary entry resolves by name in node and exposes loadSkeletonBinary', () => {
  const run = probe(
    'probe-binary.mjs',
    "const m = await import('spine-html/binary');\nconsole.log(JSON.stringify(Object.keys(m).sort()));\n",
  );
  expect(run.status, `import('spine-html/binary') failed:\n${run.stderr}`).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual(['loadSkeletonBinary']);
});

test('an unlisted subpath is refused by the exports map', () => {
  // The control for the two tests above: it is the `exports` map they are
  // going through, not a bare directory walk that would resolve anything.
  const run = probe(
    'probe-subpath.mjs',
    "try {\n  await import('spine-html/dist/DomTexture.js');\n  console.log(JSON.stringify({ code: 'RESOLVED' }));\n} catch (error) {\n  console.log(JSON.stringify({ code: error.code }));\n}\n",
  );
  expect(run.status, `probe crashed:\n${run.stderr}`).toBe(0);
  expect(JSON.parse(run.stdout).code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
});

/**
 * The modules the library build is supposed to emit — the whole of `dist/`,
 * which is the whole of what `files` ships apart from NOTICE.md.
 */
const EMITTED_MODULES = [
  'DomTexture',
  'MeshGlBlitter',
  'SpineHtmlRenderer',
  'binary',
  'coreCompat',
  'index',
  'loadAtlasAssets',
  'loadSkeletonAssets',
];

test('the library build emits those modules and nothing else', () => {
  /**
   * Issue #24: `tsconfig.build.json` compiles `src/**` and the demo's entry
   * point lives there too, so `dist/main.js` (11 kB) + `.d.ts` + both maps
   * rode into the published 0.4.1 and 0.5.0 tarballs. Nothing could reach
   * them — `main` is not a key in the `exports` map and no shipped module
   * imports it — which is exactly why every other assertion in this file
   * stayed green over two releases while 11 kB of the 76 kB of JavaScript in
   * the tarball was dead weight, and the one file in `dist/` whose top level
   * touched the DOM. Unreachable is not a signature, so the guard has to be
   * the emitted list itself, not anything a resolver or an import walk sees.
   *
   * Recursive, so a stray that lands in a subdirectory is caught too — `dist/`
   * being flat is part of what ships.
   */
  const emitted = readdirSync(pkgDist, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .sort();

  // The defect itself, named first, so its return reds out on the assertion
  // that explains it rather than on the set comparison below.
  expect(emitted.filter((file) => /(^|\/)main\./.test(file))).toEqual([]);

  // The payload, as an explicit set: the next file to wander in fails here
  // instead of shipping unnoticed for two more releases.
  expect(emitted.filter((file) => file.endsWith('.js'))).toEqual(
    EMITTED_MODULES.map((name) => `${name}.js`).sort(),
  );

  // And the rest of it — types and both map kinds accompany every module, so
  // this also pins `declaration` / `declarationMap` / `sourceMap` staying on.
  expect(emitted).toEqual(
    EMITTED_MODULES.flatMap((name) => [
      `${name}.d.ts`,
      `${name}.d.ts.map`,
      `${name}.js`,
      `${name}.js.map`,
    ]).sort(),
  );
});

/** Strips `//` and `/* *\/` comments without eating string or template contents. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (quote) {
      if (c === '\\') {
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Module specifiers of every static import / re-export in `code`. */
function specifiers(code: string): string[] {
  const pattern =
    /(?:\bimport\b|\bexport\b)[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  return [...code.matchAll(pattern)].map((match) => (match[1] ?? match[2]) as string);
}

interface GraphNode {
  file: string;
  /** Comment-stripped source: what the bundler sees, not what a grep sees. */
  code: string;
  relative: { spec: string; target: string | null }[];
}

/**
 * Transitive relative-import graph of `entry`, resolved the way node's ESM
 * resolver does it: a relative specifier is a path, taken literally, with no
 * extension guessing. So an extensionless specifier shows up here as
 * unresolved — the same fact node reports as ERR_MODULE_NOT_FOUND.
 */
function walkGraph(entry: string): Map<string, GraphNode> {
  const seen = new Map<string, GraphNode>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    const graphNode: GraphNode = { file, code, relative: [] };
    for (const spec of specifiers(code)) {
      if (!spec.startsWith('.')) continue;
      const path = resolve(dirname(file), spec);
      const target = existsSync(path) ? path : null;
      graphNode.relative.push({ spec, target });
      if (target) queue.push(target);
    }
    seen.set(file, graphNode);
  }
  return seen;
}

test('nothing reachable from the root entry carries the binary reader', () => {
  // `src/binary.ts` is a separate entry point so that a JSON-only consumer
  // never bundles SkeletonBinary, a second parser. One re-export line in
  // index.ts silently undoes that — it costs bundle size, not behaviour, so
  // nothing else in the suite would notice. This is the machine that does.
  const graph = walkGraph(resolve(pkgDist, 'index.js'));
  const name = (file: string) => relative(pkgDist, file);

  // The separation itself, first — so a regression reds out on the assertion
  // that names it rather than on one of the guards below it.
  expect(
    [...graph.values()]
      .filter(
        (n) =>
          /SkeletonBinary/.test(n.code) ||
          n.relative.some((r) => /(^|\/)binary\.js$/.test(r.spec)),
      )
      .map((n) => name(n.file)),
  ).toEqual([]);
  expect([...graph.keys()].map(name)).not.toContain('binary.js');

  // Control: the parser does exist, behind the subpath — so the assertions
  // above mean "kept out", not "not built".
  expect(existsSync(resolve(pkgDist, 'binary.js'))).toBe(true);
  expect(stripComments(readFileSync(resolve(pkgDist, 'binary.js'), 'utf8'))).toContain(
    'SkeletonBinary',
  );

  // Every relative specifier is one node can actually load. This is issue #16
  // itself, caught statically rather than through a spawned import.
  expect(
    [...graph.values()].flatMap((n) =>
      n.relative.filter((r) => !r.target).map((r) => `${name(n.file)} -> ${r.spec}`),
    ),
  ).toEqual([]);

  // Non-vacuity: the walk really traversed the package, it did not stop at
  // the entry and declare victory over an empty graph.
  expect([...graph.keys()].map(name).sort()).toEqual([
    'DomTexture.js',
    'MeshGlBlitter.js',
    'SpineHtmlRenderer.js',
    'coreCompat.js',
    'index.js',
    'loadAtlasAssets.js',
    'loadSkeletonAssets.js',
  ]);
});

test('the emitted types resolve under both bundler and nodenext', async () => {
  // The .js in the source specifiers has to survive into the .d.ts too: a
  // node16/nodenext consumer resolves `./DomTexture.js` to `./DomTexture.d.ts`
  // and rejects the extensionless form with TS2835.
  writeFileSync(
    resolve(sandbox, 'consumer.ts'),
    [
      "import { DomTexture, loadAtlasAssets, loadSkeletonAssets, loadSkeletonJson, revokeRegions, SpineHtmlRenderer, unpackRegions } from 'spine-html';",
      "import { loadSkeletonBinary } from 'spine-html/binary';",
      'export const surface = [SpineHtmlRenderer, DomTexture, unpackRegions, revokeRegions, loadAtlasAssets, loadSkeletonAssets, loadSkeletonJson, loadSkeletonBinary];',
      '',
    ].join('\n'),
  );

  const modes = [
    ['ESNext', 'bundler'],
    ['NodeNext', 'nodenext'],
  ] as const;

  for (const [moduleKind, moduleResolution] of modes) {
    writeFileSync(
      resolve(sandbox, `tsconfig.${moduleResolution}.json`),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: moduleKind,
            moduleResolution,
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            strict: true,
            noEmit: true,
            // Deliberately NOT skipped. Measured: with skipLibCheck on, a
            // fully extensionless dist/ typechecks clean under nodenext too —
            // the TS2835s are raised inside the shipped .d.ts, and that is
            // precisely the file skipLibCheck stops reading. Turning it on
            // here would cost ~3× less time and catch nothing.
            skipLibCheck: false,
          },
          files: ['consumer.ts'],
        },
        null,
        2,
      ),
    );
  }

  // Concurrent: two independent tsc processes, so the slow assertion in this
  // file costs one typecheck of wall time rather than two.
  const runs = await Promise.all(
    modes.map(async ([, moduleResolution]) => ({
      moduleResolution,
      result: await nodeAsync(
        [tscBin, '--noEmit', '-p', resolve(sandbox, `tsconfig.${moduleResolution}.json`)],
        sandbox,
      ),
    })),
  );
  for (const { moduleResolution, result } of runs) {
    expect(
      result.status,
      `tsc under moduleResolution=${moduleResolution} failed:\n${result.output}`,
    ).toBe(0);
  }
});
