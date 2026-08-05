---
title: "Design tokens"
description: "Design tokens in Jx Studio: define colors, fonts, and sizes once under Settings > CSS Variables and reuse them from every picker."
code:
  - packages/studio/src/settings/css-vars-editor.ts
  - packages/studio/src/style/project-styles.ts
  - packages/studio/src/style/token-ref.ts
  - packages/studio/src/style/live-preview.ts
  - packages/studio/src/ui/color-selector.ts
  - packages/studio/src/services/token-lint.ts
---

# Design tokens

A design token is a named value — **Primary Blue** instead of `#3b82f6`, **Body Serif** instead of a font list. Define it once for the site and reference it everywhere; change it once and everywhere updates. Tokens are what keep a growing site on one palette instead of thirty slightly different blues.

![The CSS Variables settings section with grouped color, font, and size variables](../../images/css-variables.png)

## Define tokens

1. Open **[Project settings](/docs/studio/projects/settings)** — press :kbd[⌘K] and run **Open Settings**, or pick it from the **⬢ menu** in the Command Bar.
2. Open the **CSS Variables** section.

Tokens are grouped by what they name:

- **Colors** — each row has a color swatch (click it for a native picker), the token's name, and its value. Edits appear on the canvas immediately.
- **Fonts** — each font renders a preview sentence in its own face below the row.
- **Sizes & Spacing** — widths, gaps, and radii.
- **Other** — anything that doesn't fit the groups above. It appears only once something lands in it.

To add a token, type a friendly name and a value in the group's empty row and click **Add**. Studio derives the stored variable name from the group and your name — "Primary Blue" in Colors becomes `--color-primary-blue`. The trash button removes a token; anything still referencing it falls back to nothing, so remove with care.

A token can be built from another one: give it the value `var(--color-brand)` and the row grows a chip naming **Brand**, with the color that reference ends up at — followed to the end of the chain, so an alias of an alias still shows a color rather than more syntax.

:::doc-tip
Settings is a document, so tokens get the document verbs: :kbd[⌘Z] takes back the last change, and a value that could not be written to `project.json` is raised on **[Problems](/docs/studio/interface/problems-and-progress)** rather than quietly dropped. See **[Project settings](/docs/studio/projects/settings)**.
:::

## One token, several values

A token can hold a different value in any rendering context the project declares — a color that darkens in the dark scheme, spacing that tightens on phones:

- Every color token carries a row per declared **[color scheme](/docs/framework/concepts/color-schemes)**, whether or not it has a value there, because "what is this color in dark mode" is a question a palette is always answering. Leave the row empty to inherit the base value.
- Any token can be given a value in any other declared context from the **Add override…** picker under its row — a breakpoint, a scheme, or a feature query. The picker offers only the contexts that token has no row for yet.
- Clearing an override's field removes it, and the token goes back to inheriting its base value.

Contexts are declared in one place, **Settings › Contexts** — see **[Breakpoints](/docs/studio/design/breakpoints)**. A project with no color scheme yet gets a **Manage contexts…** button under the Colors group that takes you straight there.

## Use tokens while styling

Tokens surface right inside the [Style inspector](/docs/studio/design/style-inspector)'s controls:

- The **color picker** lists your color tokens; pick one and the field shows the token's name with its swatch instead of a raw code.
- The **font family** box lists your font tokens first, each previewed in its own face. Picking one of the ready-made presets creates a matching font token automatically, so even your first font choice becomes reusable.
- Any field accepts a token typed directly as `var(--color-primary-blue)` — useful for the occasional property without a picker.

A field showing a token name is _following_ the token: edit the token in Settings and every element using it updates. The edit lands on every live canvas in place — the page you had open, and the **[Project Styles](/docs/studio/design/stylebook)** catalog — so tuning a token shows the design changing rather than describing it.

In **[Project Styles](/docs/studio/design/stylebook)**, a value that arrives from your project's site-wide style rather than from the open file wears an inherited chip reading **from site tokens** — so an element default that comes with the project is never mistaken for one written in this file.

Studio also nudges toward tokens in the other direction — when its AI assistant writes styles, hard-coded values that duplicate an existing token are flagged with the token to use instead.

:::doc-note
Tokens are CSS custom properties in your project's site-wide `style` (in `project.json`), inherited by every page and component. A per-context value is stored beside the token in an `@` block named for that context. The format is described in **[Styling](/docs/framework/concepts/styling)**.
:::

## Next

- Pair tokens with element defaults in **[Project Styles](/docs/studio/design/stylebook)**
- Size tokens that shift per screen — see **[Breakpoints](/docs/studio/design/breakpoints)**
