---
title: "Breakpoints"
description: "Breakpoints in Jx Studio: one live canvas per screen size, defining breakpoints in Settings, and how base styles cascade into overrides."
code:
  - packages/studio/src/settings/general-settings.ts
  - packages/studio/src/utils/canvas-media.ts
  - packages/studio/src/utils/inherited-style.ts
---

# Breakpoints

A breakpoint is a named screen-size condition — Tablet, Desktop — at which your design is allowed to change. In Design mode every breakpoint gets its own live canvas panel, labeled with its name and width, all showing the same page at once. The responsive rules evaluate for real in each panel, so you never wonder what the phone view looks like — it's right there next to the desktop one.

![Jx Studio design canvas showing one component across four responsive breakpoints with a style inspector](../../images/mode-design.png)

## The active breakpoint

Styling always targets one breakpoint at a time. Two controls stay in sync:

- The **breakpoint tabs** at the top of the [Style inspector](/docs/studio/design/style-inspector) — **Base** plus one tab per breakpoint.
- The **panel headers** on the canvas — click a panel's header to make its breakpoint active.

Pick **Base** to edit the styles that apply everywhere; pick a breakpoint to edit that screen size's overrides.

## How the cascade works

Base is the design; breakpoints are exceptions to it:

1. Values on the **Base** tab apply at every size.
2. On a breakpoint tab, everything inherited from earlier in the cascade shows as a dimmed placeholder — nothing is duplicated.
3. Set a value on a breakpoint tab and it becomes an override for that breakpoint only, marked with a set-dot.
4. Click the dot to remove the override; the inherited value shows through again.

Breakpoints layer in the same order a browser applies their media queries, so what you see per panel is exactly what ships.

## Define your breakpoints

Breakpoints belong to the whole site. To edit them, click the **Settings** gear at the bottom of the activity bar, then find **Breakpoints** in the _General_ section — below **Site Name**, **Description**, and **Production URL**, which live in the same section. Each row is a name and a width condition, like `(min-width: 768px)`; add, rename, edit, or remove rows there. Every change writes to `project.json` as you make it, and if a write fails, the section says why instead of letting the row snap back.

A single file can also carry breakpoints of its own: select the page root in [Layers](/docs/studio/design/layers) and open the **Media** section of the [Properties panel](/docs/studio/design/properties). There you set the file's **Base width** — how wide the Base canvas panel renders — and add breakpoints with a friendly name (Studio derives the stored name, "Tablet" becomes `--tablet`). File-level breakpoints add to the site's list for that file. More site-wide options live in **[Project settings](/docs/studio/projects/settings)**.

Only width conditions get a canvas panel. A breakpoint with a different kind of condition — reduced motion, for example — appears instead as a toggle in the context bar's **Context** popover.

A `prefers-color-scheme` breakpoint is special: it surfaces as an **Auto / Light / Dark** control in the context bar's **Context** popover instead of a generic toggle. Auto follows your OS preference; Light and Dark force that scheme on the canvas — exactly what a visitor's [color-scheme switcher](/docs/framework/concepts/color-schemes) does on the published site. The control appears only when the project declares a scheme breakpoint.

:::doc-note
Breakpoints are stored as a `$media` map — in `project.json` for the site, or at the top of a file for file-level ones. Per-breakpoint styles nest under the breakpoint's name inside each element's `style`, as described in **[Styling](/docs/framework/concepts/styling)**.
:::

## Next

- Use the breakpoint tabs while styling in the **[Style inspector](/docs/studio/design/style-inspector)**
- Element defaults respond to breakpoints too — **[Stylebook](/docs/studio/design/stylebook)**
