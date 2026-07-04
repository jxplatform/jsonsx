---
title: "Design — Jx Suite"
description: "The Design surface in Jx Studio: a live canvas at every breakpoint, a full CSS inspector, hover states, and design tokens."
---

# Design

Design is the visual canvas. Open a component or page and Studio renders it with the real runtime — pixel-identical to production — while you edit its structure and style directly.

![Jx Studio design canvas showing one component across four responsive breakpoints with a style inspector](/screenshots/mode-design.png)

## A canvas per breakpoint

Instead of one canvas you resize, Design shows a live panel for **every breakpoint** your project defines. Your `@media` rules evaluate for real, side by side, so you see the phone, tablet, and desktop layouts at once. Pan and zoom to fit.

## The style inspector

Select any element and the inspector gives you real controls — spacing, typography, color, layout, borders, backgrounds — grouped into sections with unit pickers and a color selector. Breakpoint tabs let you set a value for the base and override it per screen size.

![Jx Studio style inspector with spacing, typography, and color controls for a selected element](/screenshots/design-inspector.png)

## Hover and pseudo-states

Style `:hover`, `:focus`, `:active`, `::before`, `::after`, `::placeholder`, and more — the same nested selectors you'd write by hand, edited visually and previewed live.

## Design tokens and the Stylebook

Define your palette, fonts, and spacing scale as CSS custom properties once, and reference them everywhere. **Stylebook** mode is a catalog of your elements with their default styles, so you can set the look of every `h1`, `button`, or `a` in one place — rendered through the real canvas at each breakpoint.

![Jx Studio Stylebook mode showing element defaults across breakpoints](/screenshots/stylebook.png)

## Next

- Make it interactive in **[Script & logic](/docs/logic)**
- The underlying style format is documented in **[Styling](/docs/styling)**
