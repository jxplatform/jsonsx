---
title: "Building Components in Studio — Jx Suite"
description: "Learn how to build components in JX Studio: tagName, state, props, children, styling, event handlers, and the full component lifecycle."
---

# Building Components in Studio

> For the underlying JSON format, see [Component Model](/docs/components).

Every JX component is a JSON object. Learn the structure, add state, wire up events, compose children — and see it all render live on the canvas.

## Component Anatomy

A JX component is a JSON object with a standard structure. Here are the key fields:

```json
{
  "$id": "Counter",
  "tagName": "my-counter",
  "state": { ... },
  "children": [ ... ],
  "style": { ... },
  "$elements": [ ... ],
  "$media": { ... }
}
```

- **`$id`** — The component's name. Custom elements MUST contain a hyphen (e.g. "my-counter", "feature-card"). Standard HTML elements use their exact tag name.
- **`tagName`** — The root HTML element. Can be a standard element ("div", "section", "button") or a custom element ("my-counter"). Every component must have one.
- **`children`** — Array of child element definitions. Each child is itself a full element object with tagName, style, children, etc. Void elements (br, hr, img, input) cannot have children.
- **`state`** — Reactive variables scoped to this component. Values can be scalars, typed objects, computed expressions, function bodies, or data sources. Changes auto-update the DOM.

## Property Reference

| Property      | Type    | Description                                    |
| ------------- | ------- | ---------------------------------------------- |
| `tagName`     | string  | HTML tag name                                  |
| `className`   | string  | CSS class string                               |
| `textContent` | string  | Text content (supports `${state.x}` templates) |
| `hidden`      | boolean | Hide element from display                      |
| `tabIndex`    | number  | Tab order index                                |
| `attributes`  | object  | HTML attributes (href, src, aria-\*, data-\*)  |
| `style`       | object  | CSS properties (camelCase)                     |
| `children`    | array   | Child element objects                          |
| `onclick`     | $ref    | Event handler (references state function)      |

## Building a Button Component (Step by Step)

### Step 1: Create the component file

In the Files panel, right-click components/ → New File. Name it cta-button.json.

```json
{
  "$id": "CTAButton",
  "tagName": "cta-button"
}
```

### Step 2: Add state (props)

Add a state block with the props your component needs. Use the Signals panel in the inspector to add entries visually.

```json
"state": {
  "href": "/",
  "label": "Click me",
  "variant": "primary"
}
```

### Step 3: Add children and styling

Add child elements and style them. Use `${state.x}` template expressions to bind state to properties. Edit styles in the Style panel.

```json
"children": [{
  "tagName": "a",
  "attributes": { "href": "${state.href}" },
  "style": {
    "padding": "0.75rem 1.5rem",
    "backgroundColor": "var(--color-accent)",
    "color": "white",
    "borderRadius": "var(--radius)"
  },
  "textContent": "${state.label}"
}]
```

## Working in the Layers Panel

- **Add Element** — Right-click any node → Add Child. Type a tagName (e.g. "div", "button", "span"). A new element appears in the tree and on the canvas.
- **Reorder Elements** — Drag any element to reorder within its parent. Drop zones appear between siblings. The canvas updates in real-time as you drag.
- **Duplicate & Delete** — Right-click → Duplicate to clone an element. Right-click → Delete or press Delete key to remove. Ctrl+Z to undo. All operations are undoable.
- **Reparent Elements** — Drag an element onto another to reparent it. The element moves from its current parent to the target. Hold Alt while dragging to copy instead of move.

---

**Next:** [Styling & Design Tokens](/docs/studio-styling)
