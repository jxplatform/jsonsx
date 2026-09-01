---
title: "Styling"
description: "Style objects, nested CSS selectors, and named media breakpoints in Jx."
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

## Style objects

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

Every declaration becomes a CSS rule, the base ones and the nested ones alike. The build scopes them with a **generated class**, `.<tagName>-<n>`, which it also puts on the element:

```html
<div class="sty-card-0">…</div>
```

```css
.sty-card-0 {
  background-color: blue;
}
.sty-card-0:hover {
  background-color: darkblue;
  cursor: pointer;
}
```

Base rules come first, so a state block overrides its own base property. That ordering is the whole reason nothing is written as an `style="…"` attribute: an inline declaration beats any ordinary rule, so a `backgroundColor` written on the element could never be overridden by the `:hover` block sitting next to it in the same object.

When Studio renders the page live, the same rules are delivered through the document's adopted stylesheets and scoped with `data-jx` instead of a class. Different handle, same cascade, so what you see in the canvas is what the published page does.

(You'll also see `data-jx-static` and `data-jx-prerendered` in compiled output. Those mark hydration state and are never used as CSS selectors.)

Your own `style` **attribute**, written under `attributes`, is untouched by any of this. It stays a literal attribute at inline precedence, so it wins over the object.

### Nesting goes as deep as you write it

Selector blocks and `@` blocks nest inside each other, in either order and to any depth:

```json
{
  "style": {
    "& .nav-link": { "color": "gray", ":hover": { "color": "white" } },
    "@--sm": {
      "& li:nth-of-type(2n)": { ":hover": { "opacity": "0.8" } }
    }
  }
}
```

One flattener resolves that tree for the compiler, the live preview and Studio's canvas, so all three agree about what it means. Note that `&` never reaches the browser: Jx resolves it itself, because `.child` **compounds** onto the element here (`.sty-card-0.child`) where native CSS nesting would read the same key as a descendant.

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
