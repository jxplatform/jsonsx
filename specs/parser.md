# `@jxsuite/parser` Specification

## Content Formats and the Reference Format-Extension Classes

**Version:** 0.2.7-draft
**Status:** Partial
**Updated:** 2026-08-15
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

> **Status: Partial.** The class and every capability ship. Two derived values are **correct only
> for Latin script**: `slugifyHeading` strips on an ASCII-only character class, so a heading in any
> other script slugifies to the empty string and falls back to `section`, `section-2`, … — which
> means the deep-linkable anchors this section promises are not delivered for those documents; and
> `$wordCount`/`$readingTime` split on whitespace, which reports a CJK article as one word. See §10.

A single class carrying every capability (`Markdown.class.json`):

```json
"format": {
  "extensions": [".md"],
  "mediaType": "text/markdown",
  "documentKinds": ["page", "component", "content"],
  "exportTarget": true
}
```

| Capability  | Scope    | Timing                   | Behavior                                                                                                                                                                     |
| ----------- | -------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse`     | static   | compiler, server, client | `transpileJxMarkdown(source)` → Jx JSON document (frontmatter → top-level keys, body → children)                                                                             |
| `serialize` | static   | compiler, server, client | `serializeJxMarkdown(doc, options)` — see §5                                                                                                                                 |
| `discover`  | static   | compiler, server         | List `.md` entry files for a content-type source (file or directory)                                                                                                         |
| `load`      | static   | compiler, server         | One file → `ContentLoaderEntry[]` (frontmatter as `data`, raw source as `body`, `$children` with deduplicated heading `id`s, `_meta` with excerpt/toc/readingTime/wordCount) |
| `resolve`   | instance | runtime                  | `{ "$prototype": "Markdown", "src": "./post.md" }` → `MarkdownFileResult`                                                                                                    |

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

**Heading anchors.** `processMarkdown` assigns every `h1`–`h6` in `$children`
a slug `id` (`slugifyHeading` in `transpile.ts`: lowercase, punctuation
stripped, spaces → hyphens) with document-order deduplication — the first
occurrence is unsuffixed, repeats get `-2`, `-3`, …. `$toc` entries are built
from the same walk (`assignHeadingIds`), so rendered anchors and `$toc[i].id`
always agree; pre-existing ids are respected and still claim their slug.
Rendered pages are therefore deep-linkable to sections
(`/docs/<slug>/#<heading-id>`), which site search and TOC UIs rely on.
`transpileJxMarkdown` (the component path) is unaffected.

---

## 4. `Csv` — the CSV format class

`Csv.class.json` declares `format: { extensions: [".csv"], documentKinds: ["content"], remote: true }`.

| Capability | Scope    | Timing                   | Behavior                                                            |
| ---------- | -------- | ------------------------ | ------------------------------------------------------------------- |
| `parse`    | static   | compiler, server, client | RFC 4180 parse + schema-driven coercion (pure)                      |
| `discover` | static   | compiler, server         | List `.csv` entry files                                             |
| `load`     | static   | compiler, server         | Read file **or fetch http(s) URL** → coerced `ContentLoaderEntry[]` |
| `resolve`  | instance | runtime                  | Load the configured `src` (file or remote)                          |

Coercion per the content-type schema: `number` strips currency symbols/commas (`null` for empty/invalid), `boolean` is `"true"` only, `array` is comma-split/trimmed. **Dates are not coerced here** — a `format: "date"` field is handled once for every format by the content loader (§9.3), which is the only place that holds both the entries and the schema. Entry ids resolve `idField` → `id` → `sku` → `slug` → `Slug` → row index.

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

## 9. `Content` — the project-section class

> **Status: Implemented.**

`Content.class.json` owns the `project.json` `content` section (extensions.md §9). Its capabilities are format-agnostic: `projectData` loads every content type through the format registry, `resolvePaths` expands `contentType` `$paths`, and `assets` publishes the collections' directories.

### 9.1 `assets` — collection asset mounts

`Content.assets(sectionValue, { root })` returns one mount per content type whose `source` is a local **directory**: `{ urlPrefix: "/content/<type>", dir: <resolved source> }`. Single-file, remote, and missing sources get no mount — a lone file's siblings are not its collection — and a content type whose name is not URL-safe is skipped with a warning.

### 9.2 Content-relative asset references

Entries address media relative to themselves, so a collection reads correctly in a markdown editor and on the built site alike. After a format class loads a file, the loader remaps its references onto that collection's mount:

- element `src` and `poster` values anywhere in `$children`, and frontmatter fields the content-type schema declares `"format": "uri-reference"` (string or array of strings);
- only when the value is relative (no leading `/`, no `scheme:`, no `#`, no `${…}` template) **and** resolves against the entry's own directory to an existing file inside the mount directory;
- a relative reference that resolves to nothing is left as authored and reported as a warning naming the entry;
- the raw `body` is never rewritten — it is the round-trip source Studio saves back — and `href` is out of scope, since links between entries are routes rather than assets.

Because the rewrite happens in the loader, every consumer of `projectData` — site build, dev server, studio preview, search indexing — sees the same mounted URLs with no extra work.

### 9.3 Date coercion

> **Status: Implemented.** `coerceEntryDates` runs in the content loader between a format class's
> `load` and `validateEntries` — the one point that holds both the entries and the schema, since
> `Csv.load` receives a schema and `Markdown.load` does not.

A field the content-type schema declares as `format: "date"` or `format: "date-time"` is normalized
to RFC 3339:

| Declared    | Stored                                                  |
| ----------- | ------------------------------------------------------- |
| `date`      | `YYYY-MM-DD`                                            |
| `date-time` | `YYYY-MM-DDTHH:MM:SSZ` — **UTC**, no fractional seconds |

**Why a string and not a `Date`.** `JSON.stringify(new Date("2025-03-04"))` yields an instant, so a
Studio save would rewrite `2025-03-04` as `2025-03-04T00:00:00.000Z` — which is _March 3_ west of
UTC. A `Temporal.PlainDate` is semantically right and fails differently: `<` and `>` on one yield
`NaN`, and §6's sort compares with exactly those.

**Why UTC.** Mixed offsets do not sort lexicographically: `2025-03-04T01:00:00+02:00` sorts _after_
`2025-03-04T00:00:00Z` as text and is _earlier_ in fact. Normalizing makes the sort correct by
construction rather than correct by accident for ISO 8601.

**Accepted**, in order: a `Date` instance, an RFC 3339 string, a bare `YYYY-MM-DD`. **Everything
else is refused**, left exactly as authored, and reported naming the collection, entry, field and
value. `03/04/2025` is March 4th or April 3rd depending on the reader and `new Date()` resolves it
by implementation-defined rules, so guessing is the failure this pass exists to prevent — refusing
is the feature.

When coercion rewrote a value the authored text is kept at `_meta.rawDates[field]`, because a
collection that genuinely means "7pm local" has had that thrown away by the normalized instant.

**`_meta.mtime`.** Every loaded entry carries its source file's modification time as RFC 3339. It is
the only date a file always has, so it is the fallback a feed uses when the frontmatter carries none
(`site-architecture.md` §6.7) — and it is what would let the sitemap stop giving every page
generated from one template that template's `<lastmod>`.

**A schemaless collection is not covered.** `MarkdownCollection` (§6) globs and sorts without a
content-type schema, so nothing can know which of its frontmatter fields is a date. Its default
`sortBy: "frontmatter.date"` compares text, which is correct for `YYYY-MM-DD` and wrong for an
offset date-time. Declaring the field in a content type is what fixes it; inferring would mean
guessing, which §9.3 refuses everywhere else.

## 10. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). `remark`, `unified` and the MDAST node model are libraries rather than published standards, so they are described in §2 rather than cited here.

| Standard                                           | Class       | Binds | Evidence                                                               | Note                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ----------- | ----- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CommonMark](https://spec.commonmark.org/current/) | **Subset**  | §3    | extensions/parser/src/md.ts, extensions/parser/tests/transpile.test.ts | Parsing is CommonMark via `remark`, but only the constructs §8 maps reach a Jx node — an unmapped construct is dropped rather than mis-rendered.                                                                                                                                                                                         |
| [GFM](https://github.github.com/gfm/)              | **Subset**  | §3    | extensions/parser/src/md.ts                                            | Tables, strikethrough, task lists and autolinks are parsed; the mapping restriction above applies to them too.                                                                                                                                                                                                                           |
| [RFC 7763](https://www.rfc-editor.org/rfc/rfc7763) | **Subset**  | §3    | extensions/parser/src/Markdown.class.json                              | `gap:markdown-variant` The class declares `text/markdown`, but not the `variant` parameter RFC 7764 registers — so nothing on the wire says which flavour a `.md` file is.                                                                                                                                                               |
| [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180) | **Subset**  | §4    | extensions/parser/src/csv.ts, extensions/parser/tests/csv.test.ts      | Quoted fields, embedded separators and CRLF records are handled. There is no dialect negotiation and no header-less mode: the first record is always the header.                                                                                                                                                                         |
| [RFC 9512](https://www.rfc-editor.org/rfc/rfc9512) | **Pending** | §3    | —                                                                      | `gap:yaml-media-type` Frontmatter is YAML and carries no declared media type, so a host cannot tell what it is holding.                                                                                                                                                                                                                  |
| [UAX #15](https://www.unicode.org/reports/tr15/)   | **Pending** | §3    | —                                                                      | `gap:heading-slug-normalization` `slugifyHeading` does not normalize before casing, so the same heading typed on macOS (decomposed) and on Windows (precomposed) produces two different anchors.                                                                                                                                         |
| [UAX #29](https://www.unicode.org/reports/tr29/)   | **Pending** | §3    | —                                                                      | `gap:word-segmentation` `$wordCount` and `$readingTime` split on whitespace rather than segmenting words, so a script that does not space its words is counted as a single word.                                                                                                                                                         |
| [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) | **Subset**  | §9.3  | extensions/parser/src/dates.ts, extensions/parser/tests/dates.test.ts  | Schema-declared date fields are normalized to `full-date` or a UTC `date-time`, so sorting and comparison are correct by construction. Local offsets are not preserved in the stored value — the authored text is kept at `_meta.rawDates` instead — and a value outside the accepted forms is refused rather than parsed heuristically. |

## Changelog

- **0.2.7-draft** (2026-08-15) — §9.3 records _meta.mtime as the date fallback a feed uses.
- **0.2.6-draft** (2026-08-15) — Add §9.3 date coercion: schema-declared date fields normalize to RFC 3339, ambiguous values are refused rather than guessed.
- **0.2.5-draft** (2026-08-15) — Add §10 Standards Alignment; §3 marked Partial — heading slugs and word counts are correct only for Latin script.
- **0.2.4-draft** (2026-07-23) — Document the Content project-section class: asset mounts and content-relative reference rewriting (§9).
- **0.2.3-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.2.2-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.2.1-draft** (2026-07-17) — Sidecar bundling, extension emit capability, heading anchors (`07e28bc3`).
- **0.2.0-draft** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).
- **0.1.6-draft** (2026-05-20) — Run formatter (`8ba47930`).
- **0.1.5-draft** (2026-05-08) — Pass markdown attributes as properties (`407b70fc`).
- **0.1.4-draft** (2026-04-23) — Rebrand to jxsuite (`2897a4e8`).
- **0.1.3-draft** (2026-04-22) — Consolidate project config schema and rename as such (`e3523dbf`).
- **0.1.2-draft** (2026-04-16) — Landing site + working exports + release-it + linting (`a8409b5f`).
- **0.1.1-draft** (2026-04-15) — Rebrand to Jx / Jx Platform (`abc63f2d`).
- **0.1.0-draft** (2026-04-10) — Consolidate specs (`80ca313f`).

---

_`@jxsuite/parser` Specification v0.2.7-draft_
