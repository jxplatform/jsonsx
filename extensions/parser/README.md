# `@jxsuite/parser`

> Markdown parser and external class integration for Jx.

## Overview

`@jxsuite/parser` provides the content layer for Jx applications. It exports `MarkdownFile` and `MarkdownCollection` — external classes that satisfy the Jx `$prototype` + `$src` contract — and a `transpile` utility for converting Jx-flavored Markdown directly into Jx component objects.

Built on the [`unified`](https://unifiedjs.com/) / remark / rehype pipeline.

## Installation

```bash
bun add @jxsuite/parser
```

## `MarkdownFile`

Parses a single Markdown file into structured data.

```json
{
  "state": {
    "post": {
      "$prototype": "MarkdownFile",
      "$src": "@jxsuite/parser/MarkdownFile.class.json",
      "src": "./content/posts/hello-world.md"
    }
  }
}
```

**Resolved value:**

| Property       | Type     | Description                         |
| -------------- | -------- | ----------------------------------- |
| `slug`         | `string` | Filename without extension          |
| `path`         | `string` | Full file path                      |
| `frontmatter`  | `object` | Parsed YAML frontmatter             |
| `$body`        | `string` | Rendered HTML body                  |
| `$excerpt`     | `string` | First paragraph as HTML             |
| `$toc`         | `array`  | Table of contents (id, text, depth) |
| `$readingTime` | `number` | Estimated reading time in minutes   |
| `$wordCount`   | `number` | Word count                          |

## `MarkdownCollection`

Globs Markdown files into a sorted, filterable collection.

```json
{
  "state": {
    "posts": {
      "$prototype": "MarkdownCollection",
      "$src": "@jxsuite/parser/MarkdownCollection.class.json",
      "src": "./content/posts/*.md",
      "sortBy": "date",
      "sortOrder": "desc",
      "limit": 10
    }
  }
}
```

Returns an array of `MarkdownFile` resolved objects.

| Option      | Type     | Default  | Description                         |
| ----------- | -------- | -------- | ----------------------------------- |
| `src`       | `string` | —        | Glob pattern for Markdown files     |
| `sortBy`    | `string` | `"date"` | Frontmatter field to sort by        |
| `sortOrder` | `string` | `"desc"` | `"asc"` or `"desc"`                 |
| `limit`     | `number` | —        | Maximum number of results           |
| `filter`    | `string` | —        | Frontmatter field filter expression |

## `MarkdownDirective` (remark plugin)

Maps `::directive{attrs}` syntax to custom element tags in HTML output. Parameters are encoded as a `data-jx-props` JSON attribute so Jx components can receive them via reactive state.

```markdown
:::my-card{title="Hello" image="/img/hero.png"}
Card body content here.
:::
```

Produces:

```html
<my-card data-jx-props='{"title":"Hello","image":"/img/hero.png"}'>
  <p>Card body content here.</p>
</my-card>
```

## `transpileJxMarkdown`

Converts a Jx-flavored Markdown source string directly into a Jx component object (no file I/O).

```js
import { transpileJxMarkdown } from "@jxsuite/parser/transpile";

const doc = transpileJxMarkdown(markdownString);
// { tagName: "article", children: [...] }
```

## Parsing pipeline

1. `remark-parse` — Markdown → MDAST
2. `remark-frontmatter` + `remark-parse-frontmatter` — YAML extraction
3. `remark-gfm` — GitHub Flavored Markdown
4. `remark-directive` — directive syntax
5. `MarkdownDirective` — directive nodes → custom element tags
6. `remark-rehype` — MDAST → HAST
7. `rehype-stringify` — HAST → HTML

## License

MIT
