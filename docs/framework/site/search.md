---
title: "Site search"
description: "Enable the search section to index content collections at build time, then wire a search UI with the Search prototype or the headless client."
spec:
  - extensions.md#8.4
  - site-architecture.md#12
code:
  - extensions/search/src/client.ts
  - extensions/search/src/search-state.ts
  - extensions/search/schemas/project.fragment.schema.json
---

# Site search

Jx sites get full-text search from the `@jxsuite/search` extension: the build emits a JSON index from your content collections, and a small headless client (MiniSearch under the hood, ~7 kB) answers queries entirely in the browser. No server, no third-party service — results work on any static host, and section matches deep-link straight to the heading (`/docs/framework/site/#assets`).

## Enabling the section

Add the extension and a `search` section to `project.json`, then regenerate schemas with `jx schema`:

```json
{
  "extensions": ["@jxsuite/parser", "@jxsuite/search"],
  "search": {
    "collections": {
      "docs": { "basePath": "/docs/", "boost": { "title": 4, "heading": 2 } }
    }
  }
}
```

Per collection:

| Key            | Default                        | Meaning                                                        |
| -------------- | ------------------------------ | -------------------------------------------------------------- |
| `basePath`     | _(required)_                   | URL prefix mapping entry ids to routes                         |
| `fields`       | `["title", "heading", "text"]` | Document fields the index searches                             |
| `boost`        | `{}`                           | Per-field score boosts                                         |
| `sections`     | `true`                         | Also index one document per heading, with `#anchor` deep links |
| `sectionDepth` | `3`                            | Deepest heading level that gets its own section document       |

Top-level: `output` (default `/search-index.json`) sets where the index is written; `engine` is `minisearch` (the only engine today — the field exists so future engines slot in without reshaping the section).

`bunx jx build` then emits the index into `dist/` alongside your pages. The index holds two kinds of documents per entry: the whole page, and one per heading section — so a query can land on "the _Assets_ section of _Site architecture_" rather than just the page.

## Querying from page state

The `Search` prototype gives any page reactive results with zero client wiring:

```json
"state": {
  "q": "",
  "results": { "$prototype": "Search", "query": { "$ref": "#/state/q" }, "limit": 8 }
}
```

Bind an input to `state.q` and map over `state.results`. Each result group is a page with its matching sections:

```json
{
  "slug": "framework/site",
  "title": "Site architecture",
  "url": "/docs/framework/site/",
  "score": 12.4,
  "hits": [{ "heading": "Assets", "url": "/docs/framework/site/#assets", "score": 9.1 }]
}
```

In compiled sites the def lowers to plain client code that lazily loads the bundled client and fetches the index on first use — nothing is downloaded until the visitor actually searches. Options: `limit` (max result groups, default 8), `group` (set `false` for a flat document list), `index` (override the index URL).

## Building a search UI component

Interactive components aren't lowered, so inside a compiled component you use the headless client directly through its `$src` state conventions — the export names double as state keys:

```json
"state": {
  "searchQuery": "",
  "searchResults": [],
  "searchReady": false,
  "searchActive": 0,
  "searchInit": { "$prototype": "Function", "$src": "npm:@jxsuite/search/client", "parameters": [{ "identifier": "state" }] },
  "runSearch": { "$prototype": "Function", "$src": "npm:@jxsuite/search/client", "parameters": [{ "identifier": "state" }, { "identifier": "e" }] },
  "onMount": { "$prototype": "Function", "arguments": ["state"], "body": "state.searchInit(state);" }
}
```

- `searchInit(state)` preloads the index and flips `state.searchReady` (re-running any pending query).
- `runSearch(state, e)` reads the input event, stores grouped results on `state.searchResults`, and resets `state.searchActive` — wire it to your input's `oninput`.

The build bundles `npm:@jxsuite/search/client` (MiniSearch included) into `/assets/` automatically — declare the dependency in your project's `package.json` and import it like any module.

For full control, import the core API from the same module: `preload(indexUrl?)`, `isReady()`, and the synchronous `query(text, { limit, group })`.

:::doc-note
One index per site is the assumption: the first `preload` wins the in-page singleton. Multiple collections are fine — they share the one index and results carry their `collection` name.
:::
