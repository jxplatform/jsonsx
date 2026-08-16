---
title: "Authoring rules for agents"
description: "A briefing to paste into a coding agent: the three schemas, the five state shapes, $ref forms, style and attribute rules, and how it checks its own work."
code:
  - .claude/commands/jx.md
  - packages/schema/schema.json
  - packages/schema/project-schema.json
  - packages/schema/class-schema.json
  - packages/compiler/src/site/validate-command.ts
  - packages/schema/src/ijson.ts
---

# Authoring rules for agents

An external coding agent — Claude Code, Cursor, a script against an API — needs no Jx-specific tooling to work on a project. It reads and writes files like any repository. What it does need is a briefing, because a model that has never seen Jx will reach for the conventions of frameworks it has seen: a CSS string where the format wants an object, an `attributes` bag where the property belongs on the element.

Everything below is the briefing. Paste it into a system prompt, drop it in the agent's project instructions file, or point the agent at this page. The monorepo keeps a version of it as a `/jx` slash command at [`.claude/commands/jx.md`](https://github.com/jxsuite/jx/blob/main/.claude/commands/jx.md), which you can copy into your own project's `.claude/commands/`.

:::doc-tip
Whatever form you use, include the **check your work** section at the end. A briefing without a verification step tells the agent what good looks like but gives it no way to find out whether it got there.
:::

## Two ways valid JSON still loses your work

Both of these parse without complaint in any JSON tool, and both are **build errors** in Jx:

```json
{ "state": { "count": 0 }, "tagName": "div", "state": { "other": 1 } }
```

A repeated key. `JSON.parse` keeps the last one and discards the first without a word — so the first `state` object is gone, and nothing downstream can tell it ever existed.

```json
{ "id": 9007199254740993 }
```

An integer larger than a double can hold. It parses as `9007199254740992`, and the next save writes that wrong number back to your file.

These are errors rather than warnings because a Jx document doesn't stay JSON. It round-trips through markdown frontmatter and through the collaborative editing layer, and each crossing rebuilds the object from the parsed value — so whatever was dropped at the boundary is dropped for good.

Fractions are never flagged. `0.1` isn't exactly representable in binary floating point either, so complaining about it would mean complaining about most real documents while telling you nothing about whether your value survived.

### Names are normalized, so an accent means one thing

A state name is an identifier — declared as a key in `state`, referenced as `${state.été}` in a template and as `#/state/été` in a `$ref`. Typed on macOS an accented letter arrives decomposed (`e` plus a combining acute); typed on Windows, or pasted from most of the web, it arrives precomposed as a single character.

Those are two different property names. A document whose declaration and reference came from different machines used to build cleanly, emit a valid bundle, and render nothing at all — no error, and no way to see the difference in any editor.

Every key and every string value is now put into Unicode Normalization Form C when the file is read, so both spellings become the same name. Values are normalized too: canonically equivalent text is the _same text_ by definition, so nothing about your content changes. NFC composes and never folds or strips — CJK, emoji, and scripts with no composed forms survive exactly as written.

## The three schemas

Every Jx file validates against one of three JSON Schema 2020-12 documents, published at stable URLs:

| File                                  | Schema                                  |
| ------------------------------------- | --------------------------------------- |
| Components, pages, layouts (`*.json`) | `https://jxsuite.com/schema/v1`         |
| `project.json`                        | `https://jxsuite.com/schema/project/v1` |
| Class definitions (`*.class.json`)    | `https://jxsuite.com/schema/class/v1`   |

Inside a project, prefer the generated local copies over the network: `jx schema` writes `project.schema.json` and `document.schema.json` into the project root, composed from the core schemas plus the fragments each enabled extension ships. Each is a self-contained single-resource schema — every `$ref` a root-relative JSON Pointer into the same file — so an editor resolves it offline with no `node_modules`, no network, and no configuration (see [Machine-readable docs](/docs/framework/agents/machine-readable) and [Schema composition](/docs/extending/extensions/schema-composition)). `project.json` binds itself with `"$schema": "./project.schema.json"`. Documents carry no `$schema` key in the shipped starters — `jx validate` checks them against `document.schema.json` either way — so add one only if you want editor autocomplete. It resolves relative to the file that carries it, so count the folder levels: `"../document.schema.json"` from `pages/index.json`, `"../../document.schema.json"` from `pages/blog/post.json`. A pointer with too few `../` names a file that does not exist, and validators report the unresolvable schema instead of checking the document at all.

## Project structure

```
my-site/
  project.json       # Required. Site config, global styles, collections, build settings
  pages/             # File-based routing. Each file = a route. [slug].json = dynamic
  layouts/           # Shared page shells. Use { "tagName": "slot" } for content insertion
  components/        # Reusable custom elements
  content/           # Markdown/JSON/CSV content collections
  public/            # Static assets copied verbatim to dist/
```

Files and folders prefixed with `_` inside `pages/` are excluded from routing, so a page's private components can sit beside it.

## The document

A Jx document is a JSON object describing a reactive web component:

```json
{
  "$id": "TaskList",
  "tagName": "task-list",
  "$defs": {},
  "state": {},
  "style": {},
  "children": []
}
```

Only `tagName` is required. A `tagName` containing a hyphen makes the document a custom element.

### State — five shapes, detected by structure

**1. Naked value** — a scalar, array, or plain object with no reserved keys:

```json
"count": 0,
"items": [],
"user": { "name": "", "email": "" }
```

**2. Typed value** — has `default`, optionally `type`:

```json
"status": { "type": { "type": "string", "enum": ["idle", "loading"] }, "default": "idle" }
```

**3. Computed** — a string containing `${}`:

```json
"fullName": "${state.firstName} ${state.lastName}",
"itemCount": "${state.items.length} items"
```

**4. Function** — `$prototype: "Function"`, with an inline `body` or an external `.js` sidecar:

```json
"increment": { "$prototype": "Function", "body": "state.count++" },
"handleInput": { "$prototype": "Function", "arguments": ["event"], "body": "state.value = event.target.value" },
"validate": { "$prototype": "Function", "$src": "./validators.js", "$export": "validateEmail" }
```

**5. Data source** — `$prototype: <ClassName>`:

```json
"userData": { "$prototype": "Request", "url": "/api/users", "method": "GET" },
"posts": { "$prototype": "ContentCollection", "contentType": "blog", "sort": { "field": "pubDate", "order": "desc" } }
```

See [State](/docs/framework/concepts/state) and [Data prototypes](/docs/framework/concepts/data-prototypes).

### `$ref` bindings

| Pattern   | Example                          | Meaning                               |
| --------- | -------------------------------- | ------------------------------------- |
| State     | `{ "$ref": "#/state/count" }`    | Reactive binding to state             |
| `$defs`   | `{ "$ref": "#/$defs/TodoItem" }` | Type definition reference             |
| Parent    | `{ "$ref": "parent#/theme" }`    | A value passed in via `$props`        |
| Map item  | `{ "$ref": "$map/item" }`        | Current item in an iteration          |
| Map index | `{ "$ref": "$map/index" }`       | Current zero-based index              |
| External  | `{ "$ref": "./card.json" }`      | Another Jx document                   |
| Window    | `{ "$ref": "window#/Math/max" }` | A path resolved off the global object |

Use `${}` templates for inline one-off bindings, `$ref` objects for named or reused signals. See [References](/docs/framework/concepts/references).

### Children

Static — an array of element objects and text strings, mixed freely:

```json
"children": [
  { "tagName": "h1", "textContent": "Hello" },
  { "tagName": "p", "children": ["Welcome to ", { "tagName": "strong", "textContent": "Jx" }] }
]
```

Dynamic list — `$prototype: "Array"`:

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

See [Lists and iteration](/docs/framework/concepts/lists).

### `$switch` and `cases`

```json
{
  "$switch": { "$ref": "#/state/currentView" },
  "cases": {
    "home": { "$ref": "./views/home.json" },
    "settings": { "$ref": "./views/settings.json" }
  }
}
```

See [Dynamic switching](/docs/framework/concepts/switching).

### Style

An object of camelCase CSS properties. Nested selectors are keys prefixed with `:`, `.`, `&`, or `[`; breakpoints are `@--name` (a named breakpoint from `$media`) or `@(query)` (a literal media query):

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

See [Styling](/docs/framework/concepts/styling).

### Properties and attributes

IDL properties — `href`, `src`, `textContent`, `className`, `hidden`, `disabled`, `value`, `checked` — go directly on the element object. Everything else (`aria-*`, `data-*`, `role`, `slot`) goes in `attributes`:

```json
{
  "tagName": "a",
  "href": "/about",
  "textContent": "About",
  "attributes": { "aria-label": "About page", "data-section": "nav" }
}
```

### Event handlers

Reference a function from state:

```json
{ "tagName": "button", "textContent": "Add", "onclick": { "$ref": "#/state/handleAdd" } }
```

### Components and props

`$elements` is an **array** of `$ref` objects (paths relative to the current file) and bare npm specifiers for web-component libraries. The registered tag is the referenced document's own `tagName`. Instantiate it by tag and pass data with `$props` — a bare `{ "$ref": "./card.json" }` in `children` is not a component instance:

```json
{
  "$elements": [
    { "$ref": "./components/user-card.json" },
    "@shoelace-style/shoelace/components/button/button.js"
  ],
  "children": [
    {
      "tagName": "user-card",
      "$props": { "name": "Ada", "count": { "$ref": "#/state/count" } }
    }
  ]
}
```

`props.*` attributes (`"attributes": { "props.name": "Ada" }`) are an equivalent shorthand for **string** values only, and the key must be lowercase because HTML lowercases attribute names. Anything bound or non-string belongs in `$props`. See [Props and scope](/docs/framework/concepts/props-and-scope).

## Pages

Pages are documents with a few extra top-level fields:

```json
{
  "title": "About us",
  "$layout": "./layouts/base.json",
  "$head": [
    { "tagName": "meta", "attributes": { "name": "description", "content": "About our team" } }
  ],
  "tagName": "main",
  "children": []
}
```

- `$layout` — a path resolved from the **project root**, or `false` for no layout. Omit it to use `defaults.layout` from `project.json`.
- `$head` — merges with the layout's and the project's entries; the page wins on conflicts.
- `$paths` — the concrete routes a `[param]` page generates. One source shape, checked strictly by the generated document schema: `{ contentType, param, field }` (needs `@jxsuite/parser`), `{ values, param }`, `{ "$ref": "./data.json", param, field }`, or a bare array of parameter objects. A key that is not part of one of these is an error, not a silently empty build.
- `tagName` is optional on a page that uses a layout.

Dynamic route (`pages/blog/[slug].json`):

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

See [Routing](/docs/framework/site/routing) and [Content collections](/docs/framework/site/content-collections).

## Layouts

Ordinary documents with `<slot>` elements marking where page content lands. Name a slot to define more than one region:

```json
{
  "tagName": "div",
  "children": [
    { "tagName": "header" },
    { "tagName": "main", "children": [{ "tagName": "slot" }] },
    {
      "tagName": "aside",
      "children": [{ "tagName": "slot", "attributes": { "name": "sidebar" } }]
    },
    { "tagName": "footer" }
  ]
}
```

See [Layouts](/docs/framework/site/layouts).

## project.json

```json
{
  "$schema": "./project.schema.json",
  "name": "My Site",
  "url": "https://example.com",
  "extensions": ["@jxsuite/parser"],
  "defaults": { "layout": "./layouts/base.json", "lang": "en" },
  "$head": [{ "tagName": "link", "attributes": { "rel": "icon", "href": "/favicon.svg" } }],
  "imports": { "MarkdownCollection": "@jxsuite/parser/MarkdownCollection.class.json" },
  "$media": { "--sm": "(min-width: 640px)", "--md": "(min-width: 768px)" },
  "style": { "fontFamily": "system-ui, sans-serif", "margin": "0" },
  "content": {
    "blog": {
      "source": "./content/blog/",
      "schema": {
        "type": "object",
        "properties": { "title": { "type": "string" } },
        "required": ["title"]
      }
    }
  },
  "build": { "outDir": "./dist", "trailingSlash": "always" }
}
```

`extensions` is the enablement list, and no Studio panel edits it: turning on the connector, auth, or search extension means adding its package name to this array by hand — a good job for the agent — then re-running `jx schema`. Studio picks up the change once it is on disk. See [project.json](/docs/framework/site/project-json) and [First-party extensions](/docs/extending/extensions/first-party).

## `.class.json`

```json
{
  "$prototype": "Class",
  "title": "MyParser",
  "$implementation": "./my-parser.js",
  "$defs": {
    "parameters": { "src": { "identifier": "src", "type": { "type": "string" } } },
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

See [Custom classes](/docs/extending/extensions/classes).

## The server tier

A brochure site is not the ceiling. Three additions turn a Jx project into an application, and an agent should know they exist:

- **Server functions.** A state entry with `timing: "server"` names an async export via `$src` and `$export` — no `$prototype`. It compiles to `POST /_jx/server/<exportName>`, and the function receives `(args, env)` where `env` carries the platform's bindings. Secrets stay in that process. See [Timing](/docs/framework/concepts/timing).
- **Databases.** Add `@jxsuite/connector` to `extensions`, then declare `connections` (D1, Supabase, or SQLite) and `data` tables in `project.json`. `jx db push` applies the schema additively. Form actions and table queries read and write over `/_jx/data`. See [Databases](/docs/studio/data).
- **Accounts.** Add `@jxsuite/auth` and an `auth` section for sign-in, sessions, roles, and per-table permissions. See [Auth and secrets](/docs/studio/data/auth-and-secrets).

Two rules bind all three. **Secrets are never values in `project.json`** — the file records environment-variable _names_ only, and the values live in `.dev.vars` locally and in your host's environment when deployed. And any of this needs a server-capable `build.adapter` (`cloudflare-workers`, `cloudflare-pages`, `node`, or `bun`), which packages the server tier into a deployable worker; with connection-backed data tables it is not optional — the build **fails** on static. See [Build output and adapters](/docs/framework/site/deployment).

## Hard rules

1. `style` is always an **object** of camelCase properties, never a CSS string.
2. Use `"textContent"` for leaf elements; use `"children": ["text", …]` for mixed content.
3. IDL properties go on the element; everything else goes in `attributes`.
4. Prefer CSS `clamp()` over media queries for simple responsive values.
5. A component's `tagName` must contain a hyphen (Web Components requires it).
6. `$defs` holds JSON Schema type definitions only — no functions, no defaults, no runtime artifacts.
7. Template strings (`${}`) are pure expressions — no statements, no assignments.
8. Function `body` strings are raw JavaScript where `state` is in scope; a sidecar export takes `state` as its first parameter.
9. `$head` entries are `{ tagName, attributes }` objects, never HTML strings.
10. Layouts inject content with `{ "tagName": "slot" }` — there is no `$slot` or `$content`.
11. All state entries are reactive by default; no `signal: true` flag exists.
12. `timing` (`"compiler"`, `"server"`, `"client"`) decides where a data source resolves. `"client"` is the default.

## Check your work

Never report a task complete on the strength of the output looking right. Run the loop:

```bash
jx schema     # once per project, and after any change to project.json's "extensions"
jx validate   # after every edit — exits 1 with the failing instance paths
jx build      # only once validate is clean
```

`jx validate` prints one block per failing file:

```
pages/about.json:
  - /children/0: must NOT have additional properties
```

Each line names the file, the JSON pointer, and the violation — enough to fix without guessing. Repeat until it prints `Project is valid`. The same command gates CI, so nothing is gained by skipping it. See [CLI commands](/docs/framework/build/cli).

## Related

- [Working with agents](/docs/framework/agents) — where this briefing fits in the wider workflow
- [Machine-readable docs](/docs/framework/agents/machine-readable) — the schema and documentation URLs an agent can fetch
- [Documents](/docs/framework/concepts/documents) — the long-form version of the document model
- [Site architecture](/docs/framework/site) — the project layout these rules describe
