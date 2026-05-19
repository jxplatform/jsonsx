# Imports

The JX import system provides a unified way to manage three types of external dependencies: JX class files, npm packages, and web component libraries.

## Import Types

### JX Class Imports

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

### `$elements` - Component Registration

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

### Cascading

`$elements` defined in `project.json` apply to every page. Page-level `$elements` merge with site-level via union (deduplicated by `$ref` value or string value). Page entries take precedence on conflict.

```
project.json $elements  +  page $elements  =  effective $elements (union, dedup)
```

## npm Web Component Discovery

Packages that ship a [Custom Elements Manifest](https://custom-elements-manifest.open-wc.org/) (CEM) are auto-discovered. The server scans `package.json` dependencies for packages whose own `package.json` declares a `customElements` field pointing to their CEM JSON.

The CEM provides:

- Tag names (`declarations[].tagName`)
- Attributes and their types
- Slots, events, CSS custom properties
- Member properties with defaults

This metadata powers the Studio property inspector and enables drag-and-drop of npm web components onto the canvas.

## Runtime Behavior

### `$ref` entries

```js
// For each { $ref } in $elements:
const url = new URL(entry.$ref, base);
const doc = await fetch(url).then((r) => r.json());
defineElement(doc); // registers <tag-name> custom element
```

### Bare string entries

```js
// For each string in $elements:
await import(entry); // side-effect import, registers custom elements globally
```

Failed imports log a warning but do not block page rendering.

## Server API

### `GET /__studio/components?dir=<path>`

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

### `GET /__studio/packages`

Lists CEM-bearing npm dependencies from `package.json`.

### `GET /__studio/cem?pkg=<name>`

Returns the full Custom Elements Manifest JSON for a package.

### `POST /__studio/packages/add`

Body: `{ "name": "<package-name>" }`. Runs `bun add <name>`.

### `POST /__studio/packages/remove`

Body: `{ "name": "<package-name>" }`. Runs `bun remove <name>`.

## Studio Imports Panel

The left sidebar "Imports" tab provides three sections:

1. **Class Imports** - Name-to-path mappings from `project.json` `imports`. Add/remove with write-back.
2. **Components** - JX custom elements (`source: "jx"`) with live preview and drag-drop.
3. **Packages** - npm web components (`source: "npm"`) grouped by package, with drag-drop of individual tags and package add/remove.

### Auto-Import on Drag-Drop

When a component is dragged from the imports panel onto the canvas:

- **JX component**: a `{ $ref: "./relative/path.json" }` entry is added to the page's `$elements`
- **npm component**: the package name string is added to the page's `$elements`

Duplicates are not added if the component is already imported.

## Content Collection `$elements`

Content collections support `$elements` in their `project.json `collections``, controlling which custom element directives are available in that collection's markdown files:

```json
{
  "contentTypes": {
    "blog": {
      "source": "**/*.md",
      "$elements": ["@shoelace-style/shoelace", { "$ref": "./components/callout.json" }]
    }
  }
}
```

Collection `$elements` merge with site-level `$elements` to determine the full set of available components for markdown rendering. The `$elements` entries are passed as `allowedNames` to the `MarkdownDirective` plugin, restricting which directive tag names are valid in that collection's markdown files.

The compiler's `injectContext()` also merges site-level `$elements` into page-level `$elements` during the build, using the same union-dedup strategy as the runtime.
