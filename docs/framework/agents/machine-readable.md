---
title: "Machine-readable docs"
description: "Public endpoints an agent can fetch: llms.txt, full-docs.json, the site search index, and the canonical Jx JSON Schemas served from jxsuite.com."
code:
  - scripts/docs/build-llm-export.ts
  - sites/jxsuite.com/project.json
  - extensions/search/src/search-index.ts
  - packages/schema/schema.json
---

# Machine-readable docs

Everything on this site has a machine-readable counterpart at a stable URL. An agent working on a Jx project can fetch the documentation corpus, the search index, or the schemas themselves without scraping HTML. None of it is a separate artifact that drifts, because all of it is regenerated from the same sources on every build.

## The documentation corpus

### `llms.txt`

[`https://jxsuite.com/llms.txt`](https://jxsuite.com/llms.txt)

A plain-text index in the [llms.txt convention](https://llmstxt.org): a one-paragraph summary of the project, then one `##` heading per documentation section, then one line per page in sidebar order:

```markdown
# Jx Suite

> Jx Suite is a visual site builder (Jx Studio), a JSON-native component format, and a compiler that prerenders every page — working on plain files you own and publish with git. …

## Start here

- [Start here](https://jxsuite.com/docs/start/): What Jx Suite is, how to install Jx Studio, and where to go first …
- [Install Jx Studio](https://jxsuite.com/docs/start/install/): Download the Jx Studio desktop app …
- [Your first project](https://jxsuite.com/docs/start/first-project/): …
```

Each section's landing page comes first, then the rest of that section's own pages, then each of its groups in turn, exactly as the sidebar orders them.

It carries no page bodies, roughly 27 KB against `full-docs.json`'s ~680 KB, which makes it the cheap first fetch: point an agent at it, let it read the titles and descriptions, and let it pull only the pages it needs.

### `full-docs.json`

[`https://jxsuite.com/docs/full-docs.json`](https://jxsuite.com/docs/full-docs.json)

The same corpus in the same order, with the prose included. A JSON array of objects, one per page:

| Field         | What it holds                                           |
| ------------- | ------------------------------------------------------- |
| `slug`        | The docs path, e.g. `framework/agents/machine-readable` |
| `url`         | The canonical page URL                                  |
| `title`       | The page's frontmatter `title`                          |
| `description` | The page's frontmatter `description`                    |
| `section`     | The top-level section label, e.g. `Framework`           |
| `markdown`    | The full page body as Markdown, frontmatter stripped    |

This is the fetch for an agent that wants the whole thing at once: one request, no crawling, and the `markdown` field is the same text a contributor edits in the repository.

### `search-index.json`

[`https://jxsuite.com/search-index.json`](https://jxsuite.com/search-index.json)

The index that powers the site's own search box, emitted by the [search extension](/docs/framework/site/search) during the build. A `documents` array wrapped in an envelope of `version`, `engine` (`"minisearch"`), the indexed `fields`, and per-field `boost` weights. Each document is one page or one heading-level section within a page, carrying `id`, `collection`, `slug`, `url`, `title`, `description`, `heading`, and `text`. The two granularities **partition** the entry rather than overlapping: a page document (`heading: ""`) carries only the text before its first heading, and the section documents carry the rest. Reassemble a page by concatenating its page document with every document whose `id` starts with `<page-id>#`. A collection that keeps one directory per language adds `locale`, and then the `id` carries the tag too (`docs:fr-CA:start/install`), because two translations share an entry id.

Reach for it when you want lookup rather than reading: it is section-granular, so a query lands on a heading instead of a whole page.

:::doc-note
`llms.txt` and `full-docs.json` are written by `scripts/docs/build-llm-export.ts`, which runs immediately after `jx build` in the jxsuite.com build script. `search-index.json` is emitted by the search extension during that same build. All three are derived, never committed, so they cannot drift from `/docs`.
:::

## The schemas

The other machine-readable surface is the format itself. The Jx schemas are plain JSON Schema 2020-12 documents, served at the URLs that are also their canonical `$id`s:

| URL                                                                                            | Validates                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`https://jxsuite.com/schema/v1`](https://jxsuite.com/schema/v1)                               | Components, pages, and layouts                                                 |
| [`https://jxsuite.com/schema/project/v1`](https://jxsuite.com/schema/project/v1)               | `project.json`                                                                 |
| [`https://jxsuite.com/schema/class/v1`](https://jxsuite.com/schema/class/v1)                   | `*.class.json` class definitions                                               |
| [`https://jxsuite.com/schema/document/paths/v2`](https://jxsuite.com/schema/document/paths/v2) | A page's `$paths` source, referenced by `schema/v1` and overridden per project |

Any compliant 2020-12 validator can consume them directly. There is no Jx-specific validation runtime. They are published from `packages/schema` through the `copy` map in the site's `project.json`, so the served documents are byte-for-byte the schemas the toolchain uses.

For work inside a project, prefer the local composed copies. `jx schema` writes `project.schema.json` and `document.schema.json` into the project root, merging these core schemas with the fragments each enabled extension ships and inlining every referenced resource. Those files resolve offline (no `node_modules`, no network, no editor configuration), and they are what `jx validate` checks against. The hosted URLs above are the right reference when you are outside a project or want the core format without any extension's additions. The hosted `$paths` union accepts any extension source shape it cannot see, where your project's generated copy checks the exact set your extensions provide. See [Schema composition](/docs/extending/extensions/schema-composition).

## Related

- [Working with agents](/docs/framework/agents): the workflow these endpoints support
- [Authoring rules for agents](/docs/framework/agents/authoring-rules): the briefing to hand an agent alongside them
- [CLI commands](/docs/framework/build/cli): `jx schema` and `jx validate`
- [Site search](/docs/framework/site/search): how the search index is configured and emitted
- [Contributing to these docs](/docs/extending/contributing/docs): where the corpus comes from
