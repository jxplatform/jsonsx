---
title: "Working in the monorepo"
description: "Repo layout, running Studio from source, tests, and the conventions the Jx monorepo enforces in CI."
---

# Working in the monorepo

The Jx monorepo ([github.com/jxsuite/jx](https://github.com/jxsuite/jx)) is a Bun workspace.

## Layout

- `packages/` — the `@jxsuite/*` core packages: runtime, compiler, schema, server, studio, desktop, protocol, formulas, collab, ai, markup, import, starters, create.
- `extensions/` — extension packages built on the public hooks: parser (Markdown/CSV formats and content), connector (databases), auth.
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
