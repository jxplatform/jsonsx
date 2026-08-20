# `@jxsuite/feed`

> Atom and JSON Feed documents generated from a content collection at build time.

## Overview

`@jxsuite/feed` is the Jx extension that turns a content collection into something readers
subscribe to. It contributes one class (`Feed`) and one project.json section, both reached through
`jx-extension.json` — which names the class descriptor (`src/Feed.class.json`, whose `project` block
declares the section key) and the schema fragment that gives the section its shape:

- **`feed`** — a map of feed name → feed object. Each entry names its `collection`, the `basePath`
  its entries are served under, and optional metadata (`title`, `description`, `author`), output
  shape (`formats`, `output`, `pageSize`, `archive`, `contentMode`), frontmatter field names
  (`dateField`, `updatedField`) and `language`. The schema
  (`schemas/project.fragment.schema.json`, `$id` `https://jxsuite.com/schema/extensions/feed/v1`)
  declares the same defaults `normalizeFeedConfig` applies at runtime (`DEFAULTS` in
  `src/shared.ts`), two lists kept in step by hand; it requires at least one feed and rejects
  unknown keys.

The behavior is specified in specs/site-architecture.md §6.7 (`Status: Implemented`), which also
records **why this is an extension** rather than a compiler built-in: a feed is derived from a
content collection, and wiring the compiler to one extension's section is the coupling
specs/extensions.md §1 exists to prevent. The capability contracts are specs/extensions.md §8.4
(`emit`) and §8.6 (`head`). User docs:
[/docs/framework/site/feeds](https://jxsuite.com/docs/framework/site/feeds).

**Atom 1.0 (RFC 4287) and JSON Feed 1.1. RSS 2.0 is deliberately not offered** — no standards body,
unsettled `<guid>` semantics, and every reader handles Atom. All three standards this package binds
(RFC 4287, JSON Feed 1.1, RFC 5005) are recorded as **Subset** in the Standards Alignment table of
specs/site-architecture.md, each with an explicit list of what is not implemented. Read those rows
before claiming conformance.

## Enable it

```json
{
  "url": "https://example.com",
  "extensions": ["@jxsuite/parser", "@jxsuite/feed"],
  "content": {
    "posts": { "format": "Markdown", "source": "./content/posts/" }
  },
  "feed": {
    "blog": {
      "collection": "posts",
      "basePath": "/blog/",
      "title": "Example Blog",
      "archive": true
    }
  }
}
```

`@jxsuite/parser` is what loads the content collections this publishes; a feed names one of them by
its collection key. A default build writes `dist/feed.xml` and `dist/feed.json`, plus
`dist/feed/archive/<n>.xml` when `archive` is on, and adds the discovery links to every page's
`<head>`.

**`url` is not optional.** A feed's entry identities are absolute URLs, so without it `head` returns
`[]` silently, and `emit` returns `[]` after warning that `url` is not set in project.json.

## The `Feed` class

`src/Feed.class.json` declares three capabilities, all implemented by the plain object exported as
`Feed` from `src/feed.ts`:

- **`projectData(sectionValue, ctx?)`** — timing `["compiler", "server"]`, the only one that also
  runs on the server. Normalizes the section (defaults applied) into `_project.feed`.
- **`head(sectionValue, ctx)`** — timing `["compiler"]`. Returns one `<link rel="alternate">` per
  configured format — one per format _and_ locale when the collection is localized — typed
  `application/atom+xml` / `application/feed+json` and titled with the feed's `title` (or
  `"Feed"`). Both links survive `<head>` dedup because the merger keys a link on `type` as well as
  `rel` and `href` (specs/site-architecture.md §8.3).
- **`emit(sectionValue, ctx)`** — timing `["compiler"]`. Returns `{ path, content }[]`; the host
  writes them.

`head` exists separately from `emit` because the two answer different questions at different times
(specs/extensions.md §8.6): `head` derives entries from **configuration** and runs once before the
first page is built, while `emit` derives files from loaded content and runs after the last page has
been written — too late to reach any `<head>`.

## Emission model

Everything happens inside the compiler's site build. `emit` runs at step 6e — after routes,
components and the worker are generated, and before redirects and the `public/` copy; the **host**
writes the returned records under `outDir` (paths are outDir-relative, a leading `/` is tolerated,
and a path escaping `outDir` is a build error). The package never touches the filesystem, which is
what makes both serializers testable against a literal array of items.

Consequences worth knowing:

- The `public/` copy runs after `emit`, so a same-named file in `public/` shadows an emitted feed.
- The compiler writes `_headers` Content-Type rules — `application/atom+xml; charset=utf-8` for
  `/feed.xml` and `/feed/archive/*`, `application/feed+json; charset=utf-8` for `/feed.json` — but
  only for files the build produced, and the names it looks for are the **default** ones
  (`packages/compiler/src/site/headers-emitter.ts`). A custom `output` gets no rule.

Subpath exports (`@jxsuite/feed/atom`, `/json-feed`, `/shared`) resolve to TypeScript source, so the
serializers and the pure feed model — `normalizeFeedConfig`, `entryToItem`, `sortItems`,
`feedUpdated`, `paginate`, `feedPath` — are importable on their own.

## Surprises

- **`pageSize` (default 20) trims the subscription document even when `archive` is `false`.** The
  older entries are then published nowhere. `archive: true` is what preserves them.
- **Archives are chunked from the oldest end.** Chunking from the newest would reshuffle every
  boundary on each new entry; counting from the oldest means archive 1 keeps its contents forever
  and only the newest archive changes — RFC 5005 §2 asks that a published archive not change.
- **`<fh:complete/>` needs no archives _and_ nothing trimmed.** A document trimmed by `pageSize`
  with archives off is not complete, and says so by omission.
- **RFC 5005 archives are Atom-only.** The JSON Feed branch writes exactly one document and never
  sets `next_url`, rather than mixing two pagination conventions in one feed.
- **Dates are RFC 3339 or nothing.** Only `YYYY-MM-DD` (expanded to `T00:00:00Z`) and a full
  timestamp with `Z` or a numeric offset are accepted; anything else becomes `null` rather than a
  guess. Give the collection schema `"format": "date"` so the parser's date coercion
  (`coerceEntryDates`, specs/parser.md §9.3) normalizes the field first. An entry with no readable
  date falls back to `_meta.mtime`.
- **The feed-level `<updated>` is the newest item, never the build time** — a feed stamped with the
  build re-notifies every subscriber on every deploy. An empty feed renders
  `<updated>1970-01-01T00:00:00Z</updated>`.
- **A localized collection is several feeds, not one, and this is not configurable.** When the named
  collection's `source` contains `{locale}`, each language is published in its own URL prefix
  (`/feed.xml`, `/fr-ca/feed.xml`) holding only that language's entries, stating its language with
  `xml:lang` / JSON Feed `language`. A locale with no matching entries is not written at all.
  Discovery advertises every language with `hreflang`, because `head` runs before routing and cannot
  know which locale its page is in.
- **`contentMode` branches only on `"full"`** (`src/shared.ts`), which is what adds
  `<content type="html">` / `content_html`; the summary is emitted either way.
- **A feed naming a collection that is not loaded is skipped with a console warning**, not a build
  error.
- **The schema requires `collection` and `basePath`, but the runtime tolerates their absence** —
  `collection` falls back to the section key and `basePath` to `"/"`. Validation, not
  `normalizeFeedConfig`, is what enforces them.

## Versioning

Published to npm as `@jxsuite/feed` — TypeScript source, like every `@jxsuite` package, following
the monorepo's release train. Its only runtime dependency is `@jxsuite/schema`; extensions may
depend on core packages but never the reverse — no core package lists this one as a runtime
dependency or imports it from `src/`, and `scripts/check-dep-rules.ts` enforces that.
