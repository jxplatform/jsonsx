---
title: "Color schemes"
description: "Declare light and dark variants of a design and let visitors force either scheme with the auto/light/dark contract."
spec:
  - spec.md#9.4
  - spec.md#9.5
code:
  - packages/runtime/src/runtime.ts
  - packages/compiler/src/shared.ts
  - packages/compiler/src/site/site-build.ts
---

# Color schemes

A Jx design can ship light and dark variants of its tokens, follow the visitor's OS preference by default, and still let the visitor force either scheme with a switcher. The whole mechanism builds on [named media breakpoints](/docs/framework/concepts/styling#named-media-breakpoints) — no separate theme system.

## Declaring scheme support

Add a **scheme query** to `$media` in `project.json` — an entry whose value is exactly a `prefers-color-scheme` query:

```json
{
  "$media": {
    "--md": "(min-width: 768px)",
    "--dark": "(prefers-color-scheme: dark)"
  }
}
```

Then override any design token (or any style property) per scheme with an `@--dark` block. Convention: author the light values as the base and the dark values as overrides.

```json
{
  "style": {
    "--color-bg": "#ffffff",
    "--color-text": "#18181b",
    "@--dark": {
      "--color-bg": "#0a0a0a",
      "--color-text": "#fafafa"
    }
  }
}
```

`@--dark` blocks work in component and element styles too, exactly like responsive breakpoints:

```json
{
  "tagName": "div",
  "style": {
    "boxShadow": "0 2px 8px rgba(0,0,0,0.12)",
    "@--dark": { "boxShadow": "0 2px 8px rgba(0,0,0,0.5)" }
  }
}
```

## What declaring a scheme query does

Declaring a scheme query opts the site into the forced-scheme contract:

- Every `@--dark` block is emitted twice: once inside `@media (prefers-color-scheme: dark)` (applies in **auto** mode), and once under `:root[data-color-scheme="dark"]` (applies when the scheme is **forced**). Both copies are specificity-neutral, so your cascade is unchanged.
- `color-scheme: light dark` is declared on `:root`, with forced-mode overrides — native form controls and scrollbars follow along.
- A tiny inline script is injected at the top of `<head>` that restores the visitor's persisted choice before first paint, so a forced scheme never flashes.

## The visitor override contract

Two constants make up the contract:

| Constant            | Where                 | Meaning                                                 |
| ------------------- | --------------------- | ------------------------------------------------------- |
| `data-color-scheme` | attribute on `<html>` | `"light"` or `"dark"` forces that scheme; absent = auto |
| `jx-color-scheme`   | `localStorage` key    | persisted forced scheme; absent = auto                  |

A switcher only needs to keep the two in sync. Cycling auto → light → dark:

```js
const next = { auto: "light", light: "dark", dark: "auto" }[current];
if (next === "auto") {
  localStorage.removeItem("jx-color-scheme");
  document.documentElement.removeAttribute("data-color-scheme");
} else {
  localStorage.setItem("jx-color-scheme", next);
  document.documentElement.setAttribute("data-color-scheme", next);
}
```

The pre-paint script (injected automatically) reads the storage key on the next load, so the choice sticks across pages and visits.

:::doc-note
Only _pure_ scheme queries participate: `(prefers-color-scheme: dark)` with nothing else attached. A compound query like `(prefers-color-scheme: dark) and (min-width: 768px)` compiles as a plain media query and does not respond to the forced attribute.
:::

:::doc-tip
Studio shows an Auto/Light/Dark control in the context bar's **Context** popover whenever the project declares a scheme query, and the design token editor can author the `@--dark` values for you.
:::
