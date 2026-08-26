---
title: "Content collections"
description: "The content section of project.json: sources, formats, entry ids, ContentCollection queries, ContentEntry lookups, and schema validation."
spec:
  - site-architecture.md#6
  - site-architecture.md#9.3
  - parser.md#3.2
  - parser.md#9.2
code:
  - extensions/parser/src/content-loader.ts
  - extensions/parser/src/content.ts
  - extensions/parser/src/md.ts
---

# Content collections

> **Studio writes this format for you.** The [content-type builder](/docs/studio/projects/content-types) edits the `content` section visually, and entries show up in [The Library](/docs/studio/projects/browse) with schema-driven forms.

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

- **`source`**: a directory of entry files, a single file containing many entries (one CSV or JSON file), or an `https://` URL. jxsuite.com's `docs` type points outside the project entirely (`"source": "../../docs"`) to publish this documentation from the repo.
- **`format`**: the name of a format class provided by an enabled extension (`"Markdown"`, `"Csv"`); `"json"` is the only built-in. When omitted, the format is derived from the source file's extension; directory and remote sources require an explicit `format`, and remote sources need a format that supports remote loading (such as `Csv`).
- **`$elements`**: components available inside entries as directives, e.g. jxsuite.com registers `doc-note` and `doc-tip` for these docs. See [Jx Markdown](/docs/framework/site/jx-markdown).
- **`schema`**: a JSON Schema every entry's data must satisfy.

## Entry ids

Every entry has an `id`, derived from the filesystem:

- **Flat directories**: the filename without extension: `content/blog/hello-world.md` → `hello-world`.
- **Nested directories**: a path-based id with `/` separators: `docs/framework/site/routing.md` → `framework/site/routing`, with a trailing `/index` stripped. Path-based ids pair naturally with `[...param]` catch-all routes. See [Routing](/docs/framework/site/routing).
- **JSON files**: an array file yields one entry per item (each item's `id` field, or an indexed fallback); an object file is a single entry named after the file.

## Media beside your content

Entries reference images the way any markdown editor expects, relative to the file itself:

```markdown
![A diagram of the pipeline](./images/diagram.png)
```

Keep the images in the collection directory (`content/blog/images/diagram.png`), and the entry reads correctly in VS Code, Obsidian, GitHub, and on the built site alike. When the collection loads, that reference is remapped to the collection's own URL, `/content/blog/images/diagram.png`, which the build copies into `dist/` and the dev server serves straight from the source file. It works even when the source lives outside the project, which is how these docs ship their screenshots from `docs/images/`.

Only files an entry actually references are published; unreferenced siblings and the entry files themselves never reach `dist/`.

:::doc-note
Remapping applies to element `src`/`poster` values and to frontmatter fields your schema declares as `"format": "uri-reference"` (that's also what gives Studio a [media picker](/docs/studio/projects/media) for the field). A path that doesn't resolve to a real file beside the entry is left exactly as written, with a build warning naming the entry, so root-relative paths into `public/` keep working unchanged.
:::

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

- **`filter`**: either a shorthand object (each key must equal its value, as above) or an array of rules: `{ "field": "tags", "op": "contains", "value": "intro" }`. Operators: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `not contains`, `empty`, `not empty`. Use `"field": "id"` to match the entry id.
- **`sort`**: a rule or array of rules, `{ "field": "pubDate", "order": "desc" }`; `asc` is the default.
- **`limit`**: maximum number of entries.

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

`$prototype: "ContentEntry"` fetches one entry by id, usually bound to a route parameter:

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

Markdown headings in `$children` carry automatic anchor `id`s: the heading text lowercased, punctuation stripped, spaces hyphenated, with `-2`, `-3` suffixes deduplicating repeats in document order. The entry's table of contents (`_meta.toc`: `depth`, `text`, `id` per heading) uses the same ids, so TOC links, search results, and hand-written `#fragment` URLs all land on the rendered section.

Two details of that are worth knowing if you write in anything but English. **Letters outside ASCII are kept**, so a Japanese or Russian heading gets an anchor made of its own words rather than an empty one falling back to `section`. And an accented heading gets **one** anchor whichever way it was typed: `é` can be a single character or an `e` with a combining accent, they look identical and used to produce two different links, so the text is normalized before the id is built. Anchors for plain-ASCII headings are unchanged, so existing links still work.

`_meta.wordCount` and `_meta.readingTime` count **words as the language defines them**, not runs of text between spaces. A Japanese or Thai article has no spaces between its words and used to count as one word, and therefore as one minute to read however long it was. Reading time is word count at 200 words per minute; that rate is a single honest constant rather than a per-language table, so treat it as an estimate for prose in any script.

Fenced code blocks in `$children` arrive syntax-highlighted: recognized languages become token spans carrying `--shiki-light`/`--shiki-dark` color variables that follow the site's [color scheme](/docs/framework/concepts/color-schemes). See [Jx Markdown](/docs/framework/site/jx-markdown) for the language set.

## Schema validation

Every entry is validated against its content type's `schema` when collections load, at build time and on the dev server alike. Missing required fields and type mismatches are reported with the content type and entry id, so a bad frontmatter key fails loudly instead of rendering an empty spot. The same schema drives Studio's [frontmatter forms](/docs/studio/editing/frontmatter) and the content-type builder's field editor.

## Dates

Declare a date field with `format`, and the loader normalizes it so sorting and filtering work:

```json
{
  "properties": {
    "pubDate": { "type": "string", "format": "date" },
    "updated": { "type": "string", "format": "date-time" }
  }
}
```

| `format`      | Stored as                          |
| ------------- | ---------------------------------- |
| `"date"`      | `2025-03-04`                       |
| `"date-time"` | `2025-03-04T16:00:00Z`, always UTC |

Date-times are converted to UTC because otherwise they don't sort: `2025-03-04T01:00:00+02:00` looks _later_ than `2025-03-04T00:00:00Z` as text and is actually two hours _earlier_. If you need the original offset back, as an events collection meaning "7pm local" would, it's kept at `_meta.rawDates`.

You can write a `Date` from YAML, a full RFC 3339 timestamp, or a bare `YYYY-MM-DD`. Anything else is left exactly as you wrote it and reported as a warning naming the entry and field:

```text
Content dates: "blog/my-post" field "pubDate" is "03/04/2025", which is not an
unambiguous date. Write it as YYYY-MM-DD — a form like "03/04/2025" means two
different days depending on who reads it, so it is left as authored rather than guessed.
```

:::doc-note
Without a `format`, a date is just a string. `MarkdownCollection`'s default sort compares text, which works for `YYYY-MM-DD` and not for timestamps with offsets. Declare the field in a content type and the loader handles it.
:::

## Relationships

A schema field can reference another content type:

```json
{ "author": { "$ref": "#/content/authors" } }
```

An entry then stores the target's id (`author: jane-doe` in frontmatter), and loading resolves it to the full entry, so templates read `${state.post.data.author.data.name}`. Array fields whose `items` carry the `$ref` are to-many. Resolution rules, editing support, and modeling patterns are covered in [Relationships](/docs/framework/site/relationships).

## Related

- [Routing](/docs/framework/site/routing): generating one page per entry with `$paths`
- [Jx Markdown](/docs/framework/site/jx-markdown): the entry format for prose content
- [project.json](/docs/framework/site/project-json): where the `content` section lives
