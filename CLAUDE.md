# Jx Monorepo — Agent Notes

## Testing & Coverage Policy

Every workspace must keep full unit-test coverage — `packages/*` core packages and `extensions/*` extension packages (auth, connector, parser, search) alike. Enforcement has three layers:

1.  **Per-file coverage thresholds** live in each workspace's own `bunfig.toml` — `packages/<pkg>/bunfig.toml` and `extensions/<ext>/bunfig.toml` (`coverageThreshold = { lines = X, functions = Y }`). Bun enforces these **per file**, not as an aggregate — no single source file may fall below the bar. Keys must be plural (`lines`/`functions`); singular keys are silently ignored by Bun.
2.  **Manifest check** — `bun scripts/check-coverage-manifest.ts <workspace-dir>` (e.g. `packages/schema`, `extensions/auth`) fails if any `src/**/*.ts` file never appears in `coverage/lcov.info` (Bun only counts files imported during the run, so a brand-new untested file is otherwise invisible to thresholds). Type-only files are allowlisted inside the script.
3.  **CI** — `.github/workflows/test.yml` runs the per-workspace matrix (see the matrix list in that file — it interleaves `packages/*` and `extensions/*` entries): `bun test --isolate --coverage` (cwd = the workspace, so its bunfig applies) plus the manifest check, and a separate lint-and-typecheck job. The Bun version is pinned there; bump it together with re-baselining thresholds.

Conventions:

- New source files must ship with tests in the same PR (the manifest check fails CI otherwise).
- **Ratchet**: when a PR meaningfully raises a workspace's worst-file coverage, raise that workspace's `coverageThreshold` to just below the new minimum. Lowering a threshold requires explicit justification in the PR description.
- Run tests only via `bun test --isolate` (plain `bun test` has known order-dependent failures and is unsupported).
- Studio tests: use the shared harness `packages/studio/tests/harness.ts` (lit rendering, state/tab resets, in-memory `StudioPlatform` mock, event helpers, happy-dom rect stubs). The first import of a DOM test file must be `./harness` or `./with-dom.js` — lit-html captures `document` at import time.
- `mock.module()` before importing the module under test; `await import()` afterwards for modules with import-time side effects. sharp and `electrobun/bun` must always be mocked (sharp is unloadable on NixOS).
- Check per-file coverage with `bun test --isolate --coverage` from the workspace directory (`packages/<pkg>` or `extensions/<ext>`); the table prints to stderr.

## Specs & User-Documentation Policy

Specs (`/specs`, §-numbered) are the source of truth; user docs (`/docs`, published at jxsuite.com/docs) must track shipped behavior. Every plan for a behavior-changing task MUST include a "Specs & docs" step, and the change set must land code, spec edits, and docs-page updates together.

- **Before implementing**: consult the relevant spec; update it first when the user's request changes contracts (AGENTS.md rule). Edit spec sections IN PLACE — never renumber or remove numbered headings; docs `spec:` frontmatter anchors them and `bun run docs:check` fails on broken anchors.
- **Every substantive spec edit is a release**: run `bun run spec:bump <spec.md> <major|minor|patch|stable> -m "<what changed>"` — it advances the header + footer version, restamps `**Updated:**`, and prepends a `## Changelog` entry. Then `bun run docs:generate`. `bun run docs:spec-release` blocks in CI when a spec's _body_ changed without a version bump (body = everything but the version/`Updated:`/changelog/footer lines; header and section `Status:` markers count as body). `major` = breaking contract change, `minor` = additive, `patch` = editorial, `stable` = graduate 0.x → 1.0.0. **All specs are pre-1.0**, and at `0.x` the release-please `bump-minor-pre-major` policy applies: `major` moves the minor, `minor`/`patch` both move the patch. Versions and changelogs were reconstructed from git history (anchor-space diff per commit), so entries carry commit SHAs. The `-draft` suffix is derived from `**Status:**` (only non-`Implemented` specs carry it), never chosen by hand. Format contract: `specs/README.md`.
- **Find what a change affects**: `bun run docs:sync` maps the working diff to the docs pages/spec sections associated with the changed source files (via docs `code:` frontmatter and `@docs <slug>` tags in code). A Stop hook and a pre-commit advisory run the same check; treat the report as a prompt to update or to state explicitly that no update is needed (pure refactors).
- **Docs conventions**: pages carry `title` + `description ≤155 chars` and optionally `spec:`/`code:` frontmatter; every page needs a `docs/nav.json` entry (CI enforces bijection); `:::doc-note/tip/warning` callouts, `:kbd[...]` keys; style guide lives at `docs/extending/contributing/docs.md`.
- **Generated pages** (formula catalog, operators, protocol routes, starters, implementation status, spec changelog) are regenerated via `bun run docs:generate` — never hand-edited; CI diffs them. Adding routes/formulas/operators, or releasing a spec, means regenerating in the same PR.
- **Tag new public behavior**: add `@docs <slug>` to the implementing source file and list the file in the page's `code:` frontmatter so future changes trigger the sync check. `@since` is available for versioned additions.
- **Gates**: `bun run docs:check` (associations), `bun run docs:verify` (generated-page drift, clean tree only) — both must stay green.

## Screenshot Policy

Screenshots are never hand-taken and never hand-committed. `docs/images/` and `scripts/screenshots/capture.lock.json` are written only by `bun run screenshots`, which stamps each image's origin; an image whose hash is absent from the lock fails `docs:check`, and a docs page may only reference an image the lock names.

The shot contract (`scripts/screenshots/README.md`, designed in `packages/studio/UX-REDESIGN-PLAN.md` §13) governs what a shot may say, and `bun scripts/check-shot-contract.ts` enforces it on every PR with no browser, in seconds. Two rules decide every judgement call:

1. **A shot may name inputs the app accepts; never values the app derives.** Deltas (`toggle*`), screen coordinates and rendered text are all derived. The manifest contains no CSS or XPath selector, no `wait: {ms}`, and no `toggle*` command id — each is a committed budget that may only ratchet down.
2. **The pipeline may only ask the app to do sooner what the plan already commits to.** Nothing exists in `src/` solely to be photographed. If a shot needs a capability that fails this test, the shot is deleted or replaced by prose — never by a line of application code. A compatibility branch kept alive "so the screenshot manifest keeps working" is a defect.

Two CI lanes, because _the pipeline broke_ and _the documentation is now wrong_ are different events with different owners:

- **`check-shot-contract.ts`** runs on every PR in the `checks` job. It is red when a shot names a command, panel or region the app no longer declares — in the PR that renamed it, naming both sides.
- **The `screenshots` lane** runs on any PR touching `packages/studio/src/**`, `scripts/screenshots/**` or `packages/starters/**`, plus nightly. Its failure mode is a **bot commit, not a red X**: it re-captures, pushes the images and the lock to your branch, and comments with a before/after table and **the docs pages each changed image appears on**. It goes red only on a shot _error_ — a failed `expect`, an unknown id, an unresolvable region, an `idle()` timeout. A picture merely changing is an aesthetic judgement CI cannot make.

**You review pictures and prose; the lane produces bytes.** When the lane reports a changed image, re-read the pages it lists — a moved surface usually means the paragraph beside it is stale too, and no check will ever say so. A screenshot of content the docs pipeline already generates is a bug: every phase asks which shots it can delete before asking which it must re-author.

## Marketing & Claims Policy

Marketing copy (`sites/jxsuite.com/pages/**`) and `README.md` are gated by `bun run docs:claims` (blocking in CI and `deploy-site.yml`). The rule: a claim may only exist if it is (a) removed, (b) qualitative and clean of the forbidden patterns, or (c) pattern-matched **and** carries an allow entry in `scripts/docs/claims.json` whose `evidence` points at a test, a generated source, or a spec anchor whose status is `Implemented`. Reword the copy and the allow entry goes stale, so CI fails until it is re-justified.

- **New numbers need committed evidence.** Never introduce a performance, price, or scale figure (`<1s`, `100/100`, `$0/mo`) without a committed measurement or an allow entry explaining why it is illustrative. Measured numbers come from a benchmark, not from memory.
- **Download links / installer claims** derive from `packages/desktop/release-assets.json` — the single source of truth for asset filenames and their `signed` status. Only assets marked `signed: true` may be described as signed or notarized.
- **Non-mechanizable review items** (checked by hand): Studio-availability phrasing must match `docs/start/install.md` (the desktop app is the only end-user path to the visual editor; browser Studio is a repo-contributor workflow); avoid superlatives ("the only…", "fastest") the checker can't verify.
