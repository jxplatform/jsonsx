---
title: "A tour of Jx Studio"
description: "A guided map of the Jx Studio workspace — toolbar, activity bar, panels, canvas, tabs, and status bar, with links to each surface's guide."
code:
  - packages/studio/src/panels/toolbar.ts
  - packages/studio/src/panels/activity-bar.ts
  - packages/studio/src/panels/right-panel.ts
---

# A tour of Jx Studio

Everything in Jx Studio happens in one window. This page is your map: what each region is called, what it does, and where to read more. If you've used another visual builder, the layout will feel familiar — a live canvas in the middle, panels on either side, and a toolbar on top.

![The Jx Studio workspace with the canvas in the center, panels on both sides, and the toolbar across the top](/screenshots/hero.png)

## The toolbar

The top row holds project-wide actions: **Open Project** (with a dropdown of recent projects), **Manage**, **Publish**, **Save**, and **Undo**/**Redo**, plus a search field and the mode switcher. Read more in **[The workspace](/docs/studio/interface)**.

## The mode switcher

On the right side of the toolbar, five buttons switch how the canvas presents the open file: **Edit**, **Design**, **Grid**, **Code**, and **Stylebook**. Only the modes that make sense for the current file are enabled — see **[Modes and the preview toggle](/docs/studio/interface/modes)**.

## The activity bar

The narrow icon strip on the far left switches what the left panel shows. The activities are **Files**, **Layers**, **Imports**, **Elements**, **State**, **Data**, **Document**, and **Source Control**, with **About** and **Settings** at the bottom.

## The left panel

The left panel shows whichever activity you picked — your file tree, the element structure of the open page, the palette of things you can insert, and so on. Each activity is described in **[The workspace](/docs/studio/interface)**.

## The canvas

The center of the window renders your page or component live, exactly as it will look in production. You select, edit, and rearrange elements directly on it — see **[The canvas](/docs/studio/interface/canvas)**, **[Edit mode](/docs/studio/editing)**, and **[Design mode](/docs/studio/design)**.

## The tab strip

Every open file gets a tab above the canvas, with a dot marking unsaved changes — Studio only saves when you tell it to. Details in **[Tabs and files](/docs/studio/interface/tabs)**.

## The right panel

Three tabs inspect whatever is selected on the canvas: **Properties** (the element's settings), **Events** (what happens on click, input, and so on), and **Style** (the visual inspector). See **[Design mode](/docs/studio/design)** for Style and **[Script & logic](/docs/studio/logic)** for Events.

## The status bar

The thin strip along the bottom shows what's selected and its position in the page structure, plus short confirmation messages like "Saved".

## Quick Access

Press :kbd[⌘P] (macOS) or :kbd[Ctrl+P] (Windows/Linux) anywhere to open a file by typing part of its name — see **[Quick Access](/docs/studio/interface/quick-access)**.

## Next

- Learn each region in depth in **[The workspace](/docs/studio/interface)**
- Start writing in **[Edit mode](/docs/studio/editing)** or styling in **[Design mode](/docs/studio/design)**
- Keep your hands on the keyboard with the **[shortcut reference](/docs/studio/interface/shortcuts)**
