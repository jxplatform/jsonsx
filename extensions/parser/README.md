# `@jxsuite/parser`

> Content & Markdown extension for Jx: file-based content collections with Markdown and CSV formats.

## Overview

`@jxsuite/parser` is the first-party content extension. Its `jx-extension.json` manifest exposes six classes plus project/document schema fragments:

| Class                | Kind            | Purpose                                                                                            |
| -------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| `Markdown`           | Format (`.md`)  | Parse/serialize Jx Markdown documents, load markdown content entries, resolve a file at runtime    |
| `Csv`                | Format (`.csv`) | Parse local CSV files or remote CSV URLs into typed content entries                                |
| `Content`            | Project section | Loads the project.json `content` section into `_project.content` and expands `$paths` route params |
| `ContentCollection`  | Runtime class   | Query a content type with filter, sort, and limit                                                  |
| `ContentEntry`       | Runtime class   | Fetch a single entry from a content type by ID (or another field)                                  |
| `MarkdownCollection` | Runtime class   | Glob markdown files into a sorted, filterable array                                                |

Built on the [`unified`](https://unifiedjs.com/) / remark ecosystem.

## Installation & registration

```bash
bun add @jxsuite/parser
```

Registration is manifest-based. Add the package to `project.json`:

```json
{
  "extensions": ["@jxsuite/parser"]
}
```

That one entry registers the `.md`/`.csv` formats, the `content` project section, and the classes: `$prototype: "ContentEntry"` (etc.) resolves by name through the project's extension registry, with no `$src` or imports wiring. There are no implicit defaults: a project without the extension supports only `.json` documents.

## Content collections

Declare content types in the `content` section (validated by this package's project schema fragment):

```json
{
  "content": {
    "docs": {
      "source": "./content/docs",
      "format": "Markdown",
      "schema": {
        "type": "object",
        "properties": { "title": { "type": "string" }, "date": { "type": "string" } }
      },
      "$elements": [{ "$ref": "./components/doc-note.json" }]
    }
  }
}
```

Query them from any page or component:

```json
{
  "state": {
    "posts": {
      "$prototype": "ContentCollection",
      "contentType": "docs",
      "filter": [{ "field": "draft", "op": "!=", "value": true }],
      "limit": 10
    },
    "page": {
      "$prototype": "ContentEntry",
      "contentType": "docs",
      "id": { "$ref": "#/$params/slug" }
    }
  }
}
```

`ContentEntry` matches on the entry id (slug) by default; set `field` to match a frontmatter field (e.g. `"sku"`) instead.

## `Markdown`

One class carries every format capability:

- **static `parse`**: Jx Markdown source → Jx document (browser-safe; Studio opens `.md` files with it)
- **static `serialize`**: Jx document → markdown, `roundtrip` (lossless, default) or `export` (lossy clean markdown)
- **static `discover` / `load`** give compile-time content access: frontmatter → `data`, source preserved as `body`, parsed `$children`, and `_meta` (excerpt, toc, reading time, word count)
- **instance `resolve`**: runtime on-demand access for a `$prototype: "Markdown"` state entry

```json
{
  "state": {
    "post": { "$prototype": "Markdown", "src": "./content/posts/hello-world.md" }
  }
}
```

**Resolved value** (`MarkdownFileResult`):

| Property       | Type     | Description                                 |
| -------------- | -------- | ------------------------------------------- |
| `slug`         | `string` | Entry id (path-based under the source root) |
| `path`         | `string` | Full file path                              |
| `frontmatter`  | `object` | Parsed YAML frontmatter                     |
| `$children`    | `array`  | Body as Jx element nodes                    |
| `$excerpt`     | `string` | First paragraph                             |
| `$toc`         | `array`  | Table of contents (id, text, depth)         |
| `$readingTime` | `number` | Estimated reading time in minutes           |
| `$wordCount`   | `number` | Word count                                  |

### Directives

`:::name{attrs}` container syntax converts directly to Jx element nodes. `:::my-card{title="Hello"}` becomes a `my-card` element with its attributes routed to the right Jx locations (props, `$`-annotations, styles). Capitalized directives (e.g. `:::Array`) become tagName-less `$prototype` nodes. A content type's `$elements` list declares which components its entries may use.

## `Csv`

CSV content format (`documentKinds: ["content"]`; Studio opens `.csv` in grid/source modes).

| Option    | Type     | Description                                                       |
| --------- | -------- | ----------------------------------------------------------------- |
| `src`     | `string` | Path or http(s) URL to a CSV file (remote sources supported)      |
| `schema`  | `object` | Per-column type schema for coercion (number, boolean, array)      |
| `idField` | `string` | Column used as entry id (default chain: id, sku, slug, row index) |

## `MarkdownCollection`

Globs markdown files into a sorted array of `MarkdownFileResult`s (runtime alternative to the content section):

```json
{
  "state": {
    "posts": {
      "$prototype": "MarkdownCollection",
      "src": "./content/posts/*.md",
      "sortBy": "frontmatter.date",
      "sortOrder": "desc",
      "limit": 10
    }
  }
}
```

Options: `src` (glob), `sortBy` (dot-path, default `"frontmatter.date"`), `sortOrder` (`"asc"`/`"desc"`), `limit`, `filter` (predicate), `basePath`, `directives`.

## Module exports

| Export                           | Contents                                                               |
| -------------------------------- | ---------------------------------------------------------------------- |
| `@jxsuite/parser`                | `processMarkdown`, `Markdown`, `MarkdownCollection`                    |
| `@jxsuite/parser/markdown`       | The `Markdown` format class (browser-safe parse/serialize)             |
| `@jxsuite/parser/csv`            | `Csv`, `parseCSV`, `coerceCSVRows`                                     |
| `@jxsuite/parser/content`        | `ContentCollection`, `ContentEntry`, pure query functions              |
| `@jxsuite/parser/content-loader` | `Content` project-section loader                                       |
| `@jxsuite/parser/transpile`      | `transpileJxMarkdown` (markdown source → Jx document), `isJxMarkdown`  |
| `@jxsuite/parser/serialize`      | `serializeJxMarkdown`, `jxToMdast`, `mdastToJx`, markdown element sets |
| `@jxsuite/parser/*.class.json`   | The class descriptors named by the manifest                            |

## License

MIT
