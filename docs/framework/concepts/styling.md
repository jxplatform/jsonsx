---
title: "Styling"
description: "Inline styles, nested CSS selectors, and named media breakpoints in Jx."
spec:
  - spec.md#9
code:
  - packages/runtime/src/runtime.ts
  - packages/compiler/src/shared.ts
---

# Styling

> **Studio writes this format for you.** The [Design](/docs/studio/design) inspector and Stylebook produce everything below — this page documents the style model for hand-editing and reference.

Jx uses JSON objects for styling with camelCase CSS property names, nested selectors, and named media breakpoints.

## Inline Styles

The `style` property accepts a JSON object:

```json
{
  "tagName": "div",
  "style": {
    "backgroundColor": "blue",
    "marginTop": "10px",
    "fontSize": "16px",
    "display": "flex"
  }
}
```

## Nested CSS Selectors

Keys beginning with `:`, `.`, `&`, or `[` are treated as nested selectors:

```json
{
  "style": {
    "backgroundColor": "blue",
    ":hover": {
      "backgroundColor": "darkblue",
      "cursor": "pointer"
    },
    ".child": { "color": "white" },
    "&.active": { "outline": "2px solid white" }
  }
}
```

Inline properties apply directly to the element. Nested rules are emitted as a scoped `<style>` block using a generated `data-jx` attribute selector.

## Named Media Breakpoints

Declare breakpoints at root level with `$media`:

```json
{
  "$media": {
    "--sm": "(min-width: 640px)",
    "--md": "(min-width: 768px)",
    "--lg": "(min-width: 1024px)",
    "--dark": "(prefers-color-scheme: dark)"
  }
}
```

Use `@--name` keys in any style object:

```json
{
  "style": {
    "fontSize": "14px",
    "@--md": { "fontSize": "16px" },
    "@--dark": { "color": "#ccc" },
    "@(min-width: 1280px)": { "fontSize": "18px" }
  }
}
```

`@--name` references named breakpoints. `@(condition)` is a literal inline media query.

## Color-Scheme Variants

A `$media` entry whose value is exactly a `prefers-color-scheme` query (like `--dark` above) is a _scheme query_: its `@--dark` blocks respond both to the OS preference and to a visitor-forced scheme, and the compiler wires up `color-scheme` and no-flash persistence automatically. See [Color schemes](/docs/framework/concepts/color-schemes) for the full contract and how to build a switcher.

## Static Style Extraction

The compiler extracts all static `style` definitions into a single `<style>` block in the document `<head>`, producing clean, efficient CSS output.

## Design Tokens with CSS Custom Properties

Define tokens in your `project.json` `style` block and use them everywhere:

```json
{
  "style": {
    ":root": {
      "--color-primary": "#3b82f6",
      "--color-surface": "#ffffff",
      "--font-sans": "Inter, system-ui, sans-serif"
    }
  }
}
```

Components reference tokens with standard `var()`:

```json
{
  "style": {
    "color": "var(--color-primary)",
    "fontFamily": "var(--font-sans)"
  }
}
```

CSS custom properties cascade naturally through the DOM — every component can use them without importing anything.
