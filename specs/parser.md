# `@jxsuite/parser` Specification

## Content Formats and the Reference Format-Extension Classes

**Version:** 3.0.0-draft
**Status:** In Progress
**License:** MIT

---

## 1. Overview

`@jxsuite/parser` provides the content layer for Jx applications — and is the **reference implementation of the Jx format-extension contract** (see `specs/extensions.md`). It exports format classes (`Markdown`, `Csv`) and content-query classes (`MarkdownCollection`, `ContentCollection`, `ContentEntry`) that satisfy the Jx `$prototype` + `$src` external class contract and the format capability contract.

The compiler, dev server, and studio contain no markdown or CSV knowledge: every capability they need is declared in this package's `.class.json` files and dispatched through the format registry. A third-party package shipping the same shape of class is indistinguishable from this one.

Built on the `unified` / `remark` pipeline (markdown) and a minimal RFC 4180 parser (CSV).

---

## 2. Exports

| Export                            | Type           | Description                                                                       |
| --------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| `.` (`md.ts`)                     | Module         | Node entry: `Markdown` (re-export), `MarkdownCollection`, transpiler re-exports   |
| `./markdown`                      | Module         | Browser-safe `Markdown` format class (node-only capabilities dynamic-import `fs`) |
| `./csv`                           | Module         | `Csv` format class + `parseCSV` / `coerceCSVRows`                                 |
| `./serialize`                     | Module         | `serializeJxMarkdown` (roundtrip/export), `jxToMdast`, `mdastToJx`, element sets  |
| `./transpile`                     | Module         | `transpileJxMarkdown`, `mdastNodeToJx`, dot-path utilities (browser-safe)         |
| `./content`                       | Module         | `ContentCollection`, `ContentEntry` query classes                                 |
| `./html-to-jx`                    | Module         | `htmlToJx` — HTML string → Jx element tree                                        |
| `./Markdown.class.json`           | Format class   | Markdown format declaration (parse/serialize/discover/load + `$studio`)           |
| `./Csv.class.json`                | Format class   | CSV format declaration (parse/discover/load, `remote: true`)                      |
| `./MarkdownCollection.class.json` | External class | Glob collection of markdown files (runtime `resolve`)                             |
| `./ContentCollection.class.json`  | External class | Query a project content type                                                      |
| `./ContentEntry.class.json`       | External class | Fetch a single content entry                                                      |

---

## 3. `Markdown` — the markdown format class

A single class carrying every capability (`Markdown.class.json`):

```json
"format": {
  "extensions": [".md"],
  "mediaType": "text/markdown",
  "documentKinds": ["page", "component", "content"],
  "exportTarget": true
}
```

| Capability  | Scope    | Timing                   | Behavior                                                                                                                                     |
| ----------- | -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse`     | static   | compiler, server, client | `transpileJxMarkdown(source)` → Jx JSON document (frontmatter → top-level keys, body → children)                                             |
| `serialize` | static   | compiler, server, client | `serializeJxMarkdown(doc, options)` — see §5                                                                                                 |
| `discover`  | static   | compiler, server         | List `.md` entry files for a content-type source (file or directory)                                                                         |
| `load`      | static   | compiler, server         | One file → `ContentLoaderEntry[]` (frontmatter as `data`, raw source as `body`, `$children`, `_meta` with excerpt/toc/readingTime/wordCount) |
| `resolve`   | instance | runtime                  | `{ "$prototype": "Markdown", "src": "./post.md" }` → `MarkdownFileResult`                                                                    |

`$studio` declares the full editing control surface: editor modes, `documentMode` (content by default; component when frontmatter `tagName` matches `.+-.+`), `newFileTemplate`, and the element allowlist + nesting constraints that gate structural editing. The element sets are asserted in tests to match `MD_ELEMENTS` in `serialize.ts` (the source of truth).

### 3.1 Jx Usage (runtime)

```json
{
  "state": {
    "post": {
      "$prototype": "Markdown",
      "$src": "@jxsuite/parser/Markdown.class.json",
      "src": "./content/posts/hello-world.md"
    }
  }
}
```

### 3.2 `MarkdownFileResult`

| Property       | Type     | Description                                 |
| -------------- | -------- | ------------------------------------------- |
| `slug`         | `string` | Filename without extension                  |
| `path`         | `string` | Full file path                              |
| `frontmatter`  | `object` | Parsed YAML frontmatter                     |
| `$children`    | `array`  | Jx node tree (MDAST → Jx, no HTML pass)     |
| `$excerpt`     | `string` | First paragraph as plain text               |
| `$toc`         | `array`  | Table of contents (heading id, text, depth) |
| `$readingTime` | `number` | Estimated reading time in minutes           |
| `$wordCount`   | `number` | Word count                                  |

---

## 4. `Csv` — the CSV format class

`Csv.class.json` declares `format: { extensions: [".csv"], documentKinds: ["content"], remote: true }`.

| Capability | Scope    | Timing                   | Behavior                                                            |
| ---------- | -------- | ------------------------ | ------------------------------------------------------------------- |
| `parse`    | static   | compiler, server, client | RFC 4180 parse + schema-driven coercion (pure)                      |
| `discover` | static   | compiler, server         | List `.csv` entry files                                             |
| `load`     | static   | compiler, server         | Read file **or fetch http(s) URL** → coerced `ContentLoaderEntry[]` |
| `resolve`  | instance | runtime                  | Load the configured `src` (file or remote)                          |

Coercion per the content-type schema: `number` strips currency symbols/commas (`null` for empty/invalid), `boolean` is `"true"` only, `array` is comma-split/trimmed. Entry ids resolve `idField` → `id` → `sku` → `slug` → `Slug` → row index.

---

## 5. `serializeJxMarkdown` — the single Jx → markdown serializer

`@jxsuite/parser/serialize`. Replaces the studio's former `md-convert` and the compiler's former `compile-markdown` with one bidirectional module:

```ts
serializeJxMarkdown(doc, {
  mode?: "roundtrip" | "export",   // default "roundtrip"
  frontmatter?: boolean,            // roundtrip: emit YAML frontmatter (default true)
  allowlist?: Set<string>,          // roundtrip: markdown-native tags (default MD_ALL)
  componentDefs?: Map<string, JxElement>,                       // export: inline custom elements
  evaluateTemplate?: (value, scope) => unknown,                  // export: injected template hook
  buildScope?: (state) => Record<string, unknown> | null,        // export: injected scope builder
})
```

- **roundtrip** — lossless: YAML frontmatter (via the `yaml` package) from non-children doc keys; elements outside the allowlist (or carrying Jx-specific props) emit as remark directives with collapsed dot-path attributes. Inverse of `transpileJxMarkdown()`.
- **export** — lossy clean GFM: wrappers (`div`, `section`, …) unwrapped, custom elements inlined by resolving definitions with instance `$props`, `$prototype: "Array"` descriptors expanded, `innerHTML` converted, template strings evaluated through the injected hooks (the compiler passes its static-template machinery; the default keeps templates verbatim). No frontmatter, no directives.

Fenced-code language is canonical on `className` (`language-x`); `attributes.class` is read for backward compatibility.

Also exported: `jxToMdast` / `mdastToJx` (roundtrip tree conversions) and the element-set constants (`MD_ELEMENTS`, `MD_BLOCK`, `MD_INLINE`, `MD_ALL`, `MD_VOID`, `MD_TEXT_ONLY`) that feed `$studio.elements`.

---

## 6. `MarkdownCollection`

Runtime glob collection (node-only):

```json
{
  "state": {
    "posts": {
      "$prototype": "MarkdownCollection",
      "$src": "@jxsuite/parser/MarkdownCollection.class.json",
      "src": "./posts/*.md",
      "sortBy": "frontmatter.date",
      "sortOrder": "desc",
      "limit": 10
    }
  }
}
```

`resolve()` returns sorted/filtered/limited `MarkdownFileResult[]`.

---

## 7. `MarkdownDirective` — `::directive{attrs}` syntax

Directives map to custom element tags in the Jx tree (text/leaf/container, nesting via colon count). Directive attributes use dot-path expansion (`style.backgroundColor="blue"`), `$`-keyword mapping (`prototype=` → `$prototype`), pseudo-class/media style keys, and `--title`/`--description` annotations. Content-type `$elements` become the plugin's `allowedNames`. See `specs/jx-markdown.md` for the full dialect.

---

## 8. External class contract compliance

All classes satisfy the Jx external class contract: constructor receives the config object, `resolve()` returns the value (async), and `.class.json` schemas allow the dev server, compiler, and studio to introspect structure — including the format block, capability roles with `timing`, and `$studio` hints — without importing the implementation.

---

_`@jxsuite/parser` Specification v3.0.0-draft_
