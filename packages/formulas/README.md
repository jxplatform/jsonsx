# @jxsuite/formulas

Composite **pure formulas** for Jx, authored as declarative `$expression` JSON (spec §19.4c). Each formula is a named, parameterized computation (`clamp`, `sum`, `average`, `truncate`, `initials`, …) whose body is built exclusively from blessed operators, pure standard-library method operators (§19.4d), and blessed globals. No JavaScript source anywhere: every formula is inspectable data that the visual editor can open, badge with live values, and recompose.

## Consumption model: copy-in, not a project dependency

This package is a **studio/tooling dependency**, deliberately _not_ a runtime or project dependency. Jx documents stay self-contained plain JSON:

- **In Jx Studio**, the formula catalog lists these formulas alongside operators and blessed globals. Picking one **copies its state entry into the document** (vendoring the JSON) and inserts a `call` node referencing it. From that moment the project owns the formula: no package resolution at build or run time, no version coupling, and the user can edit their copy like any other named formula.
- **Programmatically**, `formulaEntries()` returns the catalog as ready-to-merge `state` entries for tooling that seeds documents or `project.json` state (starters, importers, AI agents):

  ```ts
  import { catalog, formulaEntries } from "@jxsuite/formulas";

  const state = { ...formulaEntries() };
  // → { clamp: { $expression: …, parameters: […] }, sum: …, … }
  ```

Because consumption is copy-in, publishing a new package version never changes existing projects. A project upgrades a formula by re-inserting it.

## Authoring a formula

One folder per formula under `formulas/`:

```
formulas/<name>/formula.json     # metadata: name, description, parameters (CEM convention)
formulas/<name>/expression.json  # the pure $expression body over $args/<name> refs
```

Then regenerate the catalog module:

```sh
bun run generate
```

The generator (`bin/generate.ts`) emits `src/catalog.ts` and **fails the build on anything impure**: unknown or mutating operators, or `call` targets outside the blessed pure globals (`window#/Math/…`, `window#/JSON/…`, …). Descriptions are mandatory because they double as editor tooltips and the LLM contract.

## Releases

Versioned independently via release-please (`formulas` component); published to npm with provenance by the repo's publish workflow when a release is cut.
