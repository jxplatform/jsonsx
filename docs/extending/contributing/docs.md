---
title: "Contributing to these docs"
description: "How the Jx documentation is written, structured, screenshotted, and checked: the style guide for every page in /docs."
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
3. Add one line to `docs/nav.json`. The sidebar is generated from it, and CI fails if a page is missing from nav, or if nav points at a missing page.
4. Run `bun run docs:check` before pushing.

Optional frontmatter associates a page with its sources, validated by CI:

```yaml
spec:
  - spec.md#19.4 # a specs/ file and numbered section
code:
  - packages/runtime/src/runtime.ts # repo paths that must exist
```

In the other direction, code comments may carry `@docs <slug>` tags (e.g. `@docs framework/concepts/reactivity`) pointing at the page that documents them. Those are validated too.

These associations also power `bun run docs:sync`: given your working diff, it lists the pages and spec sections tied to the source files you changed. It runs automatically as a pre-commit advisory (and as an agent stop-check), so behavior changes and their documentation land together. It never blocks, because a pure refactor needs no doc update.

Your page is also published for machines. After `jx build`, the site build runs `scripts/docs/build-llm-export.ts`, which regenerates `llms.txt` and `/docs/full-docs.json` from the same frontmatter and Markdown: the whole corpus, in nav order, served verbatim to whatever fetches it. In `llms.txt` each page is one line, `- [Title](url): description`, so your `description` is nearly everything an agent has before deciding whether to open the page. Make it say what the page covers rather than restate the title. See [Machine-readable docs](/docs/framework/agents/machine-readable).

## Voice and style

- Second person, present tense, imperative steps: "Click **New Project**", not "The New Project button can be clicked".
- Sentence-case headings; one H1 matching the frontmatter title.
- Studio and Start pages assume no code knowledge. Code belongs in Framework/Extending pages, or inside a `:::doc-note` aside.
- Bold for clickable UI labels (**Commit & Sync**); `:kbd[Ctrl+K]` for keys (give macOS and Windows/Linux pairs on first mention); backticks only for literal code, filenames, and JSON keys.
- Chevron click paths for navigation chains: _Settings > CSS Variables_.
- American English, short paragraphs, no marketing superlatives.

### Write it the way you would say it

The point of every rule below is that a reader should be able to hear a person behind the page. Read a paragraph aloud before you keep it. If you would not say it, rewrite it.

**Dashes.** Do not use em dashes (—) or en dashes (–) in prose. They are the strongest single tell that a page was drafted by a model, and this corpus had one every forty-four words. An en dash between numbers or key names is a range (`0–100`, `` `h1`–`h6` ``) and is fine; a bare `—` in a table cell means "none" and is fine. Everywhere else, the dash is doing one of three jobs, and each has a better answer:

- _An aside holding a list._ Put the list at the end behind a colon, or split the sentence. A comma cannot do this job, because the aside is already full of commas. "Every backend-touching operation in Studio — file I/O, project loading, git — goes through the adapter" becomes "Every backend-touching operation in Studio goes through the adapter: file I/O, project loading, git."
- _A clause tacked onto the end._ Promote it to its own sentence when it is a second fact, join it with "because" or "so" when it is a reason, and cut it when it only restates the sentence it is attached to. Vary between the three; six colons in a row is a new tic.
- _A single appositive._ A comma, a colon, or parentheses.

**Bold labels in lists.** Bold a list item's opening words when they are a label the reader will see on screen or type into a file: a button, a panel, a field, a JSON key, a package name. Do not bold a category you invented to introduce a sentence. The test is whether the reader could search the app or the file for that exact string. A list of four packages compared across the same five fields is a table in list form and should stay one; four sentences wearing headings should be a paragraph.

**Related-links tails.** A `## Related` or `## Next` item is `- [Link](slug): what it covers.` when the gloss is a bare noun phrase, or `- **[Link](slug)** verbs the rest of the sentence.` when it reads better as one. Either is within the dash rule; pick one and keep it consistent down the page.

**Sentence length.** Aim under thirty words. A long sentence is fine when it is carrying a real chain of reasoning, and a short one is fine for emphasis, but a page where every sentence lands on the same medium-length beat reads like a machine. Vary it.

**Say it once.** Do not follow a heading with a sentence that only repeats it. A definition sentence is different and is required on a surface page, but it has to add the where and the what for: "Grid is for tabular data" earns its place; "Grid mode is a mode for grids" does not. No more than two sections in a row may open with the same frame.

**Do not tell the reader what to think.** Cut "worth noting", "it's important to understand", "the key thing here". If it matters, the substance shows it. Cut throat-clearing openers too: "Let's look at", "Here's where it gets interesting", "At its core".

**Do not answer objections nobody raised**, and do not introduce an option only to reject it. "A tempting approach would be X, but" usually records an old draft rather than telling the reader anything.

**Never invent a fact to make a sentence flow.** If a rewrite needs a number, a threshold, or a name the source does not give, leave the sentence longer or ask. This applies hardest to the words that carry the contract: `never`, `always`, `only`, `must`, `all`, `none`. Those are not intensifiers to be softened.

**What to keep.** Concrete behavioral detail, negative claims, the bug that motivated a rule, an aside in parentheses, a short sentence used deliberately. Those are what make a page sound like someone who has used the thing.

## Canonical UI names

Never invent synonyms for Studio surfaces. The shell regions are the **Command Bar** and the **Command Center** pill in the middle of it, the **Navigator rail** and its **Navigator** dock, the **pane** (with its **context bar** and, above that, its **jump bar**), the **Inspector**, the **Bottom dock** and the **status bar**.

The Navigator panels are **Files, Source Control** and **Problems** (the rail's Project group) and **Outline, Page, Data** and **Packages** (its Document group). **Insert** has no rail button and is opened by name from the palette. **Languages** belongs to the Project group but stays off the rail, and appears only in a project with more than one locale. A **Search** panel is declared and not yet built, so it never shows. The Inspector tabs are **Content, Style, Logic, Assistant**; the Bottom dock's are **Problems, Logic, Activity**. Diff is not one of them: it is an **Editor** kind, and Source Control opens a changed file as a Diff editor in the side pane. A pane's **View** control offers **Edit, Design, Preview**, and its **Editor** control names the editor kind: **Canvas, Grid, Code, Diff, Library, Project Styles**.

A **View** is a view and an **Editor** is an editor: write "the Code editor", never "Code mode", because _mode_ belongs to the View control and mixing the two axes is what the modes page spends its opening paragraph separating.

**The palette** is an acceptable collective for the **Command Center** (:kbd[⌘K]) and **Quick Access** (:kbd[⌘P]) where the difference does not matter. Name one of them where it does.

**Settings** is the project's (contexts, content types, connections, packages); **Preferences** is the application's (appearance, assistant, accounts, keyboard). Never use one word for the other.

## Callouts

Three container directives render as styled asides:

```markdown
:::doc-note
Neutral context, including "behind the scenes" notes naming what Studio writes to disk.
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
- **Generated reference**: do not edit these. They carry a `GENERATED` banner and are produced by `bun run docs:generate` from package data, the specs' status markers, the specs' changelogs, and the specs' `## N. Standards Alignment` tables; CI fails on drift. Releasing a spec (`bun run spec:bump`) changes [Implementation status](/docs/extending/reference/implementation-status) and [Spec changelog](/docs/extending/reference/spec-changelog); editing a spec's Standards Alignment table changes [Standards alignment](/docs/extending/reference/standards). Regenerate in the same change set.

## Internal links

Write them as root-absolute slugs (`/docs/framework/site/routing`), with no `.md` extension and no trailing slash. Never use a relative `../foo.md` link: the site serves the target verbatim rather than rewriting it to a URL, so the link is broken the moment it publishes.

:::doc-note
`bun run docs:links` resolves every one of them: the slug against `docs/nav.json`, and any `#anchor` against the headings the target page actually publishes. A heading's anchor comes from its rendered text, lowercased, so **re-casing a heading is safe and rewording one is not**. `bun scripts/docs/check-doc-links.ts --anchors` lists every heading another page links to, which is what to check before you touch one.
:::

## Screenshots

All screenshots come from the automated pipeline. None are hand-taken, so every image can be regenerated when the UI changes:

1. Declare the shot in `scripts/screenshots/manifest.json`. The shot contract is `open` (the world the app wakes up in), `steps`, `expect`, `capture` and `then`, and the full grammar is [`scripts/screenshots/README.md`](https://github.com/jxsuite/jx/blob/main/scripts/screenshots/README.md). Give it a `docs` field listing the page slugs it illustrates.
2. Run `bun run screenshots`. Output lands in `docs/images/` and is committed alongside `scripts/screenshots/capture.lock.json`, which records the bytes and the shot definition each image came from.
3. Reference it **relative to your page**, e.g. `![descriptive alt text](../images/<name>.png)` from `docs/start/`, `../../images/<name>.png` one level deeper.

A step names a **command id** and a capture names a **region id**, never a CSS selector and never a sleep. `probe.idle()` decides when the app has settled, and a step must state the state it wants rather than flip it: `view.setAssistant` with `{ "open": false }`, never a toggle. A toggle depends on what the panel happened to be doing when the run reached it, so changing a default silently inverts every shot that used one; a setter cannot.

Relative paths are what make `/docs` readable in any markdown editor, because the images travel with the pages. The site build republishes them under `/content/docs/images/` (the `docs` collection's [asset mount](/docs/framework/site/content-collections)), which is also how a site page outside `/docs` references one.

Alt text is mandatory and describes the state shown ("Style inspector with the Typography section expanded"), not the filename. Shots drive the starter sites (real-estate by default, dark theme) so docs show real projects, not Jx internals. CI verifies every referenced image resolves into `docs/images/`, is produced by the manifest, exists on disk, and is one the capture lock names. A PNG the pipeline did not produce fails the build.
