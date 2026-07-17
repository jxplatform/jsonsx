---
title: "Formula workspace"
description: "Edit a formula full-screen in Jx Studio — chip navigation, a live data rail, instant results, and the formula catalog side by side."
code:
  - packages/studio/src/panels/formula-workspace.ts
  - packages/studio/src/services/live-preview.ts
---

# Formula workspace

The formula workspace gives one formula the entire canvas. The compact editors in the panels are fine for a two-step formula; when one grows branches, the workspace lays the whole tree out with live values at every step and your page's data alongside.

<!-- TODO(screenshot): formula-workspace — the full-screen workspace with the chip strip, selected-step editor, and data rail -->

## Open it

Click the full-screen icon beside any formula:

- On an **Expression** entry in the **[State panel](/docs/studio/logic/state)**.
- On an **$expression** event binding in the **[Events panel](/docs/studio/logic/events)**.

The canvas is replaced by the workspace, and the tab bar shows a breadcrumb — the file's name, then _fx_ and the formula's name. Click **Back** in the tab bar (or **Close** in the workspace header) to return to the normal canvas; your edits are already in the document.

## The layout

- **Header** — the formula's name and kind (a state expression or an event expression), a **Catalog** button that opens the **[formula palette](/docs/studio/logic/formulas)**, and **Close**.
- **Chip strip** — the whole formula as a left-to-right pipeline of chips, each with its live value badge. This is the map.
- **Editor pane** — the currently selected step, edited with the same operator/operand form as everywhere else. A "Selected" line above it names the step you're on.
- **Data rail** — the page's live data on the right: every value in scope with its type and an expandable tree of its contents, exactly as the **[Data explorer](/docs/studio/logic/data-explorer)** would show it. You build the formula while looking at the data it consumes.
- **Footer** — the bottom line, literally: `= result` in green, computed live. Formulas that change a value rather than produce one are marked "(mutates target)", and an evaluation problem shows its error message here in red.

## Navigate by chip

Click any chip to select that step — the editor pane retargets to it, so you edit one piece of a large formula without scrolling through the whole nested form. Click the first chip to jump back to the start of the pipeline; edits always land in the right place in the tree, and each edit is a single undo step.

## Live-context previews

The badges, the data rail, and the footer result are all computed against the **running page** — real fetched data, real list items, real state. Two details make this more useful than a static preview:

- An event formula that lives inside a repeated list is previewed with the first item's data, so `$map/item` references show real values.
- If the canvas hasn't produced data yet (for example, the page hasn't rendered since you opened the file), the footer says so — "Preview unavailable" — rather than showing stale numbers. Values reappear as soon as the canvas renders.

## Insert from the catalog

The **Catalog** button opens the same searchable palette as the inline editors, but here a pick replaces the **selected step** — so you can navigate to a branch by chip, then drop `average` or a `switch` scaffold exactly there. Library formulas are copied into your file's state on first use, as described in **[Formulas and expressions](/docs/studio/logic/formulas)**.

## Next

- The editing vocabulary itself: **[Formulas and expressions](/docs/studio/logic/formulas)**
- Multi-step behavior belongs in **[Statements](/docs/studio/logic/statements)**, not one giant formula
- Check what the page's data actually looks like in the **[Data explorer](/docs/studio/logic/data-explorer)**
