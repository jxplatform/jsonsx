---
title: "Design tokens"
description: "Design tokens in Jx Studio: define colors, fonts, and sizes once under Settings > CSS Variables and reuse them from every picker."
code:
  - packages/studio/src/settings/css-vars-editor.ts
  - packages/studio/src/ui/color-selector.ts
  - packages/studio/src/services/token-lint.ts
---

# Design tokens

A design token is a named value — **Primary Blue** instead of `#3b82f6`, **Body Serif** instead of a font list. Define it once for the site and reference it everywhere; change it once and everywhere updates. Tokens are what keep a growing site on one palette instead of thirty slightly different blues.

<!-- TODO(screenshot): css-variables — the CSS Variables settings section with color, font, and size groups -->

## Define tokens

1. Click the **Settings** gear at the bottom of the activity bar.
2. Open the **CSS Variables** section.

Tokens are grouped by what they name:

- **Colors** — each row has a color swatch (click it for a native picker), the token's name, and its value. When the project declares a [color scheme](/docs/framework/concepts/color-schemes), each color token also carries a per-scheme row (e.g. **Dark**) — leave it empty to inherit the base value, or set it to give the token a scheme-specific value. Projects without a scheme get an **Enable dark scheme** button that declares one. Edits appear on the canvas immediately.
- **Fonts** — each font renders a preview sentence in its own face below the row.
- **Sizes & Spacing** — widths, gaps, and radii. When a size token has a different value at a breakpoint, the override appears beneath it for editing.
- **Other** — anything that doesn't fit the groups above.

To add a token, type a friendly name and a value in the group's empty row and click **Add**. Studio derives the stored variable name from the group and your name — "Primary Blue" in Colors becomes `--color-primary-blue`. The trash button removes a token; anything still referencing it falls back to nothing, so remove with care.

## Use tokens while styling

Tokens surface right inside the [Style inspector](/docs/studio/design/style-inspector)'s controls:

- The **color picker** lists your color tokens; pick one and the field shows the token's name with its swatch instead of a raw code.
- The **font family** box lists your font tokens first, each previewed in its own face. Picking one of the ready-made presets creates a matching font token automatically, so even your first font choice becomes reusable.
- Any field accepts a token typed directly as `var(--color-primary-blue)` — useful for the occasional property without a picker.

A field showing a token name is _following_ the token: edit the token in Settings and every element using it updates.

Studio also nudges toward tokens in the other direction — when its AI assistant writes styles, hard-coded values that duplicate an existing token are flagged with the token to use instead.

:::doc-note
Tokens are CSS custom properties in your project's site-wide `style` (in `project.json`), inherited by every page and component. The format is described in **[Styling](/docs/framework/concepts/styling)**.
:::

## Next

- Pair tokens with element defaults in the **[Stylebook](/docs/studio/design/stylebook)**
- Size tokens that shift per screen — see **[Breakpoints](/docs/studio/design/breakpoints)**
