# Jx Specification

## Declarative Document Object Model — JSON Edition

**Version:** 2.0.0-draft
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

| Field      | Required    | Description                                                                                |
| ---------- | ----------- | ------------------------------------------------------------------------------------------ |
| `$schema`  | Recommended | URI identifying the Jx dialect version                                                     |
| `$id`      | Recommended | Component identifier, used by tooling                                                      |
| `$defs`    | Optional    | Pure JSON Schema type definitions — tooling only, no runtime artifacts                     |
| `state`    | Optional    | Reactive state: signals, computed values, functions, and data sources                      |
| `tagName`  | Required    | HTML tag name for the root element                                                         |
| `children` | Optional    | Array of child element definitions and/or text nodes (strings/numbers), or Array namespace |

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
    { "tagName": "button", "textContent": "+", "onclick": { "$ref": "#/state/increment" } }
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
    "Status": { "type": "string", "enum": ["idle", "loading", "success", "error"] },
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
      "type": { "type": "string", "enum": ["idle", "loading", "success", "error"] },
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

| Property      | Required     | Description                                                            |
| ------------- | ------------ | ---------------------------------------------------------------------- |
| `$prototype`  | Yes          | Must be `"Function"`                                                   |
| `body`        | If no `$src` | Raw function body string                                               |
| `arguments`   | No           | Array of parameter name strings. Default: `[]`                         |
| `parameters`  | No           | Array of CEM-compatible parameter objects (alternative to `arguments`) |
| `name`        | No           | Explicit function name. Default: the `state` key name                  |
| `$src`        | If no `body` | External module specifier                                              |
| `$export`     | No           | Named export in `$src` module. Default: `state` key name               |
| `description` | No           | Documentation string                                                   |
| `emits`       | No           | Array of CEM `Event` objects this function dispatches                  |

`body` and `$src` are mutually exclusive. Declaring both is a compile-time error.

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

> **Status: Pending.** Private state convention is defined but not yet enforced in the runtime or studio.

### 5.7 Shape Detection Algorithm

```
For each entry in state:

1. Value is a string containing "${"?
   → Shape 3: Computed (computed())

2. Value is a string, number, boolean, null, or array?
   → Shape 1: Naked value (reactive property)

3. Value is an object with "$prototype"?
   → Shape 4: Prototype (function, data source, or external class)

4. Value is an object with "default" (no "$prototype")?
   → Shape 2: Typed value (reactive property with type metadata)

5. Value is a plain object (no reserved keys)?
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

1. `$map/` prefix — iteration context (highest priority)
2. `#/state/` — current component scope
3. `parent#/` — explicitly passed props
4. `window#/` — global window properties
5. `document#/` — global document properties

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

> **Status: Implemented.** Runtime `applyStyle` handles nested selectors, media breakpoints, and scoped style generation.

---

## 10. Dynamic Mapped Arrays

### 10.1 Array Namespace Syntax

Dynamic lists are declared by setting `children` to an object with `$prototype: "Array"`:

```json
{
  "tagName": "ul",
  "children": {
    "$prototype": "Array",
    "items": { "$ref": "#/state/todoList" },
    "map": {
      "tagName": "li",
      "textContent": { "$ref": "$map/item" }
    }
  }
}
```

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

> **Status: Implemented.** Runtime `renderMappedArray()` handles items, filter, sort, `$map/item`, and `$map/index`.

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
| `"compiler"` | Resolved at build time; result baked into emitted HTML | **Pending**     |

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
    }
  },
  "$implementation": "./weather.js"
}
```

When `$src` points to a `.class.json` file, the runtime reads the schema and follows `$implementation` to instantiate the class from the JS module. If no `$implementation` is present, the runtime dynamically constructs a class from the schema definition (self-contained mode).

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
    "forecast": { "$prototype": "WeatherForecast", "location": "Lancaster, PA", "days": 5 },
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

> **Status: Implemented.** Runtime `renderSwitch()` handles reactive case switching.

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
| `parameters`         | CEM-compatible function parameter objects                         |
| `name`               | Inline function explicit name                                     |
| `description`        | Documentation string                                              |
| `observedAttributes` | HTML attributes the custom element watches                        |
| `onMount`            | Lifecycle: connected and rendered                                 |
| `onUnmount`          | Lifecycle: disconnected                                           |
| `onAdopted`          | Lifecycle: adopted into new document                              |

---

## 18. Standards Alignment

| Feature                | Standard                        |
| ---------------------- | ------------------------------- |
| `$ref`, `$defs`, `$id` | JSON Schema 2020-12             |
| JSON Pointer paths     | RFC 6901                        |
| Reactivity             | `@vue/reactivity` (Vue 3)       |
| Custom elements        | Web Components v1               |
| Style properties       | CSSOM camelCase                 |
| Media breakpoints      | CSS `@custom-media` convention  |
| Module loading         | ECMAScript Modules / `import()` |

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
  "style": { "fontFamily": "system-ui", "maxWidth": "480px", "margin": "2rem auto" },

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

_Jx Specification v2.0.0-draft — subject to revision_
