---
title: "The canvas"
description: "Working on the Jx Studio canvas — pan, zoom, selection, the block action bar, inserting elements, drag and drop, and the context menu."
spec:
  - studio.md#4.4
  - studio.md#6.7
  - studio-ui-guidelines.md#8.1
code:
  - packages/studio/src/editor/shortcuts.ts
  - packages/studio/src/panels/block-action-bar.ts
  - packages/studio/src/editor/context-menu.ts
  - packages/studio/src/editor/insert-zone-action.ts
  - packages/studio/src/panels/canvas-dnd-bridge.ts
  - packages/studio/src/canvas/iframe-interaction.ts
  - packages/studio/src/tabs/selection.ts
---

# The canvas

The canvas is the center of the workspace, where your page renders live — the real thing, not a mock-up. You work on it directly: click to put the cursor in the text and select the block, drag the block bar's handle to rearrange. How it behaves depends on the current [mode](/docs/studio/interface/modes); this page covers the interactions shared by the visual modes.

![Jx Studio design canvas showing one component across four responsive breakpoints with a style inspector](../../images/mode-design.png)

## Pan and zoom

In **Design** and **Project Styles** the canvas is an open surface you move around:

- **Pan** — scroll with the mouse wheel or trackpad. Hold :kbd[Shift] while scrolling to pan sideways, or drag with the middle mouse button.
- **Zoom** — hold :kbd[⌘] (macOS) or :kbd[Ctrl] (Windows/Linux) and scroll; the canvas zooms toward your cursor. :kbd[⌘=] / :kbd[Ctrl+=] zooms in, :kbd[⌘-] / :kbd[Ctrl+-] zooms out, and :kbd[⌘0] / :kbd[Ctrl+0] resets to 100%.
- The zoom pod floating at the canvas's bottom-right does the same, plus a **fit** picker — **Fit page**, **Fit width**, **Actual size** — remembered per document.

**Design opens already fitted.** Switching into Design or Project Styles scales the canvas down so the whole thing is in view, so a wide layout never lands cut off at the edge of the panel. It never scales _up_ past 100%, and it never overrides you: once you have set a zoom yourself — with the controls, :kbd[Ctrl]-scroll or the chords — that file keeps your zoom for the rest of the session.

In **Edit** mode the page scrolls like a normal browser page instead of panning, and :kbd[Ctrl]-scrolling zooms the content itself — the text reflows at the new size, like browser page zoom. In **Preview** the page scrolls too, and there is nothing to pan or zoom — see **[Modes](/docs/studio/interface/modes)**. The same goes for every editor that isn't a canvas: **Code**, the **Grid**, the **Library**, an **entry form** and **[Project Settings](/docs/studio/projects/settings)** all scroll under the wheel exactly like an ordinary page, including the boxes inside them — the Raw JSON view of `project.json`, for one. What none of them does is zoom: :kbd[Ctrl]-scroll and a trackpad pinch do nothing there, the same as anywhere else in Studio outside the canvas, so a stray pinch never rescales the whole window.

## Selecting elements

Click any element to select it. Studio outlines it, the Inspector inspects it, and the status bar shows its position in the page structure — a clickable trail of its ancestors.

That includes the parts of the page that come from its **[layout](/docs/studio/projects/pages-layouts-components)** — the header and footer render dimmed, under a `LAYOUT · layouts/base.json` chip, and clicking one selects it and offers **Open Layout →** in the Inspector. They can't be typed into from here, because they belong to every page that uses that layout; see **[Layout elements](/docs/studio/design/properties#layout-elements)**.

:kbd[⌘]-click (macOS) / :kbd[Ctrl]-click (Windows/Linux) adds an element to the selection or takes it out again. Every selected element keeps a box on the canvas, while the block action bar, the Inspector's single-element controls and the status trail address the one you clicked most recently; the status bar says **N selected** in front of the trail so the trail is never mistaken for the whole set. Ranges are drawn in the **[Outline](/docs/studio/design/layers#select-several-at-once)**, where a :kbd[Shift]-click covers everything between two rows — the canvas has no rubber-band selection.

You can also move the selection from the keyboard: :kbd[↑] and :kbd[↓] step between siblings, :kbd[→] steps into the first child, and :kbd[←] or :kbd[Esc] steps out to the parent — pressed on the outermost element, :kbd[Esc] clears the selection instead. With nothing selected at all, :kbd[↑] or :kbd[↓] selects the outermost element, so the first key press always lands somewhere. The full list is in the **[shortcut reference](/docs/studio/interface/shortcuts)**.

## The block action bar

A small floating toolbar appears above the selected element:

![The block action bar floating above a selected paragraph, showing the parent, tag, move, duplicate and formatting controls](../../images/block-action-bar.png)

- A **back arrow** selects the parent element.
- The **name badge** shows what's selected — the element's type or its name. When the element can become something else (a paragraph into a heading, for example), clicking the badge lists the conversions.
- The **⠿ drag handle** — drag it to move the element somewhere else on the page.
- **Move up** and **Move down** arrows swap the element with its neighbors.
- For a component instance, **Edit Component** opens the component itself; for anything else, **Convert to Component** turns the selection into a reusable component.
- While you're editing text, formatting buttons (bold, italic, and friends) and an **Insert data** button join the bar. See [Edit mode](/docs/studio/editing).

The bar steps aside when you leave the canvas. Click into the Inspector, a panel or the document header and it disappears, so it is never sitting over the control you were reaching for — **your selection stays exactly as it was**, which is what the Inspector is editing. It comes back the moment the canvas is in play again: click the element on the canvas, or select anything from the Outline, and the bar is there for it. The bar's own pieces — its `⋮` menu, the link popover, the slash menu — and panning or zooming the canvas all leave it alone.

:::doc-tip
The bar keeps one shape. An action that cannot apply to the current selection — moving the first child up, deleting the document root — is shown greyed with a tooltip saying what it needs, rather than disappearing. Buttons never move under your cursor.
:::

The bar also carries the structural verbs — **Duplicate** and **Delete**. It shows a fixed run of them and keeps any further verb, with its name and its shortcut, behind a **More block actions** button rather than dropping it.

With several elements selected the bar sits on the last one you clicked and names it. **Duplicate** and **Delete** act on everything selected, in one undo step; the move arrows act on that one element, because moving several elements one slot along has no single meaning. See **[Select several at once](/docs/studio/design/layers#select-several-at-once)**.

## Inserting elements

Three ways to add something to the page:

- **The + affordance** — move the pointer between two elements and a **+** appears at the insertion point. Click it and pick an element from the menu; the new element lands right there, selected.
- **The slash menu** — while editing text, type `/` at the start of a line to insert headings, lists, images, buttons, and more without leaving the keyboard. See [Edit mode](/docs/studio/editing).
- **The Insert panel** — run **Show Insert** from the command palette (:kbd[⌘K] / :kbd[Ctrl+K]) and drag an element or component card onto the canvas.

## Drag and drop

You can drag onto and around the canvas from almost anywhere: cards from the **Insert** panel, rows in the **Outline** panel, and the **⠿** handle on the block action bar. While you drag, an indicator line shows exactly where the element will land — before, after, or inside the element under the cursor. Drop to commit, or press :kbd[Esc] to cancel the drag with nothing changed.

Files from your desktop work too. Drop an image on empty space and Studio uploads it and inserts it there; drop it on a picture that's already on the page and it swaps that picture's source instead — the target highlights so you can tell the two apart before you let go. An upload that fails says so and stays said, on the **[Problems](/docs/studio/interface/problems-and-progress)** list, naming the file it couldn't write. See **[Media](/docs/studio/projects/media)**.

## The right-click context menu

Right-click any element for the full action list: **Copy**, **Cut**, **Duplicate**, **Copy styles** and **Paste styles**, **Insert before** and **Insert after**, **Wrap in Div**, **Repeat...** (turn the element into a repeating list), **Set Title**, **Edit Component** or **Convert to Component**, and **Delete**. With something on the clipboard, **Paste inside** and **Paste after** appear too.

Right-clicking an element that is already part of a [multiple selection](/docs/studio/design/layers#select-several-at-once) keeps that selection rather than collapsing it to the element you aimed at; right-clicking anything else selects it alone. **Cut** then removes the whole selection in one undo step, putting the element you aimed at on the clipboard. The other rows address that one element: to duplicate or delete a whole selection, use :kbd[⌘D] and :kbd[Delete], or the block action bar.

**Every** row is a command as well as a menu item, so all of them can be run by name from the [command palette](/docs/studio/interface/quick-access) — with the same wording, and the same reason when they are unavailable. A row that can't apply to what you have selected is greyed with that reason rather than hidden: **Cut** on the page root says it needs an element that isn't the root. See **[Commands](/docs/studio/interface/commands)**.

Right-clicking **empty space** around the page gives you the browser's own menu, not this one — there is nothing there to act on, and that margin is where you reach for View Source or Inspect.

## Editing text

Click any text to put the cursor there and start typing. Everything about writing on the canvas — formatting, the slash menu, links — is covered in **[Edit mode](/docs/studio/editing)**.

## Next

- Style what you select in **[Design mode](/docs/studio/design)**
- Wire up behavior in **[Logic](/docs/studio/logic)**
- Keep your hands on the keys with the **[shortcut reference](/docs/studio/interface/shortcuts)**
