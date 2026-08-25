---
title: "Working in the monorepo"
description: "Repo layout, running Studio from source, tests, and the conventions the Jx monorepo enforces in CI."
code:
  - scripts/ci/affected.ts
  - scripts/check-schema-freshness.ts
---

# Working in the monorepo

The Jx monorepo ([github.com/jxsuite/jx](https://github.com/jxsuite/jx)) is a Bun workspace.

## Layout

- `packages/` — the `@jxsuite/*` core packages: runtime, compiler, schema, server, studio, desktop, protocol, formulas, collab, ai, markup, import, starters, create.
- `extensions/` — extension packages built on the public hooks: parser (Markdown/CSV formats and content), connector (databases), auth, search, feed.
- `specs/` — the numbered specifications. These are the living source of truth: consult and update them **before** implementing a feature.
- `sites/` — real sites built with Jx, including jxsuite.com.
- `docs/` — this documentation (see [Contributing to these docs](/docs/extending/contributing/docs)).

## Everyday commands

- `bun install` — set up the workspace.
- `bun run dev` — start the dev server and open Studio in a browser.
- `bun test --isolate` (per package) — the supported test mode; plain `bun test` has known order-dependent failures.
- `bun run typecheck`, `bun run lint`, `bun run format` — tsgo, oxlint (all categories at error), oxfmt.

## Testing policy

Every package keeps full unit-test coverage, enforced per file by each package's `bunfig.toml` thresholds plus a manifest check that fails CI when a source file is never imported by any test. New source files ship with tests in the same PR.

## What CI runs, and when

A pull request runs the checks its diff can actually fail. The test matrix is **derived** from the workspace dependency graph rather than listed by hand, so adding a package cannot leave it untested.

To see what your working diff would trigger, before pushing:

```bash
git diff --name-only origin/main... | bun scripts/ci/affected.ts --stdin
```

Three rules decide the scope:

- **A changed package retests its dependents.** Every `@jxsuite/*` package resolves to its `src/` and CI never builds first, so a change to `schema` is observable in every suite downstream of it.
- **Some suites read files outside their own workspace.** Those edges cannot be seen in a `package.json`, so they are declared in `scripts/ci/affected.ts` — each one naming the test file that proves it. Such an edge retests only that one suite, not everything downstream of it.
- **An unrecognised path runs everything.** A new top-level directory costs one full run until someone classifies it, which is the safe direction to be wrong in.

Pushes to `main`, the nightly cron, and manual dispatch are never gated: they always run the full matrix. That is the safety net if a rule above has gone stale, and it keeps each package's coverage baseline current.

`lint`, both typechecks and all the docs and schema gates run **unconditionally**, in one `checks` job. Each is a few seconds and a fresh CI job costs longer than that to start, so gating them would cost time rather than save it.

:::doc-note
`ci` is the aggregate job. It passes when every other job either succeeded or was skipped, and fails if any failed or was cancelled — so a job your diff never reached leaves the run green.
:::

## Generated files are fixed for you, not failed at you

Two things in this repository are build outputs that happen to be committed: the screenshots under `docs/images/`, and every `*schema.json` — the core schemas under `packages/schema/`, and the `project.schema.json` / `document.schema.json` pair in each project root. They are committed because editors, `jx validate` and published npm packages read them off disk, not because anybody writes them by hand.

Both have a CI lane that **regenerates and pushes the result to your branch** rather than turning red and waiting for you:

- **Screenshots** — `.github/workflows/screenshots.yml` re-captures and comments with before/after thumbnails and the docs pages each changed image appears on.
- **Schemas** — `.github/workflows/schemas.yml` runs the generators and comments with the JSON Pointers that moved: `+ /$defs/ClassMethodDef/properties/role/enum/mount` rather than 500 KB of diff.

Locally the same two commands do the same work:

```bash
bun run schema:verify   # is every committed schema what its generator produces?
bun run schema:sync     # regenerate the stale ones
```

:::doc-warning
Never hand-edit a committed schema or a committed screenshot. The next run of either generator overwrites it, and CI will notice. If a pointer in the comment is not a change you meant to make, the fix belongs in the generator or in the source it reads.
:::

Three things make a schema go stale, and only one of them is forgetting to run the generator. The commonest is a **dependency bump**: the core schema injects web-standards data read at generation time from `@webref/css`, `@webref/elements` and `@webref/idl`, so bumping one rewrites the committed core by construction — which is why this lane, unlike the screenshot one, runs on Dependabot's branches too. The third is a **merge race**: two branches can each be green alone and stale together when one moves the core and the other regenerates a project root before it lands. Git merges that without a conflict and no per-branch check can see it, so the lane also watches `main` and opens a pull request when it finds drift there.

`bun run schema:verify` still blocks in CI. The lane cannot push to a fork, and a required check is what keeps a stale schema off `main` when it cannot.

## Releases, branches, and template versions

Versions are release-please's job. Every publishable workspace is a component in `release-please-config.json` with a matching `.release-please-manifest.json` entry, and both lists are **derived-checked** by `scripts/release-config.test.ts` — a package that is publishable but unlisted is never versioned, tagged or published, and nothing else in the pipeline can notice. Two extensions sat in exactly that state before the check existed.

Two branches:

- **`main`** is the trunk. Every PR targets it, and it is the tip of development.
- **`release`** holds only released code. CI fast-forwards it to each `desktop-v*` release commit,
  but only after that release's installers are attached and `nix build` succeeds at the tag. It is what a NixOS user pins (`nix run github:jxsuite/jx/release`), so it must never point at a tree that does not build. Nothing pushes to it by hand.

  The release builds the flake on **two** architectures. Only the x86_64 leg gates the branch; the aarch64 leg is advisory, because it had never been built before and a failure there must not strand the users who do have a working architecture. Promoting it is a one-line change to `advance-release-branch`'s `needs`, and it should happen once arm has been green for a few releases.

  **`release` is also what jxsuite.com serves.** The site deploys from the released tree rather than from the trunk, so the documentation a visitor reads always describes the app they can actually download. The trade is deliberate and worth knowing before you write docs: a page merged to `main` is not public until the desktop component next releases. Pull requests and `main` still build the site — breakage surfaces when you cause it, not on release day — they just publish nothing. To ship documentation ahead of a release, dispatch **Deploy jxsuite.com** manually with `ref: main`.

  Neither the release deploy nor the `release` push is triggered by watching the branch. CI moves `release` with a plain `GITHUB_TOKEN` push, and pushes made with that token do not start workflows — so `deploy-site.yml` is a `workflow_call` that release-please invokes, exactly like the npm publish and the desktop bundlers. An `on: push: branches: [release]` trigger would look correct and never fire once.

### Template dependency ranges are generated

Two places ship `@jxsuite/*` version ranges to people outside this repo, and neither is a workspace, so `bun install` never resolves them:

- `packages/starters/sites/*/package.json` — `@jxsuite/starters` publishes `sites/`, so these are the
  ranges a scaffolded project installs, and the ones Studio installs when it iterates a starter.
- `packages/create/template-versions.json` — the ranges `create` stamps into every project it
  generates, including starter clones, whose `package.json` it rebuilds from scratch.

Both are **generated**. `bun run templates:check` blocks in CI; `bun run templates:sync` is the fixer. Never hand-edit `template-versions.json`.

Keeping them current at release time is release-please's `extra-files`, which rewrites both surfaces **inside the release commit**, so the tree that gets published already carries the right ranges. A jsonpath addressing a scoped key must use the `[?(@property === '@jxsuite/x')]` filter form — the bracket form throws when a section exists without that key, which aborts the run and produces no release PR for any package. A test pins the spelling.

Left to drift, these ranges do more than annoy: a starter naming a version that was never published is one a user cannot install at all, and opening it in Studio raises a dependency-update dialog whose underlay covers the canvas — which is how that dialog ended up baked into 33 committed screenshots.
