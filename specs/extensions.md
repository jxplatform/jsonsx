# Jx Extensions Specification

## Format-Extension Classes and the Capability Contract

**Version:** 1.0.0-draft
**Status:** In Progress
**License:** MIT

---

## 1. Overview

Jx documents are JSON. Everything else — markdown, CSV, or any format a third party dreams up — enters the system through **format-extension classes**: ordinary Jx `.class.json` classes that additionally declare a top-level `format` block and one or more **capability methods**.

The compiler, dev server, and studio contain **no format knowledge**. They:

1. Scan the project-level `imports` map for `.class.json` files carrying a `format` block (auto-discovery).
2. Build a **format registry** indexing each class by file extension and capability.
3. Dispatch all format-specific work — parsing, serialization, content discovery and loading, studio editing constraints — through the registry.

`@jxsuite/parser` is the reference implementation: its `Markdown` and `Csv` classes are wired in exactly the way a third-party extension would be. Swap them out for your own opinionated parser, or add entirely new formats, and every integration point (build, dev server, studio editing, runtime data access) keeps working.

**`.json` is the single native built-in.** Jx _is_ JSON, so hosts handle `.json` inline and consult the registry for every other extension. A registry never claims `.json`.

---

## 2. Registration: auto-discovery from `imports`

There is no plugin manifest or registration API. A project opts into a format by importing its class in `project.json`:

```json
{
  "imports": {
    "Markdown": "@jxsuite/parser/Markdown.class.json",
    "Csv": "@jxsuite/parser/Csv.class.json"
  }
}
```

Hosts inspect each import value ending in `.class.json`; any class whose JSON carries a `format` block joins the registry under its import name. Non-class imports (layouts, components) and unreadable files are skipped silently.

Rules:

- **Project-level imports only** drive file-extension dispatch (page/component discovery, content loading, studio file opening). Page-level imports cannot be consulted before the page itself is parsed; they continue to drive `$prototype` state resolution exactly as before.
- **No implicit defaults.** A project with no format imports supports only `.json`. There is no built-in `.md` behavior anywhere.
- Two imports may claim the same extension **only with disjoint capabilities**. The registry build fails on an ambiguous `(extension, capability)` pair.

---

## 3. The `format` block

A class participates in format dispatch iff it has a top-level `format` object:

```json
"format": {
  "extensions": [".md"],
  "mediaType": "text/markdown",
  "documentKinds": ["page", "component", "content"],
  "exportTarget": true,
  "remote": false
}
```

| Key             | Type                                 | Default | Meaning                                                                                                                                                                           |
| --------------- | ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions`    | `string[]` (required)                | —       | File extensions claimed, with leading dot.                                                                                                                                        |
| `mediaType`     | `string`                             | —       | MIME type; used for icons, labels, HTTP responses.                                                                                                                                |
| `documentKinds` | `("page"\|"component"\|"content")[]` | `[]`    | `page`/`component` admit the extension into pages/components discovery globs; `content` admits it as a content-type source.                                                       |
| `exportTarget`  | `boolean`                            | `false` | When true, site builds emit a serialized sidecar per page in this format (requires a `serialize` capability).                                                                     |
| `remote`        | `boolean`                            | `false` | When true, the `load` capability accepts `http(s)` URLs as sources. Remote content sources **must** name a remote-capable format explicitly — there is no implicit remote format. |

---

## 4. Capability methods

Capabilities are declared in `$defs.methods` using well-known `role` values. All capability methods are `scope: "static"` — hosts call them on the implementation class without constructing an instance.

| Role        | Signature                                                             | Consumers                                                                     |
| ----------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `parse`     | `(source: string, options?) → JxDocument`                             | compiler (pages/components), server (component discovery), studio (open file) |
| `serialize` | `(doc: JxDocument, options?) → string`                                | studio (save file), site build (export sidecars)                              |
| `discover`  | `(source: string, { baseDir }) → string[]`                            | content loader (list entry files for a content type)                          |
| `load`      | `(path: string, { schema, directiveOptions }) → ContentLoaderEntry[]` | content loader (parse one source into entries)                                |

The existing **instance `resolve()`** method remains the runtime's on-demand access capability — a state entry like `{ "$prototype": "Markdown", "$src": "...", "src": "./post.md" }` constructs the class and awaits `resolve()`, exactly as for any external class. Format classes add static capabilities _alongside_ the standard external-class contract; they do not replace it.

### 4.1 `timing`

Each capability method may declare a `timing` array — the environments allowed to invoke it directly:

```json
"parse": {
  "role": "parse",
  "scope": "static",
  "identifier": "parse",
  "timing": ["compiler", "server", "client"],
  "parameters": [
    { "identifier": "source", "type": { "type": "string" } },
    { "identifier": "options", "type": { "type": "object" } }
  ],
  "returnType": { "$ref": "#/$defs/returnTypes/JxDocument" }
}
```

- Default when omitted: `["compiler", "server"]` (assume node-only).
- A host whose environment is excluded round-trips through the dev server (`POST /__studio/format`) instead of importing the implementation — the same pattern the runtime uses with `/__jx_resolve__`.
- Browser-safe capabilities (no `fs`/`glob`/node imports on their code path) should declare `"client"` so the studio can call them in-process.

### 4.2 Options as parameters

Capability options are declared as ordinary `parameters` with JSON-Schema types. This gives the studio enough metadata to render option UIs (e.g., serialize-mode pickers) without any host-side knowledge of the format.

---

## 5. The `$studio` block

Format classes describe their studio control surface declaratively:

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
    "block": ["h1", "h2", "p", "blockquote", "ul", "ol", "li", "pre", "hr", "table"],
    "inline": ["em", "strong", "del", "code", "a", "img", "br"],
    "void": ["hr", "br", "img"],
    "textOnly": ["code"],
    "nesting": {
      "_root": { "block": true, "inline": false, "directive": true },
      "h1": { "block": false, "inline": true },
      "ul": { "only": ["li"] },
      "pre": { "only": ["code"] },
      "table": { "only": ["thead", "tbody"] }
    }
  }
}
```

| Key               | Meaning                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `icon`            | Icon name for file listings and tabs.                                                                                                                                                                                        |
| `modes`           | Editor modes the studio offers for this format's documents.                                                                                                                                                                  |
| `documentMode`    | Whether documents open as `content` (rich-text surface) or `component` (structural surface), with an optional frontmatter-key rule for promotion.                                                                            |
| `newFileTemplate` | Initial source text for newly created files.                                                                                                                                                                                 |
| `elements`        | Element allowlist and nesting constraints gating structural editing: which tags the editor may insert, which children each parent admits (`block`/`inline`/`directive` booleans or an `only` list, keyed by tag or `_root`). |

The studio interprets this data generically; it never hard-codes per-format element sets.

---

## 6. Host introspection contract

Hosts **introspect JSON only** and import code only to call:

1. Read the `.class.json` (fetch in the browser, `readFile` in node). Never import the implementation to discover what it can do.
2. Detect format participation via the top-level `format` key.
3. Find capabilities by scanning `$defs.methods` for `role ∈ {parse, serialize, discover, load}`; the method's `identifier` (fallback: its key) names the static method.
4. To invoke: import `$implementation` (resolved relative to the `.class.json` location), take the export named by the class `title`, call `Export[identifier](...args)`.
5. Respect `timing`: if the host's environment is not listed, delegate to the dev server.

The registry implementing this contract lives at `@jxsuite/schema/format-registry` (`buildFormatRegistry(imports, io, base)`) with injected I/O so the identical logic serves node and browser hosts.

---

## 7. Worked example: a third-party TOML format

A hypothetical `@acme/jx-toml` package ships:

**`Toml.class.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Toml",
  "description": "TOML content files as Jx content entries",
  "$prototype": "Class",
  "$implementation": "./toml.js",
  "format": {
    "extensions": [".toml"],
    "mediaType": "application/toml",
    "documentKinds": ["content"]
  },
  "$defs": {
    "parameters": {
      "src": { "identifier": "src", "type": { "type": "string" } }
    },
    "constructor": {
      "role": "constructor",
      "parameters": [{ "$ref": "#/$defs/parameters/src" }],
      "body": ["this.config = config;"]
    },
    "methods": {
      "resolve": {
        "role": "method",
        "scope": "instance",
        "identifier": "resolve",
        "returnType": { "type": "object" },
        "description": "Runtime on-demand access: fetch + parse the TOML file"
      },
      "parse": {
        "role": "parse",
        "scope": "static",
        "identifier": "parse",
        "timing": ["compiler", "server", "client"],
        "parameters": [{ "identifier": "source", "type": { "type": "string" } }],
        "returnType": { "type": "object" }
      },
      "discover": {
        "role": "discover",
        "scope": "static",
        "identifier": "discover",
        "timing": ["compiler", "server"],
        "parameters": [
          { "identifier": "source", "type": { "type": "string" } },
          { "identifier": "options", "type": { "type": "object" } }
        ],
        "returnType": { "type": "array", "items": { "type": "string" } }
      },
      "load": {
        "role": "load",
        "scope": "static",
        "identifier": "load",
        "timing": ["compiler", "server"],
        "parameters": [
          { "identifier": "path", "type": { "type": "string" } },
          { "identifier": "options", "type": { "type": "object" } }
        ],
        "returnType": { "type": "array" }
      }
    }
  }
}
```

A project enables it with one line:

```json
{
  "imports": { "Toml": "@acme/jx-toml/Toml.class.json" },
  "contentTypes": {
    "settings": { "source": "./content/settings/", "format": "Toml" }
  }
}
```

With that import in place: the content loader discovers and loads `.toml` entries through the class, `ContentCollection`/`ContentEntry` queries work unchanged, pages can declare `{ "$prototype": "Toml", "src": "./x.toml" }` state for runtime access, and the studio lists `.toml` files (with whatever `$studio` hints the class declares). No host package changes.

---

## 8. Content types and formats

A `contentTypes` entry selects its format explicitly by import name, or implicitly by source extension:

```json
"contentTypes": {
  "posts": { "source": "./content/posts/", "format": "Markdown" },
  "products": { "source": "https://sheets.example.com/export.csv", "format": "Csv" }
}
```

- `format` (an import name) wins when present; otherwise the loader matches the source extension against the registry with the `load` capability.
- Directory sources go through `discover` then `load` per entry.
- Remote `http(s)` sources require an explicit `format` whose class declares `format.remote: true`. There is no fallback.

---

_Jx Extensions Specification v1.0.0-draft_
