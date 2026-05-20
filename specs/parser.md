# `@jxsuite/parser` Specification

## Markdown Parser and External Class Integration

**Version:** 2.0.0-draft
**Status:** In Progress
**License:** MIT

---

## 1. Overview

`@jxsuite/parser` provides the content layer for Jx applications. It exports external classes (`MarkdownFile`, `MarkdownCollection`) that satisfy the Jx `$prototype` + `$src` external class contract, enabling markdown content to be declared as reactive data sources in Jx component files.

Built on the `unified` / `remark` / `rehype` pipeline.

---

## 2. Exports

| Export               | Type          | Description                                               |
| -------------------- | ------------- | --------------------------------------------------------- |
| `MarkdownFile`       | Class         | Parses a single markdown file into structured data        |
| `MarkdownCollection` | Class         | Globs markdown files into a sorted, filterable collection |
| `MarkdownDirective`  | Remark plugin | Maps `::directive{attrs}` syntax to custom element tags   |

---

## 3. `MarkdownFile`

### 3.1 Jx Usage

```json
{
  "state": {
    "post": {
      "$prototype": "MarkdownFile",
      "$src": "@jxsuite/md",
      "src": "./content/posts/hello-world.md"
    }
  }
}
```

### 3.2 Constructor

Receives a configuration object with:

| Property | Type     | Required | Description                    |
| -------- | -------- | -------- | ------------------------------ |
| `src`    | `string` | Yes      | Path to a single markdown file |

### 3.3 Resolved Value

The `resolve()` method returns an object with:

| Property       | Type     | Description                                 |
| -------------- | -------- | ------------------------------------------- |
| `slug`         | `string` | Filename without extension                  |
| `path`         | `string` | Full file path                              |
| `frontmatter`  | `object` | Parsed YAML frontmatter                     |
| `$body`        | `string` | Rendered HTML body                          |
| `$excerpt`     | `string` | First paragraph as HTML                     |
| `$toc`         | `array`  | Table of contents (heading id, text, depth) |
| `$readingTime` | `number` | Estimated reading time in minutes           |
| `$wordCount`   | `number` | Word count                                  |

### 3.4 Parsing Pipeline

1. `remark-parse` — markdown to MDAST
2. `remark-frontmatter` + `remark-parse-frontmatter` — YAML frontmatter extraction
3. `remark-gfm` — GitHub Flavored Markdown (tables, strikethrough, autolinks)
4. `remark-directive` — `::directive{attrs}` syntax parsing
5. `MarkdownDirective` — maps directive nodes to custom element tags with `data-jx-props` encoding
6. `remark-rehype` — MDAST to HAST
7. `rehype-stringify` — HAST to HTML string

> **Status: Implemented.** Full parsing pipeline with all listed output properties.

---

## 4. `MarkdownCollection`

### 4.1 Jx Usage

```json
{
  "state": {
    "posts": {
      "$prototype": "MarkdownCollection",
      "$src": "@jxsuite/md",
      "src": "./content/posts/*.md",
      "sortBy": "date",
      "sortOrder": "desc",
      "limit": 10
    }
  }
}
```

### 4.2 Constructor

| Property    | Type     | Required | Description                                      |
| ----------- | -------- | -------- | ------------------------------------------------ |
| `src`       | `string` | Yes      | Glob pattern for markdown files                  |
| `sortBy`    | `string` | No       | Frontmatter field to sort by (default: `"date"`) |
| `sortOrder` | `string` | No       | `"asc"` or `"desc"` (default: `"desc"`)          |
| `limit`     | `number` | No       | Maximum number of results                        |
| `filter`    | `string` | No       | Frontmatter field filter expression              |

### 4.3 Resolved Value

An array of `MarkdownFile` resolved objects, sorted and filtered per configuration.

> **Status: Implemented.** Full collection with glob, sort, limit, and filter.

---

## 5. `MarkdownDirective`

### 5.1 Purpose

A remark plugin that transforms markdown directive syntax into custom element tags in the HTML output. Directive parameters are encoded as a single `data-jx-props` JSON attribute rather than individual HTML attributes. This aligns with Jx's property-based data flow (`$props` / lit-html `.property` syntax) and avoids requiring `observedAttributes` on component definitions.

### 5.2 Syntax

Directives follow the [remark-directive](https://github.com/remarkjs/remark-directive) syntax. Nesting uses increasing colon counts:

| Directive type | Syntax                       | Use case                                        |
| -------------- | ---------------------------- | ----------------------------------------------- |
| Text (inline)  | `:name[label]{attrs}`        | Inline custom elements within a paragraph       |
| Leaf (block)   | `::name{attrs}`              | Self-contained block elements (no body content) |
| Container      | `:::name{attrs}` ... `:::`   | Block elements wrapping child content           |
| Nested parent  | `::::name{attrs}` ... `::::` | Container wrapping other container directives   |

```markdown
::::brm-services{heading="Our Services"}
:::brm-service{title="Masonry" image="/img/masonry.png"}
Description paragraph here.
:::
:::brm-service{title="Repair" image="/img/repair.png"}
Another description.
:::
::::
```

### 5.3 Output: `data-jx-props` Encoding

Directive parameters are serialized as a JSON string in a single `data-jx-props` attribute:

```html
<brm-services data-jx-props='{"heading":"Our Services"}'>
  <brm-service data-jx-props='{"title":"Masonry","image":"/img/masonry.png"}'>
    <p>Description paragraph here.</p>
  </brm-service>
  <brm-service data-jx-props='{"title":"Repair","image":"/img/repair.png"}'>
    <p>Another description.</p>
  </brm-service>
</brm-services>
```

The runtime reads `data-jx-props` in `connectedCallback`, parses the JSON, and merges matching keys into the component's reactive state. The attribute is removed after reading. This happens before the `$props` JS property merger, so explicit `$props` from a parent component always take precedence.

Directives without parameters produce no `data-jx-props` attribute — body content is distributed via `<slot>` as usual.

### 5.4 Tag Naming

- Directive names containing a hyphen are used as-is (they already satisfy the custom element spec)
- Names without a hyphen receive a configurable prefix (default: `jx-`), e.g. `::card` → `<jx-card>`

### 5.5 Plugin Options

| Option         | Type       | Default | Description                                               |
| -------------- | ---------- | ------- | --------------------------------------------------------- |
| `prefix`       | `string`   | `"jx-"` | Prefix for directive names without a hyphen               |
| `passContent`  | `boolean`  | `true`  | Whether container directive content becomes slot children |
| `allowedNames` | `string[]` | —       | Whitelist of allowed directive names (all if omitted)     |

### 5.6 Pipeline Position

`MarkdownDirective` runs as a remark plugin (MDAST phase), after `remark-directive` parses the syntax and before `remark-rehype` converts to HAST. It sets `data.hName` (tag name) and `data.hProperties` (the `data-jx-props` attribute) on each directive node.

> **Status: Implemented.** Plugin registered in the remark pipeline with `data-jx-props` encoding.

---

## 6. External Class Contract Compliance

Both `MarkdownFile` and `MarkdownCollection` satisfy the Jx external class contract:

| Requirement                        | Implementation                                   |
| ---------------------------------- | ------------------------------------------------ |
| Constructor receives config object | Yes — all properties except reserved keywords    |
| `resolve()` async method           | Yes — returns parsed content                     |
| `value` property                   | Accessible after resolution                      |
| `subscribe(callback)`              | Not implemented (content is static at load time) |

---

## 7. `.class.json` Schemas

The package includes JSON Schema definitions for both classes:

- `MarkdownFile.class.json` — schema with `$implementation: "./md.js"`
- `MarkdownCollection.class.json` — schema with `$implementation: "./md.js"`

These enable the dev server and compiler to introspect class structure without importing the implementation.

> **Status: Implemented.** Both `.class.json` files are present and used by the resolution pipeline.

---

## 8. Dependencies

| Package                    | Purpose                       |
| -------------------------- | ----------------------------- |
| `unified`                  | Pipeline orchestrator         |
| `remark-parse`             | Markdown → MDAST              |
| `remark-frontmatter`       | YAML frontmatter support      |
| `remark-parse-frontmatter` | Frontmatter extraction        |
| `remark-gfm`               | GitHub Flavored Markdown      |
| `remark-directive`         | Directive syntax              |
| `remark-rehype`            | MDAST → HAST                  |
| `rehype-stringify`         | HAST → HTML                   |
| `glob`                     | File globbing for collections |
| `mdast-util-to-string`     | Text extraction               |
| `unist-util-visit`         | AST traversal                 |

---

_`@jxsuite/parser` Specification v2.0.0-draft_
