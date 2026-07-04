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
3. **CI** — `.github/workflows/test.yml` runs a 10-package matrix:
   `bun test --isolate --coverage` (cwd = the package, so its bunfig applies)
   plus the manifest check, and a separate lint + typecheck job. The Bun
   version is pinned there; bump it together with re-baselining thresholds.

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
