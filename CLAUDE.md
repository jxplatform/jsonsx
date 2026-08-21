# Jx Monorepo — Agent Notes

## Testing & Coverage Policy

Every workspace must keep full unit-test coverage — `packages/*` core packages and `extensions/*` extension packages (auth, connector, parser, search) alike. Enforcement has three layers:

1.  **Per-file coverage thresholds** live in each workspace's own `bunfig.toml` — `packages/<pkg>/bunfig.toml` and `extensions/<ext>/bunfig.toml` (`coverageThreshold = { lines = X, functions = Y }`). Bun enforces these **per file**, not as an aggregate — no single source file may fall below the bar. Keys must be plural (`lines`/`functions`); singular keys are silently ignored by Bun.
2.  **Manifest check** — `bun scripts/check-coverage-manifest.ts <workspace-dir>` (e.g. `packages/schema`, `extensions/auth`) fails if any `src/**/*.ts` file never appears in `coverage/lcov.info` (Bun only counts files imported during the run, so a brand-new untested file is otherwise invisible to thresholds). Type-only files are allowlisted inside the script.

    An absence is evidence, not a verdict: Bun 1.4.0 has been observed on CI leaving a file out of the report that the same run demonstrably loaded and executed. So a missing file is not failed on sight — the script **re-runs coverage over just the tests that name it** and decides from that. Nothing loads it → still a failure, which is the regression the gate is for; it is exercised → the run's counts are held to the workspace's own `coverageThreshold`, so a rescued file stays gated rather than waved through. Naming a module is not loading it, so a `mock.module()` of an otherwise untested file cannot rescue it. The evidence for the Bun defect is in the header comment of the script; if a rescue warning appears for a file **you** just added, the file is fine and Bun is not.

3.  **CI** — `.github/workflows/test.yml` runs the per-workspace matrix: `bun test --isolate --coverage` (cwd = the workspace, so its bunfig applies) plus the manifest check, alongside an ungated `checks` job (lint, both typechecks, the studio guards, the docs and schema gates) and a gated `lens-mutants` job. The Bun version is pinned once in `.github/actions/setup-bun`; bump it together with re-baselining thresholds.

    The matrix is **derived**, not listed: the `changes` job runs `scripts/ci/affected.ts`, which reads the workspace graph via `scripts/lib/workspaces.ts` and emits the workspaces a diff can reach. Consequences for agents:
    - **Adding a workspace needs no CI edit** — but it must ship a `bunfig.toml` with a `coverageThreshold`, or `affected.ts` fails the run by name.
    - **A suite that reads a file outside its own workspace needs an entry in `EXTRA_EDGES`**, with the test file that proves it. Those anchors are `existsSync`-checked before any other job starts, so moving a cited test reds CI immediately.
    - Push to `main` and `workflow_dispatch` are never gated; only pull requests are.
    - `scripts/**` has no coverage workspace, so its tests run via `bun test --isolate scripts` inside the `changes` job — the gate proves itself before it gates anything. Put new script tests where that finds them.

Conventions:

- New source files must ship with tests in the same PR (the manifest check fails CI otherwise).
- **Ratchet**: when a PR meaningfully raises a workspace's worst-file coverage, raise that workspace's `coverageThreshold` to just below the new minimum. Lowering a threshold requires explicit justification in the PR description.
- Run tests only via `bun test --isolate` (plain `bun test` has known order-dependent failures and is unsupported).
- Studio tests: use the shared harness `packages/studio/tests/harness.ts` (lit rendering, state/tab resets, in-memory `StudioPlatform` mock, event helpers, happy-dom rect stubs). The first import of a DOM test file must be `./harness` or `./with-dom.js` — lit-html captures `document` at import time.
- `mock.module()` before importing the module under test; `await import()` afterwards for modules with import-time side effects. sharp and `electrobun/bun` must always be mocked (sharp is unloadable on NixOS).
- Check per-file coverage with `bun test --isolate --coverage` from the workspace directory (`packages/<pkg>` or `extensions/<ext>`); the table prints to stderr.

## Starter Roots and the Shadowed Core

Iterating a starter inside Studio runs `bun install` in that starter's root, and a starter pins
**published** `@jxsuite/*` versions because it is a template a user scaffolds from. The install
therefore materialises a real `@jxsuite/schema` beside a workspace that is far ahead of it, and
anything resolving from that root reads the published copy. This silently produced a starter entry
schema narrower than the starter's own content for six weeks.

- **`bun run schema:generate-all` cleans first** (`schema:clean-roots` →
  `scripts/check-shadowed-core.ts --fix`). It removes only `node_modules/@jxsuite/*` and the stray
  lockfile; third-party dependencies stay, because the install is what makes the starter preview.
  A workspace **symlink** is never removed — that is `examples/`, a workspace member, and it is the
  correct answer.
- **Never put the cleanup in a starter's `package.json`.** `@jxsuite/starters` publishes `sites/`,
  so those manifests ship to users; a `postinstall` there would delete the dependencies they just
  installed. The monorepo has the workspace being shadowed, so the monorepo owns the cleanup.
- `packages/compiler`'s schema loader is independently hermetic — a first-party `*.json` schema
  resolves from the host or throws — so schema composition is safe regardless. The cleanup defends
  everything else that resolves normally.
- `bun run schema:verify` proves the committed core **and** all 50 per-project entry documents match
  their generators. `schema:validate-all` answers a different question (documents against schemas)
  and cannot see a stale schema.

## Specs & User-Documentation Policy

Specs (`/specs`, §-numbered) are the source of truth; user docs (`/docs`, published at jxsuite.com/docs) must track shipped behavior. Every plan for a behavior-changing task MUST include a "Specs & docs" step, and the change set must land code, spec edits, and docs-page updates together.

- **Before implementing**: consult the relevant spec; update it first when the user's request changes contracts (AGENTS.md rule). Edit spec sections IN PLACE — never renumber or remove numbered headings; docs `spec:` frontmatter anchors them and `bun run docs:check` fails on broken anchors.
- **Every substantive spec edit is a release**: run `bun run spec:bump <spec.md> <major|minor|patch|stable> -m "<what changed>"` — it advances the header + footer version, restamps `**Updated:**`, and prepends a `## Changelog` entry. Then `bun run docs:generate`. `bun run docs:spec-release` blocks in CI when a spec's _body_ changed without a version bump (body = everything but the version/`Updated:`/changelog/footer lines; header and section `Status:` markers count as body). `major` = breaking contract change, `minor` = additive, `patch` = editorial, `stable` = graduate 0.x → 1.0.0. **All specs are pre-1.0**, and at `0.x` the release-please `bump-minor-pre-major` policy applies: `major` moves the minor, `minor`/`patch` both move the patch. Versions and changelogs were reconstructed from git history (anchor-space diff per commit), so entries carry commit SHAs. The `-draft` suffix is derived from `**Status:**` (only non-`Implemented` specs carry it), never chosen by hand. The next version is computed from the higher of the working file and the same spec on `origin/main`, so a branch forked before a release cannot re-mint a version main already used — `spec:bump` says so when the base moves the answer, and `--base <ref>` overrides. Format contract: `specs/README.md`.
- **Find what a change affects**: `bun run docs:sync` maps the working diff to the docs pages/spec sections associated with the changed source files (via docs `code:` frontmatter and `@docs <slug>` tags in code). A Stop hook and a pre-commit advisory run the same check; treat the report as a prompt to update or to state explicitly that no update is needed (pure refactors).
- **Docs conventions**: pages carry `title` + `description ≤155 chars` and optionally `spec:`/`code:` frontmatter; every page needs a `docs/nav.json` entry (CI enforces bijection); `:::doc-note/tip/warning` callouts, `:kbd[...]` keys; style guide lives at `docs/extending/contributing/docs.md`.
- **Generated pages** (formula catalog, operators, protocol routes, starters, implementation status, spec changelog) are regenerated via `bun run docs:generate` — never hand-edited; CI diffs them. Adding routes/formulas/operators, or releasing a spec, means regenerating in the same PR.
- **Tag new public behavior**: add `@docs <slug>` to the implementing source file and list the file in the page's `code:` frontmatter so future changes trigger the sync check. `@since` is available for versioned additions.
- **Standards citations**: every spec with numbered headings carries a `## N. Standards Alignment` table naming each external standard it binds, its conformance class, the section it binds, and committed evidence — the contract is `specs/standards.md`, the gate is `bun run docs:standards`, and the derived page is `docs/extending/reference/standards.md`. A `Pending` row is how a missing standard becomes a tracked gap; its tier is derived from the bound section's `> **Status:**` marker, so "is it built" still has one source of truth. `scripts/docs/standards.json` is the lexicon of citable identifiers and only shrinks in the stale direction. A standard whose owning section does not exist yet cannot be a `Pending` row — it goes on the **adoption backlog** (`specs/standards.md` §11), which names the spec that will own it, so nothing identified is lost between audit and design.
- **The standards adoption program** — the multi-PR effort that built the registry and is closing the gaps it found — has its plan and live status board at [`STANDARDS-ADOPTION.md`](./STANDARDS-ADOPTION.md). Read it before picking up any `gap:` id: it carries the scope decisions already taken, the design for each unstarted phase, and the operational knowledge (verification recipes, browser-verified facts, toolchain traps) that is not derivable from the code.
- **Visual editors damage specs.** A round trip through a WYSIWYG Markdown editor escapes `## 18.` as `## 18\.` and flattens `[<id>](<url>)` to bare text and `**bold**` to plain. The escape is cosmetic and `bun run format:md` removes it (`bun run docs:markdown` fails on it in CI); the flattening is **unrecoverable** and needs `git show <last-good>:<file>`. Both are the same event, so treat a `heading-escaped` report as a prompt to check the file's links and bold survived.
- **Gates**: `bun run docs:check` (associations), `bun run docs:verify` (generated-page drift, clean tree only), `bun run docs:standards` (the alignment tables), `bun run docs:markdown` (visual-editor escapes) — all must stay green.

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
