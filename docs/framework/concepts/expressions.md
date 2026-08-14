---
title: "Expressions"
description: "Declarative $expression trees in Jx: the blessed operator set, aggregates, conditionals, named formulas, and where expressions may appear."
spec:
  - spec.md#19
---

# Expressions

> **Studio writes this format for you.** The **fx** mode on value fields and the formula editor ([Formulas and expressions](/docs/studio/logic/formulas)) generate everything below — this page documents the JSON if you want to hand-edit a file, review a diff, or understand what the chips represent.

An `$expression` is a computation or state change written as JSON structure instead of JavaScript source. One operator is applied to a `target`, optionally with a `value` — and because the whole thing is data, schema tooling can validate it, Studio can render it as editable chips, and the compiler can analyze it without parsing code.

The smallest complete expression — a dark-mode toggle handler:

```json
{
  "$expression": {
    "operator": "=",
    "target": { "$ref": "#/state/darkMode" },
    "value": { "operator": "!", "target": { "$ref": "#/state/darkMode" } }
  }
}
```

Expressions sit on the middle rung of the escalation ladder. Prefer the least powerful form that does the job:

| Rung                     | Power   | Use when                                  |
| ------------------------ | ------- | ----------------------------------------- |
| `$ref` binding           | Lowest  | Reading a state value                     |
| `${}` template           | Low     | Single-use computed read                  |
| `$expression`            | Mid     | Declarative computation or state mutation |
| `$prototype: "Function"` | Highest | Logic not expressible as structure        |

## Expression nodes

Every node has the same three fields:

| Field      | Required          | Description                                                              |
| ---------- | ----------------- | ------------------------------------------------------------------------ |
| `operator` | Yes               | A token from the blessed set (see below)                                 |
| `target`   | Yes               | The operand the operator acts on — a `$ref`, a literal, or a nested node |
| `value`    | By operator arity | The right-hand operand — a `$ref`, a literal, an array, or a nested node |

Nodes nest: a `target` or `value` may itself be a node, with no inner `$expression` wrapper — the wrapper appears only at the state entry or handler boundary. `counter = counter + 1` becomes:

```json
{
  "$expression": {
    "operator": "=",
    "target": { "$ref": "#/state/counter" },
    "value": { "operator": "+", "target": { "$ref": "#/state/counter" }, "value": 1 }
  }
}
```

Operands resolve exactly like any [`$ref`](/docs/framework/concepts/references) — state paths are always explicit JSON Pointers (`#/state/counter`), never raw `state.counter` strings, and `$map/` paths resolve through iteration context as elsewhere.

## Pure and mutating operators

Every operator is one of two modes, and the mode is never declared — it follows from the operator:

- **Pure** operators compute and return a value, mutating nothing: unary (`!`, `-`), arithmetic, comparison, logical, conditionals, aggregates, and the method operators below. A pure expression used as a state entry is a computed value, read via `$ref` or `${}` like any other.
- **Mutating** operators write to their `target` and return nothing: assignment (`=`, `+=`, `-=`, `*=`, `/=`) and the array-mutation methods (`push`, `pop`, `shift`, `unshift`, `splice`). A mutating expression is a handler, bound to events.

```json
{ "operator": "push", "target": { "$ref": "#/state/cart" }, "value": { "$ref": "$map/item" } }
```

```json
{
  "operator": "splice",
  "target": { "$ref": "#/state/cart" },
  "value": [{ "$ref": "$map/index" }, 1]
}
```

`push`/`unshift` take a single `value`; `splice` takes an argument array (`[start, deleteCount, ...items]`); `pop`/`shift` take none. The full operator set is closed and enumerated in the [operator reference](/docs/framework/reference/operators) — anything outside it is a compile-time error, and logic that needs more escalates to a [function body](/docs/framework/concepts/functions).

## Aggregates

`reduce`, `map`, and `filter` are pure operators over an array `target`. Their `value` is a per-item expression evaluated once per element, with the same `$map/` context that [mapped lists](/docs/framework/concepts/lists) use:

| Reference                   | Bound during aggregation        |
| --------------------------- | ------------------------------- |
| `{ "$ref": "$map/item" }`   | The current array element       |
| `{ "$ref": "$map/index" }`  | The current zero-based index    |
| `{ "$ref": "$reduce/acc" }` | The accumulator (`reduce` only) |

A cart total — `acc + item.price * item.qty`, seeded by `initial`:

```json
{
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
```

`reduce` requires `initial`; `map` and `filter` must not declare it. Aggregates compose by nesting — a `filter` node can be the `target` of a `reduce`.

## Conditionals

`?:` selects between two results. Its fields follow the ECMAScript conditional: `target` is the test, `value` the result when true, `initial` the result when false — all three required. Else-if chains nest another `?:` in `initial`.

```json
{
  "operator": "?:",
  "target": { "operator": ">", "target": { "$ref": "#/state/cart/length" }, "value": 10 },
  "value": "Cart full",
  "initial": "Keep shopping"
}
```

`switch` is value-keyed selection, mirroring element-level [`$switch`](/docs/framework/concepts/switching): `target` is the discriminant, `cases` maps its **string form** to results, `default` is optional.

```json
{
  "operator": "switch",
  "target": { "$ref": "#/state/status" },
  "cases": { "loading": "Please wait…", "error": { "$ref": "#/state/errorMessage" } },
  "default": { "$ref": "#/state/data/title" }
}
```

For fallbacks, prefer `??` (nullish coalescing) over `||` when `0`, `""`, or `false` are legitimate values — it substitutes only for `null` and `undefined`.

## Pure method operators

Genuine `String.prototype`, `Array.prototype`, and `Number.prototype` methods are operators too — the receiver in `target`, arguments in `value` (a bare scalar, or an array for multiple). Only **pure** methods qualify; where the original mutates, the ES2023 change-by-copy name stands in (`toSorted`, not `sort`).

```json
{ "operator": "toUpperCase", "target": { "$ref": "#/state/name" } }
```

```json
{ "operator": "padStart", "target": { "$ref": "#/state/code" }, "value": [6, "0"] }
```

Evaluation is null-safe: a missing receiver yields `undefined` rather than throwing. The full method table is in the [operator reference](/docs/framework/reference/operators).

## Named formulas and `call`

A pure expression entry with `parameters` is a **named formula** — a reusable computation instead of a computed value. Inside its body, parameters resolve through the `$args/` scheme:

```json
{
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
```

The `call` operator invokes it: `target` is the callee pointer, `value` the positional argument list, ordered by the declared `parameters` (omitted arguments take their `default`):

```json
{
  "operator": "call",
  "target": { "$ref": "#/state/lineTotal" },
  "value": [{ "$ref": "$map/item/price" }, { "$ref": "$map/item/qty" }]
}
```

A callee may also be a pure standard-library global through `window#/`, gated by a closed allowlist (`Math.*`, `JSON.*`, `Object.keys`/`values`/`entries`/`fromEntries`, `Number.*`, `Array.from`/`isArray`/`of`, `parseFloat`, `structuredClone`, …). Impure platform functions — `fetch`, `alert`, `Math.random`, `Date.now` — are deliberately absent; side effects belong to [Function entries](/docs/framework/concepts/functions).

```json
{
  "operator": "call",
  "target": { "$ref": "window#/Math/max" },
  "value": [{ "$ref": "#/state/a" }, { "$ref": "#/state/b" }, 0]
}
```

Formulas declared in `project.json` `state` are available on every page. A catalog of ready-made composite formulas ships with Studio's palette — see the [formula catalog](/docs/framework/reference/formulas).

## Reading the event

Handlers receive the DOM event, and the `event#/` reference scheme reads it without escalating to code — resolvable only inside an expression used as an event handler:

```json
{
  "tagName": "input",
  "oninput": {
    "$expression": {
      "operator": "=",
      "target": { "$ref": "#/state/name" },
      "value": { "$ref": "event#/target/value" }
    }
  }
}
```

## Where expressions appear

An `$expression` is valid in three positions:

1. **As a `state` entry** — a named, reusable operation. A pure entry is a computed value; a mutating entry is a handler you bind with `"onclick": { "$ref": "#/state/toggleTheme" }`, exactly like a Function entry.
2. **Inline as an event handler value** on any element, in place of a `$ref` to a function.
3. **As an element's `tagName`** — see [Choosing an element's tag](#choosing-an-elements-tag) below.

Prefer the named form when reused; the inline form for single-use handlers.

## Choosing an element's tag

Sometimes one element should be a link when it has somewhere to go and a plain box when it doesn't — wrapping the same content either way. Write the choice in `tagName`:

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
  "children": ["…your content, written once…"]
}
```

Use `switch` when there are more than two, and give it a `default` — an element with no tag can't exist:

```json
{
  "tagName": {
    "$expression": {
      "operator": "switch",
      "target": { "$ref": "#/state/level" },
      "cases": { "1": "h1", "2": "h2", "3": "h3" },
      "default": "p"
    }
  }
}
```

Two rules make this different from every other formula:

- **Every branch is a tag name, not a formula.** You choose _between_ tags; you don't compute one. That's what lets Studio tell you at authoring time that `"A LINK"` isn't a tag, instead of the page breaking in a browser.
- **The tag is decided once, when the element is created**, and isn't re-read afterwards. Changing it later would mean throwing the element away and building a new one, taking your content's focus, typed-in values and scroll position with it. If a tag needs to change in response to something, that's a `$switch` — which swaps content, not the element itself.

:::doc-note
A component's own `tagName` — the name at the top of the file — is always a plain name, as is a `$head` entry's. Those become a custom element's registered name and a tag in the page head, which can't vary per instance.
:::

## How it works

An expression lowers to the same target a `body` string would — but the function is constructed from the node tree, never parsed from a string, so no `eval` or `new Function` is involved. A mutating expression becomes a handler over the reactive `state` proxy (`(state, event) => { state.darkMode = !state.darkMode; }`); a pure expression becomes a `computed()`, recomputing whenever the state it reads changes — see [Reactivity](/docs/framework/concepts/reactivity).

References inside a node resolve in a fixed order:

```
1. $map/       — iteration context
2. $reduce/acc — fold accumulator (reduce only)
3. $args/      — named-formula parameters
4. event#/     — handler event context
5. #/state/    — current component scope
6. parent#/    — explicitly passed props
7. window#/    — global window properties
8. document#/  — global document properties
```

In production, `?:` and `switch` evaluate only the taken branch. In Studio's editor the interpreter runs with a trace that evaluates every branch, which is how each chip carries a live value badge.

## Rules

- The operator set is **closed**. An unknown operator is a compile-time error; escalate to a Function `body` instead.
- A mutating node may only appear at the handler boundary — never nested as an operand.
- Nested nodes take no `$expression` wrapper; it appears only at the entry or handler boundary.
- State operands are explicit `$ref` pointers, never raw `state.x` strings.
- `reduce` requires `initial`; `map` and `filter` must not declare it. `?:` requires `target`, `value`, and `initial`.
- `switch` matches on the discriminant's string form, because JSON keys are strings.
- `event#/` resolves only in handler position — referencing it from a non-handler entry is a compile-time error.
- `call` targets a named formula or a blessed global; call depth is capped at 64, and statically detectable call cycles are rejected.

## Related

- [Operator reference](/docs/framework/reference/operators) — every blessed token
- [Formula catalog](/docs/framework/reference/formulas) — composite formulas in Studio's palette
- [Statements](/docs/framework/concepts/statements) — multi-step bodies built from expression nodes
- [Functions and sidecars](/docs/framework/concepts/functions) — the escape hatch to real JavaScript
- [Reactivity](/docs/framework/concepts/reactivity) — how computed values track their inputs
- [Formulas and expressions in Studio](/docs/studio/logic/formulas) — the visual editor for all of this
