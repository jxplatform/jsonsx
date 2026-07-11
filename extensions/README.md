# Jx Extensions

Extension packages — the packages that extend the Jx framework the same way
any third-party developer can, using only the public hooks documented in
[specs/extensions.md](../specs/extensions.md).

| Package                             | Purpose                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| [`@jxsuite/parser`](./parser)       | Content collections (`content` section), Markdown + CSV formats, relationships       |
| [`@jxsuite/connector`](./connector) | Database connections + dynamic data tables (`connections`/`data`) over `/_jx/data`   |
| [`@jxsuite/auth`](./auth)           | Better Auth sessions, sign-in flows, and table permissions (`auth`) over `/_jx/auth` |

## Rules

- Extensions may depend on core packages (`packages/*`) and on each other.
- **Core packages may never depend on extensions** — no runtime dependency,
  no `src/` import. Enforced in CI by `scripts/check-dep-rules.ts`; the only
  exceptions are explicit app-level bundling carve-outs allowlisted there
  with a rationale (e.g. `packages/desktop`).
- Each extension ships a `jx-extension.json` manifest (referenced by the
  `"jx"` field in its `package.json`) enumerating its classes and schema
  fragments, and follows the same conventions as core packages: published as
  TypeScript source under `@jxsuite/*`, `workspace:^` intra-repo deps,
  per-package `bunfig.toml` coverage ratchet, release-please versioning, CI
  matrix entry.

## Versioning

Extension packages ride the monorepo release train exactly like core
packages: release-please manages versions and changelogs per package;
intra-repo consumers depend via `workspace:^`.
