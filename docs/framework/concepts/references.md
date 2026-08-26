---
title: "References"
description: "$ref bindings in Jx: JSON Pointer syntax, the reference schemes, reactive bindings, the event# scheme, and resolution order."
spec:
  - spec.md#7
  - spec.md#19.5
code:
  - packages/runtime/src/pointer.ts
---

# References

> **Studio writes this format for you.** Switching any bindable field to **$ref** mode with its field-mode button ([Formulas and expressions](/docs/studio/logic/formulas)) writes the `$ref` objects on this page.

A reference is an object with a single `$ref` key whose string value points at something declared elsewhere: a state entry, a global, an iteration item, or another file. The path **is JSON Pointer syntax** (RFC 6901, a `#`-fragment of `/`-separated tokens), but the semantics are Jx-specific: a `$ref` reads a live value off the reactive scope, it does not substitute a schema.

:::doc-warning
**`/` is the only separator.** A token runs to the next `/`, so `"#/state/user/name"` walks `state` → `user` → `name`. Escapes work as RFC 6901 specifies, with `~1` a literal `/` and `~0` a literal `~`, so `"#/state/a~1b"` reaches the key `a/b`.

Before 0.5.0 a dot separated segments too, so `"#/state/a/b.c"` walked three levels. That rule was not part of JSON Pointer. If you have a ref relying on it, write it with `/`.
:::

```json
{
  "tagName": "p",
  "textContent": { "$ref": "#/state/count" }
}
```

## Reference schemes

The prefix of the `$ref` string selects where the lookup happens:

| Scheme           | Example                 | Resolves to                                                                                                  |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Internal `state` | `"#/state/count"`       | Value or handler in the current document's `state`                                                           |
| Window global    | `"window#/currentUser"` | `window.currentUser`                                                                                         |
| Document global  | `"document#/appConfig"` | `document.appConfig`                                                                                         |
| Parent scope     | `"parent#/sharedState"` | Named value passed via `$props`                                                                              |
| Map context      | `"$map/item"`           | Current item in a repeater iteration                                                                         |
| Map index        | `"$map/index"`          | Current index in a repeater iteration                                                                        |
| Event context    | `"event#/target/value"` | Property path on the handler event (expressions)                                                             |
| External file    | `"./other.json"`        | A component document, for `$switch` cases and `$elements` registration, not a bare `children` node (see §13) |

Paths navigate nested data with further `/` segments: `"#/state/user/name"`, `"$map/item/title"`. A numeric index is just a segment: `"#/state/items/0"`.

:::doc-note
RFC 6901 excludes only `/` and `~` from a token, so a state key containing any other character, such as a dot, a space or a hyphen, is addressable as one segment. Jx does not restrict this, because doing so would depart from the standard, but Studio's **From data…** picker lists your state signals and cannot author such a key today. Refs like these are written by hand.
:::

## Reactive bindings

When a `$ref` resolves to a reactive state entry or computed value, the binding is live, and the DOM property updates automatically whenever the value changes. The same syntax binds behavior: pointing an event property at a Function entry attaches it as the handler.

```json
{
  "tagName": "button",
  "textContent": "+",
  "onclick": { "$ref": "#/state/increment" }
}
```

## `$ref` or template string?

Both bind reactively; they differ in intent:

| Pattern                       | Use when                                                |
| ----------------------------- | ------------------------------------------------------- |
| `{ "$ref": "#/state/label" }` | Binding to a named value, referenced in multiple places |
| `"${state.count} items"`      | Inline computed binding used in exactly one place       |

Prefer `${}` for single-use bindings and `$ref` for reused or named values (see [Reactivity](/docs/framework/concepts/reactivity)).

## The `event#` scheme

Inside a declarative [expression](/docs/framework/concepts/expressions) used as an event handler, `event#/` reads a property path off the event itself, with no function body required:

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

## Resolution

The leading token selects exactly one source. It is scheme dispatch rather than a cascading fallback:

1. `$map/` is the iteration context
2. `$reduce/acc` is the fold accumulator ([expression](/docs/framework/concepts/expressions) `reduce` only)
3. `$args/` is named-formula parameters (callable bodies only)
4. `event#/` is the handler event context (handler position only)
5. `#/state/` is the current document's scope (which already includes `$props`, merged in place)
6. `parent#/` resolves against that same merged scope
7. `window#/` and `document#/` reach the corresponding global object

A `#/state/…` miss does **not** fall through to `window`/`document`; those are reachable only through an explicit `window#/` or `document#/` ref. (An explicit-scheme miss reads as `undefined`; only a bare, schemeless ref falls back to `null`.)

## How it works

The runtime resolves each `$ref` at render time against the current scope: `$map/` and `parent#/` look up the enclosing iteration or prop scope, `#/state/` reads the document's reactive proxy, and deeper path segments walk nested objects step by step. Because reads happen inside reactive effects, any binding whose target changes re-runs automatically. An external `.json` `$ref` is loaded and rendered where the runtime supports it, as a [`$switch`](/docs/framework/concepts/switching) case or an `$elements` registration that backs a [component instance](/docs/framework/concepts/props-and-scope). A bare `{ "$ref": "./x.json" }` node is not (see spec §13).

## Rules

- A reference object has exactly one meaningful key: `$ref` with a string value (component instances may add `$props`).
- `id` and `tagName` are protected element properties and can never be set via `$ref`.
- `$map/` references are valid only inside a repeater's `map` template.
- `event#/` is valid only in an expression used as an event handler.
- `parent#/` resolves only names explicitly passed via `$props`; there is no implicit parent access.
- External file references resolve the whole document (via `$switch`/`$elements`); you cannot point into another file's internals, and a bare external `$ref` child is not a component instance (spec §13).

## Related

- [Reactivity](/docs/framework/concepts/reactivity): `${}` templates, the inline alternative
- [Expressions](/docs/framework/concepts/expressions): where `event#` and `$args/` live
- [Props and scope](/docs/framework/concepts/props-and-scope): `parent#/` and the component boundary
- [Lists and iteration](/docs/framework/concepts/lists): the `$map/` context
- [Formulas and expressions](/docs/studio/logic/formulas): the Studio binding menu
