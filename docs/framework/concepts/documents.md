---
title: "Documents"
description: "The root structure of a Jx file — $schema, $id, $defs, state, tagName, children — and why the format is plain JSON."
spec:
  - spec.md#1
  - spec.md#2
  - spec.md#3
---

# Documents

> **Studio writes this format for you.** Every page and component you build in Studio is saved as one of these files — open [Code mode](/docs/studio/logic/code) to see the raw source of whatever document you have open.

A Jx document is a single `.json` file that describes one piece of user interface: its structure, its styling, the state it holds, and the behavior attached to it. The tree of JSON objects mirrors the DOM — the browser's own object model — so property names like `tagName` and `textContent` mean exactly what they mean to a browser. Simple documents are fully self-describing: no template language, no companion script file.

The smallest complete document:

```json
{
  "$schema": "https://jxsuite.com/schema/v1",
  "$id": "Hello",
  "state": { "name": "World" },
  "tagName": "main",
  "children": [{ "tagName": "h1", "textContent": "Hello, ${state.name}!" }]
}
```

## Root fields

Every document is a JSON object with up to six top-level fields:

| Field      | Required    | Description                                                                                                                             |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`  | Recommended | Schema the file is checked against — the dialect URI, or the project's generated bundle (below)                                         |
| `$id`      | Recommended | Component identifier, used by tooling                                                                                                   |
| `$defs`    | Optional    | Pure JSON Schema type definitions — tooling only, never rendered                                                                        |
| `state`    | Optional    | Reactive state: values, computed entries, functions, and data sources — see [State](/docs/framework/concepts/state)                     |
| `tagName`  | Required    | HTML tag name for the root element                                                                                                      |
| `children` | Optional    | Array of child [elements](/docs/framework/concepts/elements), text nodes, and [repeaters](/docs/framework/concepts/lists), mixed freely |

Only `tagName` is required. A document can also carry `$media` (named breakpoints, see [Styling](/docs/framework/concepts/styling)) and `$elements` (custom-element dependencies, see [Components](/docs/framework/concepts/components)).

:::doc-note
`https://jxsuite.com/schema/v1` names the dialect, which is what you want for a document that travels on its own. Inside a project, point `$schema` at the `document.schema.json` that [`jx schema`](/docs/framework/build/cli) writes into the project root instead. That bundle is the core schema _plus_ every enabled extension's contributions, so your editor's autocomplete and `jx validate` are reading the same rules. See [Schema composition](/docs/extending/extensions/schema-composition).

The pointer is resolved relative to the file that carries it, so it needs one `../` per folder level: `"../document.schema.json"` from `pages/index.json`, `"../../document.schema.json"` from `pages/blog/post.json`. Too few and it points at a file that does not exist, which every validator reports as an unresolvable schema rather than as a document error.
:::

## `$defs` — type definitions

`$defs` holds pure JSON Schema 2020-12 type definitions. They exist for tooling — validation, autocomplete, Studio's input controls — and produce nothing at runtime:

```json
{
  "$defs": {
    "Count": { "type": "integer", "minimum": 0, "maximum": 100 },
    "Status": {
      "type": "string",
      "enum": ["idle", "loading", "success", "error"]
    }
  }
}
```

State entries reference these types with `$ref` (`{ "$ref": "#/$defs/Count" }`). `$defs` entries never contain `default`, `$prototype`, or template strings — runtime values belong in `state`.

## Component or page fragment

What a document _is_ follows from its root `tagName` and where the file lives:

- A root `tagName` **containing a hyphen** (`"my-counter"`, `"user-card"`) defines a **custom element** — a reusable [component](/docs/framework/concepts/components) that other documents instantiate by reference.
- A root `tagName` that is a **plain HTML tag** (`"main"`, `"section"`) is a **page fragment** — a tree that renders in place, either as a route in a site's `pages/` directory (see [Routing](/docs/framework/site/routing)) or inlined into another document via `$ref` (see [References](/docs/framework/concepts/references)).

Either kind may declare `state`; the difference is that a custom element gets its own isolated scope and a `$props` boundary (see [Props and scope](/docs/framework/concepts/props-and-scope)).

## Why plain JSON

Jx documents are valid JSON — not JavaScript object literals, not JSX, not a template DSL. That distinction is load-bearing:

- JSON serializes and deserializes without executing code.
- There is no `this` ambiguity — self-references are explicit `$ref` pointers.
- Visual builders, IDEs, validators, and bundlers understand it natively.
- JSON Schema tooling (validation, autocomplete, LSP) applies directly.

The format also follows the **rule of least power**: prefer a `$ref` binding over a template expression, a template expression over a [declarative expression](/docs/framework/concepts/expressions), and a handler [function](/docs/framework/concepts/functions) only when logic cannot be expressed otherwise.

## How it works

Jx is a JSON Schema dialect: any 2020-12-compatible validator can check a document against the Jx meta-schema identified by `$schema`. In development, the runtime loads the `.json` file, builds a reactive scope from `state`, and renders the tree with real DOM calls. In production, the [build](/docs/framework/build) compiles the JSON away — emitting plain JavaScript classes, static HTML, and extracted CSS.

## Rules

- A document must be valid JSON — no comments, no trailing commas, no inline code (behavior lives in `state` entries as strings or structured data).
- `tagName` is the only required root field; `$schema` and `$id` are recommended.
- `$defs` is tooling-only: no signals, no functions, no runtime artifacts.
- Jx reserves the keywords `$prototype`, `$props`, `$switch`, `$map`, `$src`, `$export`, `timing`, `default`, `body`, `arguments`, and `name` on top of the standard JSON Schema vocabulary.
- One document per file; a document nests other documents only by `$ref`, never by pasting their JSON inline.

## Related

- [Components](/docs/framework/concepts/components) — custom elements and the component model
- [Elements](/docs/framework/concepts/elements) — the objects inside `children`
- [State](/docs/framework/concepts/state) — the four shapes of a `state` entry
- [Routing](/docs/framework/site/routing) — how documents in `pages/` become URLs
- [Code editing](/docs/studio/logic/code) — the Studio surface for raw document source
