---
title: "Project Styles"
description: "Project Styles in Jx Studio: set the default look of every heading, button, and link in one catalog, live at every breakpoint."
spec:
  - studio.md#7.4
code:
  - packages/studio/src/panels/stylebook-panel.ts
  - packages/studio/src/panels/stylebook-layers-panel.ts
  - packages/studio/src/panels/stylebook-doc.ts
  - packages/studio/src/panels/target-line.ts
  - packages/studio/src/panels/style-panel.ts
  - packages/studio/src/panels/pane-context.ts
  - packages/studio/src/style/project-styles.ts
---

# Project Styles

Project Styles catalogs your elements: every heading, paragraph, button, list, table, and form control, plus your components, rendered as specimen cards with their current default styles. Instead of styling one `h2` on one page, you style what _every_ `h2` looks like, in one place. Switch to it with **Project Styles** in the **Editor** control on the pane's context bar, which is where Studio lists it; files that don't support it don't offer it. See **[Modes and views](/docs/studio/interface/modes)**.

![Jx Studio Project Styles showing element defaults across breakpoints](../../images/stylebook.png)

Your project file opens here, because that's the natural home for site-wide defaults. It is the same document that **[Project settings](/docs/studio/projects/settings)** shows as a form and the Code editor shows as raw JSON: three readings of one file, sharing one undo history and one unsaved-changes flag. Opening Project Styles on a component or another JSON document styles that file's element defaults instead.

## Read the catalog

Like Design mode, Project Styles shows one panel per breakpoint, all rendering the same catalog, so an element default that changes at Tablet is visibly different in the Tablet panel. The catalog renders through the real runtime, exactly as the defaults will render on your pages.

Two controls sit above the canvas: a **Filter** box to narrow the catalog by name, and a **Customized** toggle to show only the elements you've already styled. The **Outline** panel mirrors the catalog as a tree and marks customized entries with a dot: elements with their nested parts (a table with its rows and cells), then your components.

## Style an element type

1. Click a specimen card on the canvas, or its row in **Outline**. The Inspector switches to the **Style** tab on its own.
2. Read the Target Line before you type. Its scope chip reads **all `<h1>` in this document**. You are editing the element type, not one element. See **[Style inspector](/docs/studio/design/style-inspector)**.
3. Edit styles with the full inspector: sections, provenance chips, and all.
4. Watch every panel update: you're styling the element type, so every specimen of it changes at once, and so does every matching element the chip named.

The Target Line works the same as in Design mode: the **breakpoint** segment says which screen size a default is scoped to (see **[Breakpoints](/docs/studio/design/breakpoints)**), and the **selector** segment adds states, so you can give every link a default `:hover` in one edit (see **[Hover states and selectors](/docs/studio/design/states-and-selectors)**). Nested parts style as compound selections, like the header cells inside tables.

## Know what an edit reaches

The scope chip is the difference between "this heading" and "every heading":

- On a component or another JSON document, styling `h1` reaches **all `<h1>` in this document**.
- On a **layout** (and on your **project file**), the same edit reaches **all `<h1>` in this project**: every page inheriting that style follows it. A warning band opens under the line naming how many elements in how many files it affects, with **Show affected** to list them file by file; where the project can't be searched it says the number is **unknown** rather than guessing.
- On your project file with nothing selected, the line reads **every page in this project**. That is the file's own root style (`:root` and `body` on every route), so there is no tag to count, and the band says as much instead of printing a number it can't stand behind.

The chip is there before your first keystroke, which is the point: this catalog widens every edit from one element to a whole tag, and you should not have to discover that from the result.

A value that arrives from your project's tokens rather than from this file carries an inherited chip reading **from site tokens**, so a default you did not write here is never mistaken for one you did. It has nowhere to jump to, because that value lives in the project's site-wide style, and you edit it in **[Design tokens](/docs/studio/design/tokens)**.

## Project Styles, element styles, or component styles?

Three layers, from broadest to narrowest:

- **Project Styles defaults**: "every `h2` looks like this." Your typography, link, and form baseline. Change it here and the whole site follows.
- **Component styles**: "this card component looks like this, wherever it's used." Style the elements _inside_ a component definition in Design mode; see **[Working with components](/docs/studio/design/components)**.
- **Per-element styles**: "this one element is special." The [Style inspector](/docs/studio/design/style-inspector) on a single selection, layered on top of both.

The narrower layer wins where they overlap, so keep the common look in Project Styles and reserve per-element styling for true exceptions. [Design tokens](/docs/studio/design/tokens) slot in underneath all three, so defaults built from tokens keep even your baseline swappable.

:::doc-note
Element defaults are saved as tag-named rules in the open file's top-level `style`. In `project.json` they become site-wide and merge into every page and component. The format is described in **[Styling](/docs/framework/concepts/styling)**.
:::

## Next

- Name the values your defaults are built from in **[Design tokens](/docs/studio/design/tokens)**.
- See how Project Styles fits among the editors and views in **[Modes and views](/docs/studio/interface/modes)**.
