---
title: "Content collections"
description: "The content section of project.json: sources, formats, entry ids, ContentCollection queries, ContentEntry lookups, and schema validation."
spec:
  - site-architecture.md#6
  - parser.md#3.2
code:
  - extensions/parser/src/content-loader.ts
  - extensions/parser/src/content.ts
  - extensions/parser/src/md.ts
---

# Content collections

> **Studio writes this format for you** — the [content-type builder](/docs/studio/projects/content-types) edits the `content` section visually, and entries show up in [Browse your project](/docs/studio/projects/browse) with schema-driven forms.

Content collections are the data layer for content-driven sites: they turn folders of Markdown, JSON, or CSV files into typed, queryable data with JSON Schema validation. Each collection is a **content type**, declared in the `content` section of `project.json`.

Formats other than JSON come from extension packages, so a site using Markdown or CSV content enables the parser in `project.json`: `"extensions": ["@jxsuite/parser"]`.

## Defining a content type

```json
{
  "content": {
    "blog": {
      "source": "./content/blog/",
      "format": "Markdown",
      "schema": {
        "type": "object",
        "properties": { "title": { "type": "string" }, "pubDate": { "type": "string" } },
        "required": ["title", "pubDate"]
      }
    }
  }
}
```

Each definition takes four keys:

- **`source`** — a directory of entry files, a single file containing many entries (one CSV or JSON file), or an `https://` URL. jxsuite.com's `docs` type points outside the project entirely (`"source": "../../docs"`) to publish this documentation from the repo.
- **`format`** — the name of a format class provided by an enabled extension (`"Markdown"`, `"Csv"`); `"json"` is the only built-in. When omitted, the format is derived from the source file's extension; directory and remote sources require an explicit `format`, and remote sources need a format that supports remote loading (such as `Csv`).
- **`$elements`** — components available inside entries as directives, e.g. jxsuite.com registers `doc-note` and `doc-tip` for these docs. See [Jx Markdown](/docs/framework/site/jx-markdown).
- **`schema`** — a JSON Schema every entry's data must satisfy.

## Entry ids

Every entry has an `id`, derived from the filesystem:

- **Flat directories** — the filename without extension: `content/blog/hello-world.md` → `hello-world`.
- **Nested directories** — a path-based id with `/` separators: `docs/framework/site/routing.md` → `framework/site/routing`, with a trailing `/index` stripped. Path-based ids pair naturally with `[...param]` catch-all routes — see [Routing](/docs/framework/site/routing).
- **JSON files** — an array file yields one entry per item (each item's `id` field, or an indexed fallback); an object file is a single entry named after the file.

## Querying with ContentCollection

Pages read a collection through a `state` entry with `$prototype: "ContentCollection"`:

```json
{
  "state": {
    "posts": {
      "$prototype": "ContentCollection",
      "contentType": "blog",
      "filter": { "draft": false },
      "sort": { "field": "pubDate", "order": "desc" },
      "limit": 10
    }
  }
}
```

- **`filter`** — either a shorthand object (each key must equal its value, as above) or an array of rules: `{ "field": "tags", "op": "contains", "value": "intro" }`. Operators: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `not contains`, `empty`, `not empty`. Use `"field": "id"` to match the entry id.
- **`sort`** — a rule or array of rules, `{ "field": "pubDate", "order": "desc" }`; `asc` is the default.
- **`limit`** — maximum number of entries.

The result is an array of entries, rendered with a [repeater](/docs/framework/concepts/lists):

```json
{
  "tagName": "ul",
  "children": {
    "$prototype": "Array",
    "of": { "$ref": "#/state/posts" },
    "map": { "tagName": "li", "textContent": "${item.data.title}" }
  }
}
```

## Single entries with ContentEntry

`$prototype: "ContentEntry"` fetches one entry by id — usually bound to a route parameter:

```json
{
  "state": {
    "post": {
      "$prototype": "ContentEntry",
      "contentType": "blog",
      "id": { "$ref": "#/$params/slug" }
    }
  }
}
```

By default `id` matches the entry id; set `"field"` to match a data field instead (e.g. `"field": "sku"` to look up a product by SKU).

A resolved entry has this shape:

```json
{
  "id": "hello-world",
  "data": { "title": "Hello World", "pubDate": "2024-01-15" },
  "body": "# Hello\n\nThis is my first post.",
  "$children": [{ "tagName": "h1", "textContent": "Hello" }]
}
```

Frontmatter and data fields live under `data` (`${state.post.data.title}`); for Markdown entries, `body` is the raw source and `$children` is the parsed Jx tree, rendered with `"children": "${state.post.$children ?? []}"`.

Markdown headings in `$children` carry automatic anchor `id`s — the heading text lowercased, punctuation stripped, spaces hyphenated, with `-2`, `-3` suffixes deduplicating repeats in document order. The entry's table of contents (`_meta.toc`: `depth`, `text`, `id` per heading) uses the same ids, so TOC links, search results, and hand-written `#fragment` URLs all land on the rendered section.

## Schema validation

Every entry is validated against its content type's `schema` when collections load — at build time and on the dev server. Missing required fields and type mismatches are reported with the content type and entry id, so a bad frontmatter key fails loudly instead of rendering an empty spot. The same schema drives Studio's [frontmatter forms](/docs/studio/editing/frontmatter) and the content-type builder's field editor.

## Relationships

A schema field can reference another content type:

```json
{ "author": { "$ref": "#/content/authors" } }
```

An entry then stores the target's id (`author: jane-doe` in frontmatter), and loading resolves it to the full entry — templates read `${state.post.data.author.data.name}`. Array fields whose `items` carry the `$ref` are to-many. Resolution rules, editing support, and modeling patterns are covered in [Relationships](/docs/framework/site/relationships).

## Related

- [Routing](/docs/framework/site/routing) — generating one page per entry with `$paths`
- [Jx Markdown](/docs/framework/site/jx-markdown) — the entry format for prose content
- [project.json](/docs/framework/site/project-json) — where the `content` section lives
