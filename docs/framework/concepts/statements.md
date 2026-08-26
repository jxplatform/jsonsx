---
title: "Statements"
description: "Structured function bodies in Jx: the statement kinds, how they lower to JavaScript, and when to use statements over expressions or raw code."
spec:
  - spec.md#20
---

# Statements

> **Studio writes this format for you.** The statement editor ([Statements](/docs/studio/logic/statements)) builds these bodies as visual step cards, and this page documents the JSON those cards write to disk.

A [Function entry](/docs/framework/concepts/functions)'s `body` may be a **JSON array of statements** instead of a JavaScript source string. Each statement is one step; steps run top to bottom, exactly like the statement list inside a JavaScript function, but as structure, so tooling can validate, inspect, and edit every step.

The smallest complete structured body mutates, then notifies:

```json
{
  "addItem": {
    "$prototype": "Function",
    "body": [
      { "operator": "push", "target": { "$ref": "#/state/items" }, "value": "New item" },
      { "dispatchEvent": "items-changed" }
    ]
  }
}
```

There are four statement kinds, each reusing a web-platform name:

| Kind       | Shape                                                     | Source of the name                   |
| ---------- | --------------------------------------------------------- | ------------------------------------ |
| Expression | a bare expression node (mutation or `call`)               | ECMAScript ExpressionStatement       |
| Branch     | `{ "if", "then", "else"? }`                               | JSON Schema conditional keywords     |
| Multiway   | `{ "$switch", "cases", "default"? }`                      | Element-level `$switch`, ECMA switch |
| Dispatch   | `{ "dispatchEvent", "detail"?, "bubbles"?, "composed"? }` | WHATWG DOM `dispatchEvent`           |

## Expression statements

Any mutating [expression node](/docs/framework/concepts/expressions), or a `call`, stands alone as a step. No wrapper key; the node appears bare in the array:

```json
{ "operator": "+=", "target": { "$ref": "#/state/count" }, "value": 1 }
```

To capture a result, make the step an assignment whose `value` is a `call` node. There is no dedicated capture field:

```json
{
  "operator": "=",
  "target": { "$ref": "#/state/total" },
  "value": { "operator": "call", "target": { "$ref": "#/state/computeTotal" } }
}
```

## Branches

`if` holds a **pure** expression operand; `then` and `else` hold statement lists. `else` is optional:

```json
{
  "if": { "operator": ">", "target": { "$ref": "#/state/cart/length" }, "value": 10 },
  "then": [{ "dispatchEvent": "cart-full" }],
  "else": [{ "operator": "call", "target": { "$ref": "#/state/refreshTotals" } }]
}
```

## Multiway branches

`$switch` mirrors the element-level [`$switch`](/docs/framework/concepts/switching) in statement position: the discriminant is a pure operand, `cases` maps its **string form** to statement lists, and the optional `default` runs when no key matches:

```json
{
  "$switch": { "$ref": "#/state/status" },
  "cases": {
    "error": [{ "dispatchEvent": "load-failed" }],
    "ready": [{ "operator": "=", "target": { "$ref": "#/state/visible" }, "value": true }]
  },
  "default": []
}
```

## Dispatching events

`dispatchEvent` fires a DOM `CustomEvent`, and the statement's other keys mirror `CustomEventInit`. `detail` may be a literal, a `$ref`, or an expression node:

```json
{
  "dispatchEvent": "cart-changed",
  "detail": { "$ref": "#/state/cart" },
  "bubbles": true,
  "composed": true
}
```

The event dispatches from the handler's `event.currentTarget` (or the component instance in compiled custom elements). Declare the events a function fires in its `emits` array so Studio can autocomplete them.

## Parameters

A structured body follows the named-formula pattern. Without `parameters`, the entry is an event handler, and statements see `state` and the `event#/` scheme. With `parameters`, it is a callable invoked positionally, its arguments bound to `$args/` names:

```json
{
  "addToCart": {
    "$prototype": "Function",
    "parameters": ["item"],
    "body": [
      {
        "operator": "push",
        "target": { "$ref": "#/state/cart" },
        "value": { "$ref": "$args/item" }
      }
    ]
  }
}
```

## Statements, expressions, or a body string?

The escalation ladder continues inside Shape 4. Prefer the least powerful form:

| Form                          | Use when                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------- |
| A single `$expression`        | One operation: toggle, increment, push, a computed value                          |
| `body` as a statement array   | Multiple steps, branching, or dispatching events, still with no code              |
| `body` as a JavaScript string | Loops, `await` chains, try/catch, browser APIs: anything statements can't express |

A statement body stays fully analyzable and visually editable; a source string is opaque to tooling. Reach for the string only when structure genuinely runs out.

## How it works

One engine serves both halves: an interpreter (`runStatements`) executes statement arrays directly against the reactive `state` proxy, and a compiler (`compileStatements`) emits the genuine ECMAScript forms: `if`/`else` statements, a `switch` over the discriminant's string form, and `dispatchEvent(new CustomEvent(type, init))`. The emitted function is identical in shape to a hand-written handler, so [reactivity](/docs/framework/concepts/reactivity) tracking works unchanged.

Statements execute sequentially. A step whose value is a promise is awaited before the next step runs, giving async/await semantics without writing `await`.

## Rules

- A `body` is either a statement array or a source string, one representation per entry.
- Branch tests (`if`) and `$switch` discriminants are **pure** operands: no mutations, no `call` to a mutating entry.
- `$switch` matches `String(discriminant)` against `cases` keys, because JSON keys are strings.
- Statements run in order; thenable results are awaited before the next step.
- There is no capture field; assign a `call`'s result with an `=` statement.
- `dispatchEvent` needs a dispatch target; outside a handler (no `event`), a compiled custom element dispatches from the component instance.
- Declare dispatched events in `emits`, which is the declaration tooling reads.

## Related

- [Expressions](/docs/framework/concepts/expressions): the nodes statements are built from
- [Functions and sidecars](/docs/framework/concepts/functions): the entries that own a `body`
- [Switching](/docs/framework/concepts/switching): `$switch` at the element level
- [Statements in Studio](/docs/studio/logic/statements): the visual step editor
- [Code editing in Studio](/docs/studio/logic/code): the JavaScript escape hatch
