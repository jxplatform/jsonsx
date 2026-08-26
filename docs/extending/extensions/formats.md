---
title: "Custom formats"
description: "Claiming file extensions with the format block: parse, serialize, discover, and load capabilities, remote sources, and Studio mode hints."
spec:
  - extensions.md#7
  - extensions.md#10
  - parser.md#8
code:
  - extensions/parser/src/Markdown.class.json
  - packages/schema/src/format-registry.ts
  - packages/schema/src/media-type.ts
---

# Custom formats

A format teaches Jx a new file type. `.json` is the single native built-in — Jx _is_ JSON — so every other extension a project opens, saves, builds, or loads content from (`.md`, `.csv`, your `.toml`) is dispatched through a format class. A class participates in format dispatch iff its `.class.json` descriptor carries a top-level `format` object.

## The `format` block

The parser's `Markdown.class.json` declares, verbatim:

```json
"format": {
  "extensions": [".md"],
  "mediaType": "text/markdown; variant=GFM",
  "documentKinds": ["page", "component", "content"],
  "exportTarget": true,
  "remote": false
}
```

| Key             | Type                                 | Default | Meaning                                                                                                                                      |
| --------------- | ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions`    | `string[]` (required)                | —       | File extensions claimed, with leading dot.                                                                                                   |
| `mediaType`     | `string`                             | —       | Media type; **validated** — a malformed value fails the registry build. Used for icons, labels and HTTP responses.                           |
| `documentKinds` | `("page"\|"component"\|"content")[]` | `[]`    | `page`/`component` admit the extension into pages/components discovery globs; `content` admits it as a content source.                       |
| `exportTarget`  | `boolean`                            | `false` | When true, site builds emit a serialized sidecar per page in this format (requires a `serialize` capability).                                |
| `remote`        | `boolean`                            | `false` | When true, the `load` capability accepts `http(s)` URLs as sources. Remote content sources **must** name a remote-capable format explicitly. |

Two classes may claim the same extension **only with disjoint capabilities** — the registry build fails on an ambiguous `(extension, capability)` pair. A registry never claims `.json`.

### mediaType is checked

Your `mediaType` reaches an HTTP header, a file-picker filter and a Studio label, so it's parsed rather than passed through. Get the grammar wrong and the build tells you:

```text
Format "Toml" declares an invalid mediaType: "applicationtoml" has no "/" — a media type is type/subtype (RFC 6838 §4.2)
```

The check is on the **syntax**, not the IANA registry — `application/x.my-format` is fine, and so is any subtype nobody has registered.

Parameters are welcome and carry meaning. `@jxsuite/parser` declares `text/markdown; variant=GFM`, which is how [RFC 7763](https://www.rfc-editor.org/rfc/rfc7763) says _which_ markdown a format speaks:

```json
"format": {
  "extensions": [".md"],
  "mediaType": "text/markdown; variant=GFM"
}
```

:::doc-note
If you write code that **keys** on a media type — a file-picker `accept` map, an editor language id — use the _essence_ (`text/markdown`), not the declared string. `mediaTypeEssence` on the registry entry gives you that. Two Studio call sites broke the moment the `variant` parameter was declared, which is why the distinction exists.
:::

### What a static file server sends

Your `format` block only reaches code that went through the registry. A `.md` file served straight off disk — by the dev server, or by `jx preview` — never touches it, and the platform's own table answers instead.

For most extensions that's fine. For two it isn't, so Jx overrides them:

| Extension       | Platform says           | Jx sends                     | Why                                                                  |
| --------------- | ----------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `.md`           | `text/markdown`         | `text/markdown; variant=GFM` | Bare `text/markdown` doesn't say _which_ markdown ([RFC 7763][7763]) |
| `.yaml`, `.yml` | `text/yaml`, or nothing | `application/yaml`           | `text/yaml` is the pre-registration spelling ([RFC 9512][9512] §5)   |

[7763]: https://www.rfc-editor.org/rfc/rfc7763
[9512]: https://www.rfc-editor.org/rfc/rfc9512

Everything else keeps whatever the host already decided — this list corrects a lookup, it isn't a second MIME table. A test asserts that the `.md` entry and the parser's declared `mediaType` agree, because they live in files that can't import each other.

## Format capabilities

The block declares _what_ the class handles; the class's [capability methods](/docs/extending/extensions/capabilities) declare _how_. Four roles belong to the `format` block:

| Role        | Signature                                                     | Consumers                                   |
| ----------- | ------------------------------------------------------------- | ------------------------------------------- |
| `parse`     | `(source, options?) → JxDocument`                             | compiler, server, Studio (open file)        |
| `serialize` | `(doc, options?) → string`                                    | Studio (save), site build (export sidecars) |
| `discover`  | `(source, { baseDir }) → string[]`                            | content loading (list entry files)          |
| `load`      | `(path, { schema, directiveOptions }) → ContentLoaderEntry[]` | content loading (parse one source)          |

A format implements the subset it needs: a read-only format can ship `parse` without `serialize` (Studio then opens files in this format read-only in structural modes); a data-only format like `Csv` needs `discover`/`load` but has no reason to be a page format.

The `Markdown` class implements all four, plus the standard instance `resolve()` — so `{ "$prototype": "Markdown", "src": "./about.md" }` works as runtime state, satisfying the same [external class contract](/docs/extending/extensions/classes) as every other class.

## How the pipeline dispatches

Hosts never hard-code file types. Each one builds a format registry from the enabled extensions' manifests and routes by extension:

- **Pages and components discovery** — the site build and dev server glob for `.json` plus every extension whose format declares the matching `documentKind`, then call `parse` on non-JSON matches. This is why adding a Markdown page is just dropping `pages/about.md` in a parser-enabled project.
- **Content loading** — a `content` section entry names a format (or derives it from the source's file extension); the loader calls `discover` to list entry files, then `load` per file, validating each entry against the content type's schema. See [Content collections](/docs/framework/site/content-collections).
- **Studio editing** — opening a claimed file calls `parse` to get the Jx tree the canvas edits; saving calls `serialize`. When a capability's `timing` excludes the browser, Studio round-trips through the dev server's `POST /__studio/format` endpoint instead of importing the implementation ([Studio routes](/docs/extending/reference/studio-routes)).
- **Export sidecars** — with `exportTarget: true`, the build serializes each page into the format next to its HTML output.

## Studio hints

Format classes describe their Studio control surface declaratively in a top-level `$studio` block — Studio interprets this data generically and never hard-codes per-format element sets. From `Markdown.class.json`, abbreviated:

```json
"$studio": {
  "icon": "markdown",
  "modes": ["edit", "design", "preview", "source"],
  "documentMode": {
    "default": "content",
    "componentWhen": { "frontmatterKey": "tagName", "matches": ".+-.+" }
  },
  "newFileTemplate": "---\ntitle: Untitled\n---\n\n",
  "elements": {
    "block": ["h1", "h2", "h3", "p", "blockquote", "ul", "ol", "li", "pre", "…"],
    "inline": ["em", "strong", "del", "code", "a", "img", "br"],
    "void": ["hr", "br", "img"],
    "textOnly": ["code"],
    "nesting": {
      "h1": { "block": false, "inline": true, "directive": false },
      "ul": { "only": ["li"] },
      "…": {}
    }
  }
}
```

- `icon` — file icon in the Files panel; `modes` — which canvas modes the format supports.
- `documentMode` — whether files open as prose content or as components, with an optional frontmatter-based override (here: a hyphenated `tagName` means "this .md file defines a custom element").
- `newFileTemplate` — the seed content for **New File** in this format.
- `elements` — the allowlist and nesting constraints gating structural editing: which tags the element picker offers, what may nest where, which are void or text-only.

One more generic hint applies to any class, not just formats: `$studio.stateDefaults` — an object merged into state entries Studio creates for the prototype. The connector's `TableQuery` sets `{ "timing": "client" }` so Studio-created queries default to browser resolution.

## Related

- [Tutorial: a TOML format extension](/docs/extending/extensions/tutorial-toml-format) — build a working format end to end
- [Capability methods](/docs/extending/extensions/capabilities) — timing and the options contract
- [Content collections](/docs/framework/site/content-collections) — the consumer of `discover`/`load`
- [Jx Markdown](/docs/framework/site/jx-markdown) — what the reference format's dialect looks like
