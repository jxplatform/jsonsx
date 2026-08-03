---
title: "Design mode"
description: "Design mode in Jx Studio: a live canvas for every breakpoint plus panels for structure, style, tokens, components, and repeaters."
code:
  - packages/studio/src/canvas/canvas-render.ts
  - packages/studio/src/canvas/canvas-utils.ts
---

# Design mode

Design is the visual canvas — the mode for shaping structure and style. Switch to it with the **Design** button in the mode switcher on the right side of the toolbar, and Studio renders the open page or component with the real runtime, exactly as it will render in production, while you edit it directly.

![Jx Studio design canvas showing one component across four responsive breakpoints with a style inspector](../images/mode-design.png)

## A canvas per breakpoint

Instead of one canvas you resize, Design shows a live panel for **every breakpoint** your project defines — phone, tablet, and desktop side by side, each labeled with its name and width. Your responsive rules evaluate for real in each panel, so a change that only applies on small screens shows up only in the small-screen panel. Click a panel's header to make that breakpoint the active one for styling. Design opens with the whole set already framed to fit the pane, and you can pan and zoom from there — the zoom pod floats at the canvas's bottom-right, and the fit you leave a document on is the one it comes back to. See **[The canvas](/docs/studio/interface/canvas)** for the controls.

Breakpoints themselves — where they come from and how overrides cascade — are covered in **[Breakpoints](/docs/studio/design/breakpoints)**.

## The panels around the canvas

Design mode is the canvas plus a set of panels, each with its own page:

- **[Layers panel](/docs/studio/design/layers)** — the page's structure as a tree: select, rename, reorder, and act on any element.
- **[Elements panel](/docs/studio/design/elements)** — insert HTML elements and your components by click or drag.
- **[Properties panel](/docs/studio/design/properties)** — attributes, link targets, component props, and page settings for the selection.
- **[Style inspector](/docs/studio/design/style-inspector)** — visual CSS controls for the selection, section by section.
- **[Hover states and selectors](/docs/studio/design/states-and-selectors)** — style `:hover`, `:focus`, and selectors of your own.
- **[Design tokens](/docs/studio/design/tokens)** — name your colors, fonts, and sizes once and reuse them everywhere.
- **[Stylebook](/docs/studio/design/stylebook)** — set the default look of every heading, button, and link in one catalog.
- **[Working with components](/docs/studio/design/components)** — turn a selection into a reusable component, wire props and slots.
- **[Repeaters](/docs/studio/design/repeaters)** — turn one element into a repeating, data-bound list.

## Next

- Learn the shared canvas interactions — selection, drag and drop, the context menu — in **[The canvas](/docs/studio/interface/canvas)**
- Make it interactive in **[Script & logic](/docs/studio/logic)**
- The underlying style format is documented in **[Styling](/docs/framework/concepts/styling)**
