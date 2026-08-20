# `@jxsuite/search`

> Full-text site search built at compile time from content collections — no server, no third-party
> service.

## Overview

`@jxsuite/search` indexes a site's content collections during `jx build` and emits a single JSON
index file next to the pages. In the browser, a headless MiniSearch client fetches that file once
and answers queries synchronously. Two classes, declared in `jx-extension.json`:

- **`SearchIndex`** — owner of the project.json `search` section. `projectData` normalizes the
  section into `_project.search`; `emit` (specs/extensions.md §8.4) builds the index from the
  already-loaded content collections and hands it to the host to write.
- **`Search`** — a state class that **lowers** to core defs (specs/extensions.md §8.3): its static
  `lower` rewrites a `timing: "client"` def into a core `$prototype: "Function"` computed, so the
  only extension code reaching the browser is the client bundle.

The schema fragment `schemas/project.fragment.schema.json`
(`$id` `https://jxsuite.com/schema/ext/search/project/v1`) is the source of truth for the section's
shape and defaults: it requires `collections` with at least one entry, requires `basePath` per
collection, and rejects unknown keys. `engine` is an enum whose only member today is
`"minisearch"`. Docs: [/docs/framework/site/search](https://jxsuite.com/docs/framework/site/search)
(authoring) and
[/docs/extending/extensions/search](https://jxsuite.com/docs/extending/extensions/search)
(the extension itself).

## Enable it

```json
{
  "extensions": ["@jxsuite/parser", "@jxsuite/search"],
  "search": {
    "output": "/search-index.json",
    "collections": {
      "docs": {
        "basePath": "/docs/",
        "boost": { "title": 4, "heading": 2 }
      }
    }
  }
}
```

`@jxsuite/parser` is what loads the content collections this indexes. Defaults per collection:
`fields` `["title", "heading", "text"]`, `sections` `true`, `sectionDepth` `3`; `output` defaults
to `/search-index.json`. `basePath` is normalized to leading **and** trailing slashes, so `"blog"`
becomes `"/blog/"`. This is the whole configuration surface — there is no CLI of its own.

One default does not come from the fragment: `boost` falls back to `{}` in `normalizeSearchConfig`
(`src/shared.ts`), and the fragment declares no default for it. The schema is the source of truth
for the section's shape and for every other default.

## Build-time emission (`SearchIndex`)

`emit` reads `ctx.sections.content` — the collections the parser already loaded, keyed by name —
and never re-reads source files. It returns exactly one record, `{ path: <output>, content }`,
which the compiler writes under `outDir` (step 6e of the site build). The content is one envelope:

```json
{ "version": 1, "engine": "minisearch", "fields": [], "boost": {}, "documents": [] }
```

`fields` is the union of every configured collection's `fields` and `boost` their merged boost
maps — baked in so the client needs no configuration of its own. Both cover only the collections
that actually loaded: a name matching no content collection is skipped before its fields and boosts
are merged, so a typo silently narrows the index rather than failing the build.

Each content entry yields a **page document** (`heading: ""`, the entry's full extracted text, id
`<collection>:<entry-id>`) and, when `sections` is on, one **section document** per heading, id
`<collection>:<entry-id>#<anchor>` and URL carrying the same `#anchor`. `title` falls back to the
entry id when frontmatter has no string `title`; `description` falls back to `""`. Entry URLs
honour `build.trailingSlash` (default `"always"`).

Localized collections are indexed per locale: each entry is indexed at the URL its own locale routes
to — under the default `prefix-except-default` routing the default locale stays unprefixed and only
the others carry a `/<locale>` prefix; under `prefix-always` every locale carries one — the document
id becomes `<collection>:<locale>:<entry-id>`, and the document carries a canonical `locale` tag. A
project with no `i18n` emits documents with no `locale` field at all.

## The `Search` state class

```json
{
  "state": {
    "q": "",
    "results": { "$prototype": "Search", "timing": "client", "query": { "$ref": "#/state/q" } }
  }
}
```

`query` takes a literal string or a `$ref` into page state (`#/state/ui/q` compiles to
`state.ui.q`; a `$ref` outside `#/state/` degrades to `""`). Other parameters: `limit` (8), `group`
(true), `index` (index-URL override), `locale`. The index URL resolves def `index` →
`search.output` → `/search-index.json`.

`lower` emits `{ $bundle: ["npm:@jxsuite/search/client"], $prototype: "Function", timing: "client",
body }`. The body lazy-imports the client once per page onto `globalThis.__jxSearch`, preloads the
index, flips `state.__jxSearchReady` — reading that flag is what makes the computed re-run when the
client finishes loading — and returns results only once `isReady()`. The bundle URL is the
deterministic, hash-free `/assets/jxsuite-search-client.js`, derived from
`sidecarAssetPath("npm:@jxsuite/search/client")` in `@jxsuite/schema/asset-paths`, the same mapping
the compiler's sidecar bundler uses, so neither side depends on the other.

## The client (`@jxsuite/search/client`)

MiniSearch inside (`fuzzy: 0.2`, `prefix: true`), no UI. Core API: `preload(indexUrl?)`,
`isReady()`, and a synchronous `query(q, { limit, group, pageCap, locale })` — `limit` 8, `group`
true, `pageCap` 3 (flat mode). That `limit` default governs a direct `query()` call only: the
`$src` helper `runSearch` below always passes a fixed `UI_LIMIT` of 20. Grouped mode returns
`SearchResultGroup[]`: a page with its matching sections, sorted by best score. Flat mode returns
presentation-ready `SearchResult[]` carrying
`crumbs` (title-cased slug ancestors, plus the page title on a section row), `titleTokens` and
`excerptTokens` — arrays of `{ t, m }` runs where `m: true` marks a match, so renderers highlight
without injecting HTML.

Compiled components do not go through lowering, so inside a component you use the `$src` state
conventions instead of the `Search` prototype (`sites/jxsuite.com/components/site-search.json` is
the working example):

```json
{
  "state": {
    "searchInit": {
      "$prototype": "Function",
      "$src": "npm:@jxsuite/search/client",
      "parameters": ["state"]
    },
    "runSearch": {
      "$prototype": "Function",
      "$src": "npm:@jxsuite/search/client",
      "parameters": ["state", "e"]
    }
  }
}
```

`searchInit(state)` returns `true` immediately, preloads (honouring `state.searchIndexUrl`), then
sets `state.searchReady` and re-runs a pending `state.searchQuery`. `runSearch(state, event?)`
reads the query from `event.target.value` (else `state.searchQuery`) and publishes
`state.searchResults`, `state.searchCount` and `state.searchActive`. `$src` parameters bind **by
name, not position** (spec.md §5.3): a parameter literally named `state` gets reactive state, any
other name gets the event.

## Surprises

- **A collection name that is not a loaded content collection warns and is skipped** — the build
  still succeeds and the envelope still emits, possibly with zero documents. A typo is therefore a
  silently empty search box.
- **A heading with no `id` never starts a section document.** Heading ids come from the parser
  (specs/parser.md §3.2) and are what make the `#anchor` land on the rendered page; a heading
  without one folds into the enclosing section, as does anything under a heading deeper than
  `sectionDepth`. Text before the first heading belongs to no section — the page document covers it.
- **`emit` only runs when the project declares a non-empty `search` section** — the compiler skips
  section-owner emitters whose value is `null` or `{}` (specs/extensions.md §8.4, "Gating").
- **The `public/` copy runs after `emit`**, so a file in `public/` at the same path shadows the
  emitted index — the same semantics as `sitemap.xml`.
- **Omitting `locale` is not the same as `locale: null`.** Omitted means the page's own language,
  read from `<html lang>`; `null` searches every language. Both `lower` and `resolve` drop the key
  rather than serialize `undefined`. A document with no `locale` answers every search, and region
  is ignored when tags differ only there (`fr` matches `fr-CA`).
- **`Search.resolve()` returns `[]` outside the browser**, with a warning — search is a client-side
  interaction, so compiler-timing bakes and dev-server resolve proxying degrade rather than fail.
- **The index is one file per site and the client is a module-level singleton** — the first
  `preload` wins. Multiple collections share the one index; results carry their `collection` name.
  A failed load clears the memo so a later call can retry.
- **First-party (`@jxsuite/*`) schema fragments are read from the host, not the project's
  `node_modules`** — schema composition routes every `@jxsuite/*` `.json` ref through host
  resolution and throws when the host cannot resolve it, so installing this package into a project
  alone does not make its `search` section validate. A third-party extension's fragment still
  resolves project-first.
- **Class names are global across extensions.** `Search` and `SearchIndex` occupy the
  `$prototype`-visible namespace, not a package-scoped one.
- **`bun run build` bundles only `search-index.ts` and `search-state.ts` into `dist/`.** The client
  is deliberately not built here — the site build bundles it from source through the sidecar
  bundler.

## Versioning

Published to npm as `@jxsuite/search` — TypeScript source, like every `@jxsuite` package, following
the monorepo's release train. Its runtime dependencies are `@jxsuite/schema` and `minisearch`;
extensions may depend on core packages but never the reverse — no core package lists this one as a
runtime dependency or imports it from `src/`, and `scripts/check-dep-rules.ts` enforces that.
