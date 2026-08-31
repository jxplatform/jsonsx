# Jx Scripts

Repo-wide tooling: the gates that enforce this repository's written policies mechanically, the
generators that produce the artifacts those policies check against, the readers they share, and the
screenshot pipeline. No application code lives here. Every file is a CLI a human or a workflow
invokes, a shared reader those CLIs import, a test proving one of them, or committed data
(`docs/claims.json`, `docs/standards.json`, `screenshots/manifest.json`,
`screenshots/capture.lock.json`, `screenshots/fixtures/`) that a gate joins against the real tree.

One design unifies them: **answers are derived from disk, never hand-maintained.** The CI test
matrix comes from the workspace graph, the publish order from `publishConfig` plus release-please's
released-paths output, the screenshot scope from the shot manifest. Where a hand-written list is
unavoidable (a workflow `paths:` filter, release-please's package list), a test checks it against
the derived answer in _both_ directions, so the failure names which side is wrong.

| Directory                       | Contains                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ci/`](./ci)                   | `affected.ts`, which decides what a diff can fail, plus the tests guarding it and `bundle-analysis.yml`'s `paths:` filter                                                        |
| [`docs/`](./docs)               | The docs, link, prose, spec-release, standards and marketing-claims gates; the reference-page generators; `spec:bump`; shared parsers in `lib/`; `claims.json`, `standards.json` |
| [`screenshots/`](./screenshots) | The capture pipeline and the [shot contract](./screenshots/README.md): `run.ts`, `lib/`, `affected.ts`, `thumbnails.ts`, the manifest, the lock, `fixtures/`                     |
| [`lib/`](./lib)                 | `workspaces.ts`, the one reader of the `@jxsuite` workspace graph; `png.ts`, a dependency-free PNG decoder; `unwrap-prose.ts`, the Markdown block parser behind `format:md`      |
| top level                       | The gates answering repo-wide questions (`check-*.ts`), the schema tools, `publish-order.ts`, `normalize-markdown.ts`                                                            |

Nearly every file opens with a doc comment naming the specific failure it exists to prevent, usually
with the incident: a starter shadowed by a published `@jxsuite/schema` for six weeks, twelve
standards rows silently unvalidated after a WYSIWYG round trip, `extensions/search` never published
because it was missing from a list nothing checked. **Those headers are the documentation.** Read
the top of a script before changing it, and put the same kind of header on a new one.

## Gates

The gates in [`docs/`](./docs) are tabulated next to what they guard: the spec ones in
[specs/README.md](../specs/README.md)'s Gates table, the documentation ones (including the
association report `docs:sync`) in [docs/README.md](../docs/README.md)'s, and the marketing-claims
gate `docs:claims` in [sites/README.md](../sites/README.md)'s, beside the copy it scans. The
repo-wide ones live at the top level. Most run in
[`.github/workflows/test.yml`](../.github/workflows/test.yml)'s ungated `checks` job, some as a
bare `bun scripts/…` step and some through the `bun run` alias named beside them. Two do not:
`check-coverage-manifest.ts` runs once per workspace in the gated `test` matrix, and
`publish-order.ts` is not a gate at all. `publish.yml` consumes its stdout.

| Script                                        | Enforces                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-dep-rules.ts`                          | [specs/extensions.md §2](../specs/extensions.md): core packages may not depend on or import an extension                                                                                                    |
| `check-shadowed-core.ts`                      | No project root ships its own `node_modules/@jxsuite/*` shadowing the workspace (`--fix`, aliased `bun run schema:clean-roots`)                                                                             |
| `check-template-versions.ts`                  | Every `@jxsuite` range shipping inside a template names a released version (`bun run templates:check` / `templates:sync`)                                                                                   |
| `check-command-levels.ts`                     | [specs/studio-ui-guidelines.md §12](../specs/studio-ui-guidelines.md): each `menus` placement admits the command's level                                                                                    |
| `check-chrome-budget.ts`                      | Studio chrome caps, observed from the command and panel registries rather than a hand-kept list                                                                                                             |
| `check-shot-contract.ts`                      | Lane 1 of the screenshot gate: no browser, seconds, red in the PR that renamed the command a shot names                                                                                                     |
| `check-image-lock.ts`                         | Every committed PNG is manifest-producible, lock-named, and current (`bun run docs:images:check`)                                                                                                           |
| `check-coverage-manifest.ts`                  | Per workspace: every `src/**/*.ts` file is exercised by some test (run as `bun scripts/check-coverage-manifest.ts <dir>`)                                                                                   |
| `normalize-markdown.ts`                       | `bun run format:md` writes; `bun run docs:markdown` (`--check`) blocks on visual-editor escapes. It also puts each paragraph on one line, a rule dormant behind `--no-wrap` until the repo-wide sweep lands |
| `generate-schemas.ts` / `validate-schemas.ts` | `schema:generate-all` / `schema:validate-all` across every project root, including the shot fixtures                                                                                                        |
| `check-schema-freshness.ts`                   | Every tracked `*schema.json` is what its generator produces (`bun run schema:verify`; `schema:sync` fixes; `schemas.yml` pushes)                                                                            |
| `publish-order.ts`                            | Topological publish order for `publish.yml`, derived from the graph rather than a hand-kept `order` array                                                                                                   |

## How these run

`scripts/` has no `bunfig.toml`. It is not a coverage workspace, has no `coverageThreshold`, and has
no test-matrix entry. Its tests run through one unconditional step at the top of the `changes` job,
deliberately placed **before** `ci/affected.ts` decides anything, so the gate proves itself before
it gates:

```sh
bun test --isolate scripts
```

That is also the command to run locally. It is a substring path filter, not a directory, so it also
picks up `packages/studio/tests/gate-scripts-diff-gaps.test.ts`, which runs a second time in the
studio matrix job.

`check-coverage-manifest.ts` is the one script here that runs a subprocess: when a source file is
missing from the report it re-runs `bun test --coverage` over just the tests that name that file,
because Bun 1.4.0 has been seen dropping a record for a file the run really executed. That path is
only reached when the gate is already failing, so the happy path is still pure lcov reading. Its
header comment carries the evidence. To see what a working diff would trigger:

```sh
git diff --name-only origin/main... | bun scripts/ci/affected.ts --stdin
```

## Rules

- **A new test must live under `scripts/`.** That one step is its only home in CI, because the
  matrix runs `bun test` with cwd inside a workspace.
- **Placement inside `scripts/` is a CI cost decision.** `scripts/ci/**` and
  `scripts/lib/workspaces.ts` are in `affected.ts`'s `GLOBAL` list, so any edit there runs the full
  workspace matrix. `scripts/release-config.test.ts` documents sitting flat in `scripts/` rather
  than `scripts/ci/` for exactly this reason.
- **Export the units behind `if (import.meta.main)`**, so the gate can be tested. Follow
  `docs/check-standards.ts` or `docs/check-site-claims.ts`; `docs/check-doc-refs.ts` predates the
  convention and cannot be imported without running, which is why the byte-level image assertions
  became a separate file instead of more code inside it.
- **Assert your anchors.** `ci/affected.ts`'s `EXTRA_EDGES` each carry the test files proving the
  cross-workspace edge, and `existsSync`-checks them (plus every workspace's `bunfig.toml` and
  every bundle flag) before any decision. Moving a cited test reds the first job in the graph,
  naming both the edge and the fix.
- **One shared reader per graph.** `lib/workspaces.ts` exists because three scripts had grown
  divergent copies of the same `package.json` walk; each caller selects the edge set its question
  needs (`deps` publishes, `devDeps` matters for testing). `docs/lib/spec-status.ts` and
  `docs/lib/standards.ts` play that role for the specs.
- **Studio-specific and server-specific guards do not belong here.** They live in
  `packages/studio/scripts/` and `packages/server/scripts/`, owned by the package they guard.
  `checks` runs `check-pane-singletons.ts` and `check-icons.ts`, and `lens-mutants` runs
  `check-lens-mutants.ts`, all three as `bun --cwd packages/studio scripts/<guard>.ts`;
  `check-bundle-budget.ts` runs from `bundle-analysis.yml` without `--cwd`.
  `packages/server/scripts/check-error-shapes.ts` is server's own `lint:errors` script, and no
  workflow runs it.
- **Budgets ratchet one way.** `check-shot-contract.ts`'s `CONTRACT_BUDGET` and `TOGGLE_DEBT` may
  fall; raising one needs the written justification a lowered coverage threshold needs, and the file
  carries the paragraph for each historical move. `TOGGLE_DEBT` is empty, so any `toggle*` command
  id is a hard error the first time it appears.

## Surprises

- **`bun run typecheck` does not cover this directory.** The root `tsconfig.json` `include` lists
  only `types.d.ts`, `packages/**/src`, `packages/**/tests`, schema's types and defs, and
  `extensions/**/src` + `tests`. Only the few files `packages/studio/tests` imports get typechecked,
  transitively. Everything else here is lint-only.
- **Unknown paths fail open.** A changed file matching no rule in `ci/affected.ts` turns everything
  on rather than quietly narrowing the run. Top-level `scripts/*.ts` files are not classified, so a
  comment fix in `publish-order.ts` costs a full matrix run. `scripts/docs/**` _is_ classified
  (`NO_TESTS`), so a docs-gate edit alone selects no test workspaces.
- **`check-shadowed-core.ts` must run bare and early in CI**, before `schema:verify`, whose
  `schema:generate-all` begins with the same script and `--fix`. Any placement after that makes the
  check a tautology, which is how the condition went six weeks unreported.
- **A `git diff` pathspec is not the generator's output set.** `schema:verify` was a shell one-liner
  that regenerated all seven core schema artifacts and diffed ONE of them; `class-schema.json`,
  `project-schema.json` and the three `schemas/*.schema.json` were rewritten and never read, so a
  stale one passed green. `check-schema-freshness.ts` derives the file set from `git ls-files`
  instead. If you write a gate that regenerates something, diff **everything the run dirtied**, not
  a glob you believe covers it.
- **Committed schemas are written only by `bun run schema:sync`** and by the backfill lane
  ([`schemas.yml`](../.github/workflows/schemas.yml)), the same way `docs/images/` is written only
  by `bun run screenshots`. A hand-edited schema is a contract nothing generated, and the next run
  of either overwrites it.
- **`docs/images/` and `screenshots/capture.lock.json` are written only by `bun run screenshots`**
  and by the Lane 2 bot. A hand-added or hand-edited PNG whose hash has no lock entry is a hard
  failure. See [CLAUDE.md](../CLAUDE.md) and [screenshots/README.md](./screenshots/README.md).
- **`docs/build-llm-export.ts` is not a gate.** It is a post-build step of the jxsuite.com site
  build and writes into `dist/`, so nothing it produces is committed or diffed.
- **`migrate-project-extensions.ts` calls itself disposable but is not yet deletable.**
  `packages/compiler` names it in a user-facing error and asserts on that string in a test.
