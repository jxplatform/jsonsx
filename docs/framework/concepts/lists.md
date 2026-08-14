---
title: "Lists and iteration"
description: "Repeating elements from data in Jx: the Array pseudo-element, its items and map, the $map iteration context, and filtering and sorting."
spec:
  - spec.md#10
  - spec.md#10.2 # iteration context, including state.$map from a handler
code:
  - packages/compiler/src/targets/compile-element.ts
---

# Lists and iteration

> **Studio writes this format for you.** Converting an element with **Repeat…** and binding its data source ([Repeaters](/docs/studio/design/repeaters)) writes the Array pseudo-elements on this page.

A dynamic list is an **Array pseudo-element**: an object with `$prototype: "Array"` sitting inside a `children` array. It names the data (`items`) and a template (`map`) rendered once per item. The list re-renders automatically whenever the data changes.

```json
{
  "tagName": "ul",
  "children": [
    {
      "$prototype": "Array",
      "items": { "$ref": "#/state/todoList" },
      "map": { "tagName": "li", "textContent": { "$ref": "$map/item" } }
    }
  ]
}
```

## The iteration context

Inside the `map` template, the `$map/` [reference scheme](/docs/framework/concepts/references) reads the current iteration:

| Reference                  | Resolves to                          |
| -------------------------- | ------------------------------------ |
| `{ "$ref": "$map/item" }`  | The current array item               |
| `{ "$ref": "$map/index" }` | The current zero-based integer index |

Deeper paths reach into item fields — `"$map/item/title"` — and template strings inside the template can read the same context as `${$map.item.title}` or `${$map.index}`:

```json
{
  "$prototype": "Array",
  "items": { "$ref": "#/state/posts" },
  "map": {
    "tagName": "article",
    "children": [{ "tagName": "h2", "textContent": { "$ref": "$map/item/title" } }]
  }
}
```

The `map` template is an ordinary element def, so `attributes`, `id`, `className`, `style`, and event handlers all work there and can read the iteration context — which is how a list row gets a per-item link or a selected state:

```json
{
  "$prototype": "Array",
  "items": { "$ref": "#/state/posts" },
  "map": {
    "tagName": "a",
    "id": "post-${index}",
    "attributes": {
      "href": "${item.url}",
      "class": "row ${index === state.active ? 'is-active' : ''}"
    },
    "textContent": "${item.title}"
  }
}
```

## Mixing with sibling elements

The Array object is a _member_ of `children`, so it can sit among ordinary siblings — a static header row followed by a dynamic list, for example. It renders **wrapper-less**: mapped items become direct children of the parent element, with no container in between.

```json
{
  "tagName": "ul",
  "children": [
    { "tagName": "li", "textContent": "Header" },
    {
      "$prototype": "Array",
      "items": { "$ref": "#/state/todoList" },
      "map": { "tagName": "li", "textContent": { "$ref": "$map/item" } }
    }
  ]
}
```

## Reading the row from a handler

One handler serves every row. Which row invoked it is on state as `state.$map`, with `item` and `index`:

```json
{
  "state": {
    "toggle": {
      "$prototype": "Function",
      "body": "state.items[state.$map.index].done = !state.items[state.$map.index].done"
    }
  },
  "children": {
    "$prototype": "Array",
    "items": { "$ref": "#/state/items" },
    "map": {
      "tagName": "li",
      "children": [{ "tagName": "input", "onclick": { "$ref": "#/state/toggle" } }]
    }
  }
}
```

This works on the map body and on any descendant of it. A nested list shadows the outer context for handlers inside it.

## Passing a row to a component

`$props` on the map body hands each item's data to a component. Template values are bindings, so they read the current row:

```json
{
  "$prototype": "Array",
  "items": { "$ref": "#/state/posts" },
  "map": {
    "tagName": "post-card",
    "$props": { "title": "${$map.item.title}", "index": { "$ref": "$map/index" } }
  }
}
```

## Setting a property on each row

Properties that live on the DOM element rather than in markup — `value`, `checked`, `selected`,
`disabled` — go directly on the map body, the same as anywhere else. They may interpolate `$map`:

```json
{
  "$prototype": "Array",
  "items": { "$ref": "#/state/rows" },
  "map": {
    "tagName": "option",
    "value": "${$map.item.id}",
    "textContent": "${$map.item.label}"
  }
}
```

Each `<option>` gets its row's `id` as its value, so a `change` handler reads the key rather than the
label shown on screen. Put it in `attributes` instead and you get an HTML attribute, which for
`value` sets only the _default_ — the two diverge as soon as the user interacts.

## Filtering and sorting

`filter` and `sort` reference [functions](/docs/framework/concepts/functions) declared in `state`. The filter function receives each item and returns true to keep it; the sort function receives two items and returns a number, like a standard comparator:

```json
{
  "$prototype": "Array",
  "items": { "$ref": "#/state/allItems" },
  "filter": { "$ref": "#/state/isVisible" },
  "sort": { "$ref": "#/state/sortByDate" },
  "map": { "tagName": "list-item", "item": { "$ref": "$map/item" } }
}
```

Filtering and sorting never mutate the source array — they shape what renders.

## How it works

The runtime places an invisible anchor where the Array object sits, then renders the mapped items inline ahead of it. The whole render runs inside a reactive effect: when `items` (or a filter or sort dependency) changes, the previous generation of item nodes and their bindings is disposed and the list re-renders in place. Each item's template renders in a child scope carrying `$map` — the surrounding document's `state` remains fully visible inside the template.

## Rules

- The Array object must have `$prototype: "Array"`, an `items` source, and a `map` template.
- `items` must resolve to an array — a state entry, a [data prototype](/docs/framework/concepts/data-prototypes) such as a content collection, or a literal array.
- The list renders wrapper-less; give structure a container by making the _parent_ the container element (`ul`, `tbody`, a grid `div`).
- `$map/` references are valid only inside the `map` template.
- `filter` and `sort` must be `$ref`s to functions in `state`.
- The legacy form where `children` is _itself_ the Array object is still accepted; Studio normalizes it to a single array member on load.

## Related

- [References](/docs/framework/concepts/references) — the `$map/` scheme and resolution order
- [State](/docs/framework/concepts/state) — declaring the arrays lists iterate
- [Data prototypes](/docs/framework/concepts/data-prototypes) — collections and requests as `items` sources
- [Content collections](/docs/framework/site/content-collections) — site content as list data
- [Repeaters](/docs/studio/design/repeaters) — the Studio surface that writes this format
