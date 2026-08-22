# Releasing

The cut is one click: merge the release pull request. Everything either side of
that click is `.github/workflows/release.yml`, and no npm credential exists on
any machine — the publish authenticates to the registry over OIDC (npm trusted
publishing), so there is no token to leak and no 2FA prompt to answer.

## The loop

Every push to `main` runs `release.yml`, which hands the new commits to
[release-please](https://github.com/googleapis/release-please-action):

- **Nothing releasable since the last tag** → the run does nothing. Commit
  types release-please hides from the changelog (`docs`, `test`, `ci`, `build`,
  `chore`, `refactor`, `style`) do not open a release pull request on their own.
- **Something releasable** → it opens, or updates, a pull request titled
  `release: vX.Y.Z` containing exactly three generated changes: the
  `package.json` version, `CHANGELOG.md`, and `.release-please-manifest.json`.
  `feat` bumps the minor, `fix` and `perf` bump the patch. A `!` or a
  `BREAKING CHANGE:` footer bumps the **minor** while the package is pre-1.0
  (`bump-minor-pre-major`) — 1.0.0 is a deliberate act, not the side effect of
  one commit. To force a version, put `Release-As: 1.0.0` in a commit footer.
- **That pull request is merged** → the merge is a push to `main`, so
  `release.yml` runs again; this time release-please tags `vX.Y.Z`, creates the
  GitHub release, and the same run publishes the package.

Squash-merge the release pull request, so the commit on `main` keeps the
`release: vX.Y.Z` subject this repository has used since v0.2.0.

## One-time setup (owner, GitHub)

**Settings → Actions → General → Workflow permissions → tick "Allow GitHub
Actions to create and approve pull requests."** It is off by default, and while
it is off release-please cannot open the release pull request at all — the run
fails with *GitHub Actions is not permitted to create or approve pull
requests*. Nothing in a workflow file can grant this; it is a repository
setting.

The neighbouring "Workflow permissions" radio can stay on the read-only
default: `release.yml` declares the write scopes it needs per job, and that
elevation is granted (verified in run 32583344688 — the job received Contents,
Issues and PullRequests write under a read-only repository default).

## One-time setup (owner, npmjs.com)

Do this once, before the first automated cut. It cannot be done from here — it
needs the account.

1. npmjs.com → **spine-html** → **Settings** → **Trusted Publisher** →
   *GitHub Actions*.
2. Fill in, exactly (the fields are case-sensitive, and npm does not validate
   them on save — a typo only surfaces as a failed publish):
   - Organization or user: `firejune`
   - Repository: `spine-html`
   - Workflow filename: `release.yml`
   - Environment name: *leave blank* (the workflow declares no environment; a
     value here that the workflow does not match rejects the publish)
   - Allowed actions: `npm publish`
3. After the first successful automated publish — not before — set
   **Settings → Publishing access → Require two-factor authentication and
   disallow tokens**. Trusted publishing keeps working under that setting; it
   is what closes the door behind the classic tokens. Setting it first would
   leave no way back if the OIDC path needs a fix.

Two properties of that configuration are load-bearing in the workflow:

- The publish step must live in **`release.yml`**. Renaming the file, or moving
  the publish into another workflow, breaks the trusted publisher until the
  form is updated to match.
- It must run on a **GitHub-hosted runner**. npm does not support trusted
  publishing from self-hosted runners, so this job never moves to a private
  machine.

## Cutting a release

0. Once, before the first cut: both setup sections above.
1. Land the work on `main` as usual, with conventional-commit subjects. CI runs
   on every push.
2. Wait for the `release` run to open or update the `release: vX.Y.Z` pull
   request.
3. Read the diff — the version and the generated changelog are the whole review.
   Optionally run the suite against the release branch: **Actions → ci → Run
   workflow → `release-please--branches--main`** (see below for why it is not
   automatic).
4. **Merge it.** That is the cut.
5. Watch the second `release` run: it tags, releases, and publishes.
6. Confirm: `npm view spine-html version`, and the npm page shows the
   provenance attestation linking the tarball to the workflow run.

## Why the release pull request has no CI checks

A pull request opened with the default `GITHUB_TOKEN` starts no other workflow
runs — GitHub suppresses that to prevent recursive runs — so `ci.yml` does not
fire on release-please's pull request. The usual fix is a personal access token
or a GitHub App, and this repository deliberately does not use one:

- The base of the release pull request is a commit on `main` that `ci.yml`
  already tested on push.
- The pull request adds only generated version and changelog text. There is no
  source change for a test run to have an opinion about.
- A personal access token with `contents: write` and `pull-requests: write`
  would be the only long-lived credential in the repository — reintroducing the
  class of secret trusted publishing was adopted to remove.
- The publish is not unguarded regardless: `prepublishOnly` runs
  `tsc -p tsconfig.build.json` against the tagged tree, so a type error fails
  the publish rather than shipping.

If a rendered check on the pull request is ever wanted anyway, it takes no edit
to `release.yml`: create a fine-grained personal access token scoped to the
`firejune/spine-html` repository with **Contents: read and write** and **Pull
requests: read and write**, store it as the repository secret
`RELEASE_PLEASE_TOKEN`, and the workflow picks it up
(`secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN`). The cost is a
credential to rotate.

## What was pre-flighted, and what only the first cut can prove

A throwaway branch (run 32583528151) exercised everything in the publish path
that does not touch the registry: `id-token: write` mints an OIDC token with
`aud: npm:registry.npmjs.org` and a `workflow_ref` claim naming the workflow
file — which is the claim npm matches against the trusted publisher, so the
filename in the form and the filename in `.github/workflows/` must agree.
`npm install -g npm@latest` produced npm 12, well past the 11.5.1 that speaks
OIDC. `bun install --frozen-lockfile` plus `prepublishOnly` built the tarball
on the runner: 28 files, `dist/` included by the `files` allowlist even though
git ignores it.

One log detail that looks alarming and is not: the `GITHUB_TOKEN Permissions`
group printed at the start of a job never lists `IdToken`, whether or not the
job requested it. The probe requested `id-token: write`, the group showed only
`Contents: read` / `Metadata: read`, and the token minted anyway.

Only the first real cut can prove the registry side of the exchange, because it
needs the trusted publisher to exist. If it fails on authentication rather than
on a publisher mismatch, the first thing to try is dropping `registry-url` from
the `setup-node` step: it exists only to write an `.npmrc`, and the `.npmrc` it
writes carries a `NODE_AUTH_TOKEN` placeholder that nothing sets.

## If the automation is unavailable

The old path still works and needs nothing from this workflow: `npm version
<patch|minor|major>`, push the commit and the tag, `npm publish`. It publishes
with a classic token and a 2FA one-time password — which is why it stops being
available the moment "require two-factor authentication and disallow tokens" is
switched on. Fix the workflow instead.
