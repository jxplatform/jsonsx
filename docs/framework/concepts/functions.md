---
title: "Functions and sidecars"
description: "Function prototype entries in Jx: inline handlers, computed bodies, external .js sidecars, and how JavaScript reads and writes state."
spec:
  - spec.md#4.2
  - spec.md#4.3
  - spec.md#5.5
---

# Functions and sidecars

> **Studio writes this format for you.** The Monaco editor behind every function body ([Code editing](/docs/studio/logic/code)) reads and writes these entries — this page documents the JSON and the JavaScript contract around it.

A Function entry is a `state` entry with `$prototype: "Function"` — the top rung of the escalation ladder, where logic becomes real JavaScript. Its code lives either inline in a `body` or in an external `.js` **sidecar** file named by `$src`. Prefer [expressions](/docs/framework/concepts/expressions) and [statements](/docs/framework/concepts/statements) first; reach for a function when structure runs out.

The smallest complete function — an inline handler:

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

A `body` string is a raw function body. `state` is always in scope; `arguments` names any additional parameters — an event handler names `event`:

```json
{
  "handleInput": {
    "$prototype": "Function",
    "arguments": ["event"],
    "body": "state.value = event.target.value"
  }
}
```

## Inline computed values

A function with only a `body` (no `arguments`) that returns a value acts as a computed — the framework wraps it in `computed()` when it detects the entry is referenced reactively:

```json
{
  "titleClass": {
    "$prototype": "Function",
    "body": "return state.score >= 90 ? 'gold' : 'silver'"
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

## Structured bodies

A `body` may also be a JSON array of statements instead of a source string — multi-step logic that stays inspectable and visually editable. That form has its own page: [Statements](/docs/framework/concepts/statements).

## State access from JavaScript

Inside `body` strings and sidecar files, `state` is the component's reactive scope — a proxy over every declared state entry and function. Read and write it directly; there are no `.get()`/`.set()` calls:

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

Every write triggers the bindings that read that value — see [Reactivity](/docs/framework/concepts/reactivity). `this` is never used in Jx-managed code; all component access goes through `state`.

## Declaring the interface

Optional metadata makes a function legible to tooling:

| Property      | Description                                                          |
| ------------- | -------------------------------------------------------------------- |
| `arguments`   | Parameter names as plain strings (after the implicit `state`)        |
| `parameters`  | CEM-compatible parameter objects — richer alternative to `arguments` |
| `returns`     | JSON Schema describing the return value                              |
| `emits`       | CEM `Event` objects this function dispatches                         |
| `description` | Documentation string, surfaced in Studio's completions               |

## How it works

At runtime, the scope builder recognizes the `$prototype: "Function"` shape and turns each entry into a callable on the reactive scope. Exports and bodies are invoked with `state` as their first argument; event bindings pass the DOM event second — `(state, event)`. A body-only function referenced from a reactive position is wrapped in `computed()` instead, so it re-evaluates when the state it reads changes.

Functions marked `timing: "server"` are a separate mechanism — a plain `$src`/`$export` entry with no `$prototype`, executed across the RPC boundary. See [Timing](/docs/framework/concepts/timing).

## Rules

- `body` and `$src` are mutually exclusive — declaring both is a compile-time error.
- The first parameter is always `state`; `arguments`/`parameters` name only what follows it.
- `this` is never used. All component state goes through the `state` proxy.
- `$export` defaults to the entry's key name; sidecar exports must be named exports.
- Function entries use `camelCase` names, like all state entries.
- Only `$prototype: "Function"` may point `$src` at a `.js` file — other prototypes require a `.class.json` (see [Data prototypes](/docs/framework/concepts/data-prototypes)).

## Related

- [Expressions](/docs/framework/concepts/expressions) — the declarative rung below functions
- [Statements](/docs/framework/concepts/statements) — structured bodies without JavaScript
- [Timing](/docs/framework/concepts/timing) — server functions and the RPC boundary
- [Components](/docs/framework/concepts/components) — where state and functions are declared
- [Code editing in Studio](/docs/studio/logic/code) — the editor for bodies and sidecars
