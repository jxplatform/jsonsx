---
title: "Elements"
description: "How element objects map to the DOM: direct property names, the attributes object, children arrays, text nodes, and protected properties."
spec:
  - spec.md#8
code:
  - packages/compiler/src/shared.ts
  - packages/runtime/src/runtime.ts
---

# Elements

> **Studio writes this format for you.** Every element you place on the canvas and edit in the [Properties panel](/docs/studio/design/properties) is stored as one of these objects, and this page documents what lands in the file.

An element definition is a JSON object describing one DOM element. Its keys are the element's real DOM property names, set directly on the created element with no translation layer in between. If a property exists on the DOM element, you can set it here.

```json
{
  "tagName": "div",
  "id": "my-element",
  "className": "container active",
  "hidden": false,
  "tabIndex": 0,
  "textContent": "Hello World"
}
```

## DOM properties

Property names follow the DOM, not HTML source: `className` (not `class`), `textContent` (not inner text), `tabIndex` (not `tabindex`). Any string-valued property may contain a `${}` template for a reactive value (see [Reactivity](/docs/framework/concepts/reactivity)), or be an object with `$ref` bound to state (see [References](/docs/framework/concepts/references)):

```json
{
  "tagName": "div",
  "textContent": "${state.count} items remaining",
  "hidden": "${state.items.length === 0}"
}
```

Two properties are **protected**: `id` and `tagName` identify the element and may not be set via `$ref` bindings.

## Custom attributes

Anything that is not a standard DOM property (`data-*`, `aria-*`, `slot`) goes in the `attributes` object, written exactly as it appears in HTML:

```json
{
  "tagName": "div",
  "attributes": {
    "data-component": "my-widget",
    "aria-label": "Interactive counter",
    "slot": "header"
  }
}
```

Attribute values may also be reactive templates (`"aria-label": "${state.count} unread messages"`).

### Boolean values

An attribute value of `true` or `false`, written directly or resolved from a `${...}` template, is
spelled the way the attribute itself is read. HTML has two rules here, and Jx picks the right one
from the attribute name, so conditional markup is just a boolean:

```json
{
  "tagName": "details",
  "attributes": { "open": "${state.expanded}" }
}
```

**Presence attributes** are read by presence alone: `open`, `disabled`, `checked`, `hidden`,
`required`, `selected` and the rest of the HTML boolean family. `true` writes the bare name, `false`
removes the attribute entirely:

```html
<details open></details>
<!-- state.expanded === false -->
<details></details>
```

:::doc-warning
Never write `"open": "false"` as a string. HTML counts _any_ value as present, `"false"` included,
so `<details open="false">` is an **open** `<details>`. This is the reason a boolean is not
stringified.
:::

**Enumerated attributes** carry the word in their text and treat an empty value as unset. Every
`aria-*` attribute is one, along with `contenteditable`, `draggable` and `spellcheck`. A boolean
writes the word for these, in both directions:

```json
{ "attributes": { "aria-expanded": "${state.open}" } }
```

```html
<div aria-expanded="true"></div>
<!-- state.open === false -->
<div aria-expanded="false"></div>
```

`popover` sits between the two families and is the one attribute worth naming. It is enumerated (its
keywords are `auto`, `manual` and `hint`), but an empty value means `auto` rather than unset, so a
boolean `true` writing the bare name happens to be right. A value the browser does not recognise
falls back to `manual`, which gives up closing on Escape and on a click outside without saying so,
and `popover="true"` is such a value. Write the keyword:

```json
{ "attributes": { "popover": "auto" } }
```

Studio reports a boolean `popover` as a problem rather than correcting it. See
[Popovers and overlays](/docs/framework/concepts/overlays).

That distinction matters for accessibility: a bare `aria-hidden` is _not_ hidden, and an omitted
`contenteditable` means "inherit from the parent" rather than `false`. Writing either as a presence
attribute would silently invert it.

A **string** is never reinterpreted in either family. `"aria-current": "false"` stays exactly that,
which is how you write the not-the-current-page marker beside `"aria-current": "page"`.

The compiled page and the live runtime apply the same rule, so a prerendered element does not change
meaning when it hydrates.

## Children

`children` is an array of element definitions, rendered in order:

```json
{
  "tagName": "div",
  "children": [
    { "tagName": "h1", "textContent": "Title" },
    { "tagName": "p", "textContent": "Content" }
  ]
}
```

A `children` array may freely mix element objects, bare text nodes, and [repeaters](/docs/framework/concepts/lists) (`$prototype: "Array"` members) or [switches](/docs/framework/concepts/switching).

## Text nodes

Bare strings and numbers are valid `children` items. They produce DOM `Text` nodes directly, with no wrapper element. This is how text with inline markup is written:

```json
{
  "tagName": "p",
  "children": ["Hello ", { "tagName": "strong", "textContent": "world" }, "!"]
}
```

That is the HTML `<p>Hello <strong>world</strong>!</p>`. Template strings in text nodes are reactive: `{ "children": ["Welcome, ${state.name}!"] }`.

## Slots

Custom elements use the standard HTML `slot` mechanism for content composition. A component's template places `<slot>` elements; content the instance provides is distributed to them by `name`:

```json
{
  "tagName": "card-component",
  "children": [
    {
      "tagName": "header",
      "children": [{ "tagName": "slot", "attributes": { "name": "header" } }]
    },
    { "tagName": "main", "children": [{ "tagName": "slot" }] }
  ]
}
```

A slot's own `children` act as fallback content, kept when the instance provides nothing for it.

## Annotations

Any element may carry `$title` and `$description`, developer-facing labels that never reach the DOM:

```json
{
  "tagName": "section",
  "$title": "Hero Section",
  "$description": "Primary landing area with headline and call-to-action",
  "children": []
}
```

Studio's [Outline panel](/docs/studio/design/layers) shows `$title` as the element's display name.

## How it works

The runtime creates the element with `document.createElement(tagName)`, assigns each listed property directly on the element object, and writes `attributes` entries with `setAttribute`. Properties whose values are templates or `$ref` bindings are wrapped in reactive effects, so the DOM updates whenever the underlying state changes. Slot distribution is manual light-DOM distribution: host children are captured before the template renders, then moved to matching `<slot>` elements by `name`.

## Rules

- `tagName` is required on every element definition.
- `id` and `tagName` are protected, and never settable via `$ref`.
- Standard DOM properties go at the top level; everything else (`data-*`, `aria-*`, `slot`) goes in `attributes`.
- Bare strings and numbers in `children` become text nodes; when _all_ children are bare strings with no element siblings, prefer `textContent` instead.
- `$title` and `$description` are plain strings: not reactive, not `$ref`-resolvable, never applied to the DOM.
- Styling does not use DOM properties. The `style` object has its own grammar, covered in [Styling](/docs/framework/concepts/styling).

## Related

- [Documents](/docs/framework/concepts/documents): the file these objects live in
- [Reactivity](/docs/framework/concepts/reactivity): `${}` templates in any string property
- [Styling](/docs/framework/concepts/styling): the `style` object, nesting, and breakpoints
- [Lists and iteration](/docs/framework/concepts/lists): repeaters inside `children`
- [Properties panel](/docs/studio/design/properties): the Studio surface that edits these objects
