---
title: "State & Signals in Studio — Jx Suite"
description: "Master JX state and reactivity: reactive values, computed properties, event handlers, $ref bindings, data sources, and the signals panel."
---

# State & Reactivity in Studio

> For the underlying reactivity system, see [Reactivity](/docs/reactivity).

JX state is reactive by default — powered by @vue/reactivity. Change a value, and every template expression that references it updates automatically. No manual DOM manipulation.

## State Shape Decision Tree

The shape of a state entry determines its behavior. No flags needed — JX detects the type from the value's structure:

| Shape       | Detected By                    | Becomes                      | Example                                                              |
| ----------- | ------------------------------ | ---------------------------- | -------------------------------------------------------------------- |
| Naked value | Scalar, array, or plain object | `ref()` — reactive value     | `"count": 0`                                                         |
| Typed value | `{ type, default }`            | `ref()` — typed reactive     | `"name": { "type": "string", "default": "" }`                        |
| Computed    | String containing `${}`        | `computed()` — derived value | `"label": "${state.count} items"`                                    |
| Function    | `$prototype: "Function"`       | Event handler or computed    | `"increment": { "$prototype": "Function", "body": "state.count++" }` |
| Data source | `$prototype` with URL          | Reactive async value         | `"posts": { "$prototype": "Data", "$src": "./posts.json" }`          |

## Template Expressions

Template expressions `${...}` work anywhere a string value appears — textContent, style properties, attributes. Dependencies are tracked automatically.

```json
// In textContent
"textContent": "${state.count} items"

// In style properties
"backgroundColor": "${state.isActive ? 'var(--color-accent)' : 'transparent'}"

// In attributes
"attributes": { "href": "${state.url}" }

// Computed state entries
"greeting": "${state.name}, you clicked ${state.count} times"
```

## Event Handlers & $ref

- **Defining Handlers** — Define a function in state with `$prototype: "Function"` and a `body` string. The body has access to `state` and `event` (the DOM event object).
- **Binding with $ref** — Bind a handler to an event: `"onclick": { "$ref": "#/state/handleClick" }`. The `#/state/` prefix points to the document's state object.
- **Events Panel** — The Events tab in the inspector shows all event handlers for the selected element. Edit function bodies inline with Monaco. See which state functions are bound to which events.
- **Signals Panel** — The Signals tab shows all state entries. Add, edit, or remove signals. Change types. See computed dependencies. Each entry shows its detected type with a badge.

## Data Sources

Data sources fetch external data and make it available as reactive state. They're defined with `$prototype` and a URL:

```json
"state": {
  "posts": {
    "$prototype": "Data",
    "$src": "./posts.json"
  },
  "user": {
    "$prototype": "Request",
    "url": "/api/user",
    "method": "GET"
  }
}
```

Use data sources for content collections (blog posts, products), API data, or any external data that drives your UI. The data is reactive — when it loads or changes, the UI updates.

---

**Next:** [Site Building](/docs/studio-site-building)
