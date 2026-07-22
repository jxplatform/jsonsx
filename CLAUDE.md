# Jx Monorepo — Agent Notes

## Testing & Coverage Policy

Every package must keep full unit-test coverage. Enforcement has three layers:

1. **Per-file coverage thresholds** live in each `packages/<pkg>/bunfig.toml`
   (`coverageThreshold = { lines = X, functions = Y }`). Bun enforces these
   **per file**, not as an aggregate — no single source file may fall below
   the bar. Keys must be plural (`lines`/`functions`); singular keys are
   silently ignored by Bun.
2. **Manifest check** — `bun scripts/check-coverage-manifest.ts packages/<pkg>`
   fails if any `src/**/*.ts` file never appears in `coverage/lcov.info`
   (Bun only counts files imported during the run, so a brand-new untested
   file is otherwise invisible to thresholds). Type-only files are allowlisted
   inside the script.
3. **CI** — `.github/workflows/test.yml` runs the per-package matrix (see the
   matrix list in that file): `bun test --isolate --coverage` (cwd = the
   package, so its bunfig applies) plus the manifest check, and a separate
   lint-and-typecheck job. The Bun version is pinned there; bump it together
   with re-baselining thresholds.

Conventions:

- New source files must ship with tests in the same PR (the manifest check
  fails CI otherwise).
- **Ratchet**: when a PR meaningfully raises a package's worst-file coverage,
  raise that package's `coverageThreshold` to just below the new minimum.
  Lowering a threshold requires explicit justification in the PR description.
- Run tests only via `bun test --isolate` (plain `bun test` has known
  order-dependent failures and is unsupported).
- Studio tests: use the shared harness `packages/studio/tests/harness.ts`
  (lit rendering, state/tab resets, in-memory `StudioPlatform` mock, event
  helpers, happy-dom rect stubs). The first import of a DOM test file must be
  `./harness` or `./with-dom.js` — lit-html captures `document` at import time.
- `mock.module()` before importing the module under test; `await import()`
  afterwards for modules with import-time side effects. sharp and
  `electrobun/bun` must always be mocked (sharp is unloadable on NixOS).
- Check per-file coverage with `bun test --isolate --coverage` from the
  package directory; the table prints to stderr.

## Specs & User-Documentation Policy

Specs (`/specs`, §-numbered) are the source of truth; user docs (`/docs`,
published at jxsuite.com/docs) must track shipped behavior. Every plan for a
behavior-changing task MUST include a "Specs & docs" step, and the change set
must land code, spec edits, and docs-page updates together.

- **Before implementing**: consult the relevant spec; update it first when the
  user's request changes contracts (AGENTS.md rule). Edit spec sections IN
  PLACE — never renumber or remove numbered headings; docs `spec:` frontmatter
  anchors them and `bun run docs:check` fails on broken anchors.
- **Find what a change affects**: `bun run docs:sync` maps the working diff to
  the docs pages/spec sections associated with the changed source files (via
  docs `code:` frontmatter and `@docs <slug>` tags in code). A Stop hook and a
  pre-commit advisory run the same check; treat the report as a prompt to
  update or to state explicitly that no update is needed (pure refactors).
- **Docs conventions**: pages carry `title` + `description ≤155 chars` and
  optionally `spec:`/`code:` frontmatter; every page needs a `docs/nav.json`
  entry (CI enforces bijection); `:::doc-note/tip/warning` callouts,
  `:kbd[...]` keys; style guide lives at
  `docs/extending/contributing/docs.md`. Screenshots come only from
  `scripts/screenshots` (never hand-taken).
- **Generated pages** (formula catalog, operators, protocol routes, starters)
  are regenerated via `bun run docs:generate` — never hand-edited; CI diffs
  them. Adding routes/formulas/operators means regenerating in the same PR.
- **Tag new public behavior**: add `@docs <slug>` to the implementing source
  file and list the file in the page's `code:` frontmatter so future changes
  trigger the sync check. `@since` is available for versioned additions.
- **Gates**: `bun run docs:check` (associations), `bun run docs:verify`
  (generated-page drift, clean tree only) — both must stay green.

## Marketing & Claims Policy

Marketing copy (`sites/jxsuite.com/pages/**`) and `README.md` are gated by
`bun run docs:claims` (blocking in CI and `deploy-site.yml`). The rule: a claim
may only exist if it is (a) removed, (b) qualitative and clean of the forbidden
patterns, or (c) pattern-matched **and** carries an allow entry in
`scripts/docs/claims.json` whose `evidence` points at a test, a generated
source, or a spec anchor whose status is `Implemented`. Reword the copy and the
allow entry goes stale, so CI fails until it is re-justified.

- **New numbers need committed evidence.** Never introduce a performance,
  price, or scale figure (`<1s`, `100/100`, `$0/mo`) without a committed
  measurement or an allow entry explaining why it is illustrative. Measured
  numbers come from a benchmark, not from memory.
- **Download links / installer claims** derive from
  `packages/desktop/release-assets.json` — the single source of truth for asset
  filenames and their `signed` status. Only assets marked `signed: true` may be
  described as signed or notarized.
- **Non-mechanizable review items** (checked by hand): Studio-availability
  phrasing must match `docs/start/install.md` (the desktop app is the only
  end-user path to the visual editor; browser Studio is a repo-contributor
  workflow); avoid superlatives ("the only…", "fastest") the checker can't
  verify.
