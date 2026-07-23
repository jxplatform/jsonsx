---
title: "Contributing to these docs"
description: "How the Jx documentation is written, structured, screenshotted, and checked — the style guide for every page in /docs."
code:
  - scripts/docs/check-doc-refs.ts
  - scripts/docs/check-doc-sync.ts
  - scripts/docs/generate-reference.ts
  - scripts/screenshots/manifest.json
---

# Contributing to these docs

The documentation lives in `/docs` at the monorepo root, published through the jxsuite.com site. Every page is a Markdown file with YAML frontmatter; the folder path is the URL (`docs/studio/editing.md` → `/docs/studio/editing/`).

## Adding a page

1. Create the Markdown file under the right section (`start/`, `studio/`, `framework/`, `extending/`).
2. Add frontmatter: `title` (sentence case, no site suffix) and `description` (≤155 characters).
3. Add one line to `docs/nav.json` — the sidebar is generated from it, and CI fails if a page is missing from nav (or nav points at a missing page).
4. Run `bun run docs:check` before pushing.

Optional frontmatter associates a page with its sources, validated by CI:

```yaml
spec:
  - spec.md#19.4 # a specs/ file and numbered section
code:
  - packages/runtime/src/runtime.ts # repo paths that must exist
```

In the other direction, code comments may carry `@docs <slug>` tags (e.g. `@docs framework/concepts/reactivity`) pointing at the page that documents them — also validated.

These associations also power `bun run docs:sync`: given your working diff, it lists the pages and spec sections tied to the source files you changed. It runs automatically as a pre-commit advisory (and as an agent stop-check), so behavior changes and their documentation land together. It never blocks — a pure refactor needs no doc update.

## Voice and style

- Second person, present tense, imperative steps: "Click **New Project**", not "The New Project button can be clicked".
- Sentence-case headings; one H1 matching the frontmatter title.
- Studio and Start pages assume no code knowledge. Code belongs in Framework/Extending pages — or inside a `:::doc-note` aside.
- Bold for clickable UI labels (**Commit & Sync**); `:kbd[Ctrl+K]` for keys (give macOS and Windows/Linux pairs on first mention); backticks only for literal code, filenames, and JSON keys.
- Chevron click paths for navigation chains: _Settings > CSS Variables_.
- American English, short paragraphs, no marketing superlatives.

## Canonical UI names

Never invent synonyms for Studio surfaces. The activities are **Files, Layers, Imports, Elements, State, Data, Document, Source Control**; the canvas modes are **Edit, Design, Grid, Code, Stylebook** plus the **Preview** toggle; the right-panel tabs are **Properties, Events, Style**.

## Callouts

Three container directives render as styled asides:

```markdown
:::doc-note
Neutral context — including "behind the scenes" notes naming what Studio writes to disk.
:::

:::doc-tip
Shortcuts and good practices.
:::

:::doc-warning
Data loss or surprising behavior only.
:::
```

Use at most a couple per screenful, and never open a page with one.

## Page shapes

- **Studio surface page**: definition sentence (what it is, where it lives) → hero screenshot → "Open …" click path first → verb-first task sections with numbered steps and a screenshot after each state-changing step → a `:::doc-note` naming what Studio writes, linking the Framework counterpart → related links.
- **Framework concept page**: a "Studio writes this format for you" note linking the Studio surface → smallest complete JSON example first → one H2 per variant with a short example each → how it compiles → hard rules → related links.
- **Tutorial**: outcome + finished screenshot + rough duration + prerequisites → numbered steps with expected-result sentences ("You should now see…") → "What you built" recap → next steps.
- **Generated reference**: do not edit these — they carry a `GENERATED` banner and are produced by `bun run docs:generate` from package data, the specs' status markers, and the specs' changelogs; CI fails on drift. Releasing a spec (`bun run spec:bump`) changes [Implementation status](../reference/implementation-status.md) and [Spec changelog](../reference/spec-changelog.md), so regenerate in the same change set.

## Screenshots

All screenshots come from the automated pipeline — none are hand-taken, so every image can be regenerated when the UI changes:

1. Declare the shot in `scripts/screenshots/manifest.json` (project, file, actions, regions). Give it a `docs` field listing the page slugs it illustrates.
2. Run `bun run screenshots` — output lands in `docs/images/` and is committed.
3. Reference it **relative to your page**, e.g. `![descriptive alt text](../images/<name>.png)` from `docs/start/`, `../../images/<name>.png` one level deeper.

Relative paths are what make `/docs` readable in any markdown editor — the images travel with the pages. The site build republishes them under `/content/docs/images/` (the `docs` collection's [asset mount](/docs/framework/site/content-collections)), which is also how a site page outside `/docs` references one.

Alt text is mandatory and describes the state shown ("Style inspector with the Typography section expanded"), not the filename. Shots drive the starter sites (real-estate by default, dark theme) so docs show real projects, not Jx internals. CI verifies every referenced image resolves into `docs/images/`, is produced by the manifest, and exists on disk.
