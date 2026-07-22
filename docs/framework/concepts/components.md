---
title: "Components"
description: "How Jx components work: self-describing JSON, state management, external sidecars, and custom elements."
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

Custom elements render to the light DOM (no Shadow DOM). Style scoping uses `data-jx` attributes.

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
