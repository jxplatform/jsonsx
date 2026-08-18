---
title: "Contributing to these docs"
description: "How the Jx documentation is written, structured, screenshotted, and checked — the style guide for every page in /docs."
code:
  - scripts/docs/check-doc-refs.ts
  - scripts/docs/check-doc-sync.ts
  - scripts/docs/generate-reference.ts
  - scripts/docs/build-llm-export.ts
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

Your page is also published for machines. After `jx build`, the site build runs `scripts/docs/build-llm-export.ts`, which regenerates `llms.txt` and `/docs/full-docs.json` from the same frontmatter and Markdown — the whole corpus, in nav order, served verbatim to whatever fetches it. In `llms.txt` each page is one line — `- [Title](url): description` — so your `description` is nearly everything an agent has before deciding whether to open the page. Make it say what the page covers rather than restate the title. See [Machine-readable docs](/docs/framework/agents/machine-readable).

## Voice and style

- Second person, present tense, imperative steps: "Click **New Project**", not "The New Project button can be clicked".
- Sentence-case headings; one H1 matching the frontmatter title.
- Studio and Start pages assume no code knowledge. Code belongs in Framework/Extending pages — or inside a `:::doc-note` aside.
- Bold for clickable UI labels (**Commit & Sync**); `:kbd[Ctrl+K]` for keys (give macOS and Windows/Linux pairs on first mention); backticks only for literal code, filenames, and JSON keys.
- Chevron click paths for navigation chains: _Settings > CSS Variables_.
- American English, short paragraphs, no marketing superlatives.

## Canonical UI names

Never invent synonyms for Studio surfaces. The shell regions are the **Command Bar**, the **Navigator rail** and its **Navigator** dock, the **pane** (with its **context bar**), the **Inspector**, the **Bottom dock** and the **status bar**.

The Navigator panels are **Files, Source Control, Problems** (the rail's Project group), **Outline, Page, Data, Packages** (its Document group), plus **Insert** and **State**, which have no rail button and are opened by name from the palette. The Inspector tabs are **Content, Style, Logic, Assistant**; the Bottom dock's are **Problems, Diff, Logic, Activity**. A pane's **View** control offers **Edit, Design, Preview**, and its **Editor** control names the editor kind — **Canvas, Grid, Code, Diff, Library, Project Styles**.

**Settings** is the project's (contexts, content types, connections, packages); **Preferences** is the application's (appearance, assistant, accounts, keyboard). Never use one word for the other.

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
- **Generated reference**: do not edit these — they carry a `GENERATED` banner and are produced by `bun run docs:generate` from package data, the specs' status markers, the specs' changelogs, and the specs' `## N. Standards Alignment` tables; CI fails on drift. Releasing a spec (`bun run spec:bump`) changes [Implementation status](/docs/extending/reference/implementation-status) and [Spec changelog](/docs/extending/reference/spec-changelog); editing a spec's Standards Alignment table changes [Standards alignment](/docs/extending/reference/standards). Regenerate in the same change set.

## Internal links

Write them as root-absolute slugs — `/docs/framework/site/routing` — with no `.md` extension and no trailing slash. Never use a relative `../foo.md` link: the site serves the target verbatim rather than rewriting it to a URL, so the link is broken the moment it publishes.

:::doc-warning
**No gate checks internal links.** `docs:check` validates frontmatter, spec anchors, `code:` paths, images, and the nav bijection — nothing resolves a link target. A typo, or a renamed page, ships silently. Verify each slug against `docs/nav.json` as you write it, and grep for the old slug whenever you rename a page.
:::

## Screenshots

All screenshots come from the automated pipeline — none are hand-taken, so every image can be regenerated when the UI changes:

1. Declare the shot in `scripts/screenshots/manifest.json` — the shot contract is `open` (the world the app wakes up in), `steps`, `expect`, `capture` and `then`, and the full grammar is [`scripts/screenshots/README.md`](https://github.com/jxsuite/jx/blob/main/scripts/screenshots/README.md). Give it a `docs` field listing the page slugs it illustrates.
2. Run `bun run screenshots` — output lands in `docs/images/` and is committed alongside `scripts/screenshots/capture.lock.json`, which records the bytes and the shot definition each image came from.
3. Reference it **relative to your page**, e.g. `![descriptive alt text](../images/<name>.png)` from `docs/start/`, `../../images/<name>.png` one level deeper.

A step names a **command id** and a capture names a **region id** — never a CSS selector, and never a sleep. `probe.idle()` decides when the app has settled, and a step must state the state it wants rather than flip it: `view.setAssistant` with `{ "open": false }`, never a toggle. A toggle depends on what the panel happened to be doing when the run reached it, so changing a default silently inverts every shot that used one; a setter cannot.

Relative paths are what make `/docs` readable in any markdown editor — the images travel with the pages. The site build republishes them under `/content/docs/images/` (the `docs` collection's [asset mount](/docs/framework/site/content-collections)), which is also how a site page outside `/docs` references one.

Alt text is mandatory and describes the state shown ("Style inspector with the Typography section expanded"), not the filename. Shots drive the starter sites (real-estate by default, dark theme) so docs show real projects, not Jx internals. CI verifies every referenced image resolves into `docs/images/`, is produced by the manifest, exists on disk, and is one the capture lock names — a PNG the pipeline did not produce fails the build.
