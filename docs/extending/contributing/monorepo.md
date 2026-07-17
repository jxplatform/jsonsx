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
