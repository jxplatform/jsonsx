---
title: "Styling"
description: "Inline styles, nested CSS selectors, and named media breakpoints in Jx."
spec:
  - spec.md#9
code:
  - packages/runtime/src/runtime.ts
  - packages/runtime/src/css.ts
  - packages/compiler/src/shared.ts
---

# Styling

> **Studio writes this format for you.** The [Design](/docs/studio/design) inspector and **Project Styles** produce everything below. This page documents the style model for hand-editing and reference.

Styles are JSON objects. Property names are the CSS ones in camelCase, the same spelling the CSSOM uses, so `background-color` is written `backgroundColor`.

## Inline styles

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

## Nested CSS selectors

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

Inline properties apply directly to the element. Nested rules are emitted as a scoped `<style>` block keyed on a **generated class**, `.<tagName>-<n>`, which the build also puts on the element:

```html
<div class="sty-card-0">…</div>
```

```css
.sty-card-0:hover {
  padding: 8px;
}
```

(You'll also see `data-jx-static` and `data-jx-prerendered` in compiled output. Those mark hydration state and are never used as CSS selectors.)

### At-rules that hold declarations

Most `@` keys wrap selectors: a [breakpoint](#named-media-breakpoints), `@supports`, `@starting-style`. Four hold plain declarations instead, and their block is emitted as written, with no selector inside and no scoping to the element that declares it: `@position-try`, `@property`, `@font-face` and `@counter-style`. The name such a rule declares is global to the document, so it is written where it is used, the way you would write it in a stylesheet:

```json
{
  "style": {
    "position-anchor": "--menu-button",
    "position-try-fallbacks": "--flip-up",
    "@position-try --flip-up": { "inset-block-start": "auto" }
  }
}
```

`@keyframes` is not one of them: its body is percentage stops, which is a third shape again.

## Named media breakpoints

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

`@--name` references named breakpoints. `@(condition)` is a literal inline media query, and the
parentheses are the query's own: a feature query keeps them (`@(min-width: 1280px)`), while a
bare media type does not, so `@(print)` emits `@media print`.

## Color-scheme variants

A `$media` entry whose value is exactly a `prefers-color-scheme` query (like `--dark` above) is a _scheme query_: its `@--dark` blocks respond both to the OS preference and to a visitor-forced scheme, and the compiler wires up `color-scheme` and no-flash persistence automatically. See [Color schemes](/docs/framework/concepts/color-schemes) for the full contract and how to build a switcher.

## Static style extraction

The compiler extracts every static `style` definition into a single `<style>` block in the document `<head>`, so a page carries one stylesheet rather than a rule per element.

## Design tokens as CSS custom properties

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

CSS custom properties cascade through the DOM, so every component can use them without importing anything.
