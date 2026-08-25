# Jx Documentation

The user-facing documentation corpus, published at jxsuite.com/docs. Where [`specs/`](../specs/README.md) defines the contract, these pages track what actually ships. Every page is a Markdown file with YAML frontmatter, and the folder path is the URL: `docs/studio/editing.md` → `/docs/studio/editing/`. A section's landing page is the sibling `.md` one level up (`docs/start.md` → slug `start`).

The style guide for writing a page — voice, page shapes, callouts, the canonical names for every Studio surface — is itself a page: [extending/contributing/docs.md](./extending/contributing/docs.md). This file covers the directory and its machinery.

| Member                                       | Contents                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`start/`](./start) + `start.md`             | Install, first project, Studio tour, tutorials, "coming from X" migration guides                          |
| [`studio/`](./studio) + `studio.md`          | The visual editor, surface by surface (`ai/ data/ design/ editing/ interface/ logic/ projects/ publish/`) |
| [`framework/`](./framework) + `framework.md` | The JSON document format Studio writes, how a site compiles, and the generated catalogs                   |
| [`extending/`](./extending) + `extending.md` | Extension authoring, embedding Studio, the backend protocol, generated reference tables                   |
| [`nav.json`](./nav.json)                     | The sidebar manifest — `{ id, sections[{ path, label, children[] }] }`                                    |
| [`images/`](./images)                        | Screenshots, every one produced by `bun run screenshots`                                                  |

## Anatomy of a page

```markdown
---
title: "Style inspector"
description: "The Style tab in Jx Studio: a Target Line stating what an edit changes, chips naming where each value came from, and visual CSS controls."
spec:
  - studio.md#6.2
code:
  - packages/studio/src/panels/style-panel.ts
  - packages/studio/src/panels/target-line.ts
---

# Style inspector
```

| Key               | Rule                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **`title`**       | Required. Sentence case, no site suffix; becomes the page `<title>`                                                      |
| **`description`** | Required, **≤ 155 characters** (`MAX_DESCRIPTION`). Becomes the meta description and the page's one line in `llms.txt`   |
| **`spec:`**       | Optional string or array. `<spec-file>` or `<spec-file>#<anchor>`; the anchor must match a numbered heading in that spec |
| **`code:`**       | Optional string or array of repo-relative paths that must exist. This is the association `docs:sync` reads               |
| **`generated:`**  | `true` only on the generated pages, which must also carry the `<!-- GENERATED` banner                                    |

The reverse association is a `@docs <slug>` tag in a source comment, scanned across `packages/*/src/**/*.ts` and `extensions/*/src/**/*.ts`. A tag pointing at a page that does not exist fails CI; a missing tag fails nothing, it just drops that file out of future sync reports.

**Every page appears exactly once in `nav.json`, and every nav path has a page.** The bijection is enforced in both directions, and a duplicate nav path is a third failure mode — so a new page and its one nav line land in the same change.

Markup beyond CommonMark: `:::doc-note`, `:::doc-tip` and `:::doc-warning` container directives (real components registered as the collection's `$elements`), and `:kbd[Ctrl+K]` for keys. Bold for clickable UI labels; backticks only for literal code, filenames, and JSON keys.

## Generated pages

These pages are written by `bun run docs:generate` and must never be hand-edited — CI regenerates and diffs them. The generator's own map of page → source is the list; this table tracks it.

| Page                                           | Generated from                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `extending/reference/studio-routes.md`         | `@jxsuite/protocol` `STUDIO_ROUTES` + `PROBLEM_TYPES`                         |
| `extending/reference/implementation-status.md` | The specs' `**Status:**` markers                                              |
| `extending/reference/spec-changelog.md`        | The specs' `## Changelog` sections                                            |
| `extending/reference/standards.md`             | The specs' `## N. Standards Alignment` tables + `scripts/docs/standards.json` |
| `framework/reference/formulas.md`              | `@jxsuite/formulas/catalog`                                                   |
| `framework/reference/operators.md`             | `packages/schema/schema.json`                                                 |
| `studio/projects/starters.md`                  | `packages/starters/registry.json`                                             |
| `studio/interface/commands.md`                 | `packages/studio/src/commands/app-commands.ts`                                |
| `studio/interface/shortcuts.md`                | The same command set                                                          |

The generator runs oxfmt over what it writes, so committed output is already formatted — required, because `docs:verify` diffs it and a later repo-wide `bun run format` must not change it.

Releasing a spec is therefore a docs change: `bun run spec:bump` bumps the version and prepends a changelog entry, which feeds the spec-changelog page, and the `**Status:**` markers a release moves by hand feed the other two. Regenerate in the same PR.

## Images

`docs/images/` is written only by `bun run screenshots`, which commits the PNGs alongside `scripts/screenshots/capture.lock.json` — the record of the bytes and the shot definition each image came from. **You cannot add an image by hand:** a PNG whose `sha256` has no lock entry fails `docs:images:check`, and a page referencing an image the lock does not name fails `docs:check`, even with the file sitting right there on disk.

Reference images page-relative into `docs/images/` — `![alt](../images/x.png)`, one `../` per level below `docs/`. Root-absolute and URL forms both fail the check. The relative form is what keeps `/docs` readable in a plain Markdown editor; the site republishes the directory at `/content/docs/images/` through the collection's asset mount. Alt text is mandatory and describes the state shown.

The shot grammar — and the rule that a step names a command id and a capture a region id, never a CSS selector, a sleep, or a toggle — is [`scripts/screenshots/README.md`](../scripts/screenshots/README.md).

## Gates

These commands guard this directory, but none of them live in it: each is a script in [`scripts/`](../scripts/README.md) — mostly under `scripts/docs/`, with `docs:images:check` and `docs:markdown` at the top level. [scripts/README.md](../scripts/README.md) is where their placement in CI, their shared readers, and the conventions for changing one are written down.

| Command                   | Enforces                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| bun run docs:check        | Frontmatter, `spec:` anchors, `code:` paths, image refs, the nav bijection, and the reverse `@docs` tags   |
| bun run docs:images:check | The bytes: every PNG is one the lock names, and each shot's definition hash still matches the working tree |
| bun run docs:generate     | Rewrites the generated pages                                                                               |
| bun run docs:verify       | The CI chain — generate, `git diff --exit-code -- docs`, then both checks above                            |
| bun run docs:links        | Every internal link: the slug against `nav.json`, and every `#anchor` against the target's headings        |
| bun run docs:markdown     | Visual-editor escapes — an escaped heading number, an escaped inner underscore — every tracked `*.md`      |
| bun run docs:sync         | Advisory only: maps a diff to the pages and spec sections declared for the files it touched                |

`docs:verify` requires a **clean** `docs/` tree — it diffs after regenerating, so any uncommitted docs edit fails it, generated or not. Iterate with `docs:check`; run `docs:verify` after committing. `docs:markdown` is repo-wide, so a spec or a package README can turn it red; `bun run format:md` fixes it.

`docs:sync` runs on its own in two places — the Claude Code Stop hook and a non-blocking pre-commit advisory — and it also joins in the screenshot manifest, so a report can name the page whose picture, and therefore whose surrounding prose, your change just aged. It never blocks and it only knows about declared associations: silence is not proof the docs are current.

## Surprises

- **A relative `../foo.md` link publishes broken**, because the site serves the target verbatim
  rather than rewriting it to a URL. It is the failure that looks right while you write it: the
  relative form is exactly what resolves in a Markdown preview. `docs:links` is the gate.
- **A `spec:` anchor breaks when someone renumbers a spec heading**, which is why spec sections are
  edited in place and never renumbered or removed. The failure surfaces here, not in the spec.
- **The screenshots lane's normal outcome is a bot commit, not a red X.** It re-captures, pushes the
  images and the lock to your branch, and comments with the pages each changed image appears on. Go re-read those pages: whether the paragraph beside a moved surface is now wrong is a judgement no check makes.
- **Behavior changes land with their docs.** Every plan for behavior-changing work carries a
  "Specs & docs" step, and the code, the spec edit, and the page update go in one change set.

## Publishing

[`sites/jxsuite.com`](../sites/README.md) consumes this directory as a Markdown content collection (`content.docs.source = "../../docs"`), with `nav.json` loaded as a second, JSON collection that renders the sidebar. One catch-all route serves every page, building its `<title>` from the frontmatter `title` plus the site suffix and its meta description from `description`; the same collection feeds site search. After `jx build`, the site build emits `dist/llms.txt` (nav-ordered) and `dist/docs/full-docs.json` (the whole corpus) for machine readers — neither is committed. Pushes touching `docs/**` or `scripts/docs/**` trigger the site deploy, which runs `bun run docs:claims` first.
