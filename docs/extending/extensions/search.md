---
title: "Search indexes"
description: "How @jxsuite/search owns the search section, emits a build-time index with the emit capability, and lowers Search defs to client code."
spec:
  - extensions.md#8.4
  - extensions.md#8.3
  - extensions.md#9
code:
  - extensions/search/jx-extension.json
  - extensions/search/src/SearchIndex.class.json
  - extensions/search/src/search-index.ts
  - extensions/search/src/search-state.ts
  - extensions/search/src/shared.ts
  - extensions/search/src/client.ts
---

# Search indexes

`@jxsuite/search` is the reference implementation of the **`emit` capability**, the hook that lets a section-owner class write derived artifacts (here: a search index) into the build output. It is deliberately headless: the extension contributes the `search` project section, the build-time index, a `Search` state class, and a browser client, but no UI. Sites author their own search box against the client's contract.

If you want to _add search to a site_ rather than study the extension, start with the user-level [Site search](/docs/framework/site/search) page.

## What the manifest declares

```json
{
  "name": "@jxsuite/search",
  "classes": {
    "SearchIndex": "./src/SearchIndex.class.json",
    "Search": "./src/Search.class.json"
  },
  "schemas": { "project": "./schemas/project.fragment.schema.json" }
}
```

Two classes, one schema fragment:

- **`SearchIndex`** owns the `search` section (`project.key: "search"`) and carries two capabilities: `projectData` (normalizes the section into `_project.search`) and `emit` (builds the index).
- **`Search`** is a state class pages query results through; it compiles away via [`lower`](/docs/extending/extensions/capabilities).
- The fragment contributes the `search` property to the composed [project schema](/docs/extending/extensions/schema-composition): an `engine` (an enum of `minisearch` today, room for more), an `output` path, and per-collection index settings.

## The `emit` capability

`emit` runs at build time, after routes and components compile (extensions.md §8.4). The host passes the section value and a context carrying the **already-loaded** project sections, so the emitter never re-reads source files:

```ts
emit(sectionValue, { projectConfig, root, sections, routes })
  → [{ path: "/search-index.json", content: "…json…" }]
```

`SearchIndex.emit` walks each configured collection in `sections.content` and produces two document granularities per entry:

- a **page document**: title and description from frontmatter, plus the entry's text. All of it when `sections` is off, and only the **preamble** before the first heading when it is on;
- **section documents** (when `sections: true`): one per heading up to `sectionDepth`, each with the heading text, the section's own text, and a URL ending in `#<heading-id>`. Heading ids are assigned by the parser and always match the rendered anchors ([parser.md §3.2](/docs/framework/site/content-collections)).

Together the two **partition** the entry, which is the point. Emitting the full page text alongside the sections put the whole corpus in the index twice: on jxsuite.com that was 922,007 characters of page text against 899,502 of section text, of which only ~22,505 was preamble no section already covered. The index was 2.3 MB and took ~180 ms of uninterrupted main-thread work to build in the browser; the partitioned one is 1.4 MB and ~110 ms. No word left the index. An entry that yields no sections keeps its full text, because nothing else would index it.

:::doc-tip
This generalizes to any `emit` implementation: what an emitter writes is downloaded and parsed by a visitor, so emitting the same content twice costs them twice.
:::

The result is one JSON envelope at the configured `output` path:

```json
{
  "version": 1,
  "engine": "minisearch",
  "fields": ["title", "heading", "text"],
  "boost": { "title": 4, "heading": 2 },
  "documents": [
    { "id": "docs:framework/site", "url": "/docs/framework/site/", "heading": "", "text": "…" },
    {
      "id": "docs:framework/site#assets",
      "url": "/docs/framework/site/#assets",
      "heading": "Assets",
      "text": "…"
    }
  ]
}
```

The emitter returns data; **the host writes the files**, guards against path traversal, and skips the emitter entirely when the project declares no `search` section, the same gating as section loading and server mounts.

### Multilingual collections

A collection kept [one directory per locale](/docs/framework/site/i18n) indexes each language separately. Every document from a localized entry carries three things the monolingual case doesn't need:

| Field    | Is                                                                         |
| -------- | -------------------------------------------------------------------------- |
| `url`    | the entry's URL **in its own language** (`/fr-ca/blog/hello/`)             |
| `id`     | `<collection>:<locale>:<entry-id>`, because translations share an entry id |
| `locale` | the canonical tag                                                          |

The client then searches **the page's language by default**, read from `<html lang>`, which the build wrote from the route's locale, so it is the same answer the index was built against:

```js
query("bonjour"); // the page's language
query("bonjour", { locale: "fr-CA" }); // a named language
query("bonjour", { locale: null }); // every language
```

A document with no `locale` (an unlocalized collection) answers every search. It isn't in one language; it's outside the question.

:::doc-note
Without the scoping, a reader searching a French page gets the English copy of the page they're already on, ranked first, because it matched the same words.
:::

## Lowering `Search` to client code

A page declares reactive results with the `Search` prototype:

```json
"state": {
  "q": "",
  "results": { "$prototype": "Search", "query": { "$ref": "#/state/q" }, "timing": "client" }
}
```

In compiled sites `Search.lower()` replaces that def with a core `Function` computed that lazy-imports the bundled client, preloads the index once, and re-queries whenever `state.q` (or the ready flag) changes. No extension code ships to the browser except the client bundle itself, which the lowered def names via **`$bundle`** (extensions.md §8.3):

```js
{
  "$bundle": ["npm:@jxsuite/search/client"],
  "$prototype": "Function",
  "timing": "client",
  "body": "…import('/assets/jxsuite-search-client.js') … m.query(state.q, {…})…"
}
```

The compiler's sidecar bundler resolves `npm:@jxsuite/search/client` from `node_modules`, bundles it (MiniSearch inlined) into `/assets/jxsuite-search-client.js`, and strips `$bundle` from the def. The deterministic URL comes from `sidecarAssetPath` in `@jxsuite/schema/asset-paths`, shared by extension and compiler so neither depends on the other.

Inside compiled **components**, use the client's `$src` surface instead, since components are not lowered; see [Site search](/docs/framework/site/search).

## Under node

`Search.resolve()` degrades to `[]` with a warning outside the browser, because search is a client interaction, and compiler-timing bakes or dev-server resolution should never fail a build over it.

:::doc-tip
The `emit` contract generalizes beyond search: RSS/Atom feeds, export manifests, or any derived artifact a section owner can compute from loaded project data fits the same shape.
:::
