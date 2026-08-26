---
title: "Reactivity"
description: "Template strings, signals, computed values, and reactive bindings in Jx."
spec:
  - spec.md#6
code:
  - packages/runtime/src/runtime.ts
---

# Reactivity

> **Studio writes this format for you.** The **Data** panel and the Inspector's **Logic** tab ([Logic](/docs/studio/logic)) generate everything below. This page documents the model if you want to hand-edit or understand it.

Template literal syntax `${}` is valid **anywhere a string value appears** in the document tree, not only inside `state`. Wherever you write one, the value recomputes when the state it reads changes. All reactivity is powered by `@vue/reactivity`.

A template resolves `state.propertyName` against the current component's reactive proxy, plus the iteration bindings (`$map`, `item`, `index`) where an Array map provides them.

## Reactive element properties

```json
{
  "tagName": "div",
  "textContent": "${state.count} items remaining",
  "className": "${state.active ? 'card active' : 'card'}",
  "hidden": "${state.items.length === 0}"
}
```

## Reactive style properties

```json
{
  "tagName": "div",
  "style": {
    "color": "${state.score > 90 ? 'gold' : 'inherit'}",
    "opacity": "${state.loading ? '0.5' : '1'}"
  }
}
```

## Reactive attributes

```json
{
  "tagName": "button",
  "attributes": {
    "aria-label": "${state.count} unread messages",
    "data-state": "${state.status}"
  }
}
```

## How it works

When the compiler encounters `${}` in any string-valued property, it wraps the binding in a reactive effect:

```js
watchEffect(() => {
  el.textContent = `${state.count} items remaining`;
});
```

Dependencies are tracked automatically by Vue when `state.*` properties are read.

## Choosing between `$ref` and a template string

Prefer `${}` for a single-use reactive binding, and `$ref` for a signal that is named and reused.

| Pattern                       | Use when                                          |
| ----------------------------- | ------------------------------------------------- |
| `{ "$ref": "#/state/label" }` | Binding to a named signal used in multiple places |
| `"${state.count} items"`      | Inline computed binding used in exactly one place |

## Computed state

Template strings in `state` become `computed()` values:

```json
{
  "state": {
    "firstName": "Jane",
    "lastName": "Doe",
    "fullName": "${state.firstName} ${state.lastName}"
  }
}
```

## Reading and writing state from JavaScript

Within `body` strings and external `.js` files, read and write state directly:

```js
// Read
const current = state.count;

// Write
state.count = current + 1;

// Mutate array (Vue tracks mutations)
state.items.push(newItem);

// Mutate nested object
state.user.name = "Alice";
```

There are no `.get()` or `.set()` calls and no `this`. All component state is reached through `state`.

## Prototypes for web APIs

Built-in prototypes for common web APIs:

| `$prototype`      | Web API      | Description                   |
| ----------------- | ------------ | ----------------------------- |
| `Request`         | Fetch API    | Reactive URL, debounce, abort |
| `URLSearchParams` | URL API      | Computed `.toString()`        |
| `FormData`        | FormData API | Field population              |
| `LocalStorage`    | Storage API  | Reactive persistence          |
| `SessionStorage`  | Storage API  | Session-scoped storage        |
| `IndexedDB`       | IDB API      | Store creation, CRUD          |
| `Array`           | —            | Dynamic mapped lists          |

## Timing

| Value        | When                                            |
| ------------ | ----------------------------------------------- |
| `"client"`   | Resolved at runtime in the browser (default)    |
| `"server"`   | Resolved at runtime on the server via RPC       |
| `"compiler"` | Resolved at build time, baked into emitted HTML |

## Related

- [State](/docs/framework/concepts/state) declares the signals a template reads.
- [Expressions](/docs/framework/concepts/expressions) covers what may appear inside `${}`.
- [Timing](/docs/framework/concepts/timing) covers when each value resolves.
