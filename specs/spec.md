# Jx Specification

## Declarative Document Object Model — JSON Edition

**Version:** 2.0.1-draft
**Status:** In Progress
**License:** MIT

---

## Table of Contents

1. [Overview](#1-overview)
2. [Philosophy](#2-philosophy)
3. [Document Format](#3-document-format)
4. [The Component Model](#4-the-component-model)
5. [The `$defs` and `state` Grammar](#5-the-defs-and-state-grammar)
6. [Universal Reactivity](#6-universal-reactivity)
7. [Reference System](#7-reference-system)
8. [Element Definitions](#8-element-definitions)
9. [Styling](#9-styling)
10. [Dynamic Mapped Arrays](#10-dynamic-mapped-arrays)
11. [Web API Namespaces](#11-web-api-namespaces)
12. [External Class Integration](#12-external-class-integration)
13. [Component Encapsulation](#13-component-encapsulation)
14. [Dynamic Component Switching](#14-dynamic-component-switching)
15. [Scope Rules](#15-scope-rules)
16. [Custom Element Definitions](#16-custom-element-definitions)
17. [Reserved Keywords](#17-reserved-keywords)
18. [Standards Alignment](#18-standards-alignment)

---

## 1. Overview

Jx is a schema and runtime for building reactive web applications using plain JSON. A Jx application is a tree of JSON objects whose structure mirrors the DOM API, whose reactivity is powered by `@vue/reactivity`, and whose behavior is declared in `state` entries as inline functions or external module references.

The core premise: **structure and state are data; the shape of each `state` entry determines its type and behavior — no additional flags required in the common case.**

A Jx component is a single `.json` file that can be fully self-describing:

```
component.json   ← structure, styling, state declarations, functions, bindings
```

When handler functions grow complex, they may be extracted to an external `.js` sidecar referenced via `$src` on individual `$prototype: "Function"` entries. This is optional — simple components need no sidecar.

The JSON file is fully serializable, statically analyzable, and visual-builder-friendly.

---

## 2. Philosophy

### 2.1 DOM-First Design

Jx property names mirror standard DOM element properties. `tagName`, `className`, `textContent`, `hidden`, `tabIndex` — all map directly to their DOM equivalents. This makes the schema self-documenting to any web developer and reduces the surface area of novel concepts to learn.

### 2.2 Rule of Least Power

Following [Tim Berners-Lee's Rule of Least Power](https://www.w3.org/DesignIssues/Principles.html#PLP): given a choice of solutions, use the least powerful one capable of solving the problem.

- Declarative JSON over imperative JavaScript wherever possible
- `$ref` bindings over template expressions wherever possible
- Template expressions over handler functions wherever possible
- Handler functions only when logic cannot be expressed otherwise

### 2.3 JSON as the Authoritative Format

Jx documents are valid JSON. They are not JavaScript object literals, not JSX, not a template DSL. This distinction is intentional and load-bearing:

- JSON is fully serializable and deserializable without code execution
- JSON has no `this` ambiguity — self-references use explicit `$ref` pointers
- JSON is natively understood by visual builders, IDEs, validators, and bundlers
- JSON Schema tooling (validation, autocomplete, LSP) applies directly

### 2.4 Explicit Over Implicit

Signal scope does not leak across component boundaries. Every dependency a component has on external state must be explicitly declared as a `$prop`. This makes data flow statically knowable — a requirement for both the compiler and visual builder tooling.

Within a single component, state declared in `state` is available to all descendant elements of that component without explicit passing.

### 2.5 Standards Alignment

Where a web platform standard exists, Jx follows it:

| Jx Feature                         | Platform Precedent                       |
| ---------------------------------- | ---------------------------------------- |
| `$ref` for references              | JSON Reference / JSON Pointer (RFC 6901) |
| `$defs` for type definitions       | JSON Schema 2020-12                      |
| Signal scope at component boundary | CSS Custom Properties scope              |
| Explicit props at element boundary | HTML attributes on Custom Elements       |
| `.json` / `.js` file pairs         | HTML / JS, CSS Modules / JS              |
| `$prototype` namespaces            | Web API constructor names                |

---

## 3. Document Format

### 3.1 Root Structure

Every Jx document is a JSON object with the following top-level fields:

```json
{
  "$schema": "https://jxsuite.com/schema/v1",
  "$id": "ComponentName",
  "$defs": {},
  "state": {},
  "tagName": "my-component",
  "children": []
}
```

| Field      | Required    | Description                                                                                                                                                                                                     |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`  | Recommended | URI identifying the Jx dialect version                                                                                                                                                                          |
| `$id`      | Recommended | Component identifier, used by tooling                                                                                                                                                                           |
| `$defs`    | Optional    | Pure JSON Schema type definitions — tooling only, no runtime artifacts                                                                                                                                          |
| `state`    | Optional    | Reactive state: signals, computed values, functions, and data sources                                                                                                                                           |
| `tagName`  | Required    | HTML tag name for the root element                                                                                                                                                                              |
| `children` | Optional    | Array of child element definitions, text nodes (strings/numbers), and/or Array namespaces (repeaters) mixed freely. A bare Array namespace (the whole children slot is one repeater) is also accepted. See §10. |

### 3.2 JSON Schema Dialect

Jx is a JSON Schema dialect. Documents may be validated against the Jx meta-schema using any JSON Schema 2020-12 compatible validator. The `$schema` URI identifies the dialect version and enables schema-aware tooling.

Jx extends the base JSON Schema vocabulary with the following reserved keywords: `$prototype`, `$props`, `$switch`, `$map`, `$src`, `$export`, `timing`, `default`, `body`, `arguments`, `name`.

Standard JSON Schema 2020-12 keywords (`type`, `format`, `properties`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `required`, `description`, `examples`, etc.) are inherited from the JSON Schema vocabulary and are valid on `$defs` type definitions and `state` typed value entries.

---

## 4. The Component Model

### 4.1 Self-Describing Components

A Jx component is a single `.json` file. All state, computed values, and functions are declared in `state`. Simple components are fully self-describing — no sidecar file required:

```json
{
  "$id": "Counter",
  "state": {
    "count": 0,
    "increment": { "$prototype": "Function", "body": "state.count++" }
  },
  "tagName": "my-counter",
  "children": [
    { "tagName": "span", "textContent": "${state.count}" },
    {
      "tagName": "button",
      "textContent": "+",
      "onclick": { "$ref": "#/state/increment" }
    }
  ]
}
```

### 4.2 External Function Sidecar

When handler functions grow complex, they may be extracted to a `.js` sidecar file. Each function entry declares its own `$src`:

```json
{
  "state": {
    "increment": { "$prototype": "Function", "$src": "./counter.js" },
    "decrement": { "$prototype": "Function", "$src": "./counter.js" }
  }
}
```

The `.js` file exports each function as a named export. The first parameter is always `state` — the component's reactive scope object:

```js
export function increment(state) {
  state.count++;
}
export function decrement(state) {
  state.count = Math.max(0, state.count - 1);
}
```

When multiple Function entries share a `$src`, the runtime imports the module once and extracts named exports. Module caching is automatic.

### 4.3 Handler Binding

At runtime, function exports are called with `state` as their first argument. `state` is the component's reactive scope object — a `reactive()` proxy of all declared state and functions. Inside a handler, state is read and written directly:

```js
export function increment(state) {
  state.count++;
}
export function handleInput(state, event) {
  state.name = event.target.value;
}
```

`this` is never used in Jx-managed code. All component state is accessed via `state`.

---

## 5. The `$defs` and `state` Grammar

### 5.1 Separation of Concerns

Jx separates type definitions from runtime variables:

- **`$defs`** — Pure JSON Schema 2020-12 type definitions. Tooling only. No runtime artifacts.
- **`state`** — All runtime variables: mutable state, computed values, functions, and data sources.

This separation aligns `$defs` with its standard JSON Schema 2020-12 meaning and eliminates the ambiguity of a single namespace serving both roles.

### 5.2 `$defs` — Pure Type Definitions

`$defs` contains only JSON Schema type definitions. No signals, no functions, no runtime artifacts:

```json
{
  "$defs": {
    "Count": { "type": "integer", "minimum": 0, "maximum": 100 },
    "Status": {
      "type": "string",
      "enum": ["idle", "loading", "success", "error"]
    },
    "TodoItem": {
      "type": "object",
      "properties": {
        "id": { "type": "integer" },
        "text": { "type": "string" },
        "done": { "type": "boolean" }
      },
      "required": ["id", "text", "done"]
    }
  }
}
```

**Rules:**

- Every `$defs` entry is a JSON Schema — it has `type`, `properties`, `enum`, `$ref`, etc.
- No `default`, `$prototype`, `body`, or template strings
- Naming convention: `PascalCase` for types (`TodoItem`, `Count`, `Status`)
- `$defs` entries are referenced from `state` entries via `$ref`, or from external documents
- `$defs` is optional — `state` entries can declare types inline or omit types entirely

> **Status: Implemented.** The runtime, compiler, schema, and all examples use the `$defs`/`state` split.

### 5.3 `state` — Runtime Variables

`state` is a root-level property containing all runtime variables. Everything in `state` is initialized inside Vue's `reactive()`, making all entries reactive by default.

Every entry in `state` falls into exactly one of four shapes, determinable by inspection alone.

#### Shape 1 — Naked Value

**Identified by:** a JSON scalar (number, string without `${}`, boolean, null), array, or plain object with no Jx reserved keys.

```json
{
  "state": {
    "count": 0,
    "price": 9.99,
    "name": "World",
    "active": false,
    "data": null,
    "tags": [],
    "user": { "id": null, "name": "", "role": "guest" }
  }
}
```

**Emitted as:** property on `reactive({})`, initialized to the value.

**Rules:**

- A plain string without `${}` is a string state property initialized to that string value
- A plain object with no `$prototype`, no `type`, no `default`, and no `properties` is an object state property
- All state entries are reactive by default

> **Status: Implemented.** Runtime `buildScope` handles all naked value types.

#### Shape 2 — Typed Value (JSON Schema)

**Identified by:** an object with a `default` property, optionally with `type`, and no `$prototype`.

```json
{
  "state": {
    "count": {
      "type": { "$ref": "#/$defs/Count" },
      "default": 0,
      "description": "Current counter value"
    },
    "status": {
      "type": {
        "type": "string",
        "enum": ["idle", "loading", "success", "error"]
      },
      "default": "idle"
    }
  }
}
```

**Emitted as:** property on `reactive({})`, initialized to the `default` value.

**Rules:**

- The `default` keyword is the required discriminator — its value is the initial state
- The `type` property references a JSON Schema (either via `$ref` to `$defs` or inline)
- Schema keywords are tooling-only — they power LSP validation, autocomplete, and studio rendering. Stripped before runtime emission.

**Use the typed form when** the value needs type constraints, documentation, or references a shared type via `$ref`. **Use naked values (Shape 1) when none apply.**

##### The `format` Keyword

The `format` keyword provides rendering hints for visual editors. It does not affect runtime behavior — the value remains its declared `type` — but tells the studio which specialized input control to present.

| `format` value | Underlying `type` | Studio control                          |
| -------------- | ----------------- | --------------------------------------- |
| `"image"`      | `string`          | Media picker (file browser + thumbnail) |
| `"date"`       | `string`          | Date input (YYYY-MM-DD)                 |
| `"color"`      | `string`          | Color picker                            |

```json
{
  "state": {
    "bg": { "type": "string", "format": "image", "default": "" },
    "publishDate": { "type": "string", "format": "date", "default": "" },
    "accentColor": { "type": "string", "format": "color", "default": "#000000" }
  }
}
```

> **Status: Implemented.** Runtime handles `default` extraction. Schema generator includes `TypedStateDef`.

#### Shape 3 — Computed (Template String)

**Identified by:** a JSON string value containing `${}` syntax.

```json
{
  "state": {
    "fullName": "${state.firstName} ${state.lastName}",
    "displayTitle": "${state.score >= 90 ? 'Expert' : 'Beginner'}",
    "scoreLabel": "${state.score}%",
    "isEmpty": "${state.items.length === 0}"
  }
}
```

**Emitted as:** `computed(() => \`...template...\`)`

**Rules:**

- Dependencies are tracked automatically by Vue when `state.*` properties are read during evaluation
- The string must be a pure expression — no statements, no assignments, no semicolons
- `return` is never written — the expression value is the signal value
- `state` refers exclusively to the current component's reactive scope

> **Status: Implemented.** Runtime compiles template strings via `new Function("state", "$map", `` `return \`${str}\`` ``)`.

#### Shape 4 — Prototype (`$prototype`)

**Identified by:** object with `$prototype` property.

Functions and data sources are both declared via `$prototype`:

##### 4a — Function (Inline handler)

```json
"increment": {
  "$prototype": "Function",
  "body": "state.count++"
},
"handleInput": {
  "$prototype": "Function",
  "arguments": ["event"],
  "body": "state.value = event.target.value"
}
```

##### 4b — Function (Inline computed)

```json
"titleClass": {
  "$prototype": "Function",
  "body": "return state.score >= 90 ? 'gold' : 'silver'"
}
```

A function with only `body` (no `arguments`) and no event binding acts as a computed value — the framework automatically wraps it in `computed()` when it detects it is referenced reactively.

##### 4c — Function (External)

```json
"addItem": {
  "$prototype": "Function",
  "$src": "./handlers/items.js"
},
"validateEmail": {
  "$prototype": "Function",
  "$src": "npm:@myorg/validators",
  "$export": "validateEmail"
}
```

##### 4d — Function Properties

| Property      | Required     | Description                                                                                                     |
| ------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| `$prototype`  | Yes          | Must be `"Function"`                                                                                            |
| `body`        | If no `$src` | Function body: raw JS source string, or a structured statement array (§20)                                      |
| `arguments`   | No           | Array of parameter name strings. Default: `[]`                                                                  |
| `parameters`  | No           | Array of parameter entries — bare string names or CEM-compatible parameter objects (alternative to `arguments`) |
| `type`        | No           | Return type for tooling — JSON Schema or CEM `{ text }` format                                                  |
| `name`        | No           | Explicit function name. Default: the `state` key name                                                           |
| `$src`        | If no `body` | External module specifier                                                                                       |
| `$export`     | No           | Named export in `$src` module. Default: `state` key name                                                        |
| `description` | No           | Documentation string                                                                                            |
| `emits`       | No           | Array of CEM `Event` objects this function dispatches                                                           |

`body` and `$src` are mutually exclusive. Declaring both is a compile-time error.

`parameters` entries may be bare string names (`["item"]`, as in §20.1's example), CEM-compatible parameter objects (`{ "name": "id", "type": { "text": "number" }, "default": 1 }`), or a mix — the schema and runtime accept both forms, and the runtime normalizes every entry to its name. Prefer objects when tooling metadata (types, defaults, descriptions) matters; bare names suffice otherwise.

**Compiled-site delivery.** In compiled sites, bundleable `$src` specifiers — `npm:<pkg>[/subpath]` and project-relative `./…` files (TypeScript included) — are bundled per the entry's `timing`. Client-timing functions compile to self-contained ESM bundles under `/assets/` with deterministic, hash-free names (relative specifiers key on their project-relative path); emitted page and element modules import the bundle URL instead of the raw specifier, so external libraries work on purely static hosts with no `node_modules/` at runtime. `timing: "compiler"` functions are never bundled — they execute in the build host. Absolute URL specifiers (`/lib/x.js`, `https://…`) are emitted verbatim and served as-is. Server-timing functions are imported by the generated site worker (server.md §6). The bundler backend is `Bun.build` under Bun and esbuild under Node (see compiler.md).

##### 4e — Data Source (External Class)

```json
{
  "state": {
    "userData": {
      "$prototype": "Request",
      "url": "/api/users/",
      "urlParams": { "$ref": "#/state/userId" },
      "method": "GET"
    },
    "posts": {
      "$prototype": "MarkdownCollection",
      "src": "./content/posts/*.md",
      "timing": "compiler"
    }
  }
}
```

External class entries are always resolved reactively — the framework wraps their resolved values in `ref()` automatically.

### 5.4 Naming Convention

State entries use plain `camelCase` names (e.g. `count`, `items`, `firstName`). Function entries also use `camelCase` (e.g. `increment`, `handleInput`). Type definitions in `$defs` use `PascalCase` (e.g. `TodoItem`, `Count`).

### 5.5 Signal Access in JavaScript

Within function `body` strings and external `.js` files, state is read and written directly on the `state` reactive proxy — no `.get()` or `.set()` calls:

```js
// Read
const current = state.count;

// Write
state.count = current + 1;

// Mutate array in place (Vue tracks array mutations)
state.items.push(newItem);
state.items.splice(0, 1);

// Mutate nested object (Vue tracks nested reads and writes)
state.user.name = "Alice";
```

> **Status: Implemented.** All examples and the runtime use direct property access on the `state` reactive proxy.

### 5.6 Private State (`#` prefix)

State entries prefixed with `#` are private. They are never exposed to the studio property panel, never included in CEM extraction, and never settable via `$props`:

```json
{
  "state": {
    "count": 0,
    "#cache": {},
    "#lastFetchTime": null
  }
}
```

> **Status: Partially implemented.** The studio enforces the convention: `#` entries are excluded from the editable prop list (`componentPropEntries`) and skipped during CEM extraction (`cem-export`), so they never surface in the property panel or the exported manifest. The runtime does not yet enforce it — `#` entries build into scope like any other state entry, and a `$props` write against a `#` name is not blocked.

### 5.7 Shape Detection Algorithm

```
For each entry in state:

1. Value is a string containing "${"?
   → Shape 3: Computed (computed())

2. Value is a string, number, boolean, null, or array?
   → Shape 1: Naked value (reactive property)

3. Value is an object with "$expression"?
   → Shape 5: Expression (declarative operation; mutating → handler, pure → computed)

4. Value is an object with "$prototype"?
   → Shape 4: Prototype (function, data source, or external class)

5. Value is an object with "default" (no "$prototype")?
   → Shape 2: Typed value (reactive property with type metadata)

6. Value is a plain object (no reserved keys)?
   → Shape 1: Object value (reactive property)
```

> **Status: Implemented.** Runtime `buildScope` follows this exact algorithm.

---

## 6. Universal Reactivity

Template literal syntax `${}` is valid **anywhere a string value appears in the document tree** — not only in `state`.

### 6.1 Reactive element properties

```json
{
  "tagName": "div",
  "textContent": "${state.count} items remaining",
  "className": "${state.active ? 'card active' : 'card'}",
  "hidden": "${state.items.length === 0}"
}
```

### 6.2 Reactive style properties

```json
{
  "tagName": "div",
  "style": {
    "color": "${state.score > 90 ? 'gold' : 'inherit'}",
    "opacity": "${state.loading ? '0.5' : '1'}"
  }
}
```

### 6.3 Reactive attributes

```json
{
  "tagName": "button",
  "attributes": {
    "aria-label": "${state.count} unread messages",
    "data-state": "${state.status}"
  }
}
```

### 6.4 Compilation

When the compiler encounters `${}` in any string-valued property, it wraps the binding in a reactive effect:

```js
watchEffect(() => {
  el.textContent = `${state.count} items remaining`;
});
```

### 6.5 Relationship to `$ref`

| Pattern                       | Use when                                                  |
| ----------------------------- | --------------------------------------------------------- |
| `{ "$ref": "#/state/label" }` | Binding to a named signal — referenced in multiple places |
| `"${state.count} items"`      | Inline computed binding used in exactly one place         |

Prefer `${}` for single-use reactive bindings. Prefer `$ref` for reused or named signals.

### 6.6 Scope

Template strings anywhere in a component's document tree have access only to that component's `state` via `state.propertyName`. The `state` scope is always the current component's reactive proxy.

> **Status: Implemented.** Runtime wraps template strings in `effect()` for all string-valued properties.

---

## 7. Reference System

### 7.1 `$ref` Syntax

Jx uses `$ref` to express bindings between properties and declared state, following the JSON Reference convention:

```json
{ "$ref": "#/state/count" }
```

### 7.2 Reference Schemes

| Scheme           | Example                 | Resolves to                                      |
| ---------------- | ----------------------- | ------------------------------------------------ |
| Internal `state` | `"#/state/count"`       | Signal or handler in current component's `state` |
| Window global    | `"window#/currentUser"` | `window.currentUser`                             |
| Document global  | `"document#/appConfig"` | `document.appConfig`                             |
| Parent scope     | `"parent#/sharedState"` | Named signal passed via `$props`                 |
| Map context      | `"$map/item"`           | Current item in an Array map iteration           |
| Map index        | `"$map/index"`          | Current index in an Array map iteration          |
| External file    | `"./other.json"`        | Another Jx component (fully dereferenced)        |

### 7.3 Reactive Bindings

When a `$ref` resolves to a reactive state property or computed, the binding is reactive — the DOM property updates automatically whenever the value changes:

```json
{
  "tagName": "p",
  "textContent": { "$ref": "#/state/count" }
}
```

### 7.4 `$ref` Resolution Order

1. `$map/` — iteration context (highest priority)
2. `$reduce/acc` — fold accumulator (reduce per-item expression only)
3. `$args/` — named-formula parameters (callable body only, §19.4c)
4. `event#/` — handler event context (handler position only)
5. `#/state/` — current component scope
6. `parent#/` — explicitly passed props
7. `window#/` — global window properties
8. `document#/` — global document properties

> **Status: Implemented.** Runtime `resolveRef` handles all schemes.

---

## 8. Element Definitions

### 8.1 DOM Property Mapping

Any valid DOM element property may be set directly on an element definition object:

```json
{
  "tagName": "div",
  "id": "my-element",
  "className": "container active",
  "hidden": false,
  "tabIndex": 0,
  "textContent": "Hello World"
}
```

### 8.2 Protected Properties

`id` and `tagName` are protected — they may not be set via `$ref` bindings.

### 8.3 Custom Attributes

Non-standard attributes are set via the `attributes` object:

```json
{
  "tagName": "div",
  "attributes": {
    "data-component": "my-widget",
    "aria-label": "Interactive counter",
    "slot": "header"
  }
}
```

### 8.4 Child Arrays

Children are expressed as a JSON array of element definitions and/or bare text nodes:

```json
{
  "tagName": "div",
  "children": [
    { "tagName": "h1", "textContent": "Title" },
    { "tagName": "p", "textContent": "Content" }
  ]
}
```

#### Text Node Children

Bare strings and numbers are valid `children` items. They produce DOM `Text` nodes directly, without wrapper elements:

```json
{
  "tagName": "p",
  "children": ["Hello ", { "tagName": "strong", "textContent": "world" }, "!"]
}
```

This is equivalent to the HTML `<p>Hello <strong>world</strong>!</p>`.

Template strings in text node children are reactive:

```json
{ "children": ["Welcome, ${state.name}!"] }
```

When all children are bare strings with no element siblings, prefer the simpler `textContent` representation instead.

#### Computed Children (Build Time)

The entire `children` value may be a `${…}` template string that resolves **at
site-build time** to an array of child definitions. This is the mechanism for
injecting parsed content (e.g. a content entry's `$children` from
`@jxsuite/parser`) into a wrapper element:

```json
{ "tagName": "bl-prose", "children": "${state.entry.$children}" }
```

The compiler's template pass replaces `children` with the resolved array and
recurses into it. Scope of the feature: the template must resolve to an array
during the site build (e.g. from `$paths`-bound state or a compiler-timing
prototype). A computed-children string is **not** re-evaluated at runtime —
runtime-reactive content swapping is not supported through this form — and a
plain non-template string is not a valid `children` value at all (text
children must be array items, per above).

### 8.5 Slot Support

Custom elements support the standard HTML `slot` mechanism for content composition:

```json
{
  "tagName": "card-component",
  "children": [
    {
      "tagName": "header",
      "children": [{ "tagName": "slot", "attributes": { "name": "header" } }]
    },
    {
      "tagName": "main",
      "children": [{ "tagName": "slot" }]
    }
  ]
}
```

The runtime performs manual light DOM slot distribution: capturing host children before rendering the template, then distributing them to matching `<slot>` elements by `name` attribute. Fallback content is preserved when no matching content is provided.

> **Status: Implemented.** Runtime `distributeSlots()` handles light DOM slot distribution.

### 8.6 Annotations

Any element may carry `$title` and `$description` as developer-facing metadata annotations, inspired by JSON Schema's annotation keywords:

```json
{
  "tagName": "section",
  "$title": "Hero Section",
  "$description": "Primary landing area with headline and call-to-action buttons",
  "children": [...]
}
```

**Rules:**

- Both are plain strings (not reactive, not `$ref`-resolvable)
- Neither is applied to the DOM or compiled to HTML output
- `$title` provides a human-friendly label for tooling (e.g., Jx Studio layers panel)
- `$description` provides extended documentation for the element's purpose
- In markdown remark directives, these map to `--title` and `--description` attributes

> **Status: Implemented.** Runtime RESERVED_KEYS includes both; schema validates them on ElementDef.

---

## 9. Styling

### 9.1 Inline Styles as Objects

The `style` property accepts an object with camelCase CSS property names:

```json
{
  "tagName": "div",
  "style": {
    "backgroundColor": "blue",
    "marginTop": "10px",
    "fontSize": "16px",
    "display": "flex"
  }
}
```

### 9.2 Nested CSS Selectors

CSS nesting is supported via special keys. Keys beginning with `:`, `.`, `&`, or `[` are treated as nested selectors:

```json
{
  "style": {
    "backgroundColor": "blue",
    ":hover": { "backgroundColor": "darkblue", "cursor": "pointer" },
    ".child": { "color": "white" },
    "&.active": { "outline": "2px solid white" }
  }
}
```

Inline properties are applied directly to the element. Nested rules are emitted as a scoped `<style>` block using a generated `data-jx` attribute selector.

Nesting is **recursive**: selector groups and at-rule groups (`@`-prefixed
keys — named breakpoints per §9.4, or standard at-rules like
`@starting-style`) may nest to arbitrary depth, e.g. breakpoint → selector →
pseudo-class:

```json
{
  "style": {
    "& .nav-link": { "color": "gray", ":hover": { "color": "white" } },
    "@--sm": {
      "& li:nth-of-type(2n)": { ":hover": { "opacity": "0.8" } }
    }
  }
}
```

Both the compiler and the runtime resolve nesting recursively; the component
and project style schemas model the same recursive contract. (Known compiler
limitation: inside an at-rule group, only one selector level is currently
emitted — at-rule → selector → pseudo is accepted by the schema and runtime
but not yet fully emitted by the static compiler.)

### 9.3 Static Style Extraction

The compiler extracts all static `style` definitions into a single `<style>` block in the document `<head>`.

### 9.4 Named Media Breakpoints (`$media`)

Named breakpoints are declared at root level using `$media`, following the CSS `@custom-media` convention:

```json
{
  "$media": {
    "--sm": "(min-width: 640px)",
    "--md": "(min-width: 768px)",
    "--lg": "(min-width: 1024px)",
    "--dark": "(prefers-color-scheme: dark)"
  }
}
```

Within any `style` object, `@--name` keys reference named breakpoints. `@(condition)` keys are literal media queries:

```json
{
  "style": {
    "fontSize": "14px",
    "@--md": { "fontSize": "16px" },
    "@--dark": { "color": "#ccc" },
    "@(min-width: 1280px)": { "fontSize": "18px" }
  }
}
```

`$media` declarations propagate through the component scope.

A `$media` entry whose value is a _pure_ `prefers-color-scheme` query — exactly
`(prefers-color-scheme: light)` or `(prefers-color-scheme: dark)`, no other conditions — is a
**scheme query**. Scheme queries participate in the forced-scheme contract defined in §9.5.

> **Status: Implemented.** Runtime `applyStyle` handles nested selectors, media breakpoints, and scoped style generation.

### 9.5 Color-Scheme Variants and Forced Schemes

Declaring a scheme query in `$media` opts a document (or site) into the color-scheme contract.
Two normative constants define the visitor-facing override mechanism:

- **`data-color-scheme`** — attribute on the root element (`<html>`). Value `"light"` or
  `"dark"` forces that scheme; an absent attribute means _auto_ (follow the OS
  `prefers-color-scheme`).
- **`jx-color-scheme`** — `localStorage` key a site switcher persists the visitor's forced
  scheme under. Values `"light"` or `"dark"`; absent means auto.

**Dual emission.** Every style block keyed by a scheme query (`@--dark { … }` or a literal
`@(prefers-color-scheme: …) { … }`) is emitted twice:

1. a media-guarded copy that applies only while no scheme is forced — root-level rules are
   guarded as `:root:where(:not([data-color-scheme]))`, scoped rules as
   `:where(:root:not([data-color-scheme])) <selector>`;
2. an unconditional forced copy under the attribute — `:root:where([data-color-scheme="dark"])`
   for root-level rules, `:where(:root[data-color-scheme="dark"]) <selector>` for scoped rules.

All guards are wrapped in `:where()` so specificity matches the unguarded selector and source
order decides the cascade: base rules are always emitted **before** conditional blocks.
At the project level, custom properties inside a scheme block land on `:root` and direct
properties on `body`, mirroring the base emission.

**Compound-query limitation.** A query that combines `prefers-color-scheme` with any other
condition (e.g. `(prefers-color-scheme: dark) and (min-width: 768px)`) is _not_ a scheme query:
it keeps plain `@media` emission and does not respond to the forced attribute.

**`color-scheme` declaration.** When a scheme query is declared, the compiler emits
`:root { color-scheme: light dark }` plus per-attribute overrides
(`:root:where([data-color-scheme="light"]) { color-scheme: light }` and the dark equivalent) so
native widgets, scrollbars, and form controls follow the forced scheme. Authors who set
`colorScheme` in the project `style` suppress this emission.

**Pre-paint script.** Site and standalone compilation targets inject a small synchronous inline
`<script>` into `<head>` — ahead of all style blocks — that reads `jx-color-scheme` from
`localStorage` and sets `data-color-scheme` on the root element, eliminating any flash of the
wrong scheme on load. Declaring a scheme query is the sole opt-in; no other configuration
exists.

> **Status: Implemented.** `pureSchemeOf`/`schemeSelectors` (runtime, re-exported by the
> compiler) define the shared selector contract; `applyStyle`, `compileStyles`, and the site
> pipeline all dual-emit through them.

---

## 10. Dynamic Mapped Arrays

### 10.1 Array Namespace Syntax

A dynamic list is an array **pseudo-element** — an object with `$prototype: "Array"` that sits as a
**member of a `children` array**, nestled among sibling elements or as the sole child. It renders
**wrapper-less**: its mapped items become direct children of the array's parent (no intervening
container).

```json
{
  "tagName": "ul",
  "children": [
    { "tagName": "li", "textContent": "Header" },
    {
      "$prototype": "Array",
      "items": { "$ref": "#/state/todoList" },
      "map": {
        "tagName": "li",
        "textContent": { "$ref": "$map/item" }
      }
    }
  ]
}
```

> **Backward compatibility.** The legacy form where `children` is _itself_ the Array object
> (`"children": { "$prototype": "Array", … }`) is still accepted: the runtime and compiler render its
> items directly into the parent element, and the studio normalizes it to a single array member on
> load.

### 10.2 Iteration Context

| Reference                  | Resolves to                          |
| -------------------------- | ------------------------------------ |
| `{ "$ref": "$map/item" }`  | The current array item object        |
| `{ "$ref": "$map/index" }` | The current zero-based integer index |

### 10.3 Filtering and Sorting

```json
{
  "$prototype": "Array",
  "items": { "$ref": "#/state/allItems" },
  "filter": { "$ref": "#/state/isVisible" },
  "sort": { "$ref": "#/state/sortByDate" },
  "map": { "tagName": "list-item", "item": { "$ref": "$map/item" } }
}
```

> **Status: Implemented.** The runtime renders array members inline (wrapper-less) via
> `renderMappedArrayInto()`, handling items, filter, sort, `$map/item`, and `$map/index`.

---

## 11. Web API Namespaces

### 11.1 Prototype Namespace Syntax

Web APIs are accessed via `$prototype` in a `state` entry:

```json
{
  "state": {
    "userData": {
      "$prototype": "Request",
      "url": "/api/users/",
      "urlParams": { "$ref": "#/state/userId" },
      "method": "GET"
    }
  }
}
```

### 11.2 Supported Prototypes

| `$prototype`      | Web API      | Status                                                                  |
| ----------------- | ------------ | ----------------------------------------------------------------------- |
| `Request`         | Fetch API    | **Implemented** — reactive URL, debounce, manual mode, abort controller |
| `URLSearchParams` | URL API      | **Implemented** — computed `.toString()`                                |
| `FormData`        | FormData API | **Implemented** — basic field population                                |
| `LocalStorage`    | Storage API  | **Implemented** — reactive read/write with persistence                  |
| `SessionStorage`  | Storage API  | **Implemented** — session-scoped reactive storage                       |
| `Cookie`          | Cookie API   | **Implemented** — maxAge, path, domain, secure, sameSite                |
| `IndexedDB`       | IDB API      | **Implemented** — store creation, indexes, CRUD helper                  |
| `Array`           | —            | **Implemented** — dynamic mapped list (see §10)                         |
| `Set`             | —            | **Implemented** — `new Set(default)`                                    |
| `Map`             | —            | **Implemented** — `new Map(Object.entries(default))`                    |
| `Blob`            | Blob API     | **Implemented** — parts and type                                        |
| `ReadableStream`  | Streams API  | **Pending** — stub returns `null`                                       |

### 11.3 Timing Values

| Value        | When                                                   | Status          |
| ------------ | ------------------------------------------------------ | --------------- |
| `"client"`   | Resolved at runtime in the browser (default)           | **Implemented** |
| `"server"`   | Resolved at runtime on the server via RPC              | **Implemented** |
| `"compiler"` | Resolved at build time; result baked into emitted HTML | **Implemented** |

> **Status: Implemented.** The site build resolves `timing: "compiler"` entries at build time (`prototype-resolver`) and bakes the resolved data into the compiled tree; the resolved entries are then stripped from emitted output. The compiler's `isDynamic` check skips them, so a component whose only state is compiler-timed compiles as fully static HTML.

### 11.4 Server Timing — RPC Function Boundary

`timing: "server"` designates a cross-process function call. The entry points to a named export in a server-side module via `$src` and `$export`. No `$prototype` is used:

```json
{
  "state": {
    "metrics": {
      "$src": "./dashboard.server.js",
      "$export": "fetchMetrics",
      "timing": "server"
    }
  }
}
```

The referenced function must be an async export in the `$src` module. The function receives `(args, env)` — `args` is the arguments object from the caller, and `env` is the platform's environment bindings (Cloudflare Workers `env`, Node `process.env` wrapper, etc.):

```js
export async function fetchMetrics(args, env) {
  const db = env.DB; // e.g., Cloudflare D1 binding
  const { data } = await db.prepare("SELECT * FROM metrics").all();
  return data;
}
```

Functions that don't need platform bindings can ignore the second parameter:

```js
export async function fetchMetrics({ userId }) {
  const { data } = await supabase.from("metrics").select("*").eq("user_id", userId);
  return data;
}
```

#### Arguments

An optional `arguments` field passes named parameters. Values may be static or reactive `$ref` references:

```json
"metrics": {
  "$src": "./dashboard.server.js",
  "$export": "fetchMetrics",
  "timing": "server",
  "arguments": {
    "userId": { "$ref": "#/state/userId" },
    "filter": "active"
  }
}
```

When any `arguments` value is a signal `$ref`, the call becomes reactive.

#### Security Boundary

Private environment variables and server-only credentials remain in the server process. The browser receives only the function's serialized return value. The `env` parameter gives server functions access to platform bindings (KV namespaces, D1 databases, email workers, secrets) without exposing them to the client.

#### Site-Wide Bundling

When `build.adapter` is set in `project.json`, all `timing: "server"` entries across the entire site (components and pages) are collected, deduplicated by export name, and bundled into a single `_worker.js` entry point. See compiler spec §6.3 for details.

> **Status: Implemented.** Runtime handles `timing: "server"` entries. Dev server provides `/__jx_server__` proxy. Compiler emits per-route Hono handlers (`compileServer`) or a site-wide bundled worker (`compileSiteServer`) when `build.adapter` is set.

---

## 12. External Class Integration

### 12.1 Built-in Prototypes

Jx provides several `$prototype` types that resolve automatically without any `imports` or `$src` configuration:

| Prototype            | Timing   | Description                                        |
| -------------------- | -------- | -------------------------------------------------- |
| `Function`           | client   | Inline handlers with `body`/`arguments`            |
| `Array`              | client   | Reactive array wrapper                             |
| `LocalStorage`       | client   | Persistent key-value storage                       |
| `SessionStorage`     | client   | Session-scoped key-value storage                   |
| `Request`            | client   | HTTP fetch with reactive URL params                |
| `MarkdownFile`       | compiler | Parses a single `.md` file into frontmatter + tree |
| `MarkdownCollection` | compiler | Globs and parses multiple `.md` files              |
| `ContentCollection`  | compiler | Schema-validated multi-format content source       |
| `ContentEntry`       | compiler | Single entry within a content collection           |

`MarkdownFile` and `MarkdownCollection` are first-class prototypes — they resolve at compile time with zero configuration:

```json
{
  "state": {
    "page": {
      "$prototype": "MarkdownFile",
      "src": "./content/about.md",
      "timing": "compiler"
    },
    "posts": {
      "$prototype": "MarkdownCollection",
      "src": "./content/posts/*.md",
      "timing": "compiler"
    }
  }
}
```

The compiler maps these names to their `.class.json` implementations internally (`@jxsuite/parser/MarkdownFile.class.json`, `@jxsuite/parser/MarkdownCollection.class.json`). No `imports` entry is needed.

### 12.2 The `$src` Property

For **third-party or project-local** classes, `$src` on any `state` entry with a non-Function `$prototype` **must** point to a `.class.json` file. The `.class.json` schema is the canonical entrypoint — it can optionally reference a JS implementation via `$implementation`. Direct JS `$src` for non-Function prototypes is not allowed.

```json
{
  "state": {
    "forecast": {
      "$prototype": "WeatherForecast",
      "$src": "./lib/WeatherForecast.class.json",
      "location": "Lancaster, PA",
      "days": 5
    }
  }
}
```

| Specifier form                      | Example                                      | Resolution                        |
| ----------------------------------- | -------------------------------------------- | --------------------------------- |
| Relative `.class.json` path         | `"./lib/WeatherForecast.class.json"`         | Relative to the `.json` file      |
| npm package specifier               | `"@acme/weather/WeatherForecast.class.json"` | Resolved via `node_modules`       |
| `$prototype: "Function"` with `.js` | `"./lib/helpers.js"`                         | Direct JS import (Functions only) |

### 12.3 External Class Contract

**Constructor:** Receives a single configuration object containing all `state` properties except reserved keywords (`$prototype`, `$src`, `$export`, `timing`, `default`, `description`).

**Value resolution:** Checked in order:

1. `instance.resolve()` — async method, awaited
2. `instance.value` — synchronous getter or property
3. `instance` itself — fallback

**Return type declaration:** Methods in a `.class.json` definition may declare a `returnType` field containing a JSON Schema type descriptor. This allows tooling (visual builders, type checkers, autocomplete) to reason about a method's output without executing it:

```json
"resolve": {
  "role": "method",
  "$prototype": "Function",
  "returnType": { "type": "array", "items": { "$ref": "#/$defs/ContentLoaderEntry" } }
}
```

The `returnType` value is a standard JSON Schema object (`type`, `items`, `properties`, `$ref`, etc.). It may reference local `$defs` within the same `.class.json` file; named return types conventionally live under the `returnTypes` `$defs` category (compiler spec §5.3) and are referenced as `{ "$ref": "#/$defs/returnTypes/<Name>" }`. For classes whose `resolve()` returns an array, this signals to tooling that instances are valid sources for mapped iteration (§10).

**Reactivity (optional):**

```js
instance.subscribe(callback);
instance.unsubscribe();
```

### 12.4 `.class.json` Schema-Defined Classes

All non-Function external classes **must** use a `.class.json` file as their `$src` entrypoint. These are JSON Schema 2020-12 documents describing a class structure with an optional `$implementation` key:

```json
{
  "$schema": "https://jxsuite.com/schema/v1/class",
  "$id": "WeatherForecast",
  "title": "WeatherForecast",
  "description": "Fetches weather data for a location",
  "$defs": {
    "parameters": {
      "location": { "type": "string", "description": "City and state" },
      "days": { "type": "integer", "default": 3 }
    },
    "fields": {
      "forecasts": { "type": "array" }
    },
    "methods": {
      "resolve": {
        "role": "method",
        "$prototype": "Function",
        "returnType": {
          "type": "array",
          "items": { "$ref": "#/$defs/returnTypes/ForecastDay" }
        }
      }
    },
    "returnTypes": {
      "ForecastDay": {
        "type": "object",
        "properties": {
          "date": { "type": "string" },
          "high": { "type": "number" },
          "low": { "type": "number" }
        }
      }
    }
  },
  "$implementation": "./weather.js"
}
```

When `$src` points to a `.class.json` file, the runtime reads the schema and follows `$implementation` to instantiate the class from the JS module. If no `$implementation` is present, the runtime dynamically constructs a class from the schema definition (self-contained mode).

The `returnType` field on a method uses standard JSON Schema to describe the output type. It may use `$ref` to reference `$defs` entries within the same class definition — by convention named schemas under the `returnTypes` category. Tooling uses this metadata to determine capabilities — for example, a method whose `returnType` declares `"type": "array"` indicates the class is a valid data source for mapped iteration (§10).

> **Status: Implemented.** Runtime enforces `.class.json` entrypoint for all non-Function external prototypes. `$implementation` in the schema optionally redirects to a JS module. Dev server handles resolution via proxy. Compiler emits `.class.json` → ES class.

### 12.5 Import Maps

To avoid repeating `$src` paths across every state entry, a document may declare a top-level `imports` key that maps `$prototype` names to `.class.json` paths:

```json
{
  "imports": {
    "WeatherForecast": "@acme/weather/WeatherForecast.class.json",
    "GeoLocation": "./lib/GeoLocation.class.json"
  },
  "state": {
    "forecast": {
      "$prototype": "WeatherForecast",
      "location": "Lancaster, PA",
      "days": 5
    },
    "coords": { "$prototype": "GeoLocation", "address": "123 Main St" }
  }
}
```

**Rules:**

| Rule                              | Description                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Values must end in `.class.json`  | Non-`.class.json` values emit a console warning and are skipped                    |
| Explicit `$src` wins              | If a state entry already has `$src`, the import map is not consulted               |
| `$prototype: "Function"` excluded | Function prototypes are never resolved via import map                              |
| Built-in prototypes unchanged     | `Request`, `Set`, `Map`, `LocalStorage`, etc. are unaffected                       |
| Import overrides built-ins        | An explicit `imports` entry takes precedence over built-in prototype mappings      |
| Site-level cascading              | `imports` in `site.json` cascade to all pages; page-level entries win on collision |

**Resolution order:** explicit `$src` → page `imports` → site `imports` → built-in prototype mappings → unknown prototype warning.

At runtime, `buildScope` injects the mapped `$src` into each bare `$prototype` entry before any resolution pass executes, so all downstream resolution (`resolvePrototype` → `resolveExternalPrototype` → `resolveClassJson`) works unchanged.

> **Status: Implemented.** Runtime pre-processes `doc.imports` in `buildScope`. Compiler merges site-level imports into page documents via `injectContext`. Built-in prototype mappings (`MarkdownFile`, `MarkdownCollection`) resolve at compile time without imports. Site-loader defaults include `imports: {}`.

---

## 13. Component Encapsulation

### 13.1 External Component References

```json
{
  "children": [
    { "$ref": "./components/my-counter.json" },
    {
      "$ref": "./components/card.json",
      "$props": {
        "title": "Hello",
        "count": { "$ref": "#/state/count" }
      }
    }
  ]
}
```

### 13.2 Explicit Props

Props are passed via `$props`. This is the only mechanism for passing state across component boundaries:

```json
{
  "$ref": "./card.json",
  "$props": {
    "title": "Static string",
    "count": { "$ref": "#/state/count" },
    "onAction": { "$ref": "#/state/handleAction" }
  }
}
```

### 13.3 Signal Forwarding

When a `$props` value is a `$ref` to a signal, the child receives the same reactive reference — writes in either scope trigger effects in both.

### 13.4 Scope Isolation

Signal scope is bounded at the component (custom element) level. Child components receive external state only via explicit `$props`.

> **Status: Implemented.**

---

## 14. Dynamic Component Switching

### 14.1 `$switch` Syntax

```json
{
  "tagName": "main",
  "children": [
    {
      "$switch": { "$ref": "#/state/currentRoute" },
      "cases": {
        "home": { "$ref": "./views/home.json" },
        "about": { "$ref": "./views/about.json" },
        "profile": { "$ref": "./views/profile.json" }
      }
    }
  ]
}
```

**Container element.** A `$switch` node always renders a container element — its `tagName` if declared, else `div`. Properties, `style` (including `$media` breakpoints, §9.4), and `attributes` declared on the switch node apply to this container, exactly as on any element definition (§8). The active case renders as the container's children; when the discriminant changes, the container is emptied and the new case rendered in its place.

**Case forms.** Each `cases` value is one of:

- **An external component `$ref`** (`"./views/home.json"`) — the referenced document is fetched and rendered asynchronously; a stale load (the discriminant changed again before it resolved) is discarded.
- **An inline element definition** — any element object (§8), rendered synchronously.

**Scope.** The two forms differ in scope, mirroring §13/§15: an inline case renders in the parent component's scope, so parent `state` is directly visible to its bindings. An external case builds an isolated scope from the referenced document — a component boundary with no `$props` pass-through, so parent state is not visible inside it.

**Matching.** The resolved discriminant is matched against `cases` keys by its string form (JSON object keys are strings — the same normalization the expression-level `switch` operator applies, §19.4b). No matching case leaves the container empty.

> **Status: Implemented.** Runtime `renderSwitch()` creates the container, applies properties/style/attributes to it, and reactively re-renders the active case — inline definitions in the parent scope, external `$ref` cases in an isolated scope.

---

## 15. Scope Rules

### 15.1 Scope Levels

| Level      | Scope                   | Mirrors                   |
| ---------- | ----------------------- | ------------------------- |
| `window`   | Application-wide        | `window` global           |
| `document` | Document-wide           | `document` object         |
| Component  | Custom element boundary | CSS Custom Property scope |

### 15.2 Within-Component Scope

All `state` entries are available to all descendant elements within that component without explicit passing.

### 15.3 Cross-Component Scope

Signals do not cross component boundaries implicitly. `$props` is required.

### 15.4 Scope Resolution Order

1. `$map/` context
2. Local component `state`
3. Explicitly passed `$props`
4. `window` globals
5. `document` globals

> **Status: Implemented.**

---

## 16. Custom Element Definitions

### 16.1 Definition

A Jx component whose root `tagName` contains a hyphen is a custom element definition:

```json
{
  "tagName": "user-card",
  "state": {
    "username": "Guest",
    "status": "offline",
    "displayName": "${state.username} (${state.status})"
  },
  "children": [{ "tagName": "h3", "textContent": "${state.displayName}" }]
}
```

### 16.2 Property-First Interface

Custom elements use JavaScript properties as their primary data interface. `$props` can include signal references, functions, objects, and scalars. HTML observed attributes are a secondary mechanism.

### 16.3 Dependency Registration (`$elements`)

```json
{
  "tagName": "variant-item-list",
  "$elements": [{ "$ref": "./components/variant-card.json" }]
}
```

Dependencies are registered depth-first before the parent.

> **Status: Implemented.**

### 16.4 Lifecycle Hooks

| Callback                   | `state` Entry | Called When                            |
| -------------------------- | ------------- | -------------------------------------- |
| `connectedCallback`        | `onMount`     | Element inserted into DOM and rendered |
| `disconnectedCallback`     | `onUnmount`   | Element removed from DOM               |
| `adoptedCallback`          | `onAdopted`   | Element moved to new document          |
| `attributeChangedCallback` | (automatic)   | Observed attribute changes             |

> **Status: Implemented.**

### 16.5 Observed Attributes

```json
{
  "tagName": "user-card",
  "observedAttributes": ["username", "status"],
  "state": { "username": "Guest", "status": "offline" }
}
```

Type coercion: `string` → no conversion, `number` → `Number()`, `boolean` → presence check.

> **Status: Implemented.**

### 16.6 Light DOM Rendering

Custom elements render to the light DOM (no Shadow DOM). Style scoping uses `data-jx` attributes.

> **Status: Implemented.**

### 16.7 Development vs. Production

|          | Development           | Production                       |
| -------- | --------------------- | -------------------------------- |
| Renderer | `@jxsuite/runtime`    | `lit-html`                       |
| State    | `@vue/reactivity`     | `@vue/reactivity`                |
| Source   | JSON interpreted live | JSON compiled away               |
| Bundle   | `.json` + runtime     | `.js` classes only (~10 kB deps) |

### 16.8 CEM-Compatible Annotations

Custom elements may carry annotations compatible with the Custom Elements Manifest specification:

- `observedAttributes` — attribute declarations
- `parameters` on functions — CEM `Parameter` objects
- `emits` on functions — CEM `Event` objects
- `attribute` and `reflects` on typed `state` entries

> **Status: Partially implemented.** Schema includes CEM fields. Studio has CEM editing UI. Full CEM document export is pending.

---

## 17. Reserved Keywords

| Keyword              | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `$schema`            | Dialect identifier                                                |
| `$id`                | Component identifier                                              |
| `$defs`              | Pure JSON Schema type definitions                                 |
| `state`              | Reactive state, computed values, functions, and data sources      |
| `$ref`               | Reference pointer (JSON Pointer, RFC 6901)                        |
| `$props`             | Explicit prop passing at component boundary                       |
| `$prototype`         | Constructor name — Web API class, `"Function"`, or external class |
| `$src`               | External module specifier                                         |
| `$export`            | Named export within `$src` module                                 |
| `$switch`            | Dynamic component switching                                       |
| `$map`               | Iteration context namespace                                       |
| `$media`             | Named media breakpoint declarations                               |
| `$elements`          | Custom element dependency declarations                            |
| `timing`             | Execution timing: `"compiler"`, `"server"`, or `"client"`         |
| `default`            | Initial value for typed state entries                             |
| `body`               | Inline function body                                              |
| `arguments`          | Function parameter names (string array)                           |
| `parameters`         | Function parameter entries — bare names or CEM-compatible objects |
| `returnType`         | JSON Schema describing a `.class.json` method's return type       |
| `name`               | Inline function explicit name                                     |
| `description`        | Documentation string                                              |
| `observedAttributes` | HTML attributes the custom element watches                        |
| `$expression`        | Declarative operation, mutating or pure (Shape 5)                 |
| `operator`           | Operator token within an expression node                          |
| `target`             | Operand the operator acts on                                      |
| `value`              | Right-hand operand, or per-item expression for aggregates         |
| `initial`            | Seed accumulator for the reduce aggregate operator                |
| `onMount`            | Lifecycle: connected and rendered                                 |
| `onUnmount`          | Lifecycle: disconnected                                           |
| `onAdopted`          | Lifecycle: adopted into new document                              |

---

## 18. Standards Alignment

| Feature                 | Standard                        |
| ----------------------- | ------------------------------- |
| `$ref`, `$defs`, `$id`  | JSON Schema 2020-12             |
| JSON Pointer paths      | RFC 6901                        |
| Reactivity              | `@vue/reactivity` (Vue 3)       |
| Custom elements         | Web Components v1               |
| Style properties        | CSSOM camelCase                 |
| Media breakpoints       | CSS `@custom-media` convention  |
| Module loading          | ECMAScript Modules / `import()` |
| `$expression` operators | ECMAScript operator punctuators |
| Array / aggregate ops   | ECMAScript `Array.prototype`    |
| `event#` scheme         | DOM `Event` interface           |

---

## 19. Declarative Expressions (`$expression`)

### 19.1 Motivation

The Rule of Least Power (§2.2) defines a ladder of escalating power:

> `$ref` bindings → template expressions → handler functions

A gap exists between the third and fourth rungs. The moment an interaction must _write_ state — `state.count++`, `state.items.push(x)` — the only available tool is a Shape 4 `$prototype: "Function"` with a `body` string. A `body` string is opaque JavaScript: it cannot be validated by JSON Schema tooling, inspected by the visual builder, or analyzed by the compiler without parsing embedded source.

`$expression` introduces the missing rung: a **declarative operation** that mutates state through structure rather than through an interpreted string. It covers the common case of simple event-driven state changes — toggling a boolean, incrementing a counter, adding or removing array items — while `body` remains the escape hatch for logic that cannot be expressed declaratively.

This mirrors the relationship between `${}` and `$ref` established in §6.5: prefer the least powerful form; escalate only when necessary.

| Rung                     | Power   | Static-analyzable  | Use when                                    |
| ------------------------ | ------- | ------------------ | ------------------------------------------- |
| `$ref` binding           | Lowest  | Yes                | Reading a signal                            |
| `${}` template           | Low     | Yes                | Single-use computed read                    |
| **`$expression`**        | **Mid** | **Yes**            | **Simple declarative state mutation**       |
| `$prototype: "Function"` | Highest | No (`body` opaque) | Logic not expressible as a single operation |

### 19.2 Form

An `$expression` entry is an object containing a single `$expression` key whose value is an **expression node**. An expression node applies an `operator` to a `target`, optionally with a `value`:

```json
{
  "$expression": {
    "operator": "=",
    "target": { "$ref": "#/state/darkMode" },
    "value": { "operator": "!", "target": { "$ref": "#/state/darkMode" } }
  }
}
```

| Field      | Required          | Description                                                             |
| ---------- | ----------------- | ----------------------------------------------------------------------- |
| `operator` | Yes               | An operator token from the blessed set (§19.4)                          |
| `target`   | Yes               | The operand the operator acts on. A `$ref`, a literal, or a nested node |
| `value`    | By operator arity | The right-hand operand. A `$ref`, a literal, an array, or a nested node |

**Operand resolution.** `target` and `value` are resolved with the same rules as any `$ref` (§7.4). Consistent with §2.3, all references to state use explicit JSON Pointer `$ref` — never a raw `state.x` string. A `target` of `{ "$ref": "$map/item/qty" }` therefore resolves through map context exactly as elsewhere in the document.

**Operand literals.** A literal operand is a scalar (a string not containing `${`, a number, a boolean, `null`), an array of operands, or a **plain object**. An object carrying neither a `$ref` nor an `operator` key is a literal value passed through as-is — the form an `Intl` options bag takes as a `call` argument (§19.4c). Objects with those keys remain pointers and nested nodes respectively, never literals.

**Recursion.** A `value` or `target` may itself be an expression node (no `$expression` wrapper required on nested nodes — the wrapper appears only at the `state` entry or handler boundary). This permits compound expressions such as `counter = counter + 1`:

```json
{
  "$expression": {
    "operator": "=",
    "target": { "$ref": "#/state/counter" },
    "value": {
      "operator": "+",
      "target": { "$ref": "#/state/counter" },
      "value": 1
    }
  }
}
```

### 19.3 Operator Arity

An expression node is one of two **modes**, determined entirely by its operator:

- **Mutating** — the node writes to its `target` and returns nothing. Used as an event handler. (`=`, the compound assigns, and the array-mutation methods.)
- **Pure** — the node computes and returns a value, mutating nothing. Used as a computed `state` value or as a nested operand. (Unary, binary, and the aggregate operators.)

The mode is not declared; it follows from the blessed operator set (§19.4). The compiler routes a mutating node to a handler and a pure node to a `computed()` (§19.8). A pure node may nest inside either mode; a mutating node may only appear at a handler boundary, never as an operand.

| Arity       | Mode     | Uses `target`      | Uses `value`         | Operators                                      |
| ----------- | -------- | ------------------ | -------------------- | ---------------------------------------------- |
| Unary       | Pure     | Yes                | No                   | `!`, `-` (negation)                            |
| Binary      | Pure     | Yes (left)         | Yes (right)          | `+ - * / %`, `=== !== < <= > >=`, `&& \|\| ??` |
| Conditional | Pure     | Yes (test / disc.) | Branches (see below) | `?:`, `switch` (see §19.4b)                    |
| Assignment  | Mutating | Yes (LHS)          | Yes (RHS)            | `=`, `+= -= *= /=`                             |
| Method      | Mutating | Yes (receiver)     | Args (see below)     | `push`, `pop`, `shift`, `unshift`, `splice`    |
| Aggregate   | Pure     | Yes (source)       | Per-item expression  | `reduce`, `map`, `filter` (see §19.4a)         |

For **binary** operators, `target` is the left operand and `value` the right; the result is a value (it does not mutate). For **assignment** operators, `target` is the assignable location (a writable `$ref`) and the operation mutates it. For **method** operators, `target` is the array receiver and `value` carries the arguments: a single value for `push`/`unshift`, an array of arguments for `splice` (`[start, deleteCount, ...items]`), and omitted for `pop`/`shift`. **Aggregate** operators are defined in §19.4a.

```json
{ "operator": "push",   "target": { "$ref": "#/state/cart" }, "value": { "$ref": "$map/item" } }
{ "operator": "splice", "target": { "$ref": "#/state/cart" }, "value": [{ "$ref": "$map/index" }, 1] }
{ "operator": "pop",    "target": { "$ref": "#/state/cart" } }
{ "operator": "+=",     "target": { "$ref": "$map/item/qty" }, "value": 1 }
```

### 19.4 Blessed Operator Set

The operator set is **closed**. An operator outside this list is a compile-time error; logic requiring it must use a `body` string. The set is chosen to cover the mutation patterns already present in `body` strings across the existing examples (e.g. Appendix A's `push`, `splice`, and `!`-toggle handlers).

| Category               | Tokens                                  |
| ---------------------- | --------------------------------------- |
| Assignment             | `=` `+=` `-=` `*=` `/=`                 |
| Unary                  | `!` `-`                                 |
| Arithmetic (binary)    | `+` `-` `*` `/` `%`                     |
| Comparison             | `===` `!==` `<` `<=` `>` `>=`           |
| Logical (binary)       | `&&` `\|\|` `??`                        |
| Conditional (pure)     | `?:` `switch` (see §19.4b)              |
| Array mutation methods | `push` `pop` `shift` `unshift` `splice` |
| Aggregate (pure)       | `reduce` `map` `filter`                 |

All tokens except the methods and `switch` are genuine ECMAScript operator punctuators (`?:` names the conditional operator's two punctuators as one token; `??` is nullish coalescing). `switch` is the ECMAScript selection keyword, mirroring the element-level `$switch` (§14). The array and aggregate methods are genuine `Array.prototype` methods. No token in this table is invented.

### 19.4a Aggregate Operators

Aggregate operators are **pure** (§19.1): they read an array `target` and return a derived value, mutating nothing. They are the declarative replacement for the callback-in-a-string pattern a Shape 3 template would otherwise require (`"${state.cart.reduce(...)}"`), keeping the per-item computation as an inspectable expression tree rather than opaque source.

Their `value` is a single **per-item expression node** evaluated once per element of `target`, in a scope where the existing `$map/` context (§7.2) is bound to the current element:

| Reference                   | Bound during aggregation             |
| --------------------------- | ------------------------------------ |
| `{ "$ref": "$map/item" }`   | The current array element            |
| `{ "$ref": "$map/index" }`  | The current zero-based integer index |
| `{ "$ref": "$reduce/acc" }` | The accumulator (`reduce` only)      |

This is the same `$map/` binding §10.2 establishes for mapped-array templates; an aggregate's per-item expression is conceptually identical to a `map`'s per-item template, so no new iteration concept is introduced. `$reduce/acc` is the sole new pointer — the fold accumulator, resolvable only inside a `reduce` per-item expression.

| Operator | `value` (per-item expression)              | `initial`  | Returns                            |
| -------- | ------------------------------------------ | ---------- | ---------------------------------- |
| `reduce` | step: combines `$reduce/acc` with the item | Required   | The final accumulator value        |
| `map`    | the value to produce per item              | Disallowed | A new array of the produced values |
| `filter` | a predicate (truthy = keep)                | Disallowed | A new array of the kept elements   |

`reduce` requires an `initial` field — the seed accumulator. `map` and `filter` must not declare `initial`.

**Cart total** — `cart.reduce((acc, item) => acc + item.price * item.qty, 0)`:

```json
{
  "total": {
    "$expression": {
      "operator": "reduce",
      "target": { "$ref": "#/state/cart" },
      "initial": 0,
      "value": {
        "operator": "+",
        "target": { "$ref": "$reduce/acc" },
        "value": {
          "operator": "*",
          "target": { "$ref": "$map/item/price" },
          "value": { "$ref": "$map/item/qty" }
        }
      }
    }
  }
}
```

**Filter then count** composes by nesting an aggregate as the `target` of another — `cart.filter(i => i.qty > 0)`:

```json
{
  "operator": "filter",
  "target": { "$ref": "#/state/cart" },
  "value": {
    "operator": ">",
    "target": { "$ref": "$map/item/qty" },
    "value": 0
  }
}
```

Aggregate `map`/`filter` are the inline, declarative form of the `filter`/`sort` hooks gestured at in §10.3 — those hooks accept a `$ref` to a function today; an aggregate expression expresses the same predicate structurally.

### 19.4b Conditional Operators

Conditional operators are **pure** (§19.1): they select among operands and return the selected value, mutating nothing. They are the declarative replacement for conditional logic that would otherwise require a template string or a `body` string.

**`?:`** is the ECMAScript conditional operator. Its fields map onto the existing node shape following ESTree's `ConditionalExpression` (test / consequent / alternate): `target` is the test, `value` the consequent, and `initial` the alternate (the same field-repurposing precedent as `reduce`'s seed). All three are required.

```json
{
  "operator": "?:",
  "target": { "operator": ">", "target": { "$ref": "#/state/cart/length" }, "value": 10 },
  "value": "Cart full",
  "initial": "Keep shopping"
}
```

Else-if chains nest another `?:` in `initial`, exactly as in ECMAScript. A visual editor renders the chain as a flat If / Else-if / Else list; the AST needs no dedicated chain node.

**`switch`** is value-keyed multiway selection, mirroring the element-level `$switch`/`cases` (§14) at expression level: `target` is the discriminant, `cases` maps the discriminant's **string form** to result operands, and the optional `default` is the result when no key matches (`undefined` without it). `value` and `initial` are not used.

```json
{
  "operator": "switch",
  "target": { "$ref": "#/state/status" },
  "cases": { "loading": "Please wait…", "error": { "$ref": "#/state/errorMessage" } },
  "default": { "$ref": "#/state/data/title" }
}
```

Matching is on the string form (`String(discriminant)`) because JSON object keys are strings — the same normalization the element-level `$switch` applies. Arbitrary-condition branching composes from `?:` chains; `switch` is reserved for discriminant matching, as in ECMAScript.

**`??`** (nullish coalescing) joins the binary table: `target ?? value`, returning `value` only when `target` is `null` or `undefined`. Prefer it over `\|\|` when `0`, `""`, or `false` are legitimate values.

In production evaluation `?:` and `switch` evaluate only the taken branch. Under the editor trace (§19.9) every branch is evaluated so each carries a live value.

### 19.4c Named Formulas and the `call` Operator

A **named formula** is a Shape 5 expression entry with `parameters` (the same convention as Function entries, §5.3 4d — bare names or CEM parameter objects): a pure, reusable computation. Parameterless pure entries remain computed values exactly as before; the presence of `parameters` makes the entry **callable** instead.

```json
{
  "state": {
    "lineTotal": {
      "parameters": [
        { "name": "price", "type": { "text": "number" } },
        { "name": "qty", "type": { "text": "number" }, "default": 1 }
      ],
      "$expression": {
        "operator": "*",
        "target": { "$ref": "$args/price" },
        "value": { "$ref": "$args/qty" }
      }
    }
  }
}
```

Inside a formula body, parameters resolve via the **`$args/` scheme** — a context binding like `$map/` and `$reduce/acc`, inserted into the §7.4 resolution order above `event#/`. Deep paths (`$args/user/name`) navigate the argument value.

**`call`** (a genuine `Function.prototype` name) invokes a callable: `target` is the callee pointer and `value` is the positional argument list — the `splice` args-in-value precedent. Argument order follows the callee's declared `parameters`; omitted arguments take their CEM `default`.

```json
{
  "operator": "call",
  "target": { "$ref": "#/state/lineTotal" },
  "value": [{ "$ref": "$map/item/price" }, { "$ref": "$map/item/qty" }]
}
```

**Blessed globals.** A callee may also be a pure standard-library function through the existing `window#/` scheme, gated by the closed `BLESSED_GLOBALS` allowlist (`Math.*`, `JSON.*`, `Object.keys/values/entries/fromEntries`, `Number.*`, `Array.from/isArray/of`, `String.fromCharCode/fromCodePoint`, the `Intl` helpers below, …). Every entry is a genuine ECMAScript or WHATWG function with no side effects; anything off the list is an error at compile time and evaluation time alike. Impure platform functions (`fetch`, `alert`, `Math.random`, `Date.now`) are deliberately absent — side effects belong to Function entries.

```json
{
  "operator": "call",
  "target": { "$ref": "window#/Math/max" },
  "value": [{ "$ref": "#/state/a" }, { "$ref": "#/state/b" }, 0]
}
```

**Intl helpers.** The `Intl` formatters are constructors, not plain functions, so they cannot join the allowlist directly. Three **synthetic helpers** wrap construct-then-format as pure calls:

| Helper                    | Signature                          | Wraps                                                              |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `Intl/formatNumber`       | `(value, locale?, options?)`       | `new Intl.NumberFormat(locale, options).format(value)`             |
| `Intl/formatDate`         | `(value, locale?, options?)`       | `new Intl.DateTimeFormat(locale, options).format(new Date(value))` |
| `Intl/formatRelativeTime` | `(value, unit, locale?, options?)` | `new Intl.RelativeTimeFormat(locale, options).format(value, unit)` |

The interpreter dispatches these through a helpers table (`BLESSED_HELPERS`); the compiler emits the equivalent inline construct-then-format expression. An `options` argument is a plain-object literal operand (§19.2):

```json
{
  "operator": "call",
  "target": { "$ref": "window#/Intl/formatNumber" },
  "value": [{ "$ref": "#/state/price" }, "en-US", { "style": "currency", "currency": "USD" }]
}
```

**Semantics and lowering.** Project-global formulas live in `project.json` `state` and reach every page through the standard project-state merge — there is no separate formulas section. `buildScope` lowers a named formula to a scope callable that maps positional arguments onto parameter names; call sites therefore compile to plain positional calls (`state.lineTotal(3, 4)`), identical in the interpreter and every compiled target. `call` chains are bounded by `MAX_CALL_DEPTH` (64) against unbounded recursion; the compiler must additionally reject statically detectable call cycles. Reads inside a formula body are tracked reactively as usual — a computed that calls a formula recomputes when the formula's inputs change.

### 19.4d Pure Standard-Library Method Operators

The method-operator table extends to genuine **pure** `String.prototype`, `Array.prototype`, and `Number.prototype` methods — the receiver in `target` (any operand, including a derived value), the argument in `value` (bare scalar) or argument list (array, the `splice` precedent). Where the standard library's original method mutates, the ES2023 change-by-copy name stands in — `toSorted` not `sort`, `toReversed` not `reverse`, `toSpliced`/`with` not `splice`/index assignment — so every operator in this table remains pure. No token is invented.

| Prototype | Operators                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Array     | `includes` `indexOf` `lastIndexOf` `join` `slice` `concat` `at` `flat` `toSorted` `toReversed` `toSpliced` `with`                                                                                                         |
| String    | `toUpperCase` `toLowerCase` `trim` `trimStart` `trimEnd` `split` `startsWith` `endsWith` `padStart` `padEnd` `replaceAll` `repeat` `charAt` `normalize` `toLocaleUpperCase` `toLocaleLowerCase` (plus the Array homonyms) |
| Number    | `toFixed` `toPrecision` `toLocaleString`                                                                                                                                                                                  |

```json
{ "operator": "toUpperCase", "target": { "$ref": "#/state/name" } }
{ "operator": "includes",    "target": { "$ref": "#/state/tags" }, "value": "featured" }
{ "operator": "toSorted",    "target": { "$ref": "#/state/scores" } }
{ "operator": "padStart",    "target": { "$ref": "#/state/code" }, "value": [6, "0"] }
```

Evaluation is null-safe, matching path reads: a missing receiver or a method absent from the receiver's type yields `undefined` rather than throwing (compiled form: `(receiver)?.method?.(args)`). Aggregates (§19.4a) likewise accept a derived array as `target` — `join(map(split(name, " "), …), "")` composes without intermediate state entries.

### 19.5 The `event#` Reference Scheme

Handlers receive `(state, event)` (§4.3). To allow `$expression` handlers to read event data without escalating to a `body` string, the reference system (§7.2) is extended with one scheme:

| Scheme        | Example                 | Resolves to                          |
| ------------- | ----------------------- | ------------------------------------ |
| Event context | `"event#/target/value"` | A property path on the handler event |

`event#` is resolvable only within an expression node used as an event handler. Referencing it from a `state`-entry expression that is not invoked as a handler is a compile-time error. It is inserted into the §7.4 resolution order immediately below `$map/`:

```
1. $map/       — iteration context
2. $reduce/acc — fold accumulator (reduce per-item expression only)
3. $args/      — named-formula parameters (callable body only, §19.4c)
4. event#/     — handler event context (handler position only)
5. #/state/    — current component scope
6. parent#/    — explicitly passed props
7. window#/    — global window properties
8. document#/  — global document properties
```

Example — an input handler with no `body` string:

```json
{
  "tagName": "input",
  "attributes": { "placeholder": "Item name" },
  "oninput": {
    "$expression": {
      "operator": "=",
      "target": { "$ref": "#/state/name" },
      "value": { "$ref": "event#/target/value" }
    }
  }
}
```

### 19.6 Placement

`$expression` is valid in two positions:

1. **As a `state` entry** (a named, reusable operation — Shape 5, §19.7):

   ```json
   {
     "state": {
       "toggleTheme": {
         "$expression": {
           "operator": "=",
           "target": { "$ref": "#/state/darkMode" },
           "value": {
             "operator": "!",
             "target": { "$ref": "#/state/darkMode" }
           }
         }
       }
     }
   }
   ```

2. **Inline as an event handler value** on any element, in place of a `$ref` to a function:

   ```json
   {
     "tagName": "button",
     "textContent": "Toggle",
     "onclick": {
       "$expression": {
         "operator": "=",
         "target": { "$ref": "#/state/darkMode" },
         "value": { "operator": "!", "target": { "$ref": "#/state/darkMode" } }
       }
     }
   }
   ```

A named `state` expression may be bound to multiple elements via `$ref` (`"onclick": { "$ref": "#/state/toggleTheme" }`), exactly as a Function entry is. Prefer the named form when reused; prefer the inline form for single-use handlers (cf. §6.5).

A **pure** expression (§19.1) used as a `state` entry is a computed value — it is read via `$ref` or `${}` like any Shape 3 computed (`"textContent": { "$ref": "#/state/total" }`). A **mutating** expression used as a `state` entry is a handler, bound to events. The mode follows from the operator; it is not declared.

### 19.7 Shape Detection (amends §5.7)

A new branch is inserted **before** the `$prototype` check, since the entry is identified by its own reserved key:

```
For each entry in state:

1. Value is a string containing "${"?
   → Shape 3: Computed (computed())

2. Value is a string, number, boolean, null, or array?
   → Shape 1: Naked value (reactive property)

3. Value is an object with "$expression"?
   → Shape 5: Expression (declarative operation; mutating → handler, pure → computed)

4. Value is an object with "$prototype"?
   → Shape 4: Prototype (function, data source, or external class)

5. Value is an object with "default" (no "$prototype")?
   → Shape 2: Typed value (reactive property with type metadata)

6. Value is a plain object (no reserved keys)?
   → Shape 1: Object value (reactive property)
```

### 19.8 Compilation

An `$expression` lowers to the **same target** as the equivalent `body` string (§4.3, §5.5): a function over the `state` reactive proxy. The difference is that the function is _constructed from structure_ rather than parsed from a source string, so it is fully analyzable before emission and never requires `eval`/`new Function`.

The toggle expression:

```json
{
  "operator": "=",
  "target": { "$ref": "#/state/darkMode" },
  "value": { "operator": "!", "target": { "$ref": "#/state/darkMode" } }
}
```

compiles to the equivalent of:

```js
(state, event) => {
  state.darkMode = !state.darkMode;
};
```

Reactivity is identical to a hand-written handler — Vue tracks the reads and writes on the `state` proxy. Array-mutation operators compile to in-place mutations (`state.cart.push(...)`), which Vue tracks per §5.5.

A **pure** expression (§19.1) lowers instead to a `computed()` (the same target as a Shape 3 template, §5.3), since it returns a value and mutates nothing. The cart-total `reduce` compiles to the equivalent of:

```js
computed(() => state.cart.reduce((acc, item) => acc + item.price * item.qty, 0));
```

The per-item expression node becomes the callback body, with `$reduce/acc` bound to the accumulator parameter and `$map/item` / `$map/index` to the element and index. Because the source array is read inside the `computed`, Vue tracks it — the total recomputes whenever the cart or any line's `price`/`qty` changes. As with handlers, the callback is _constructed from the node tree_, never parsed from a string, so it stays analyzable and the visual builder can render each node as an editable form control.

Conditional nodes compile to their ECMAScript equivalents: `?:` to a parenthesized ternary, `??` to a parenthesized binary, and `switch` to a strict-equality chain over the discriminant's string form, bound once (`((_d) => _d === "loading" ? … : _default)(String(…))`).

### 19.9 Editor Evaluation Trace

The interpreter accepts an optional **trace** — a `report(path, value)` callback — so a visual editor can badge every node of an expression with its live value against real component state.

- Every node and `$ref`/nested operand reports its evaluated value, keyed by its path within the expression tree (`["value", "target"]` etc.).
- Branch-selecting operators (`?:`, `switch`) evaluate **all** branches under trace — the untaken branches' values are reported, then the semantically correct result is returned. (`&&`/`\|\|`/`??` already evaluate both operands eagerly; purity makes this observationally equivalent.)
- Aggregates report a **first-iteration sample** of their per-item expression rather than one report per element.
- Because branch-forcing removes natural exit conditions, reporting stops beyond `MAX_REPORT_DEPTH` (64); evaluation itself continues untraced.
- The trace is interpreter-only. Compiled output (§19.8) is never affected, and evaluation without a trace takes the untouched production path — including branch short-circuiting.

---

## 20. Structured Function Bodies (Statements)

### 20.1 Motivation

§19 removed the `body`-string escape hatch for single operations; multi-step side effects (mutate, branch, notify) still required opaque JavaScript. A Function entry's `body` may now be a **JSON array of statements** instead of a source string — explicit structured function declaration, analyzable by tooling and editable visually. This mirrors ESTree exactly: a function body is `Statement[]`. No new keyword, no new entry kind — the escalation ladder _within_ Shape 4 becomes structured statements → JS string.

```json
{
  "state": {
    "addToCart": {
      "$prototype": "Function",
      "parameters": ["item"],
      "emits": [{ "name": "cart-changed" }],
      "body": [
        {
          "operator": "push",
          "target": { "$ref": "#/state/cart" },
          "value": { "$ref": "$args/item" }
        },
        {
          "if": { "operator": ">", "target": { "$ref": "#/state/cart/length" }, "value": 10 },
          "then": [{ "dispatchEvent": "cart-full" }],
          "else": [{ "operator": "call", "target": { "$ref": "#/state/refreshTotals" } }]
        },
        {
          "dispatchEvent": "cart-changed",
          "detail": { "$ref": "#/state/cart" },
          "bubbles": true,
          "composed": true
        }
      ]
    }
  }
}
```

### 20.2 Statement Kinds

Every statement kind reuses a web-platform name — §19.4's law extended to statement position:

| Kind       | Shape                                                | Source of the name                           |
| ---------- | ---------------------------------------------------- | -------------------------------------------- |
| Expression | a bare §19 expression node (mutation or `call`)      | ECMAScript ExpressionStatement               |
| Branch     | `{ if, then, else? }` — statement lists in then/else | JSON Schema 2020-12 conditional keywords     |
| Multiway   | `{ $switch, cases, default? }` — statement lists     | Element-level `$switch` (§14), ECMA switch   |
| Dispatch   | `{ dispatchEvent, detail?, bubbles?, composed? }`    | WHATWG DOM `dispatchEvent`/`CustomEventInit` |

- The branch `if` and the `$switch` discriminant hold **pure** operands; `$switch` matches by string form, exactly like §19.4b.
- **Result capture** composes — an assignment statement whose `value` is a `call` node — so no dedicated capture field exists.
- `dispatchEvent` dispatches from the handler's `event.currentTarget` (interpreter and client islands) or the component instance (compiled custom elements); the entry's `emits` (CEM) remains the declaration the editor autocompletes from.
- Statements execute sequentially; a statement whose value is a thenable is awaited before the next (ECMA async/await semantics).

### 20.3 Lowering

`body: Statement[]` follows the named-formula pattern (§19.4c): without `parameters` the entry lowers to an event handler `(state, event)`; with `parameters` it lowers to a positional callable whose arguments bind to `$args/` names. The engine is `runStatements` (interpreter) + `compileStatements` (JS emitter) — one module, both halves, mirroring §19.8: `if`/`else` and `switch` emit their genuine ECMAScript statement forms, and dispatch emits `dispatchEvent(new CustomEvent(type, init))`. Inline event bindings accept structured bodies through the existing Function binding form — `JxEventBinding` is unchanged.

---

## Appendix A — Minimal Complete Example

```json
{
  "$schema": "https://jxsuite.com/schema/v1",
  "$id": "TodoApp",

  "$defs": {
    "TodoItem": {
      "type": "object",
      "properties": {
        "id": { "type": "integer" },
        "text": { "type": "string" },
        "done": { "type": "boolean" }
      },
      "required": ["id", "text", "done"]
    }
  },

  "state": {
    "items": {
      "type": { "type": "array", "items": { "$ref": "#/$defs/TodoItem" } },
      "default": [{ "id": 1, "text": "Learn Jx", "done": false }]
    },
    "remaining": "${state.items.filter(i => !i.done).length}",
    "total": "${state.items.length}",
    "summary": "${state.remaining} of ${state.total} remaining",
    "addItem": {
      "$prototype": "Function",
      "body": "state.items.push({ id: Date.now(), text: 'New item', done: false })"
    },
    "toggleItem": {
      "$prototype": "Function",
      "arguments": ["id"],
      "body": "const item = state.items.find(i => i.id === id); if (item) item.done = !item.done"
    },
    "clearDone": {
      "$prototype": "Function",
      "body": "state.items.splice(0, state.items.length, ...state.items.filter(i => !i.done))"
    }
  },

  "tagName": "todo-app",
  "style": {
    "fontFamily": "system-ui",
    "maxWidth": "480px",
    "margin": "2rem auto"
  },

  "children": [
    { "tagName": "h1", "textContent": "${state.summary}" },
    {
      "tagName": "div",
      "style": { "display": "flex", "gap": "0.5rem", "marginBottom": "1rem" },
      "children": [
        {
          "tagName": "button",
          "textContent": "Add item",
          "onclick": { "$ref": "#/state/addItem" }
        },
        {
          "tagName": "button",
          "textContent": "Clear done",
          "onclick": { "$ref": "#/state/clearDone" }
        }
      ]
    },
    {
      "tagName": "ul",
      "children": {
        "$prototype": "Array",
        "items": { "$ref": "#/state/items" },
        "map": {
          "tagName": "li",
          "style": {
            "textDecoration": "${$map.item.done ? 'line-through' : 'none'}",
            "opacity": "${$map.item.done ? '0.5' : '1'}"
          },
          "textContent": "${$map.item.text}",
          "onclick": { "$ref": "#/state/toggleItem" }
        }
      }
    }
  ]
}
```

---

## Appendix B — Dependency Stack

| Package           | Version | Purpose                                                |
| ----------------- | ------- | ------------------------------------------------------ |
| `@vue/reactivity` | `^3.5`  | Reactive primitives (`reactive`, `computed`, `effect`) |

---

## Appendix C — Cart Example (Declarative Handlers)

This rewrites the mutating handlers of Appendix A's idiom using `$expression`, leaving only genuinely complex logic as `body`.

```json
{
  "$schema": "https://jxsuite.com/schema/v1",
  "$id": "Cart",

  "$defs": {
    "CartLine": {
      "type": "object",
      "properties": {
        "id": { "type": "integer" },
        "name": { "type": "string" },
        "price": { "type": "number", "minimum": 0 },
        "qty": { "type": "integer", "minimum": 1 }
      },
      "required": ["id", "name", "price", "qty"]
    }
  },

  "state": {
    "cart": {
      "type": { "type": "array", "items": { "$ref": "#/$defs/CartLine" } },
      "default": []
    },
    "draftName": "",
    "count": "${state.cart.length}",

    "total": {
      "$expression": {
        "operator": "reduce",
        "target": { "$ref": "#/state/cart" },
        "initial": 0,
        "value": {
          "operator": "+",
          "target": { "$ref": "$reduce/acc" },
          "value": {
            "operator": "*",
            "target": { "$ref": "$map/item/price" },
            "value": { "$ref": "$map/item/qty" }
          }
        }
      }
    },

    "setDraft": {
      "$expression": {
        "operator": "=",
        "target": { "$ref": "#/state/draftName" },
        "value": { "$ref": "event#/target/value" }
      }
    },

    "clearCart": {
      "$expression": {
        "operator": "splice",
        "target": { "$ref": "#/state/cart" },
        "value": [0, { "$ref": "#/state/count" }]
      }
    }
  },

  "tagName": "shopping-cart",

  "children": [
    {
      "tagName": "h2",
      "textContent": "${state.count} items — $${state.total}"
    },
    {
      "tagName": "input",
      "attributes": { "placeholder": "Item name" },
      "oninput": { "$ref": "#/state/setDraft" }
    },
    {
      "tagName": "button",
      "textContent": "Clear",
      "onclick": { "$ref": "#/state/clearCart" }
    },
    {
      "tagName": "ul",
      "children": {
        "$prototype": "Array",
        "items": { "$ref": "#/state/cart" },
        "map": {
          "tagName": "li",
          "children": [
            "${$map.item.name} ×${$map.item.qty} ",
            {
              "tagName": "button",
              "textContent": "+",
              "onclick": {
                "$expression": {
                  "operator": "+=",
                  "target": { "$ref": "$map/item/qty" },
                  "value": 1
                }
              }
            },
            {
              "tagName": "button",
              "textContent": "remove",
              "onclick": {
                "$expression": {
                  "operator": "splice",
                  "target": { "$ref": "#/state/cart" },
                  "value": [{ "$ref": "$map/index" }, 1]
                }
              }
            }
          ]
        }
      }
    }
  ]
}
```

---

_Jx Specification v2.1.0-draft — subject to revision_
