---
title: "Working in the monorepo"
description: "Repo layout, running Studio from source, tests, and the conventions the Jx monorepo enforces in CI."
---

# Working in the monorepo

The Jx monorepo ([github.com/jxsuite/jx](https://github.com/jxsuite/jx)) is a Bun workspace.

## Layout

- `packages/` — the `@jxsuite/*` core packages: runtime, compiler, schema, server, studio, desktop, protocol, formulas, collab, ai, markup, import, starters, create.
- `extensions/` — extension packages built on the public hooks: parser (Markdown/CSV formats and content), connector (databases), auth, search, feed.
- `specs/` — the numbered specifications. These are the living source of truth: consult and update them **before** implementing a feature.
- `sites/` — real sites built with Jx, including jxsuite.com.
- `docs/` — this documentation (see [Contributing to these docs](/docs/extending/contributing/docs/)).

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

## Releases, branches, and template versions

Versions are release-please's job. Every publishable workspace is a component in
`release-please-config.json` with a matching `.release-please-manifest.json` entry, and both lists
are **derived-checked** by `scripts/release-config.test.ts` — a package that is publishable but
unlisted is never versioned, tagged or published, and nothing else in the pipeline can notice. Two
extensions sat in exactly that state before the check existed.

Two branches:

- **`main`** is the trunk. Every PR targets it, and it is the tip of development.
- **`release`** holds only released code. CI fast-forwards it to each `desktop-v*` release commit,
  but only after that release's installers are attached and `nix build` succeeds at the tag. It is
  what a NixOS user pins (`nix run github:jxsuite/jx/release`), so it must never point at a tree
  that does not build. Nothing pushes to it by hand.

### Template dependency ranges are generated

Two places ship `@jxsuite/*` version ranges to people outside this repo, and neither is a workspace,
so `bun install` never resolves them:

- `packages/starters/sites/*/package.json` — `@jxsuite/starters` publishes `sites/`, so these are the
  ranges a scaffolded project installs, and the ones Studio installs when it iterates a starter.
- `packages/create/template-versions.json` — the ranges `create` stamps into every project it
  generates, including starter clones, whose `package.json` it rebuilds from scratch.

Both are **generated**. `bun run templates:check` blocks in CI; `bun run templates:sync` is the
fixer. Never hand-edit `template-versions.json`.

Keeping them current at release time is release-please's `extra-files`, which rewrites both surfaces
**inside the release commit**, so the tree that gets published already carries the right ranges.
A jsonpath addressing a scoped key must use the `[?(@property === '@jxsuite/x')]` filter form — the
bracket form throws when a section exists without that key, which aborts the run and produces no
release PR for any package. A test pins the spelling.

Left to drift, these ranges do more than annoy: a starter four majors behind is one a user cannot
install, and opening it in Studio raises a dependency-update dialog whose underlay covers the
canvas — which is how that dialog ended up baked into 33 committed screenshots.

