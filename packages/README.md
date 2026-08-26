# Jx Packages

The core packages are the Jx framework itself. [`extensions/*`](../extensions/README.md) extends Jx
through the public hooks any third party can use; `packages/*` is what gets extended. The dependency
edge between the two is one-way, and it is the rule that defines this directory: see
[specs/extensions.md §2](../specs/extensions.md).

| Package                           | What it is                                                             |
| --------------------------------- | ---------------------------------------------------------------------- |
| [`@jxsuite/schema`](./schema)     | JSON Schema 2020-12 meta-schema generator for Jx documents             |
| [`@jxsuite/runtime`](./runtime)   | JSON-native reactive web component runtime: no virtual DOM, no diffing |
| [`@jxsuite/compiler`](./compiler) | Static HTML compiler, island detector, site builder, plus the `jx` CLI |
| [`@jxsuite/server`](./server)     | Bun dev server: live reload, proxy resolution, Studio backend          |
| [`@jxsuite/studio`](./studio)     | The visual builder, as a backend-agnostic browser application          |
| [`@jxsuite/desktop`](./desktop)   | Studio packaged as a desktop app on Electrobun (an app, not a library) |
| [`@jxsuite/protocol`](./protocol) | Studio Backend Protocol: wire types and the canonical route table      |
| [`@jxsuite/collab`](./collab)     | Co-editing primitives: Y.Doc schema, op bridge, differ, wire envelope  |
| [`@jxsuite/ai`](./ai)             | Streaming LLM client, tool registry, reactive chat state               |
| [`@jxsuite/create`](./create)     | Project scaffolding behind `bun create @jxsuite`                       |
| [`@jxsuite/starters`](./starters) | Starter catalogue: `registry.json` plus one buildable project each     |
| [`@jxsuite/import`](./import)     | Clone a live website into a Jx project                                 |
| [`@jxsuite/markup`](./markup)     | HTML → Jx nodes, Markdown → sanitized HTML                             |
| [`@jxsuite/formulas`](./formulas) | Composite pure formulas authored as declarative `$expression` JSON     |

## Rules

- Core packages may depend on each other. **Core packages may never depend on an extension**: no
  `dependencies`, `peerDependencies`, or `optionalDependencies` entry, and no `@jxsuite/<extension>`
  import from `src/`. `devDependencies` are permitted (test fixtures only), because the publish
  graph uses runtime deps.
- Enforced on every PR by `bun scripts/check-dep-rules.ts` in the ungated `checks` job. The source
  scan is not redundant with the manifest check: Bun hoists workspace packages to the root
  `node_modules`, so an undeclared import would resolve at runtime and pass every test silently. It
  matches import/re-export/`import()`/`require()` specifiers only. A quoted mention in an error
  message is deliberately not a violation.
- The sole carve-out is [`packages/desktop`](./desktop), allowlisted in that script with a
  rationale. An allowlisted directory is skipped for **both** the manifest check and the source
  scan, so a second entry weakens the rule everywhere it applies.
- Intra-repo dependencies are always `workspace:^`.
- Every non-`private` package needs a `LICENSE` file, because `bun run docs:claims` fails without
  one.

## Layout

Each directory is a Bun workspace member through the root `packages/*` glob and carries the same
furniture: `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `bunfig.toml`, `src/` and
`tests/`. Three exceptions are worth knowing before a typecheck surprises you:

- `create` and `starters` keep their sources at the package root (`starters/index.ts`,
  `create/generate.ts`), which is outside the root tsconfig's `packages/**/src/**/*` include, so
  they carry their own `tsconfig.json`. They declare no `typecheck` script, so root
  `bun run typecheck` covers only their tests.
- `desktop` is excluded from the root tsconfig entirely (electrobun ships raw `.ts` in its dist) and
  runs its own `typecheck` script as a separate CI step.
- `packages/*/coverage` and `packages/*/dist` are gitignored, as is
  `packages/starters/sites/*/bun.lock` (the stray install left behind by opening a starter in
  Studio).

## Testing

`bun test --isolate` only; plain `bun test` has known order-dependent failures and is unsupported.

```sh
# from the workspace, so its own bunfig.toml applies
cd packages/<pkg> && bun test --isolate --coverage

# from the repo root
bun scripts/check-coverage-manifest.ts packages/<pkg>
```

Each `bunfig.toml` sets `coverageThreshold = { lines, functions }`, which Bun enforces **per file**,
not as an aggregate. The keys must be plural or Bun ignores them silently.
`coveragePathIgnorePatterns` excludes sibling workspaces on purpose: `../protocol/src/routes.ts`
reads 33% functions inside a consumer's run and 100% under protocol's own, so a sibling's source in
your coverage table is a missing ignore pattern, not a regression.

The CI matrix is **derived** from disk by `scripts/ci/affected.ts`, not hand-listed. A new package
therefore needs no workflow edit, but it must ship a `bunfig.toml` with a `coverageThreshold`, or
the first job in the graph fails the run by name. A suite that reads files outside its own workspace
needs an `EXTRA_EDGES` entry there naming the test that proves it, and those evidence paths are
`existsSync`-checked before any other job starts.

## Publishing and versioning

Every package except `desktop` publishes to npm as raw TypeScript source: `exports` point at `.ts`
files (`./src/*.ts` everywhere but `create` and `starters`, whose sources sit at the package root),
`files` ships those sources, `publishConfig.provenance` is on. `desktop` declares no `exports`,
`main`, `files`, `publishConfig` or `license`, so `scripts/publish-order.ts` drops it from the npm
set. `desktop` ships as installers attached to the `desktop-v*` GitHub release, and still needs a
version and a tag because the bundler workflows check out `desktop-v<version>`. Which of those
installers may be called _signed_ is `packages/desktop/release-assets.json`'s answer, not prose's:
only the macOS DMGs carry `signed: true` today.

Versioning is the monorepo release train: release-please, one component per package.
[`extensions/*`](../extensions/README.md) rides it on the same terms. The component list is checked
against the workspace graph in both directions by `scripts/release-config.test.ts` (two extensions
once sat unlisted, hence the test).
The `runtime`, `parser`, `compiler` and `server` components carry `extra-files` that rewrite the
version ranges shipped inside templates (`packages/starters/sites/*/package.json` and
`packages/create/template-versions.json`) as part of the release commit. Those files are generated:
`bun run templates:check` blocks in CI and `bun run templates:sync` is the fixer. Ranges left to
drift make a starter uninstallable and raise a dependency-update dialog over the canvas.

## Surprises

- **The `jx` binary runs `dist/cli.js`, not `src/`.** Probing compiler behavior through the bin
  without rebuilding silently tests stale code; run `bun run build:compiler` first, or invoke
  `packages/compiler/src/cli.ts` directly.
- **The canonical Bun pin is `.github/actions/setup-bun`**, which is what `test.yml` uses; the other
  workflows still call `oven-sh/setup-bun` with their own copy of the same version, so a bump has to
  reach all of them. Coverage instrumentation shifts between Bun versions, so bumping it also means
  re-baselining every `packages/*/bunfig.toml` in the same PR.
- **Do not restate counts in prose**: not the number of packages here, and especially not the
  number of starters. `bun run docs:claims` reads `packages/starters/registry.json` and fails the
  root README or any marketing page that disagrees; it does not scan package READMEs, so there the
  habit is the only guard.
- **A `bun install`ed starter root shadows this workspace**: it materialises a published
  `@jxsuite/schema` beside the far-ahead local copy. `bun run schema:generate-all` cleans those
  roots first via `scripts/check-shadowed-core.ts --fix`.
