---
title: "Components"
description: "How Jx components work: self-describing JSON, state management, external sidecars, custom elements, and the shadow-DOM opt-in."
spec:
  - spec.md#16.6
code:
  - packages/compiler/src/shadow.ts
  - packages/compiler/src/targets/compile-element.ts
---

# Components

> **Studio writes this format for you.** This page documents the underlying JSON — useful when you want to hand-edit a file, review a diff, or understand what the visual tools produce.

A Jx component is a single `.json` file. All state, computed values, and functions are declared in `state`. Simple components need no sidecar file.

## Self-Describing Components

```
{
  "$id": "Counter",
  "state": {
    "count": 0,
    "increment": {
      "$prototype": "Function",
      "body": "state.count++"
    }
  },
  "tagName": "my-counter",
  "children": [
    { "tagName": "span", "textContent": "${state.count}" },
    { "tagName": "button", "textContent": "+", "onclick": { "$ref": "#/state/increment" } }
  ]
}
```

## State Shapes

Every entry in `state` falls into one of four shapes, determinable by inspection:

### Shape 1 — Naked Value

A JSON scalar, array, or plain object with no reserved keys:

```
{ "state": { "count": 0, "name": "World", "tags": [] } }
```

### Shape 2 — Typed Value

An object with a `default` property and optional `type`:

```
{
  "state": {
    "count": {
      "type": { "$ref": "#/$defs/Count" },
      "default": 0,
      "description": "Current counter value"
    }
  }
}
```

### Shape 3 — Computed (Template String)

A string containing `${}` syntax:

```
{
  "state": {
    "fullName": "${state.firstName} ${state.lastName}",
    "isEmpty": "${state.items.length === 0}"
  }
}
```

### Shape 4 — Prototype (`$prototype`)

An object with `$prototype` for functions and data sources:

```
{
  "state": {
    "increment": {
      "$prototype": "Function",
      "body": "state.count++"
    },
    "userData": {
      "$prototype": "Request",
      "url": "/api/users/",
      "method": "GET"
    }
  }
}
```

## External Sidecars

When functions grow complex, extract them to a `.js` file:

```
{
  "state": {
    "increment": { "$prototype": "Function", "$src": "./counter.js" },
    "decrement": { "$prototype": "Function", "$src": "./counter.js" }
  }
}
```

```
export function increment(state) {
  state.count++;
}
export function decrement(state) {
  state.count = Math.max(0, state.count - 1);
}
```

The first parameter is always `state` — the component's reactive scope. `this` is never used.

## Custom Elements

A component whose `tagName` contains a hyphen is a custom element:

```
{
  "tagName": "user-card",
  "state": {
    "username": "Guest",
    "status": "offline"
  },
  "children": [{ "tagName": "h3", "textContent": "${state.username}" }]
}
```

Custom elements render to the **light DOM**. Nothing attaches a shadow root, so scoping is done with selectors instead: a component's own rules are prefixed with its tag name, and a nested element with its own `style` gets a generated `.<tagName>-<n>` class.

```css
sty-card {
  color: red;
}
sty-card .inner {
  color: blue;
}
```

:::doc-note
This cuts both ways, and it's worth knowing which. Your page CSS **can** reach into a component and restyle it — handy when you want it, and the reason a stray global rule can change a component you didn't touch. There's no encapsulation boundary to stop either one.
:::

## Opting into a shadow root

If you want that boundary, ask for it per component:

```json
{
  "tagName": "sd-card",
  "$shadow": "open",
  "style": { "border": "1px solid", "& .inner": { "color": "blue" } },
  "children": [
    { "tagName": "div", "className": "inner", "children": ["hello"] },
    { "tagName": "slot" }
  ]
}
```

Or for the whole project, with `"defaults": { "shadow": "open" }` in `project.json`. A component's own `$shadow` always wins — including `"$shadow": false`, which is how you keep one component in the light DOM when everything else moved.

The build emits a **declarative shadow root**, so the component paints correctly before any JavaScript runs:

```html
<sd-card>
  <template shadowrootmode="open">
    <link rel="stylesheet" href="/components/sd-card.css" />
    <div class="inner">hello</div>
    <slot></slot>
  </template>
  <p>your slotted content, out here where the slot can project it</p>
</sd-card>
```

### What changes

|                           | Light DOM (default)                      | `$shadow`              |
| ------------------------- | ---------------------------------------- | ---------------------- |
| Page CSS reaches in       | yes                                      | no                     |
| `<slot>`                  | emulated — children are moved into place | real slot distribution |
| Your styles are scoped by | the tag name                             | `:host`                |
| Stylesheet lives in       | the page `<head>`                        | the shadow root        |

**Slots are the difference that matters.** The light-DOM emulation _moves_ your children into the component's rendered tree. A real slot leaves them where they are and projects them — so they stay your page's children, your page's CSS still styles them, and the component reaches them with `::slotted()`.

:::doc-tip
Write `:host` in your styles either way. In a shadow component it stays `:host`; in a light one the build turns it into the tag name, and `:host(.wide)` into `sd-card.wide`. That means the same style object works in both modes, so flipping `$shadow` doesn't silently break your CSS.
:::

`closed` works too, and means what the standard says: nothing outside can reach the root, not even your own scripts via `element.shadowRoot`. Use it when you mean it.

## Props and Encapsulation

Props are passed via `$props` on an instance node — the only mechanism for crossing component boundaries. Register the component in `$elements` and instantiate it by its custom-element tag:

```
{
  "$elements": { "my-card": { "$ref": "./card.json" } },
  "children": [
    {
      "tagName": "my-card",
      "$props": {
        "title": "Static string",
        "count": { "$ref": "#/state/count" }
      }
    }
  ]
}
```

Signal scope is bounded at the component level. No implicit scope leaking.
