---
title: "Functions and sidecars"
description: "Function prototype entries in Jx: inline handlers, computed bodies, external .js sidecars, and how JavaScript reads and writes state."
spec:
  - spec.md#4.2
  - spec.md#4.3
  - spec.md#5.5
  - spec.md#5.3 # Function properties, parameter binding, $src classification
code:
  - packages/compiler/src/targets/compile-element.ts
  - packages/compiler/src/targets/compile-client.ts
---

# Functions and sidecars

> **Studio writes this format for you.** The Monaco editor behind every function body ([Code editing](/docs/studio/logic/code)) reads and writes these entries, and this page documents the JSON and the JavaScript contract around it.

A Function entry is a `state` entry with `$prototype: "Function"`, the top rung of the escalation ladder, where logic becomes JavaScript. Its code lives either inline in a `body` or in an external `.js` **sidecar** file named by `$src`. Prefer [expressions](/docs/framework/concepts/expressions) and [statements](/docs/framework/concepts/statements) first; reach for a function when structure runs out.

The smallest complete function is an inline handler:

```json
{
  "state": {
    "count": 0,
    "increment": { "$prototype": "Function", "body": "state.count++" }
  }
}
```

Bind it to an event like any handler: `"onclick": { "$ref": "#/state/increment" }`.

## Inline handlers

A `body` string is a raw function body. `state` is always in scope; `arguments` names any additional parameters, so an event handler names `event`:

```json
{
  "handleInput": {
    "$prototype": "Function",
    "arguments": ["event"],
    "body": "state.value = event.target.value"
  }
}
```

An event binding always calls the handler with the state and the event, and the names you declare bind **by name, not by position**: a parameter called `state` receives the reactive state, and any other name receives the event. So `["event"]`, `["state", "event"]`, and `["state"]` each bind exactly what they read, and a body may reference `state` whether or not it declared it. The same holds for a handler written inline on an `on*` property.

## Inline computed values

A function with only a `body` (no `arguments`) that returns a value acts as a computed, and the framework wraps it in `computed()` when it detects the entry is referenced reactively:

```json
{
  "titleClass": {
    "$prototype": "Function",
    "body": "return state.score >= 90 ? 'gold' : 'silver'"
  }
}
```

Only a `return` with a value on the same line makes an entry a computed. A bare `return;` is an early exit, so a handler that starts with a guard clause stays a handler:

```json
{
  "toggle": {
    "$prototype": "Function",
    "body": "if (state.locked) return; state.open = !state.open"
  }
}
```

## External sidecars

When a function outgrows a string, move it to a `.js` file and point `$src` at it. Each entry resolves to the named export matching its key (override with `$export`); npm specifiers work too:

```json
{
  "state": {
    "increment": { "$prototype": "Function", "$src": "./counter.js" },
    "decrement": { "$prototype": "Function", "$src": "./counter.js" },
    "validateEmail": {
      "$prototype": "Function",
      "$src": "npm:@myorg/validators",
      "$export": "validateEmail"
    }
  }
}
```

```js
export function increment(state) {
  state.count++;
}
export function decrement(state) {
  state.count = Math.max(0, state.count - 1);
}
```

When several entries share a `$src`, the module is imported once and its named exports extracted; module caching is automatic.

A sidecar entry has no `body` to read, so its role follows how the document uses it. Bind it to an event, invoke it as `state.helper(state)`, or name it a lifecycle hook, and it stays a function. Read it anywhere else, in a list's `items`, a `${}` interpolation or a property binding, and it becomes a computed value: what you get is the export's **return value**, recomputed when its inputs change, not the function itself.

```json
{
  "state": {
    "leads": { "$prototype": "Request", "url": "/api/leads" },
    "openLeads": { "$prototype": "Function", "$src": "./leads.js" }
  },
  "children": {
    "$prototype": "Array",
    "items": { "$ref": "#/state/openLeads" },
    "map": { "tagName": "li", "textContent": "${$map.item.name}" }
  }
}
```

```js
export function openLeads(state) {
  return (state.leads ?? []).filter((l) => l.open);
}
```

`items` reads `openLeads`, so it resolves to the filtered array and re-filters whenever `leads` arrives.

## Structured bodies

A `body` may also be a JSON array of statements instead of a source string, which is multi-step logic that stays inspectable and visually editable. That form has its own page: [Statements](/docs/framework/concepts/statements).

## State access from JavaScript

Inside `body` strings and sidecar files, `state` is the component's reactive scope, a proxy over every declared state entry and function. Read and write it directly; there are no `.get()`/`.set()` calls:

```js
// Read
const current = state.count;

// Write
state.count = current + 1;

// Mutate arrays in place — mutations are tracked
state.items.push(newItem);
state.items.splice(0, 1);

// Nested objects are tracked too
state.user.name = "Alice";
```

Every write triggers the bindings that read that value. See [Reactivity](/docs/framework/concepts/reactivity). `this` is never used in Jx-managed code; all component access goes through `state`.

## Declaring the interface

Optional metadata makes a function legible to tooling:

| Property      | Description                                                           |
| ------------- | --------------------------------------------------------------------- |
| `arguments`   | Parameter names as plain strings, bound by name                       |
| `parameters`  | CEM-compatible parameter objects, a richer alternative to `arguments` |
| `returns`     | JSON Schema describing the return value                               |
| `emits`       | CEM `Event` objects this function dispatches                          |
| `description` | Documentation string, surfaced in Studio's completions                |

## How it works

At runtime, the scope builder recognizes the `$prototype: "Function"` shape and turns each entry into a callable on the reactive scope. Exports and bodies are invoked with `state` as their first argument; event bindings pass the DOM event second, as `(state, event)`. A body-only function referenced from a reactive position is wrapped in `computed()` instead, so it re-evaluates when the state it reads changes.

Functions marked `timing: "server"` are a separate mechanism: a plain `$src`/`$export` entry with no `$prototype`, executed across the RPC boundary. See [Timing](/docs/framework/concepts/timing).

## Rules

- `body` and `$src` are mutually exclusive, and declaring both is a compile-time error.
- `state` is always reachable from a body. `arguments`/`parameters` bind by name: a parameter named `state` gets the state, any other name gets the event.
- `this` is never used. All component state goes through the `state` proxy.
- `$export` defaults to the entry's key name; sidecar exports must be named exports.
- Function entries use `camelCase` names, like all state entries.
- Only `$prototype: "Function"` may point `$src` at a `.js` file. Other prototypes require a `.class.json` (see [Data prototypes](/docs/framework/concepts/data-prototypes)).

## Related

- [Expressions](/docs/framework/concepts/expressions): the declarative rung below functions
- [Statements](/docs/framework/concepts/statements): structured bodies without JavaScript
- [Timing](/docs/framework/concepts/timing): server functions and the RPC boundary
- [Components](/docs/framework/concepts/components): where state and functions are declared
- [Code editing in Studio](/docs/studio/logic/code): the editor for bodies and sidecars
