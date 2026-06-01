Author a Jx project component, page, layout, or project configuration based on the user's request: $ARGUMENTS

You are authoring files for the Jx platform — a declarative, JSON-based web framework. All UI is described as JSON documents that map directly to DOM structure. Reactivity is powered by @vue/reactivity.

---

## Three Schemas

Every Jx file validates against one of three JSON Schema 2020-12 documents:

1. **Component/Page/Layout** (`$schema: "https://jxsuite.com/schema/v1"`) — UI documents
2. **Project config** (`$schema: "https://jxsuite.com/schema/project/v1"`) — `project.json`
3. **Class definition** (`$schema: "https://jxsuite.com/schema/class/v1"`) — `.class.json`

Read the generated schemas at `packages/schema/schema.json`, `packages/schema/project-schema.json`, and `packages/schema/class-schema.json` for the authoritative field reference.

---

## Project Structure

```
my-site/
  project.json       # Required. Site config, global styles, collections, build settings
  pages/             # File-based routing. Each .json = a route. [slug].json = dynamic
  layouts/           # Shared page shells. Use { "tagName": "slot" } for content insertion
  components/        # Reusable custom elements
  content/           # Markdown/JSON content collections
  public/            # Static assets copied to dist/
```

Files prefixed with `_` in `pages/` are excluded from routing.

---

## Component Document (the core building block)

A Jx document is a JSON object describing a reactive web component:

```json
{
  "$schema": "https://jxsuite.com/schema/v1",
  "$id": "TaskList",
  "tagName": "task-list",
  "$defs": { ... },
  "state": { ... },
  "style": { ... },
  "children": [ ... ]
}
```

### State — 5 shapes (detected by structure)

**Shape 1 — Naked value** (scalar, array, or plain object with no reserved keys):

```json
"count": 0,
"items": [],
"user": { "name": "", "email": "" }
```

**Shape 2 — Typed value** (has `default`, optionally `type`):

```json
"status": { "type": { "type": "string", "enum": ["idle", "loading"] }, "default": "idle" }
```

**Shape 3 — Computed** (string containing `${}`):

```json
"fullName": "${state.firstName} ${state.lastName}",
"itemCount": "${state.items.length} items"
```

**Shape 4 — Function** (`$prototype: "Function"`):

```json
"increment": { "$prototype": "Function", "body": "state.count++" },
"handleInput": { "$prototype": "Function", "arguments": ["event"], "body": "state.value = event.target.value" },
"validate": { "$prototype": "Function", "$src": "./validators.js", "$export": "validateEmail" }
```

**Shape 5 — Data source** (`$prototype: <ClassName>`):

```json
"userData": { "$prototype": "Request", "url": "/api/users", "method": "GET" },
"posts": { "$prototype": "ContentCollection", "contentType": "blog", "sort": { "field": "pubDate", "order": "desc" } }
```

### `$ref` bindings

| Pattern   | Example                          | Meaning                         |
| --------- | -------------------------------- | ------------------------------- |
| State     | `{ "$ref": "#/state/count" }`    | Reactive binding to state       |
| $defs     | `{ "$ref": "#/$defs/TodoItem" }` | Type definition reference       |
| Parent    | `{ "$ref": "parent#/theme" }`    | Prop from parent via `$props`   |
| Map item  | `{ "$ref": "$map/item" }`        | Current item in Array iteration |
| Map index | `{ "$ref": "$map/index" }`       | Current index                   |
| External  | `{ "$ref": "./card.json" }`      | Another Jx component            |
| Window    | `{ "$ref": "window#/config" }`   | Window global                   |

Use `${}` templates for inline one-off bindings. Use `$ref` objects for named/reused signals.

### Children

**Static:** array of element objects or text strings:

```json
"children": [
  { "tagName": "h1", "textContent": "Hello" },
  { "tagName": "p", "children": ["Welcome to ", { "tagName": "strong", "textContent": "Jx" }] }
]
```

**Dynamic mapped list** (`$prototype: "Array"`):

```json
"children": {
  "$prototype": "Array",
  "items": { "$ref": "#/state/todos" },
  "map": {
    "tagName": "li",
    "className": "${$map.item.done ? 'completed' : ''}",
    "textContent": { "$ref": "$map/item/text" }
  }
}
```

### `$switch` / `cases` (dynamic component switching)

```json
{
  "$switch": { "$ref": "#/state/currentView" },
  "cases": {
    "home": { "$ref": "./views/home.json" },
    "settings": { "$ref": "./views/settings.json" }
  }
}
```

### Style

camelCase CSS properties. Nested selectors via `:`, `.`, `&`, `[` prefixes. Media breakpoints via `@--name` or `@(query)`:

```json
"style": {
  "display": "flex",
  "gap": "1rem",
  "padding": "clamp(1rem, 3vw, 2rem)",
  ":hover": { "backgroundColor": "#f0f0f0" },
  "&.active": { "borderColor": "blue" },
  "@--md": { "flexDirection": "row" },
  "@(prefers-reduced-motion: reduce)": { "transition": "none" }
}
```

### Attributes

Non-IDL HTML attributes go in `attributes`:

```json
{
  "tagName": "a",
  "href": "/about",
  "attributes": { "aria-label": "About page", "data-section": "nav" }
}
```

Note: IDL properties like `href`, `src`, `textContent`, `className`, `hidden`, `disabled`, `value`, `checked` go directly on the element object, not inside `attributes`.

### Event handlers

Reference a function from state:

```json
{ "tagName": "button", "textContent": "Add", "onclick": { "$ref": "#/state/handleAdd" } }
```

### `$elements` (custom element dependencies)

```json
"$elements": [
  { "$ref": "./components/task-item.json" },
  "@shoelace-style/shoelace/components/button/button.js"
]
```

### `$props` (passing data to child components)

```json
{ "$ref": "./user-card.json", "$props": { "user": { "$ref": "#/state/currentUser" } } }
```

---

## Page Documents

Pages are component documents with additional properties:

```json
{
  "title": "About Us",
  "$layout": "./layouts/base.json",
  "$head": [
    { "tagName": "meta", "attributes": { "name": "description", "content": "About our team" } }
  ],
  "tagName": "main",
  "children": [ ... ]
}
```

- `$layout` — path to layout file, or `false` for no layout. Omit to use project default.
- `$head` — merges with layout and project `$head` (page wins on conflicts).
- `$paths` — dynamic route generation from content collections.
- `tagName` is optional on pages that use a layout.

### Dynamic routes (`[param].json`)

```json
{
  "$paths": { "contentType": "blog", "param": "slug" },
  "state": {
    "post": {
      "$prototype": "ContentEntry",
      "contentType": "blog",
      "id": { "$ref": "#/$params/slug" }
    }
  }
}
```

---

## Layout Documents

Layouts wrap page content. Use `{ "tagName": "slot" }` for the page content insertion point:

```json
{
  "tagName": "div",
  "children": [
    { "tagName": "header", "children": [ ... ] },
    { "tagName": "main", "children": [{ "tagName": "slot" }] },
    { "tagName": "footer", "children": [ ... ] }
  ]
}
```

---

## project.json

```json
{
  "name": "My Site",
  "url": "https://example.com",
  "defaults": { "layout": "./layouts/base.json", "lang": "en" },
  "$head": [
    { "tagName": "link", "attributes": { "rel": "icon", "href": "/favicon.svg" } }
  ],
  "$elements": [ ... ],
  "imports": { "MarkdownCollection": "@jxsuite/parser/MarkdownCollection.class.json" },
  "$media": { "--sm": "(min-width: 640px)", "--md": "(min-width: 768px)" },
  "style": { "fontFamily": "system-ui, sans-serif", "margin": "0" },
  "contentTypes": {
    "blog": {
      "source": "./content/blog/",
      "schema": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] }
    }
  },
  "build": { "outDir": "./dist", "trailingSlash": "always" }
}
```

---

## .class.json (Class Definitions)

```json
{
  "$prototype": "Class",
  "title": "MyParser",
  "$implementation": "./my-parser.js",
  "$defs": {
    "parameters": {
      "src": { "identifier": "src", "type": { "type": "string" } }
    },
    "constructor": {
      "role": "constructor",
      "$prototype": "Function",
      "parameters": [{ "$ref": "#/$defs/parameters/src" }]
    },
    "methods": {
      "resolve": { "role": "method", "identifier": "resolve", "returnType": { "type": "object" } }
    }
  }
}
```

---

## Authoring Rules

1. **Style is always an object** of camelCase properties, never a CSS string.
2. **Text content**: use `"textContent": "..."` for leaf elements, or `"children": ["text"]` for mixed content.
3. **IDL properties** (`href`, `src`, `value`, `checked`, `disabled`, `hidden`, `className`, `textContent`) go directly on the element. Non-IDL attributes (`aria-*`, `data-*`, `role`, `slot`) go in `"attributes": {}`.
4. **Responsive sizing**: prefer CSS `clamp()` over media queries for simple responsive values.
5. **Custom element names** (component `tagName`) must contain a hyphen per Web Components spec.
6. **`$defs`** contains only JSON Schema type definitions — no functions, no runtime artifacts.
7. **Template strings** (`${}`) are pure expressions — no statements, no assignments.
8. **Function bodies** are raw JS strings where `state` is the first implicit parameter.
9. **`$head` entries** are `{ tagName, attributes }` objects, not HTML strings.
10. **Layouts** use `{ "tagName": "slot" }` for content injection — not `$slot` or `$content`.
11. All state entries are reactive by default — no `signal: true` flag exists.
12. The `timing` property (`"compiler"`, `"server"`, `"client"`) controls when data sources resolve.
