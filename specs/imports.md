# Imports

**Version:** 0.1.10-draft\
**Status:** Partial\
**Updated:** 2026-08-27\
**License:** MIT

---

The JX import system provides a unified way to manage three types of external dependencies: JX class files, npm packages, and web component libraries.

## 1. Import Types

### 1.1 JX Class Imports

Class imports map short names to file paths, enabling `$prototype` resolution without full paths. Defined in `project.json` under `imports`:

```json
{
  "imports": {
    "MyLayout": "./layouts/main.json",
    "PostCard": "./components/post-card.class.json"
  }
}
```

These cascade from site level into every page. Page-level `imports` merge on top (page wins on conflict).

### 1.2 Format Class Auto-Discovery

Imports are also the registration mechanism for **format-extension classes** (see `specs/extensions.md`). Hosts (compiler, dev server, studio) scan the **project-level** `imports` map for `.class.json` files carrying a top-level `format` block and build a format registry from them:

```json
{
  "imports": {
    "Markdown": "@jxsuite/parser/Markdown.class.json",
    "Csv": "@jxsuite/parser/Csv.class.json"
  }
}
```

With these imports in place, `.md` files are discoverable as pages/components, content types can use `"format": "Markdown"` / `"format": "Csv"`, and the studio offers the formats' editing surfaces. Without them, only `.json` is handled — there are no implicit format defaults. Page-level imports continue to drive `$prototype` state resolution but do not participate in file-extension dispatch (they cannot be read before the page itself is parsed).

### 1.3 `$elements` - Component Registration

`$elements` declares which custom elements a page uses. It accepts two formats:

```json
{
  "$elements": [
    { "$ref": "./components/task-item.json" },
    { "$ref": "./components/task-stats.json" },
    "@shoelace-style/shoelace"
  ]
}
```

- **`{ $ref }` objects**: JX custom element definitions. The runtime fetches the JSON, registers the custom element via `defineElement()`.
- **Bare strings**: npm package specifiers. The runtime calls `import(pkgName)` as a side-effect import, which registers the package's custom elements globally.

### 1.4 Cascading

`$elements` defined in `project.json` apply to every page. Page-level `$elements` merge with site-level via union (deduplicated by `$ref` value or string value). Page entries take precedence on conflict.

```
project.json $elements  +  page $elements  =  effective $elements (union, dedup)
```

**A component the project itself defines does not have to be declared.** Almost nothing writes `$elements` for its own components, and three surfaces each reach the same effective set a different way: a build scans the rendered HTML for tags it compiled and emits a module script per tag, the studio canvas walks the document against the project's component registry, and a host composing from the working tree walks the document against the tree. Every hyphenated tag a document names that `components/<tag>.json` defines joins the effective set, transitively through the components those definitions name, so a component that brings another registers both.

Declaration remains what a page needs for anything the project does not define — an npm specifier, or a component whose file name is not its tag — and a declared entry is deduplicated against a discovered one by the path it RESOLVES to, so a layout's `../components/nav.json` and a discovered `./components/nav.json` are one entry. Only `.json` components are discoverable: a `$ref` is fetched and parsed by the browser, which has no extension parser to hand.

## 2. npm Web Component Discovery

Packages that ship a [Custom Elements Manifest](https://custom-elements-manifest.open-wc.org/) (CEM) are auto-discovered. The server scans `package.json` dependencies for packages whose own `package.json` declares a `customElements` field pointing to their CEM JSON.

The CEM provides:

- Tag names (`declarations[].tagName`)
- Attributes and their types
- Slots, events, CSS custom properties
- Member properties with defaults

This metadata powers the Studio property inspector and enables drag-and-drop of npm web components onto the canvas.

## 3. Runtime Behavior

### 3.1 `$ref` entries

```js
// For each { $ref } in $elements:
const url = new URL(entry.$ref, base);
const doc = await fetch(url).then((r) => r.json());
defineElement(doc); // registers <tag-name> custom element
```

### 3.2 Bare string entries

```js
// For each string in $elements:
await import(entry); // side-effect import, registers custom elements globally
```

Failed imports log a warning but do not block page rendering.

## 4. Server API

### 4.1 `GET /__studio/components?dir=<path>`

Returns the component registry for a project. Each entry includes:

```json
{
  "tagName": "task-item",
  "path": "components/task-item.class.json",
  "source": "jx",
  "props": [{ "name": "title", "type": "string" }]
}
```

For npm packages with CEM:

```json
{
  "tagName": "sl-button",
  "source": "npm",
  "package": "@shoelace-style/shoelace",
  "props": [{ "name": "variant", "type": "string" }]
}
```

### 4.2 `GET /__studio/packages`

Lists CEM-bearing npm dependencies from `package.json`.

### 4.3 `GET /__studio/cem?pkg=<name>`

Returns the full Custom Elements Manifest JSON for a package.

### 4.4 `POST /__studio/packages/add`

Body: `{ "name": "<package-name>" }`. Runs `bun add <name>`.

### 4.5 `POST /__studio/packages/remove`

Body: `{ "name": "<package-name>" }`. Runs `bun remove <name>`.

## 5. Studio Imports Panel

The left sidebar "Imports" tab provides three sections:

1. **Imported Modules** - Name-to-path mappings from `project.json` `imports`. Add/remove with write-back.
2. **Components** - JX custom elements (`source: "jx"`) with live preview and drag-drop.
3. **Packages** - npm web components (`source: "npm"`) grouped by package, with drag-drop of individual tags and package add/remove.

### 5.1 Auto-Import on Drag-Drop

When a component is dragged from the imports panel onto the canvas:

- **JX component**: a `{ $ref: "./relative/path.json" }` entry is added to the page's `$elements`
- **npm component**: the package name string is added to the page's `$elements`

Duplicates are not added if the component is already imported.

## 6. Content Collection `$elements`

Content collections support `$elements` in their `project.json `collections``, controlling which custom element directives are available in that collection's markdown files:

```json
{
  "contentTypes": {
    "blog": {
      "source": "./content/blog/",
      "format": "md",
      "$elements": ["@shoelace-style/shoelace", { "$ref": "./components/callout.json" }]
    }
  }
}
```

Collection `$elements` merge with site-level `$elements` to determine the full set of available components for markdown rendering. The `$elements` entries are passed as `allowedNames` to the `MarkdownDirective` plugin, restricting which directive tag names are valid in that collection's markdown files.

The compiler's `injectContext()` also merges site-level `$elements` into page-level `$elements` during the build, using the same union-dedup strategy as the runtime.

## 7. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). The Custom Elements Manifest (§2) is a community format with no standards body, so it is described there rather than cited here. Subresource Integrity for a bare-specifier `$elements` script is tracked against `compiler.md` §3, where the emitted-script contract lives.

| Standard                                                                                  | Class        | Binds | Evidence                                 | Note                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------ | ----- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ECMA-262](https://ecma-international.org/publications-and-standards/standards/ecma-262/) | **Adopted**  | §3    | packages/runtime/src/runtime.ts          | A bare-string `$elements` entry is loaded with a dynamic `import()` for its registration side effect — the standard's own module semantics, with no loader of Jx's own.                                                                                                                                                                                                                     |
| [WHATWG HTML](https://html.spec.whatwg.org/)                                              | **Borrowed** | §1    | packages/compiler/src/site/site-build.ts | The project-level `imports` map has an import map's shape — bare specifier to URL — but it is resolved by Jx at build and load time and is never emitted as a `<script type="importmap">`, so a browser never sees it. The import map the compiler _does_ emit is a separate, fixed two-entry object naming the client runtime, which the build serves from `/assets/` (`compiler.md` §12). |

## Changelog

- **0.1.10-draft** (2026-08-27) — Components a project defines are discovered from the tree rather than only declared.
- **0.1.9-draft** (2026-08-15) — Name where the emitted import map now points (§1).
- **0.1.8-draft** (2026-08-15) — Number the sections so they are addressable, and add §7 Standards Alignment.
- **0.1.7-draft** (2026-08-02) — Imports panel section renamed to Imported Modules in the UI.
- **0.1.6-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.5-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.1.4-draft** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).
- **0.1.3-draft** (2026-06-01) — Remove old glob-based content type references (`6bcbfdaf`).
- **0.1.2-draft** (2026-05-19) — Reflect new content type transition (`6eb3d2b6`).
- **0.1.1-draft** (2026-04-22) — Consolidate project config schema and rename as such (`e3523dbf`).
- **0.1.0-draft** (2026-04-22) — External web component support (`a9d0fbe4`).
