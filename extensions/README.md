# Jx Extensions

Extension packages extend the Jx framework the same way any third-party developer can, using only
the public hooks documented in [specs/extensions.md](../specs/extensions.md).
[`packages/*`](../packages/README.md) is what they extend, and the dependency edge between the two
directories is one-way.

| Package                             | Purpose                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| [`@jxsuite/parser`](./parser)       | Content collections (`content` section), Markdown + CSV formats, relationships        |
| [`@jxsuite/connector`](./connector) | Database connections + dynamic data tables (`connections`/`data`) over `/_jx/data`    |
| [`@jxsuite/auth`](./auth)           | Better Auth sessions, sign-in flows, and table permissions (`auth`) over `/_jx/auth`  |
| [`@jxsuite/feed`](./feed)           | Atom + JSON Feed documents (`feed`) emitted from a content collection at build time   |
| [`@jxsuite/search`](./search)       | Build-time search index (`search`) over content collections + headless browser client |

## Rules

- Extensions may depend on core packages ([`packages/*`](../packages/README.md)) and on each other.
- **Core packages may never depend on extensions**: no runtime dependency, no `src/` import.
  Enforced in CI by [`scripts/check-dep-rules.ts`](../scripts/check-dep-rules.ts); the only
  exceptions are explicit app-level bundling carve-outs allowlisted there with a rationale, and
  [`packages/desktop`](../packages/desktop) is the sole one today. `examples` and `sites/*` are leaf
  apps, which makes them exempt consumers, like a user's own project.
- Each extension ships a `jx-extension.json` manifest (referenced by the `"jx"` field in its
  `package.json`) enumerating its classes and schema fragments, and follows the same conventions as
  core packages: published as TypeScript source under `@jxsuite/*`, `workspace:^` intra-repo deps,
  per-package `bunfig.toml` coverage ratchet, release-please versioning.
- The CI matrix is **derived** from disk by `scripts/ci/affected.ts`, not hand-listed, so a new
  extension needs no workflow edit, but it must ship a `bunfig.toml` with a `coverageThreshold`,
  or the first job in the graph fails the run by name.

## Testing

`bun test --isolate` only; plain `bun test` has known order-dependent failures and is unsupported.

```sh
# from the workspace, so its own bunfig.toml applies
cd extensions/<ext> && bun test --isolate --coverage

# from the repo root
bun scripts/check-coverage-manifest.ts extensions/<ext>
```

## Publishing and versioning

Extension packages ride the monorepo release train exactly like core packages: release-please
manages versions and changelogs per package; intra-repo consumers depend via `workspace:^`. The
raw-TypeScript `exports` shape, the derived publish order and the per-file coverage ratchet are
documented once in [packages/README.md](../packages/README.md).
