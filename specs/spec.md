# Jx Specification

## Declarative Document Object Model — JSON Edition

**Version:** 0.4.33-draft **Status:** Partial **Updated:** 2026-08-16 **License:** MIT

---

## Table of Contents

1.  [Overview](#1-overview)
2.  [Philosophy](#2-philosophy)
3.  [Document Format](#3-document-format)
4.  [The Component Model](#4-the-component-model)
5.  [The `$defs` and `state` Grammar](#5-the-defs-and-state-grammar)
6.  [Universal Reactivity](#6-universal-reactivity)
7.  [Reference System](#7-reference-system)
8.  [Element Definitions](#8-element-definitions)
9.  [Styling](#9-styling)
10. [Dynamic Mapped Arrays](#10-dynamic-mapped-arrays)
11. [Web API Namespaces](#11-web-api-namespaces)
12. [External Class Integration](#12-external-class-integration)
13. [Component Encapsulation](#13-component-encapsulation)
14. [Dynamic Component Switching](#14-dynamic-component-switching)
15. [Scope Rules](#15-scope-rules)
16. [Custom Element Definitions](#16-custom-element-definitions)
17. [Reserved Keywords](#17-reserved-keywords)
18. [Standards Alignment](#18-standards-alignment)
19. [Declarative Expressions](#19-declarative-expressions-expression)
20. [Structured Function Bodies](#20-structured-function-bodies-statements)
21. [Evaluation Surface](#21-evaluation-surface)

---

## 1\. Overview

Jx is a schema and runtime for building reactive web applications using plain JSON. A Jx application is a tree of JSON objects whose structure mirrors the DOM API, whose reactivity is powered by `@vue/reactivity`, and whose behavior is declared in `state` entries as inline functions or external module references.

The core premise: **structure and state are data; the shape of each `state` entry determines its type and behavior — no additional flags required in the common case.**

A Jx component is a single `.json` file that can be fully self-describing:

```
component.json   ← structure, styling, state declarations, functions, bindings
```

When handler functions grow complex, they may be extracted to an external `.js` sidecar referenced via `$src` on individual `$prototype: "Function"` entries. This is optional — simple components need no sidecar.

The JSON file is fully serializable, statically analyzable, and visual-builder-friendly.

---

## 2\. Philosophy

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

### 2.5 Platform Precedents

Where a web platform standard exists, Jx follows it. This section is the design principle; the machine-checked register of what Jx actually claims about each standard is §18.

| Jx Feature                         | Platform Precedent                                           |
| ---------------------------------- | ------------------------------------------------------------ |
| $ref path syntax                   | JSON Pointer (RFC 6901) shape; Jx binding semantics (see §7) |
| $defs for type definitions         | JSON Schema 2020-12                                          |
| Signal scope at component boundary | CSS Custom Properties scope                                  |
| Explicit props at element boundary | HTML attributes on Custom Elements                           |
| .json / .js file pairs             | HTML / JS, CSS Modules / JS                                  |
| $prototype namespaces              | Named after Web API constructors (semantics are Jx-specific) |

Jx borrows the **shape** of these standards. Where the semantics diverge — `$ref` binds live state rather than substituting schemas, `$prototype: "Request"` auto-fetches rather than describing an inert request — the spec says so explicitly rather than implying full conformance.

---

## 3\. Document Format

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

| Field    | Required    | Description                                                                                                                                                                                                     |
| -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| $schema  | Recommended | URI identifying the Jx dialect version                                                                                                                                                                          |
| $id      | Recommended | Component identifier, used by tooling                                                                                                                                                                           |
| $defs    | Optional    | Pure JSON Schema type definitions — tooling only, no runtime artifacts                                                                                                                                          |
| state    | Optional    | Reactive state: signals, computed values, functions, and data sources                                                                                                                                           |
| tagName  | Required    | HTML tag name for the root element                                                                                                                                                                              |
| children | Optional    | Array of child element definitions, text nodes (strings/numbers), and/or Array namespaces (repeaters) mixed freely. A bare Array namespace (the whole children slot is one repeater) is also accepted. See §10. |

### 3.2 Schema-Backed Documents

Jx ships a real JSON Schema 2020-12 meta-schema (generated from W3C webref data). A Jx document is validated **as an instance** against that meta-schema by any 2020-12-compatible validator — this is what powers editor autocomplete, hover docs, and CI validation. The `$schema` URI in a document points editors at the meta-schema for that document (the VS Code "schema for this instance" convention); it is a tooling pointer, not a dialect declaration.

> **Status: Implemented.** `packages/schema` generates the meta-schema and exposes `validateDocument` (ajv 2020). Two honesty notes: Jx is **not** a JSON Schema _dialect_ in the normative sense — it declares no `$vocabulary`, so a validator cannot process a Jx document as a _schema_. And the reserved Jx keywords below are not JSON Schema vocabulary; a standards-only processor ignores them.

Jx layers the following reserved keywords on top of the JSON object model: `$prototype`, `$props`, `$switch`, `$map`, `$src`, `$export`, `timing`, `default`, `body`, `arguments`, `name`. (`default` is a standard JSON Schema annotation keyword that Jx repurposes as the Shape-2 discriminator — see §5.)

Standard JSON Schema 2020-12 keywords (`type`, `format`, `properties`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `required`, `description`, `examples`, etc.) are genuine 2020-12 and are valid on `$defs` type definitions. Note that a Shape-2 `state` entry may reference a def with `"type": { "$ref": "#/$defs/…" }`, which is a Jx convenience, not valid JSON Schema (there `type` must be a string).

---

## 4\. The Component Model

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

## 5\. The `$defs` and `state` Grammar

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

| format value | Underlying type | Studio control                          |
| ------------ | --------------- | --------------------------------------- |
| "image"      | string          | Media picker (file browser + thumbnail) |
| "date"       | string          | Date input (YYYY-MM-DD)                 |
| "color"      | string          | Color picker                            |

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

**Emitted as:** `computed(() => \`...template...\`)\`

**Rules:**

- Dependencies are tracked automatically by Vue when `state.*` properties are read during evaluation
- The string must be a pure expression — no statements, no assignments, no semicolons
- `return` is never written — the expression value is the signal value
- `state` refers exclusively to the current component's reactive scope

> **Status: Implemented.** Runtime compiles template strings via ` new Function("state", "$map", `` ` return \`${str}\` ` ``) `.

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

A body counts as returning a value only when something follows `return` on the same line. A bare `return;` is an early-exit guard, so a handler that begins `if (!x) return;` stays a handler; a newline after `return` is an ASI bare return and counts the same way.

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

| Property    | Required   | Description                                                                                                   |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| $prototype  | Yes        | Must be "Function"                                                                                            |
| body        | If no $src | Function body: raw JS source string, or a structured statement array (§20)                                    |
| arguments   | No         | Array of parameter name strings. Default: []                                                                  |
| parameters  | No         | Array of parameter entries — bare string names or CEM-compatible parameter objects (alternative to arguments) |
| type        | No         | Return type for tooling — JSON Schema or CEM { text } format                                                  |
| name        | No         | Explicit function name. Default: the state key name                                                           |
| $src        | If no body | External module specifier                                                                                     |
| $export     | No         | Named export in $src module. Default: state key name                                                          |
| description | No         | Documentation string                                                                                          |
| emits       | No         | Array of CEM Event objects this function dispatches                                                           |

`body` and `$src` are mutually exclusive. Declaring both is a compile-time error.

`parameters` entries may be bare string names (`["item"]`, as in §20.1's example), CEM-compatible parameter objects (`{ "name": "id", "type": { "text": "number" }, "default": 1 }`), or a mix — the schema and runtime accept both forms, and the runtime normalizes every entry to its name. Prefer objects when tooling metadata (types, defaults, descriptions) matters; bare names suffice otherwise.

**Parameter binding at event call sites.** An event binding always invokes a handler with `(state, event)`. Declared names bind to those arguments **by name, not by position**: a parameter literally named `state` receives the reactive state, and any other name receives the event. So `["event"]`, `["state", "event"]` and `["state"]` all bind what they read, and a handler body may reference `state` regardless of whether it declared that parameter. This applies to both `state`\-entry handlers and handlers defined inline on an `on*` property, in the interpreter and in every compiled target alike.

**Classifying an external Function.** Because `body` and `$src` are mutually exclusive, a `$src` entry has no body for the framework to inspect, so its role follows how the document uses it. An entry referenced as a **callable** — bound to an `on*` event, invoked by an `$expression` `call` node (§19.4c), called as `state.key(…)` from a template or another body, or named as a lifecycle hook (§16.4) — stays a function. Otherwise its return value is read reactively and the entry is a computed value, matching the inline-body rule in 4b. Reading a `$src` entry that resolves to a function (rather than its result) is therefore not a supported way to obtain the imported function itself.

**Compiled-site delivery.** In compiled sites, bundleable `$src` specifiers — `npm:<pkg>[/subpath]` and project-relative `./…` files (TypeScript included) — are bundled per the entry's `timing`. Client-timing functions compile to self-contained ESM bundles under `/assets/` with deterministic, hash-free names (relative specifiers key on their project-relative path); emitted page and element modules import the bundle URL instead of the raw specifier, so external libraries work on purely static hosts with no `node_modules/` at runtime. `timing: "compiler"` functions are never bundled — they execute in the build host. Absolute URL specifiers (`/lib/x.js`, `https://…`) are emitted verbatim and served as-is. Server-timing functions are imported by the generated server output — the site worker when `build.adapter` is set, a per-page `_server.js` handler otherwise (compiler.md §6). The bundler backend is `Bun.build` under Bun and esbuild under Node (see compiler.md).

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

> **Status: Partial.** The studio enforces the convention: `#` entries are excluded from the editable prop list (`componentPropEntries`) and skipped during CEM extraction (`cem-export`), so they never surface in the property panel or the exported manifest. The runtime does not yet enforce it — `#` entries build into scope like any other state entry, and a `$props` write against a `#` name is not blocked.

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

## 6\. Universal Reactivity

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

| Pattern                     | Use when                                                  |
| --------------------------- | --------------------------------------------------------- |
| { "$ref": "#/state/label" } | Binding to a named signal — referenced in multiple places |
| "${state.count} items"      | Inline computed binding used in exactly one place         |

Prefer `${}` for single-use reactive bindings. Prefer `$ref` for reused or named signals.

### 6.6 Scope

Template strings resolve `state.propertyName` against the current component's reactive proxy, plus the iteration bindings (`$map`, `item`, `index`) where an Array map provides them.

> **Status: Implemented.** The interpreting runtime compiles each `${…}` with `new Function` and wraps it in an `effect()`. **Honesty note:** this is full JavaScript, not a sandbox — `state` is in scope, but so is the entire global environment, and a template _can_ assign or call side effects (`"${state.count = 1}"` runs). The "access only to `state`" wording is therefore an authoring convention, not an enforced boundary. The compiler emits no `new Function` (templates are spliced verbatim into generated modules — §21); the eval requirement applies only to the interpreting runtime (dev server, Studio canvas, `@jxsuite/runtime` as a library), which consequently needs CSP `'unsafe-eval'`.

> **Status: Future.** A restricted template evaluator (reusing the `$expression` operator allowlist, §19) would make the `state`\-only scope a real boundary and remove the interpreter's `unsafe-eval` requirement. Not yet built.

---

## 7\. Reference System

### 7.1 `$ref` Syntax

Jx uses `$ref` to bind a property to declared state. The path **borrows JSON Pointer syntax** (RFC 6901 shape — a `#`\-fragment of `/`\-separated tokens):

```json
{ "$ref": "#/state/count" }
```

The **semantics are Jx-specific**, not JSON Reference: a Jx `$ref` reads a live value off the reactive scope, it does not substitute a schema. Two consequences follow. RFC 6901 escape sequences (`~0`, `~1`) are **not implemented** — a key containing `/` or `~` is unreachable. And within a **nested** path (the segments after the first) `.` works as a separator alongside `/`, so `#/state/user/name` walks into `state.user.name`; the leading token is read literally, so `#/state/user.name` reads the key `"user.name"`, not `state.user.name`. The schemes below (`window#/`, `parent#/`, `$map/`, `event#/`, …) are Jx extensions, not JSON Reference URIs.

### 7.2 Reference Schemes

| Scheme          | Example               | Resolves to                                                                                                                               |
| --------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Internal state  | "#/state/count"       | Signal or handler in current component's state                                                                                            |
| Window global   | "window#/currentUser" | window.currentUser                                                                                                                        |
| Document global | "document#/appConfig" | document.appConfig                                                                                                                        |
| Parent scope    | "parent#/sharedState" | Named signal passed via $props                                                                                                            |
| Map context     | "$map/item"           | Current item in an Array map iteration                                                                                                    |
| Map index       | "$map/index"          | Current index in an Array map iteration                                                                                                   |
| External file   | "./other.json"        | A component document — resolved for $switch cases and $elements registration (§14, §16), not as a node-level component instance (see §13) |

### 7.3 Reactive Bindings

When a `$ref` resolves to a reactive state property or computed, the binding is reactive — the DOM property updates automatically whenever the value changes:

```json
{
  "tagName": "p",
  "textContent": { "$ref": "#/state/count" }
}
```

### 7.4 `$ref` Resolution

Resolution is **scheme dispatch**, not a cascading fallback: the leading token selects exactly one source. A `#/state/…` ref that misses yields no value and does **not** fall through to `window`/`document` (an explicit-scheme miss reads as `undefined`; only a bare, schemeless ref falls back to `null`). Those globals are reachable only via an explicit `window#/` or `document#/` ref. Context schemes are only valid in the position that provides them:

- `$map/`, `$reduce/acc` — iteration / fold context (mapped-array and reduce expressions)
- `$args/` — named-formula parameters (callable body only, §19.4c)
- `event#/` — handler event context (handler position only)
- `#/state/` — the current component's scope (which already includes `$props`, merged in place — see §15.4)
- `parent#/` — resolves against the same merged scope as a bare state read
- `window#/` / `document#/` — the corresponding global object

> **Status: Implemented** for `$map/`, `$reduce/`, `$args/`, `event#/`, `#/state/`, `window#/`, `document#/` in `resolveRef`. **Partial** for node-level external-file refs: `$switch` cases and `$elements` entries are fetched and resolved (§14, §16), but a bare `{ "$ref": "./x.json" }` child is **not** — see §13.

---

## 8\. Element Definitions

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

The entire `children` value may be a `${…}` template string that resolves **at site-build time** to an array of child definitions. This is the mechanism for injecting parsed content (e.g. a content entry's `$children` from `@jxsuite/parser`) into a wrapper element:

```json
{ "tagName": "bl-prose", "children": "${state.entry.$children}" }
```

The compiler's template pass replaces `children` with the resolved array and recurses into it. Scope of the feature: the template must resolve to an array during the site build (e.g. from `$paths`\-bound state or a compiler-timing prototype). A computed-children string is **not** re-evaluated at runtime — runtime-reactive content swapping is not supported through this form — and a plain non-template string is not a valid `children` value at all (text children must be array items, per above).

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

- Both are plain strings (not reactive, not `$ref`\-resolvable)
- Neither is applied to the DOM or compiled to HTML output
- `$title` provides a human-friendly label for tooling (e.g., Jx Studio layers panel)
- `$description` provides extended documentation for the element's purpose
- In markdown remark directives, these map to `--title` and `--description` attributes

> **Status: Implemented.** Runtime RESERVED\_KEYS includes both; schema validates them on ElementDef.

---

## 9\. Styling

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

Inline properties are applied directly to the element. Nested rules are emitted as a scoped `<style>` block keyed on a **generated class** — `.<tagName>-<n>`, assigned to the element in the compiled HTML. (`data-jx-static` and `data-jx-prerendered` exist on emitted elements but are hydration markers, never CSS selectors.)

Nesting is **recursive**: selector groups and at-rule groups (`@`\-prefixed keys — named breakpoints per §9.4, or standard at-rules like `@starting-style`) may nest to arbitrary depth, e.g. breakpoint → selector → pseudo-class:

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

Both the compiler and the runtime resolve nesting recursively; the component and project style schemas model the same recursive contract. (Known compiler limitation: inside an at-rule group, only one selector level is currently emitted — at-rule → selector → pseudo is accepted by the schema and runtime but not yet fully emitted by the static compiler.)

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

A `$media` entry whose value is a _pure_ `prefers-color-scheme` query — exactly `(prefers-color-scheme: light)` or `(prefers-color-scheme: dark)`, no other conditions — is a **scheme query**. Scheme queries participate in the forced-scheme contract defined in §9.5.

> **Status: Implemented.** Runtime `applyStyle` handles nested selectors, media breakpoints, and scoped style generation.

### 9.5 Color-Scheme Variants and Forced Schemes

Declaring a scheme query in `$media` opts a document (or site) into the color-scheme contract. Two normative constants define the visitor-facing override mechanism:

- **`data-color-scheme`** — attribute on the root element (`<html>`). Value `"light"` or `"dark"` forces that scheme; an absent attribute means _auto_ (follow the OS `prefers-color-scheme`).
- **`jx-color-scheme`** — `localStorage` key a site switcher persists the visitor's forced scheme under. Values `"light"` or `"dark"`; absent means auto.

**Dual emission.** Every style block keyed by a scheme query (`@--dark { … }` or a literal `@(prefers-color-scheme: …) { … }`) is emitted twice:

1.  a media-guarded copy that applies only while no scheme is forced — root-level rules are guarded as `:root:where(:not([data-color-scheme]))`, scoped rules as `:where(:root:not([data-color-scheme])) <selector>`;
2.  an unconditional forced copy under the attribute — `:root:where([data-color-scheme="dark"])` for root-level rules, `:where(:root[data-color-scheme="dark"]) <selector>` for scoped rules.

All guards are wrapped in `:where()` so specificity matches the unguarded selector and source order decides the cascade: base rules are always emitted **before** conditional blocks. At the project level, custom properties inside a scheme block land on `:root` and direct properties on `body`, mirroring the base emission.

**Compound-query limitation.** A query that combines `prefers-color-scheme` with any other condition (e.g. `(prefers-color-scheme: dark) and (min-width: 768px)`) is _not_ a scheme query: it keeps plain `@media` emission and does not respond to the forced attribute.

**`color-scheme` declaration.** When a scheme query is declared, the compiler emits `:root { color-scheme: light dark }` plus per-attribute overrides (`:root:where([data-color-scheme="light"]) { color-scheme: light }` and the dark equivalent) so native widgets, scrollbars, and form controls follow the forced scheme. Authors who set `colorScheme` in the project `style` suppress this emission.

**Pre-paint script.** Site and standalone compilation targets inject a small synchronous inline `<script>` into `<head>` — ahead of all style blocks — that reads `jx-color-scheme` from `localStorage` and sets `data-color-scheme` on the root element, eliminating any flash of the wrong scheme on load. Declaring a scheme query is the sole opt-in; no other configuration exists.

> **Status: Implemented.** `pureSchemeOf`/`schemeSelectors` (runtime, re-exported by the compiler) define the shared selector contract; `applyStyle`, `compileStyles`, and the site pipeline all dual-emit through them.

---

## 10\. Dynamic Mapped Arrays

### 10.1 Array Namespace Syntax

A dynamic list is an array **pseudo-element** — an object with `$prototype: "Array"` that sits as a **member of a `children` array**, nestled among sibling elements or as the sole child. It renders **wrapper-less**: its mapped items become direct children of the array's parent (no intervening container).

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

> **Backward compatibility.** The legacy form where `children` is _itself_ the Array object (`"children": { "$prototype": "Array", … }`) is still accepted: the runtime and compiler render its items directly into the parent element, and the studio normalizes it to a single array member on load.

### 10.2 Iteration Context

| Reference                | Resolves to                          |
| ------------------------ | ------------------------------------ |
| { "$ref": "$map/item" }  | The current array item object        |
| { "$ref": "$map/index" } | The current zero-based integer index |

Template strings inside the map read the same context as `${$map.item…}` and `${$map.index}` (§6.6).

**From a handler.** An event handler bound anywhere inside a map — on the map body or on any of its descendants — reads its iteration off state as `state.$map`, carrying `item` and `index`. The iteration is published before the handler body runs, so a handler shared by every row can tell which row invoked it. A nested map shadows the outer context for handlers within it.

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

> **Status: Implemented.** The runtime renders array members inline (wrapper-less) via `renderMappedArrayInto()`, handling items, filter, sort, `$map/item`, and `$map/index`.

---

## 11\. Web API Namespaces

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

| $prototype      | Web API      | Status                                                              |
| --------------- | ------------ | ------------------------------------------------------------------- |
| Request         | Fetch API    | Implemented — reactive URL, debounce, manual mode, abort controller |
| URLSearchParams | URL API      | Implemented — computed .toString()                                  |
| FormData        | FormData API | Implemented — basic field population                                |
| LocalStorage    | Storage API  | Implemented — reactive read/write with persistence                  |
| SessionStorage  | Storage API  | Implemented — session-scoped reactive storage                       |
| Cookie          | Cookie API   | Implemented — maxAge, path, domain, secure, sameSite (see §11.2a)   |
| IndexedDB       | IDB API      | Implemented — store creation, indexes, CRUD helper                  |
| Array           | —            | Implemented — dynamic mapped list (see §10)                         |
| Set             | —            | Implemented — new Set(default)                                      |
| Map             | —            | Implemented — new Map(Object.entries(default))                      |
| Blob            | Blob API     | Implemented — parts and type                                        |
| ReadableStream  | Streams API  | Pending — stub returns null                                         |

#### 11.2a The `Cookie` prototype's attribute rules

> **Status: Implemented.**

Three attributes are **derived rather than taken as declared**, because a browser that disagrees with a cookie's attributes drops it silently — the write appears to succeed and the value is simply never there again ([RFC 6265bis](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis) §4.1.3, §5.4.7):

- A **`__Host-`** name forces `Secure`, forces `Path=/`, and drops any declared `Domain`. Honoring a declared path or domain would produce a cookie no browser stores.
- A **`__Secure-`** name forces `Secure`, and leaves path and domain alone.
- **`SameSite=None`** forces `Secure`.

Two attributes are absent on purpose, and neither is a missing feature:

- **`HttpOnly`** cannot be set from script and would make the value unreadable to the binding that wrote it. Its absence is the correct behavior for a script-written cookie.
- **`Expires`** is not supported. `Max-Age` covers the same ground, §5.5 makes `Max-Age` win wherever both appear, and `Expires` takes an HTTP-date whose mis-spelling fails silently in the direction of a cookie that never expires.

The cookie **name is data, never pattern syntax**: the reader splits the cookie header rather than building a regular expression from an author-supplied name.

### 11.3 Timing Values

| Value      | When                                                   | Status      |
| ---------- | ------------------------------------------------------ | ----------- |
| "client"   | Resolved at runtime in the browser (default)           | Implemented |
| "server"   | Resolved at runtime on the server via RPC              | Implemented |
| "compiler" | Resolved at build time; result baked into emitted HTML | Implemented |

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

**In a compiled deployment**, private environment variables and server-only credentials remain in the server process: the compiler emits the function into a route in the generated server output that the browser can only call over HTTP, and the browser receives only the serialized return value. Where that route lands depends on `build.adapter`: with an adapter set it goes into the generated site worker (`dist/worker.js`, or `dist/_worker.js` under the Cloudflare Pages adapter); with no adapter the compiler emits a standalone per-page `_server.js` handler beside the page instead (compiler.md §6.2). The `env` parameter gives server functions access to platform bindings (KV namespaces, D1 databases, email workers, secrets) without exposing them to the client.

> **Status: Partial (dev boundary).** During `jx dev`, the interpreting runtime currently attempts a browser-side `import()` of the `$src` module before falling back to the `/__jx_server__` proxy. A `*.server.js` that is browser-loadable therefore has its **source delivered to the client** in dev — so do not embed secrets in the module body; read them from `env` inside the function, which only the proxy (and the compiled worker) provides. The compiled deployment does not have this gap. Making the dev path proxy-first is a tracked follow-up.

#### Site-Wide Bundling

When `build.adapter` is set in `project.json`, all `timing: "server"` entries across the entire site (components and pages) are collected, deduplicated by export name, and bundled into a single worker entry point — `dist/worker.js`, or `dist/_worker.js` for `"cloudflare-pages"`. That same worker also carries the extension server mounts (extensions.md §11): authentication at `/_jx/auth`, connector data CRUD at `/_jx/data`. See compiler spec §6.3 for details.

> **Status: Implemented.** Runtime handles `timing: "server"` entries. Dev server provides `/__jx_server__` proxy. Compiler emits per-route Hono handlers (`compileServer`) or a site-wide bundled worker (`compileSiteServer`) when `build.adapter` is set.

---

## 12\. External Class Integration

### 12.1 Built-in Prototypes

Jx provides several `$prototype` types that resolve automatically without any `imports` or `$src` configuration:

| Prototype          | Timing   | Description                                      |
| ------------------ | -------- | ------------------------------------------------ |
| Function           | client   | Inline handlers with body/arguments              |
| Array              | client   | Reactive array wrapper                           |
| LocalStorage       | client   | Persistent key-value storage                     |
| SessionStorage     | client   | Session-scoped key-value storage                 |
| Request            | client   | HTTP fetch with reactive URL params              |
| MarkdownFile       | compiler | Parses a single .md file into frontmatter + tree |
| MarkdownCollection | compiler | Globs and parses multiple .md files              |
| ContentCollection  | compiler | Schema-validated multi-format content source     |
| ContentEntry       | compiler | Single entry within a content collection         |

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

| Specifier form                  | Example                                    | Resolution                        |
| ------------------------------- | ------------------------------------------ | --------------------------------- |
| Relative .class.json path       | "./lib/WeatherForecast.class.json"         | Relative to the .json file        |
| npm package specifier           | "@acme/weather/WeatherForecast.class.json" | Resolved via node_modules         |
| $prototype: "Function" with .js | "./lib/helpers.js"                         | Direct JS import (Functions only) |

### 12.3 External Class Contract

**Constructor:** Receives a single configuration object containing all `state` properties except reserved keywords (`$prototype`, `$src`, `$export`, `timing`, `default`, `description`).

**Value resolution:** Checked in order:

1.  `instance.resolve()` — async method, awaited
2.  `instance.value` — synchronous getter or property
3.  `instance` itself — fallback

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

| Rule                            | Description                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Values must end in .class.json  | Non-.class.json values emit a console warning and are skipped                  |
| Explicit $src wins              | If a state entry already has $src, the import map is not consulted             |
| $prototype: "Function" excluded | Function prototypes are never resolved via import map                          |
| Built-in prototypes unchanged   | Request, Set, Map, LocalStorage, etc. are unaffected                           |
| Import overrides built-ins      | An explicit imports entry takes precedence over built-in prototype mappings    |
| Site-level cascading            | imports in site.json cascade to all pages; page-level entries win on collision |

**Resolution order:** explicit `$src` → page `imports` → site `imports` → built-in prototype mappings → unknown prototype warning.

At runtime, `buildScope` injects the mapped `$src` into each bare `$prototype` entry before any resolution pass executes, so all downstream resolution (`resolvePrototype` → `resolveExternalPrototype` → `resolveClassJson`) works unchanged.

> **Status: Implemented.** Runtime pre-processes `doc.imports` in `buildScope`. Compiler merges site-level imports into page documents via `injectContext`. Built-in prototype mappings (`MarkdownFile`, `MarkdownCollection`) resolve at compile time without imports. Site-loader defaults include `imports: {}`.

---

## 13\. Component Encapsulation

### 13.1 Component Instances

A component instance is created by **registering** the component document in the top-level `$elements` map (§16) and then placing an element node with its **custom-element `tagName`**, passing data through `$props`:

```json
{
  "$elements": {
    "my-card": { "$ref": "./components/card.json" }
  },
  "children": [
    {
      "tagName": "my-card",
      "$props": {
        "title": "Hello",
        "count": { "$ref": "#/state/count" }
      }
    }
  ]
}
```

> **Status: Removed.** A node-level external `$ref` child — `{ "$ref": "./card.json", "$props": {…} }` placed directly in `children` — is **not** a component instance. The runtime does not fetch or render it (it produces an empty `<div>`, and `renderNode` emits a one-time console warning). Register the document in `$elements` and instantiate it by its custom-element tag, as above. `$switch` cases (§14) and `$elements` entries (§16) are the resolved external-`$ref` positions.

### 13.2 Explicit Props

Props are passed via `$props` on the instance node. This is the only mechanism for passing state across component boundaries:

```json
{
  "tagName": "my-card",
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

## 14\. Dynamic Component Switching

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

## 15\. Scope Rules

### 15.1 Scope Levels

| Level     | Scope                   | Mirrors                   |
| --------- | ----------------------- | ------------------------- |
| window    | Application-wide        | window global             |
| document  | Document-wide           | document object           |
| Component | Custom element boundary | CSS Custom Property scope |

### 15.2 Within-Component Scope

All `state` entries are available to all descendant elements within that component without explicit passing.

### 15.3 Cross-Component Scope

Signals do not cross component boundaries implicitly. `$props` is required.

### 15.4 Scope Resolution Order

A bare identifier or `#/state/` ref resolves in this order:

1.  `$map/` iteration context, where present
2.  The component scope — `state` entries and `$props`, which are **merged into the same scope** (a `$prop` overwrites a same-named `state` entry in place; there is no separate props namespace)

`window` and `document` globals are **not** part of this fallback chain: an explicit-scheme miss yields no value (a bare, schemeless ref is the only form that falls back to `null`). Reach globals with an explicit `window#/` / `document#/` ref (§7.4).

> **Status: Implemented.**

---

## 16\. Custom Element Definitions

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

| Callback                 | state Entry | Called When                            |
| ------------------------ | ----------- | -------------------------------------- |
| connectedCallback        | onMount     | Element inserted into DOM and rendered |
| disconnectedCallback     | onUnmount   | Element removed from DOM               |
| adoptedCallback          | onAdopted   | Element moved to new document          |
| attributeChangedCallback | (automatic) | Observed attribute changes             |

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

Custom elements render to the light DOM. No shadow root is attached anywhere in the compiler or the runtime, and none is offered: there is no `attachShadow`, no `shadowrootmode`, no `::part` and no `adoptedStyleSheets`.

Scoping is therefore selector-based, in two parts: a component's own rules are prefixed with its **tag name** (`sty-card { … }`, `sty-card .inner { … }`), and a nested element carrying its own `style` gets a **generated class**, `.<tagName>-<n>`. `data-jx-static` and `data-jx-prerendered` appear on emitted elements but mark hydration state and are never used as selectors.

What that buys and what it costs is the same fact stated twice: a page's own CSS can reach into a component and restyle it, and so can a stylesheet the author never wrote.

**A component may opt into a shadow root.** `$shadow: "open" | "closed" | false` on the component, `defaults.shadow` for the project, `false` if neither says otherwise. A component's own value wins in both directions, so `$shadow: false` opts one component out of a project that opted in.

Light DOM remains the default and is not a placeholder for this. The two modes differ in ways an author has to mean:

|                     | Light DOM                                                            | Shadow DOM                                      |
| ------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| Render target       | the element                                                          | its shadow root                                 |
| <slot>              | emulated — children saved, spliced back where the literal <slot> sat | real slot distribution                          |
| Style scope         | <tag> prefix, .<tag>-<n> classes                                     | :host, with ::slotted() reaching assigned nodes |
| Stylesheet          | <link> in the document head                                          | <link> inside the shadow root                   |
| Page CSS reaches in | yes                                                                  | no                                              |

Slot distribution is the difference that cannot be papered over, and the reason shadow cannot become the default: the emulation _moves_ children into the rendered tree, while a real `<slot>` leaves them in the light tree and projects them.

**Server rendering is a declarative shadow root.** A prerendered shadow component emits `<template shadowrootmode="open|closed">` containing its markup and its stylesheet link, with the slotted light children as **siblings outside** the template — where the slot projects them from. The parser materializes that root before any script runs, so the component paints correctly with JavaScript disabled or still loading.

**The element adopts that root rather than replacing it.** Calling `attachShadow` over an existing declarative root throws, and even where it did not, replacing it would discard the markup the feature exists to ship. An `open` root is found on the element; a `closed` one is not — by definition — and `ElementInternals` is the standard's only way back to it, which is why the two modes emit different lookups rather than one call with a mode string.

What the client render then does is **replace**, not hydrate: lit renders its own tree, so the declarative markup is cleared first, exactly as the light path clears `innerHTML`. The stylesheet link is the one child kept, because it styles that root and the document's head cannot reach in. Jx does not use lit-ssr's `hydrate`, so a declarative shadow root is a first paint rather than a hydration target — the same contract the light path has always had.

**A style object means the same thing in both modes.** `:host` and `:host(.sel)` are translated rather than passed through: inside a root they stand alone, and outside they become the tag name and `<tag>.sel`, which is what "the host, matching this" means when there is no root. Moving a component between modes therefore does not silently break its styles.

**Content-Security-Policy is unaffected.** The component stylesheet stays an external `<link>`, merely relocated, so no hash changes (site-architecture.md §14.3.1).

> **Status: Implemented.** Light DOM is the default; the `$shadow` opt-in emits and adopts a declarative shadow root, verified in a browser for both modes.

### 16.7 Development vs. Production

|          | Development           | Production                     |
| -------- | --------------------- | ------------------------------ |
| Renderer | @jxsuite/runtime      | lit-html                       |
| State    | @vue/reactivity       | @vue/reactivity                |
| Source   | JSON interpreted live | JSON compiled away             |
| Bundle   | .json + runtime       | .js classes only (~10 kB deps) |

### 16.8 CEM-Compatible Annotations

Custom elements may carry annotations compatible with the Custom Elements Manifest specification:

- `observedAttributes` — attribute declarations
- `parameters` on functions — CEM `Parameter` objects
- `emits` on functions — CEM `Event` objects
- `attribute` and `reflects` on typed `state` entries

> **Status: Partial.** Schema includes CEM fields. Studio has CEM editing UI. Full CEM document export is pending.

---

## 17\. Reserved Keywords

| Keyword            | Purpose                                                           |
| ------------------ | ----------------------------------------------------------------- |
| $schema            | Dialect identifier                                                |
| $id                | Component identifier                                              |
| $defs              | Pure JSON Schema type definitions                                 |
| state              | Reactive state, computed values, functions, and data sources      |
| $ref               | Reference pointer (JSON Pointer, RFC 6901)                        |
| $props             | Explicit prop passing at component boundary                       |
| $prototype         | Constructor name — Web API class, "Function", or external class   |
| $src               | External module specifier                                         |
| $export            | Named export within $src module                                   |
| $switch            | Dynamic component switching                                       |
| $map               | Iteration context namespace                                       |
| $media             | Named media breakpoint declarations                               |
| $elements          | Custom element dependency declarations                            |
| timing             | Execution timing: "compiler", "server", or "client"               |
| default            | Initial value for typed state entries                             |
| body               | Inline function body                                              |
| arguments          | Function parameter names (string array)                           |
| parameters         | Function parameter entries — bare names or CEM-compatible objects |
| returnType         | JSON Schema describing a .class.json method's return type         |
| name               | Inline function explicit name                                     |
| description        | Documentation string                                              |
| observedAttributes | HTML attributes the custom element watches                        |
| $expression        | Declarative operation, mutating or pure (Shape 5)                 |
| operator           | Operator token within an expression node                          |
| target             | Operand the operator acts on                                      |
| value              | Right-hand operand, or per-item expression for aggregates         |
| initial            | Seed accumulator for the reduce aggregate operator                |
| onMount            | Lifecycle: connected and rendered                                 |
| onUnmount          | Lifecycle: disconnected                                           |
| onAdopted          | Lifecycle: adopted into new document                              |

---

## 18\. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). Two things once listed here are **not** standards and are therefore prose rather than rows: reactivity is `@vue/reactivity`, a library; and the `$media` breakpoint syntax borrows the shape of CSS `@custom-media`, a Media Queries Level 5 feature no browser ships, which Jx resolves itself at build and run time. The Custom Elements Manifest (§16.8) is a community format with no standards body.

| Standard            | Class     | Binds    | Evidence                                                                                                                      | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ECMA-404            | Adopted   | §3       | packages/schema/src/parse.ts                                                                                                  | A Jx document is JSON. Nothing in the format extends the syntax.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| JSON Schema 2020-12 | Divergent | §3.2, §5 | packages/schema/src/schema.ts, packages/schema/tests/schema.test.ts                                                           | $defs holds genuine 2020-12 type definitions and a document validates as an instance against a conformant meta-schema. Three deviations: Jx declares no $vocabulary, so it is not a dialect; $id is a display name and establishes no base URI for relative $ref; and $schema is an editor "schema for this instance" pointer, not a dialect declaration.                                                                                                                                                                                     |
| ECMA-262            | Subset    | §19, §20 | packages/runtime/src/expression.ts, packages/runtime/tests/expression.test.ts                                                 | Operator punctuators and their arity are ECMAScript's, and aggregate operations follow Array.prototype semantics — but only an allow-listed subset is evaluable, and if/then/else statements are imperative control flow over a statement list rather than anything from JSON Schema.                                                                                                                                                                                                                                                         |
| WHATWG DOM          | Subset    | §16, §20 | packages/compiler/src/targets/compile-element.ts                                                                              | Custom elements are defined and dispatchEvent emits a real CustomEvent. Shadow trees are not used at all (§16.6).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| WHATWG HTML         | Subset    | §16.6    | packages/compiler/src/shadow.ts, packages/compiler/src/targets/compile-element.ts, packages/compiler/tests/shadow-dom.test.ts | Custom elements are defined and upgraded as the standard describes and render into the light DOM by default. A component may opt into a shadow root with $shadow (a project into all of them with defaults.shadow), which emits a declarative <template shadowrootmode> the element then adopts — open through element.shadowRoot, closed through ElementInternals. Not offered: ElementInternals for form association, and ::part addressed from outside a component.                                                                        |
| CSS Scoping         | Subset    | §16.6    | packages/compiler/src/shared.ts, packages/compiler/tests/shadow-dom.test.ts                                                   | :host, :host() and ::slotted() are emitted for a shadow component, and :host/:host() are translated to the tag name in light DOM so one style object serves both modes. :host-context() is not offered — it never reached a second engine.                                                                                                                                                                                                                                                                                                    |
| CSSOM               | Adopted   | §9.1     | packages/runtime/src/runtime.ts                                                                                               | style keys are the CSSOM camelCase IDL attribute names, so a property name needs no translation table.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| CSS Color 4         | Adopted   | §9.5     | packages/compiler/src/shared.ts, packages/compiler/tests/shared.test.ts                                                       | color-scheme: light dark is emitted with per-attribute overrides, so native controls follow a forced scheme rather than only the author's own rules.                                                                                                                                                                                                                                                                                                                                                                                          |
| RFC 6901            | Borrowed  | §7       | packages/runtime/src/runtime.ts                                                                                               | Shape only. A $ref binds live reactive state rather than substituting a value, ~0/~1 escapes are unimplemented, and . is treated as a separator.                                                                                                                                                                                                                                                                                                                                                                                              |
| RFC 9535            | Borrowed  | §7       | packages/runtime/src/runtime.ts                                                                                               | The dotted segment form #/state/user.name is JSONPath's shape rather than a deviation from JSON Pointer — but no JSONPath selector, filter or wildcard is supported, so nothing here is a JSONPath query.                                                                                                                                                                                                                                                                                                                                     |
| CSP Level 3         | Divergent | §21      | packages/compiler/tests/no-eval.test.ts                                                                                       | Compiled output contains no new Function and no eval, proven by a committed test, so it runs under a policy without 'unsafe-eval'. The interpreting runtime compiles templates and function bodies at load time and therefore requires 'unsafe-eval' permanently — §21.3 states this as a property, not a defect.                                                                                                                                                                                                                             |
| Trusted Types       | Subset    | §21.5    | packages/studio/src/services/trusted-types.ts, packages/studio/tests/trusted-types.test.ts, packages/runtime/src/runtime.ts   | gap:trusted-types The policy exists and refuses: createHTML asserts its input is sanitized and throws naming what it found, createScript/createScriptURL throw outright, and the runtime's four innerHTML = "" writes became replaceChildren(). Not enforced — no deployment sends require-trusted-types-for, because under this standard eval and new Function are gated too and the canvas interpreter needs both; §21.5 records why that is two permanent CSP profiles rather than a TODO, and why enforcement waits on a report-only run. |

---

## 19\. Declarative Expressions (`$expression`)

### 19.1 Motivation

The Rule of Least Power (§2.2) defines a ladder of escalating power:

> `$ref` bindings → template expressions → handler functions

A gap exists between the third and fourth rungs. The moment an interaction must _write_ state — `state.count++`, `state.items.push(x)` — the only available tool is a Shape 4 `$prototype: "Function"` with a `body` string. A `body` string is opaque JavaScript: it cannot be validated by JSON Schema tooling, inspected by the visual builder, or analyzed by the compiler without parsing embedded source.

`$expression` introduces the missing rung: a **declarative operation** that mutates state through structure rather than through an interpreted string. It covers the common case of simple event-driven state changes — toggling a boolean, incrementing a counter, adding or removing array items — while `body` remains the escape hatch for logic that cannot be expressed declaratively.

This mirrors the relationship between `${}` and `$ref` established in §6.5: prefer the least powerful form; escalate only when necessary.

| Rung                   | Power   | Static-analyzable | Use when                                    |
| ---------------------- | ------- | ----------------- | ------------------------------------------- |
| $ref binding           | Lowest  | Yes               | Reading a signal                            |
| ${} template           | Low     | Yes               | Single-use computed read                    |
| $expression            | Mid     | Yes               | Simple declarative state mutation           |
| $prototype: "Function" | Highest | No (body opaque)  | Logic not expressible as a single operation |

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

| Field    | Required          | Description                                                           |
| -------- | ----------------- | --------------------------------------------------------------------- |
| operator | Yes               | An operator token from the blessed set (§19.4)                        |
| target   | Yes               | The operand the operator acts on. A $ref, a literal, or a nested node |
| value    | By operator arity | The right-hand operand. A $ref, a literal, an array, or a nested node |

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

| Arity       | Mode     | Uses target        | Uses value           | Operators                                |
| ----------- | -------- | ------------------ | -------------------- | ---------------------------------------- |
| Unary       | Pure     | Yes                | No                   | !, - (negation)                          |
| Binary      | Pure     | Yes (left)         | Yes (right)          | + - * / %, === !== < <= > >=, && \|\| ?? |
| Conditional | Pure     | Yes (test / disc.) | Branches (see below) | ?:, switch (see §19.4b)                  |
| Assignment  | Mutating | Yes (LHS)          | Yes (RHS)            | =, += -= *= /=                           |
| Method      | Mutating | Yes (receiver)     | Args (see below)     | push, pop, shift, unshift, splice        |
| Aggregate   | Pure     | Yes (source)       | Per-item expression  | reduce, map, filter (see §19.4a)         |

For **binary** operators, `target` is the left operand and `value` the right; the result is a value (it does not mutate). For **assignment** operators, `target` is the assignable location (a writable `$ref`) and the operation mutates it. For **method** operators, `target` is the array receiver and `value` carries the arguments: a single value for `push`/`unshift`, an array of arguments for `splice` (`[start, deleteCount, ...items]`), and omitted for `pop`/`shift`. **Aggregate** operators are defined in §19.4a.

```json
{ "operator": "push",   "target": { "$ref": "#/state/cart" }, "value": { "$ref": "$map/item" } }
{ "operator": "splice", "target": { "$ref": "#/state/cart" }, "value": [{ "$ref": "$map/index" }, 1] }
{ "operator": "pop",    "target": { "$ref": "#/state/cart" } }
{ "operator": "+=",     "target": { "$ref": "$map/item/qty" }, "value": 1 }
```

### 19.4 Blessed Operator Set

The operator set is **closed**. An operator outside this list is a compile-time error; logic requiring it must use a `body` string. The set is chosen to cover the mutation patterns already present in `body` strings across the existing examples (e.g. Appendix A's `push`, `splice`, and `!`\-toggle handlers).

| Category               | Tokens                        |
| ---------------------- | ----------------------------- |
| Assignment             | = += -= *= /=                 |
| Unary                  | ! -                           |
| Arithmetic (binary)    | + - * / %                     |
| Comparison             | === !== < <= > >=             |
| Logical (binary)       | && \|\| ??                    |
| Conditional (pure)     | ?: switch (see §19.4b)        |
| Array mutation methods | push pop shift unshift splice |
| Aggregate (pure)       | reduce map filter             |

All tokens except the methods and `switch` are genuine ECMAScript operator punctuators (`?:` names the conditional operator's two punctuators as one token; `??` is nullish coalescing). `switch` is the ECMAScript selection keyword, mirroring the element-level `$switch` (§14). The array and aggregate methods are genuine `Array.prototype` methods. No token in this table is invented.

### 19.4a Aggregate Operators

Aggregate operators are **pure** (§19.1): they read an array `target` and return a derived value, mutating nothing. They are the declarative replacement for the callback-in-a-string pattern a Shape 3 template would otherwise require (`"${state.cart.reduce(...)}"`), keeping the per-item computation as an inspectable expression tree rather than opaque source.

Their `value` is a single **per-item expression node** evaluated once per element of `target`, in a scope where the existing `$map/` context (§7.2) is bound to the current element:

| Reference                 | Bound during aggregation             |
| ------------------------- | ------------------------------------ |
| { "$ref": "$map/item" }   | The current array element            |
| { "$ref": "$map/index" }  | The current zero-based integer index |
| { "$ref": "$reduce/acc" } | The accumulator (reduce only)        |

This is the same `$map/` binding §10.2 establishes for mapped-array templates; an aggregate's per-item expression is conceptually identical to a `map`'s per-item template, so no new iteration concept is introduced. `$reduce/acc` is the sole new pointer — the fold accumulator, resolvable only inside a `reduce` per-item expression.

| Operator | value (per-item expression)              | initial    | Returns                            |
| -------- | ---------------------------------------- | ---------- | ---------------------------------- |
| reduce   | step: combines $reduce/acc with the item | Required   | The final accumulator value        |
| map      | the value to produce per item            | Disallowed | A new array of the produced values |
| filter   | a predicate (truthy = keep)              | Disallowed | A new array of the kept elements   |

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

| Helper                  | Signature                        | Wraps                                                            |
| ----------------------- | -------------------------------- | ---------------------------------------------------------------- |
| Intl/formatNumber       | (value, locale?, options?)       | new Intl.NumberFormat(locale, options).format(value)             |
| Intl/formatDate         | (value, locale?, options?)       | new Intl.DateTimeFormat(locale, options).format(new Date(value)) |
| Intl/formatRelativeTime | (value, unit, locale?, options?) | new Intl.RelativeTimeFormat(locale, options).format(value, unit) |

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

| Prototype | Operators                                                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Array     | includes indexOf lastIndexOf join slice concat at flat toSorted toReversed toSpliced with                                                                                                 |
| String    | toUpperCase toLowerCase trim trimStart trimEnd split startsWith endsWith padStart padEnd replaceAll repeat charAt normalize toLocaleUpperCase toLocaleLowerCase (plus the Array homonyms) |
| Number    | toFixed toPrecision toLocaleString                                                                                                                                                        |

```json
{ "operator": "toUpperCase", "target": { "$ref": "#/state/name" } }
{ "operator": "includes",    "target": { "$ref": "#/state/tags" }, "value": "featured" }
{ "operator": "toSorted",    "target": { "$ref": "#/state/scores" } }
{ "operator": "padStart",    "target": { "$ref": "#/state/code" }, "value": [6, "0"] }
```

Evaluation is null-safe, matching path reads: a missing receiver or a method absent from the receiver's type yields `undefined` rather than throwing (compiled form: `(receiver)?.method?.(args)`). Aggregates (§19.4a) likewise accept a derived array as `target` — `join(map(split(name, " "), …), "")` composes without intermediate state entries.

### 19.5 The `event#` Reference Scheme

Handlers receive `(state, event)` (§4.3). To allow `$expression` handlers to read event data without escalating to a `body` string, the reference system (§7.2) is extended with one scheme:

| Scheme        | Example               | Resolves to                          |
| ------------- | --------------------- | ------------------------------------ |
| Event context | "event#/target/value" | A property path on the handler event |

`event#` is resolvable only within an expression node used as an event handler. Referencing it from a `state`\-entry expression that is not invoked as a handler is a compile-time error. It is inserted into the §7.4 resolution order immediately below `$map/`:

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

`$expression` is valid in three positions:

1.  **As a `state` entry** (a named, reusable operation — Shape 5, §19.7):

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

2.  **Inline as an event handler value** on any element, in place of a `$ref` to a function:

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

3.  **As an element's `tagName`** — a tag chosen when the element is created, narrowed to the `TagExpression` shape: `?:` or `switch`, whose every result is a literal `TagName`. This is the one position where an `$expression` is **not live** — the tag is resolved once, at creation, and never re-read.

    ```json
    {
      "tagName": {
        "$expression": {
          "operator": "?:",
          "target": { "$ref": "#/state/href" },
          "value": "a",
          "initial": "div"
        }
      },
      "attributes": { "href": "${state.href}" },
      "children": ["…written once, whichever tag it turns out to be…"]
    }
    ```

    **Why the results are tag names and not operands.** The candidate set has to be readable without evaluating anything: the compiler emits one template per candidate (lit cannot bind a tag name), `jx validate` refuses an illegal name at authoring time, and the void-element, preformatted and slot analyses that read a tag structurally keep a finite set to reason about. A `${…}` template here would surrender all of it — and did: nothing in the pipeline evaluated one, so each consumer failed differently and silently.

    **Why once and not live.** A tag that changed after mount means replacing the element, and the subtree's listeners, focus, typed input values and component instances go with it. `jx validate` warns when a tag discriminant is also an assignment target, so the case where the rule bites is caught before it ships. The document ROOT's `tagName` and a `$head` entry's stay literal — they are a custom element's name and a head tag.

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

## 20\. Structured Function Bodies (Statements)

### 20.1 Motivation

§19 removed the `body`\-string escape hatch for single operations; multi-step side effects (mutate, branch, notify) still required opaque JavaScript. A Function entry's `body` may now be a **JSON array of statements** instead of a source string — explicit structured function declaration, analyzable by tooling and editable visually. This mirrors ESTree exactly: a function body is `Statement[]`. No new keyword, no new entry kind — the escalation ladder _within_ Shape 4 becomes structured statements → JS string.

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

| Kind       | Shape                                              | Source of the name                       |
| ---------- | -------------------------------------------------- | ---------------------------------------- |
| Expression | a bare §19 expression node (mutation or call)      | ECMAScript ExpressionStatement           |
| Branch     | { if, then, else? } — statement lists in then/else | JSON Schema 2020-12 conditional keywords |
| Multiway   | { $switch, cases, default? } — statement lists     | Element-level $switch (§14), ECMA switch |
| Dispatch   | { dispatchEvent, detail?, bubbles?, composed? }    | WHATWG DOM dispatchEvent/CustomEventInit |

- The branch `if` and the `$switch` discriminant hold **pure** operands; `$switch` matches by string form, exactly like §19.4b.
- **Result capture** composes — an assignment statement whose `value` is a `call` node — so no dedicated capture field exists.
- `dispatchEvent` dispatches from the handler's `event.currentTarget` (interpreter and client islands) or the component instance (compiled custom elements); the entry's `emits` (CEM) remains the declaration the editor autocompletes from.
- Statements execute sequentially; a statement whose value is a thenable is awaited before the next (ECMA async/await semantics).

### 20.3 Lowering

`body: Statement[]` follows the named-formula pattern (§19.4c): without `parameters` the entry lowers to an event handler `(state, event)`; with `parameters` it lowers to a positional callable whose arguments bind to `$args/` names. The engine is `runStatements` (interpreter) + `compileStatements` (JS emitter) — one module, both halves, mirroring §19.8: `if`/`else` and `switch` emit their genuine ECMAScript statement forms, and dispatch emits `dispatchEvent(new CustomEvent(type, init))`. Inline event bindings accept structured bodies through the existing Function binding form — `JxEventBinding` is unchanged.

---

## 21\. Evaluation Surface

> **Status: Partial.** The surface is stated accurately, which is what this section is for, and a Trusted Types policy now guards the one injection sink the Studio shell has (§21.5). What is absent is **enforcement**: no deployment sends `require-trusted-types-for`, and doing so needs a report-only run first for the reason §21.5 gives. See §18.

Jx documents contain executable code — `${}` templates and `body`/`$src` functions. Where and how that code runs differs by mode, and the security posture differs with it. This section states the surface honestly so hosts can make an informed decision.

### 21.1 Compiled Output — No Runtime Eval

The compiler produces plain HTML/CSS plus per-island ES modules. It does **not** emit `new Function` or `eval`: a `${}` template is **spliced verbatim** into an emitted module as a real template literal (`compile-client.ts`), and statements/`$expression` lower to genuine JS. A compiled static or island page therefore runs under a strict CSP with **no `'unsafe-eval'`**.

> **Status: Implemented.** Enforced by a test (`packages/compiler/tests/no-eval.test.ts`) that compiles templates, `$switch` external cases, and a `.class.json`, and asserts the emitted JS contains no `new Function(`/`eval(`.

The corollary is a **build-time** concern, not a runtime one: because template text becomes code in the bundle, any document string that reaches a template position becomes executable at build time. A pipeline that compiles **untrusted** documents (e.g. user-submitted content merged into the tree) must sanitize or escape `${` sequences first — treat compiling a document as running it.

### 21.2 Build Host — Trusted-Input Evaluation

During a build the compiler evaluates project code (resolving `timing: "compiler"` prototypes, importing `$src` modules). This is the same trust class as running the project's own `npm`/`bun` scripts: build inputs are trusted by definition.

### 21.3 Interpreting Runtime — Requires `'unsafe-eval'`

The interpreting runtime — the dev server, the Studio canvas, and `@jxsuite/runtime` used directly as a library — compiles `${}` templates and inline `body` functions with `new Function` on the fly (§6.6). Any page hosting the interpreter must allow `'unsafe-eval'` in its CSP. This is why the compiled path exists: ship compiled output to production and the eval requirement disappears. A future restricted evaluator (§6.6) would remove this requirement from the interpreter as well.

### 21.4 Trust Model for Documents

A Jx document is **executable input**. Loading and rendering an untrusted document in the interpreting runtime runs its code; compiling an untrusted document runs its code at build time. Jx does not sandbox document code — treat a `.json` document with the same trust you would treat a `.js` file from the same source.

> **Status: Implemented** (as a stated property, not a sandbox). See also `@jxsuite/server` §4.2 for the dev-server network controls and `docs/framework/concepts/security.md` for the user-facing summary.

### 21.5 Two CSP Profiles, Permanently

> **Status: Implemented** as a decision; enforcement is not.

There are **two** profiles here, not one profile with an outstanding TODO, and saying so is the point of this section: "remove `eval` from the runtime" has been living as an implied task, and it is not one. The interpreter **is** those `new Function` sites — an interpreter that does not compile expressions at runtime is a compiler.

| Profile                 | 'unsafe-eval' | Why                                                                    |
| ----------------------- | ------------- | ---------------------------------------------------------------------- |
| Compiled output         | never         | §21.1, with a committed test asserting the emitted JS contains neither |
| The interpreting canvas | permanently   | §21.3 — it evaluates ${} templates and body functions as they are read |

**What Trusted Types actually gates, verified rather than assumed.** The tempting reading is that `require-trusted-types-for 'script'` covers DOM injection sinks and leaves `eval` to `script-src`. It does not: under Trusted Types, `eval()` and `new Function()` are gated as well, and throw when no default policy exists. The escape hatch is a **default policy whose `createScript` passes its input through**, which re-permits evaluation and makes the script half of Trusted Types a rubber stamp.

That is why the two halves are staged separately, and why the shell does not enforce yet:

- **The injection sinks are handled now.** The four `innerHTML = ""` writes in `@jxsuite/runtime` became `replaceChildren()` — identical semantics, four fewer sinks, and no policy needed to clear an element. The shell's one remaining sink is the assistant's markdown, which goes through a policy that **asserts** its input is sanitized and throws naming what it found. A `createHTML` that returned its input unchanged would satisfy the API and defend nothing.
- **`createScript` and `createScriptURL` refuse.** Nothing in the shell builds either from a string. The canvas iframe is a different document with a different profile, so a permissive `createScript` in the shell would buy the shell nothing and cost it the control.
- **Enforcement needs a report-only deployment first.** This is the one place where getting the standard's scope wrong produces a plan that cannot be executed, so the order is: ship the policy, observe under `Content-Security-Policy-Report-Only`, then enforce.

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

| Package         | Version | Purpose                                          |
| --------------- | ------- | ------------------------------------------------ |
| @vue/reactivity | ^3.5    | Reactive primitives (reactive, computed, effect) |

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

## Changelog

- **0.4.33-draft** (2026-08-16) — §21.5 two CSP profiles, permanently: compiled output never needs 'unsafe-eval' and the interpreting canvas always will. A Trusted Types policy guards the shell's one injection sink and refuses to build scripts; the runtime's four innerHTML writes became replaceChildren().
- **0.4.32-draft** (2026-08-16) — §11.2a the Cookie prototype derives Secure/Path/Domain from a name prefix and from SameSite=None; HttpOnly and Expires are absent on purpose; a cookie name is data, never pattern syntax.
- **0.4.31-draft** (2026-08-16) — Shadow DOM opt-in: $shadow and defaults.shadow emit a declarative shadow root the element adopts; :host translation keeps one style object valid in both modes (§16.6).
- **0.4.30-draft** (2026-08-16) — §9.1 and §16.6: style scoping is a tag-name prefix and generated classes, not data-jx attribute selectors; cite the light-DOM divergence.
- **0.4.29-draft** (2026-08-15) — §18 becomes the machine-checked standards table; §2.5 renamed Platform Precedents to free the reserved title; §21 marked Partial — no Trusted Types policy is installed.
- **0.4.28-draft** (2026-08-10) — §19.6 $expression gains a third position — an element's tagName, narrowed to a TagExpression whose every branch is a literal TagName so the candidate set is enumerable without evaluating; it is the one $expression position that is not live, resolved once at element creation, and the document root's and $head entries' tagNames stay literal.
- **0.4.27-draft** (2026-07-30) — Clarify that a bare `return;` is an early-exit guard, not a value return, when classifying a Function body as a computed (§5.3 4b).
- **0.4.26-draft** (2026-07-30) — Define the handler-side iteration context: an event handler bound inside a map reads its row via state.$map (§10.2).
- **0.4.25-draft** (2026-07-30) — Define parameter binding by name at event call sites, and how a bodyless $src Function is classified as a computed or a callable (§5.3 4d).
- **0.4.24-draft** (2026-07-24) — §5.3 and §11.4: a timing: "server" route lands in the generated site worker only when build.adapter is set; without an adapter the compiler emits a per-page \_server.js handler instead.
- **0.4.23-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.4.22-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.4.21-draft** (2026-07-22) — Reconcile spec with shipped behavior; document the eval surface (`c8d1d580`).
- **0.4.20-draft** (2026-07-22) — Align specs and docs with the bundled-schema validation contract (`ae861ff6`).
- **0.4.19-draft** (2026-07-17) — Forced color-scheme contract — dual emission, color-scheme triplet, pre-paint script (`e629684d`).
- **0.4.18-draft** (2026-07-17) — Sidecar bundling, extension emit capability, heading anchors (`07e28bc3`).
- **0.4.17-draft** (2026-07-17) — Align spec.md, site-architecture, desktop, server, extensions with reality (`c61ba567`).
- **0.4.16-draft** (2026-07-17) — Clean up spec (`897e8c1e`).
- **0.4.15-draft** (2026-07-15) — Pure method operators and the composite formula catalog (spec §19.4d) (`58be3b1a`).
- **0.4.14-draft** (2026-07-15) — Conditional operators and editor evaluation trace (spec §19.4b, §19.9) (`79926245`).
- **0.4.13-draft** (2026-06-15) — Arrays as pseudo-element (`0b8b3070`).
- **0.4.12-draft** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).
- **0.4.11-draft** (2026-06-02) — Returns type in the class definition (`32e4737a`).
- **0.4.10-draft** (2026-06-01) — Declarative expressions (`472aeb15`).
- **0.4.9-draft** (2026-05-25) — Element annotations (title/description) (`c9137e50`).
- **0.4.8-draft** (2026-05-20) — "format" on fields for image fields (`02f87d29`).
- **0.4.7-draft** (2026-05-20) — Release 0.11.0 (`4a0e17ed`).
- **0.4.6-draft** (2026-05-20) — Run formatter (`8ba47930`).
- **0.4.5-draft** (2026-05-18) — Always emit worker.js for cloudflare (`3dd37c2d`).
- **0.4.4-draft** (2026-05-15) — Add markdown prototypes at top-level (`24020906`).
- **0.4.3-draft** (2026-05-15) — Provider-sepcific Site-Wide Bundling (`51cb5cf6`).
- **0.4.2-draft** (2026-04-23) — Oxfmt (`af32c08c`).
- **0.4.1-draft** (2026-04-23) — Rebrand to jxsuite (`2897a4e8`).
- **0.4.0-draft** (2026-04-22) — Consolidate project config schema and rename as such (`e3523dbf`).
- **0.3.7-draft** (2026-04-22) — External web component support (`a9d0fbe4`).
- **0.3.6-draft** (2026-04-22) — Init new site (`f33d319b`).
- **0.3.5-draft** (2026-04-20) — Text nodes support (`4d45eeb7`).
- **0.3.4-draft** (2026-04-16) — Landing site + working exports + release-it + linting (`a8409b5f`).
- **0.3.3-draft** (2026-04-15) — Rebrand to Jx / Jx Platform (`abc63f2d`).
- **0.3.2-draft** (2026-04-15) — Importmap support (`c1b329d4`).
- **0.3.1-draft** (2026-04-15) — Require json based entrypoints for external class integration (`86dc4383`).
- **0.3.0-draft** (2026-04-10) — Consolidate specs (`80ca313f`).
- **0.2.3-draft** (2026-04-07) — Custom element spec (`4f377be3`).
- **0.2.2-draft** (2026-04-06) — Server-side timing (scaffolding) (`23932590`).
- **0.2.1-draft** (2026-04-06) — Transition to vue reactivity (`70cb8445`).
- **0.2.0-draft** (2026-04-06) — Pure js in defs and strings (`6494999d`).
- **0.1.3-draft** (2026-04-06) — External/md parser (`5161ec0e`).
- **0.1.2-draft** (2026-04-04) — Declarative media breakpoints (`3142b64e`).
- **0.1.1-draft** (2026-04-04) — Rebrand as JSONsx (`0daa94f7`).
- **0.1.0-draft** (2026-04-04) — Init (`a93852ac`).

---

_Jx Specification v0.4.33-draft — subject to revision_
