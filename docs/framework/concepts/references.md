---
title: "References"
description: "$ref bindings in Jx: JSON Pointer syntax, the reference schemes, reactive bindings, the event# scheme, and resolution order."
spec:
  - spec.md#7
  - spec.md#19.5
---

# References

> **Studio writes this format for you.** Switching any bindable field to **$ref** mode with its field-mode button ([Formulas and expressions](/docs/studio/logic/formulas)) writes the `$ref` objects on this page.

A reference is an object with a single `$ref` key whose string value points at something declared elsewhere — a state entry, a global, an iteration item, or another file. References follow the JSON Reference convention (JSON Pointer, RFC 6901), so a Jx binding looks like any other `$ref` in the JSON Schema world.

```json
{
  "tagName": "p",
  "textContent": { "$ref": "#/state/count" }
}
```

## Reference schemes

The prefix of the `$ref` string selects where the lookup happens:

| Scheme           | Example                 | Resolves to                                        |
| ---------------- | ----------------------- | -------------------------------------------------- |
| Internal `state` | `"#/state/count"`       | Value or handler in the current document's `state` |
| Window global    | `"window#/currentUser"` | `window.currentUser`                               |
| Document global  | `"document#/appConfig"` | `document.appConfig`                               |
| Parent scope     | `"parent#/sharedState"` | Named value passed via `$props`                    |
| Map context      | `"$map/item"`           | Current item in a repeater iteration               |
| Map index        | `"$map/index"`          | Current index in a repeater iteration              |
| Event context    | `"event#/target/value"` | Property path on the handler event (expressions)   |
| External file    | `"./other.json"`        | Another Jx document, fully dereferenced            |

Paths navigate nested data with further `/` segments: `"#/state/user/name"`, `"$map/item/title"`.

## Reactive bindings

When a `$ref` resolves to a reactive state entry or computed value, the binding is live — the DOM property updates automatically whenever the value changes. The same syntax binds behavior: pointing an event property at a Function entry attaches it as the handler.

```json
{
  "tagName": "button",
  "textContent": "+",
  "onclick": { "$ref": "#/state/increment" }
}
```

## `$ref` or template string?

Both bind reactively; they differ in intent:

| Pattern                       | Use when                                                 |
| ----------------------------- | -------------------------------------------------------- |
| `{ "$ref": "#/state/label" }` | Binding to a named value — referenced in multiple places |
| `"${state.count} items"`      | Inline computed binding used in exactly one place        |

Prefer `${}` for single-use bindings and `$ref` for reused or named values (see [Reactivity](/docs/framework/concepts/reactivity)).

## The `event#` scheme

Inside a declarative [expression](/docs/framework/concepts/expressions) used as an event handler, `event#/` reads a property path off the event itself — no function body required:

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

`event#` is resolvable only in handler position. Referencing it from an expression that is not invoked as a handler is a compile-time error.

## Resolution order

When a reference could match more than one scheme, resolution proceeds top-down:

1. `$map/` — iteration context (highest priority)
2. `$reduce/acc` — fold accumulator ([expression](/docs/framework/concepts/expressions) `reduce` only)
3. `$args/` — named-formula parameters (callable bodies only)
4. `event#/` — handler event context (handler position only)
5. `#/state/` — current document scope
6. `parent#/` — explicitly passed props
7. `window#/` — global window properties
8. `document#/` — global document properties

## How it works

The runtime resolves each `$ref` at render time against the current scope: `$map/` and `parent#/` look up the enclosing iteration or prop scope, `#/state/` reads the document's reactive proxy, and deeper path segments walk nested objects step by step. Because reads happen inside reactive effects, any binding whose target changes re-runs automatically. A `$ref` to an external `.json` file loads and renders that document in place — the basis of [component instances](/docs/framework/concepts/props-and-scope) and [dynamic switching](/docs/framework/concepts/switching).

## Rules

- A reference object has exactly one meaningful key: `$ref` with a string value (component instances may add `$props`).
- `id` and `tagName` are protected element properties — they can never be set via `$ref`.
- `$map/` references are valid only inside a repeater's `map` template.
- `event#/` is valid only in an expression used as an event handler.
- `parent#/` resolves only names explicitly passed via `$props` — there is no implicit parent access.
- External file references resolve the whole document; you cannot point into another file's internals.

## Related

- [Reactivity](/docs/framework/concepts/reactivity) — `${}` templates, the inline alternative
- [Expressions](/docs/framework/concepts/expressions) — where `event#` and `$args/` live
- [Props and scope](/docs/framework/concepts/props-and-scope) — `parent#/` and the component boundary
- [Lists and iteration](/docs/framework/concepts/lists) — the `$map/` context
- [Formulas and expressions](/docs/studio/logic/formulas) — the Studio binding menu
