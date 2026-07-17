---
title: "Reactivity"
description: "Template strings, signals, computed values, and reactive bindings in Jx."
---

# Reactivity

> **Studio writes this format for you.** The State, Data, and Events panels ([Script & logic](/docs/studio/logic)) generate everything below — this page documents the model if you want to hand-edit or understand it.

Template literal syntax `${}` is valid **anywhere a string value appears** in the document tree. All reactivity is powered by `@vue/reactivity`.

## Reactive Element Properties

```json
{
  "tagName": "div",
  "textContent": "${state.count} items remaining",
  "className": "${state.active ? 'card active' : 'card'}",
  "hidden": "${state.items.length === 0}"
}
```

## Reactive Style Properties

```json
{
  "tagName": "div",
  "style": {
    "color": "${state.score > 90 ? 'gold' : 'inherit'}",
    "opacity": "${state.loading ? '0.5' : '1'}"
  }
}
```

## Reactive Attributes

```json
{
  "tagName": "button",
  "attributes": {
    "aria-label": "${state.count} unread messages",
    "data-state": "${state.status}"
  }
}
```

## How It Works

When the compiler encounters `${}` in any string-valued property, it wraps the binding in a reactive effect:

```js
watchEffect(() => {
  el.textContent = `${state.count} items remaining`;
});
```

Dependencies are tracked automatically by Vue when `state.*` properties are read.

## `$ref` vs Template Strings

| Pattern                       | Use when                                          |
| ----------------------------- | ------------------------------------------------- |
| `{ "$ref": "#/state/label" }` | Binding to a named signal used in multiple places |
| `"${state.count} items"`      | Inline computed binding used in exactly one place |

## Computed State

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

## Signal Access in JavaScript

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

No `.get()` or `.set()` calls. No `this`. All component state is accessed via `state`.

## Web API Prototypes

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
