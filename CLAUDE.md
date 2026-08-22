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

## Dependency Autopilot

Dependencies update themselves and merge themselves. `.github/dependabot.yml` opens the pull requests, `.github/workflows/dependabot-auto-merge.yml` hands each one to GitHub's auto-merge, and the `ci` required status check on `main` is the only thing that decides. Nothing in the chain relaxes a check — the design is "let the suite be the reviewer", so a broken update is a red X and a stalled pull request, and the answer to one is more test coverage rather than a carve-out.

Three ecosystems, deliberately NOT consolidated into one pull request. `multi-ecosystem-groups` exists and is the wrong trade here: `.github/**` reaches no test workspace while `bun.lock` is in `affected.ts`'s GLOBAL list, so merging them would make every action version bump pay for a full run of the test suite.

| Ecosystem        | Cadence          | Grouping                   | What one pull request costs       |
| ---------------- | ---------------- | -------------------------- | --------------------------------- |
| `github-actions` | daily (weekdays) | one group, everything      | `checks` only                     |
| `bun`            | daily (weekdays) | minor+patch / major, split | the full ~22-job matrix, plus Nix |
| `nix`            | weekly           | one group, all four inputs | the Nix build only                |

The `bun` entry is a SINGLE root entry and covers all 21 workspace manifests — Dependabot expands the root `workspaces` globs itself and rewrites every member's `package.json`. `directories: ["/packages/*"]` would be wrong: a sub-directory bun job resolves the same root `bun.lock` upward, which is the "overlap in directories" the documentation forbids, and produces duplicate pull requests.

### bun.nix lags between releases, on purpose

`bun.nix` is a pure function of `bun.lock`, so every bun update makes it stale by construction — and **no bot can fix it on the Dependabot branch**. A push made with `GITHUB_TOKEN` raises no `pull_request` event, so the new head gets zero check runs and could never satisfy a required check. That is measured, not assumed: PR #131 carries a `github-actions[bot]` commit whose head still reports `state=pending` with no checks at all.

So the invariant moved. `bun.nix` matches `bun.lock` **at every release**, not at every commit:

- `bun run nix:check` / `bun run nix:sync` (`scripts/check-bun-nix.ts`) is the ONE definition of "regenerate bun.nix" — shared by the devShell's `update-nix-hashes`, both workflows below, and the root `postinstall`. It names the packages that moved instead of leaving a 289 KB diff to read.
- `nix.yml` regenerates it **in the working tree** before every build, so the Nix check on a dependency pull request answers _does this dependency set build?_ rather than going red on a generator nobody could have run.
- `.github/workflows/release-bun-nix.yml` commits the regenerated file to the **release pull request** — the branch that becomes the tag, and one a human is already watching.
- `nix.yml`'s release leg (`publish: true`) runs the check BARE. A drift there is a failure, not a fixup: if the sync ever fails to land, the release build fails, `release` does not advance, and release-please opens an issue. A stale `bun.nix` cannot reach a user.

### The Nix build is part of `ci`

`nix.yml` no longer has an `on: pull_request` trigger. A path-filtered workflow can never be a required check — it leaves the check pending forever when it does not fire — so test.yml (which has no `paths:` filter, and must never grow one) owns the pull-request leg via `workflow_call`, gated on `affected.ts`'s `NIX_INPUTS`, and the `ci` aggregate requires it. That is what lets a dependency bump which breaks packaging block its own auto-merge.

`flake.nix`, `flake.lock` and `bun.nix` moved OUT of `affected.ts`'s GLOBAL list in the same change: no test suite reads them, so a weekly flake-input bump now runs the Nix build and nothing else instead of spending the whole matrix.

### Settings, not code

Two things live in repository settings and cannot be asserted from the tree:

1.  **Allow auto-merge** (Settings → General → Pull requests). Without it the mutation errors out.
2.  **A ruleset on `main`** requiring a pull request and the `ci` status check, enforced for everyone. This is load-bearing, not hygiene: `gh pr merge --auto` FAILS OPEN — with no required check it performs an ordinary merge instead, and it treats `UNSTABLE` (non-required checks red) as immediately mergeable. That is why the workflow calls the `enablePullRequestAutoMerge` mutation, which errors rather than merging, and asserts the ruleset exists before delegating to it.

No secret is involved. On a Dependabot event `secrets.*` resolves against the separate Dependabot store, so a secret referenced in that workflow would arrive as an empty string — a failure that reads like a malformed value rather than a missing one.

### Traps that are quiet rather than loud

- **`bun.lock` must stay at `lockfileVersion: 1`.** Dependabot's updater image pins Bun 1.3.14, which refuses version 2 — Bun 1.4's default for a lockfile written from scratch. The failure is `DependencyFileNotSupported`, i.e. bun updates simply stop arriving. `scripts/dependabot-config.test.ts` asserts this, along with everything else in this section that can be asserted from the tree.
- **A `GITHUB_TOKEN` merge starts no `push` workflows.** release-please and the Nix cache-warming build are both `push: main`, and auto-merge merges as `GITHUB_TOKEN` — so both now also run on a schedule. Without that the release pull request would silently stop picking up commits and the Actions cache on `main` would go cold.
- **A three-day cooldown applies to every version update** whether or not it is configured, and the days keys cannot be set to zero. `cooldown: { exclude: ["*"] }` is the documented lever for zero delay; it trades away the supply-chain quarantine, so it is not the default here.
- **Release-only workflows are unexercised.** `bundle-desktop-*`, `build-msix` and `publish` are `workflow_call`-only, so an action bump inside them is first executed during a real release. Accepted deliberately — that pipeline already fails loudly and opens issues — but it is the one place where a green `ci` does not mean "tested".
- **`@jxsuite/*` is ignored** for the bun ecosystem. release-please owns those ranges (it rewrites them inside the release commit via `extra-files`, and `bun run templates:check` gates them), so a Dependabot bump would be a second writer on the same line.

## Releases, and the two ways one silently does not happen

release-please owns every version, tag, changelog and npm publish (`release-please-config.json`,
`.release-please-manifest.json`, `.github/workflows/release-please.yml`). Both of its failure modes
exit 0, which is why each now has a gate.

### A raw `<tag>` in a commit subject deletes that package from its own release

release-please writes the release pull request body with changelog text HTML-escaped, then on merge
parses that body and **re-serialises it** (`PullRequestBody.parse(...).toString()`) before parsing
it a second time in `buildRelease()`. The round trip DECODES the entities, so `&lt;picture&gt;`
comes back as a live `<picture>` element; node-html-parser then swallows the `</details>` that
should have closed the section, the component is no longer found in the parsed release data, and
release-please logs `Pull request contains releases, but not for component: <name>` and skips it —
no tag, no GitHub release, no npm publish, green run.

`feat(compiler): responsive images — <picture> per format…` did exactly that: `schema` and
`starters` fell out of three consecutive releases, and `@jxsuite/starters` sat at 1.2.2 on npm while
`@jxsuite/create@1.3.2` shipped depending on `^1.5.0`, so `npm install @jxsuite/create` was
unresolvable. The bug is upstream and still present in release-please 17.11.1, so the defence is to
keep the text out of the changelog. **Backticks do not help** — the escaping happens on raw text.

- The rule and the full write-up live in `commitlint.config.js` (`changelog-safe-angle-brackets`).
- `.husky/commit-msg` applies it as you commit; `checks` runs
  `bun scripts/check-changelog-safety.ts` over the pull request's commits, because a hook is
  skippable with `--no-verify` and that is how the subject landed.
- Only the **subject** and `BREAKING CHANGE:` notes are judged — nothing else reaches a changelog,
  so a commit body may still contain markup.

### A crashed `release-please` job disables the whole pipeline on the re-run

The job creates the GitHub releases first and builds the next pull request second. If it dies in
between — a GitHub 5xx during its commit-history walk, which an un-tagged component provokes by
forcing a 500-commit backfill — the releases exist but the run failed. **Re-running it is not
idempotent in the way that matters**: the pull request is already labelled `autorelease: tagged`, so
`releases_created` comes back `false` and `publish`, all four desktop bundlers, `nix-build` and
`deploy-site` all skip. That is how `desktop-v2.2.0` shipped with no installers.

`verify-release-integrity` is the answer: `if: always()`, gated on nothing, it asserts every version
in `.release-please-manifest.json` has a GitHub release at its tag and — for publishable
workspaces — that exact version on npm (`bun run release:integrity`, `--no-npm` to skip the
registry). It fails the run and opens ONE `release-incomplete` issue. Nothing `needs:` it, so a red
X there blocks nothing else. The daily schedule on the workflow makes it a standing sweep.

To backfill npm after a skip, `publish.yml` has a `workflow_dispatch` entry point and is
idempotent — the failure report prints the exact `gh workflow run` invocation.

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
- `bun run schema:verify` proves the committed core **and** all 52 per-project entry documents match
  their generators. `schema:validate-all` answers a different question (documents against schemas)
  and cannot see a stale schema.

## Stale schemas fix themselves

Every committed schema in this repository is a build output — the seven core artifacts
`bun run generate:schema` writes under `packages/schema/`, and the `project.schema.json` /
`document.schema.json` pair `bun run schema:generate-all` composes into each of the 26 project
roots. They are committed because editors, `jx validate` and every published `@jxsuite/schema`
consumer read them off disk, not because anybody authors them. So the policy is the screenshot
policy: **a generator produces the bytes, and you review the meaning.**

- **`bun run schema:verify` is the gate** (`scripts/check-schema-freshness.ts`), and
  **`bun run schema:sync` is the fixer.** The gate regenerates, reports drift as the JSON Pointers
  that moved, and puts the working tree back exactly as it found it; `--fix` leaves the result on
  disk. Never hand-edit a committed schema — the fix belongs in the generator or the source it
  reads.
- **The file set is DERIVED, not listed.** It is every tracked `*schema.json`. The gate this
  replaced was a shell one-liner whose two `git diff` pathspecs were each narrower than the
  generator they followed: it regenerated all seven core artifacts and looked at ONE, so a stale
  `class-schema.json`, `project-schema.json` or `schemas/project.core.schema.json` passed green.
  Verified by stamping a marker into `class-schema.json` and watching the old `schema:verify`
  exit 0.
- **`.github/workflows/schemas.yml` backfills it**, exactly as `screenshots.yml` does for pictures:
  it regenerates on every pull request, pushes the result to the branch, and posts one comment
  saying which pointers moved. Four things differ from that lane deliberately — no `paths:` filter
  (the whole job is under 30 seconds), Dependabot is **not** excluded (a `@webref/*` bump rewrites
  the core schema by construction, and there is no human on that branch), no `github.actor` refusal
  (the generators are deterministic, so the run its own push triggers pushes nothing — termination
  is a fixed point, not a guard), and a changed schema is **not** neutral, because a contract change
  is exactly the kind of thing a reviewer must read.
- **The trunk leg is not decoration.** Two branches can each be green alone and stale together: one
  moves the core, the other adds or regenerates a project root before it lands. Git merges that
  without a conflict, no per-branch check can see it, and `main` is stale from the second merge
  onward. `main` requires a pull request, so the lane opens one on a single reused
  `chore/schema-drift` branch. When the report says _nothing in this diff explains it_, that is
  what happened.
- **`schema:verify` stays a hard red X in `checks`** even though the lane fixes the same drift. The
  lane cannot push to a fork, and a required check is what keeps a stale schema off `main` when it
  cannot. The red X naming the problem and the lane fixing it is the intended sequence, not a
  duplicate.

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
