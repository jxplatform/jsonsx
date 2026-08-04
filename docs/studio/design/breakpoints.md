---
title: "Breakpoints"
description: "Breakpoints in Jx Studio: one live canvas per screen size, defining breakpoints in Settings, and how base styles cascade into overrides."
code:
  - packages/studio/src/settings/contexts-section.ts
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

Breakpoints are defined in one place: **Settings › Contexts**. Click the **Settings** gear at the bottom of the activity bar and pick **Contexts**, or open the context bar's **Context** popover and click **Manage contexts…** at the bottom of it — which gets you there without losing your element selection.

The section holds three groups, because all three are the same thing on disk and only differ in what their condition asks about:

- **Size breakpoints** — width conditions like `(max-width: 768px)`. These are the ones that get their own canvas panel.
- **Colour schemes** — a Light/Dark picker that writes the `prefers-color-scheme` query for you, so a scheme can never be mistyped into something else.
- **Feature queries** — anything else a media query can ask: reduced motion, print, hover, orientation. These appear as toggles in the **Context** popover rather than as canvas panels.

Above them sits **Base width** — how wide the Base canvas panel renders when no other context applies.

Name a context in plain language; Studio derives the stored name ("Wide screen" becomes `--wide-screen`). Every change is schema-checked and then written to `project.json`. If the schema refuses the value or the write fails, the reason appears under the control that caused it and the old value stays put — a refused edit never looks like the field forgetting what you typed.

A colour scheme is what turns on the **Auto / Light / Dark** control in the context bar's **Context** popover. Auto follows your OS preference; Light and Dark force that scheme on the canvas — exactly what a visitor's [color-scheme switcher](/docs/framework/concepts/color-schemes) does on the published site. The control appears only once the project declares a scheme.

:::doc-note
**Definition and selection are separate.** Settings › Contexts is the only place a context is created, renamed or deleted. The context bar's **Context** popover only _chooses_ among what is defined there. Earlier versions of Studio let you create breakpoints from the New Project wizard, Settings › General, the Properties panel's Media section and the CSS Variables editor's "Enable dark scheme" button; all four are gone.
:::

:::doc-note
Breakpoints are stored as a `$media` map in `project.json`. The file format is unchanged: a document may still carry its own `$media` map, and it still merges over the project's at render time — what moved is where you author it. Per-breakpoint styles nest under the breakpoint's name inside each element's `style`, as described in **[Styling](/docs/framework/concepts/styling)**.
:::

## Next

- Use the breakpoint tabs while styling in the **[Style inspector](/docs/studio/design/style-inspector)**
- Element defaults respond to breakpoints too — **[Stylebook](/docs/studio/design/stylebook)**
