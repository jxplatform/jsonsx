---
title: "A tour of Jx Studio"
description: "A guided map of the Jx Studio window: the Command Bar, the Navigator, panes and the canvas, the jump bar, the Inspector and the Bottom dock."
spec:
  - studio.md#3.1
code:
  - packages/studio/src/panels/toolbar.ts
  - packages/studio/src/panels/activity-bar.ts
  - packages/studio/src/panels/right-panel.ts
  - packages/studio/src/panels/jump-bar.ts
  - packages/studio/src/panels/bottom-dock.ts
  - packages/studio/src/panels/statusbar.ts
---

# A tour of Jx Studio

Everything in Jx Studio happens in one window. This page is your map: what each region is called, what it does, and where to read more. If you've used another visual builder the shape will feel familiar: a live canvas in the middle, docks on either side, a bar across the top. The names below are the ones the app itself uses.

![The Jx Studio workspace with the canvas in the center, panels on both sides, and the Command Bar across the top](../images/hero.png)

## The Command Bar

The top row. It holds the **⬢ menu** (opening and creating projects, Preferences, and everything else without a permanent button), the **layout tabs** (**Write · Design · Build · Ship**), the **Command Center pill**, the four buttons worth keeping in reach (**Save**, **Open in Browser**, **Undo**, **Redo**), and a toggle for each of the three docks. Read more in **[The workspace](/docs/studio/interface)**.

## The Command Center

The pill in the middle of the Command Bar reads `◈ project › document › selection`, and it is the fastest way to get anywhere. Press :kbd[⌘K] to open it, or click a segment to open it already scoped: the project segment lists your projects, the document segment finds a file, the selection segment finds an element in the open document. See **[Quick Access](/docs/studio/interface/quick-access)**.

## The Navigator

The labelled rail on the far left, and the panel it opens beside it. The rail is in two groups. **Project**: **Files** (:kbd[⌘1]) and **Source Control** (:kbd[⌘3]). **Document**: **Outline** (:kbd[⌘4]), **Page** (:kbd[⌘5]), **Data** (:kbd[⌘6]) and **Packages** (:kbd[⌘7]). One panel shows at a time, under a header naming it and the level it works at, so you always know what you're looking at. At its foot, the **Settings** button opens a menu holding three entries, each with a submenu that jumps straight to a section: **Preferences…** for the app, **Open Project Settings** and **Open Project Styles** for this project. Each panel is described in **[The workspace](/docs/studio/interface)**.

## The panes and the canvas

The center of the window holds one editor pane, or two side by side when :kbd[⌘\] gives the open document a pane of its own, so you can keep a page on screen while you work on its source, its layout or the same page at another size. A pane renders your page or component live, exactly as it will look in production, and you select, edit and rearrange elements directly on it. See **[The canvas](/docs/studio/interface/canvas)**, **[Edit mode](/docs/studio/editing)** and **[Design mode](/docs/studio/design)**.

Above the pane sits its strip of open documents, then the **[jump bar](/docs/studio/interface#the-jump-bar)**, reading `◈ project › file › element` with every segment a button, so you always know where you are and can step anywhere along the chain. Under those, a context bar states which **Editor** is open on the file, which **View** of the canvas is showing (**Edit**, **Design** or **Preview**), and the **Context** it's being rendered in. Details in **[Documents and panes](/docs/studio/interface/tabs)** and **[Editors and views](/docs/studio/interface/modes)**.

## The Inspector

The dock on the right, in four tabs: **Content** (the selected element's settings), **Style** (the visual inspector), **Logic** (what happens on click, input and so on), and **Assistant** (the AI chat). **[Design mode](/docs/studio/design)** covers the Style tab, and **[Logic](/docs/studio/logic)** covers the Logic tab.

## The Bottom dock

:kbd[⌘J] opens a dock under the panes with two tabs. **Problems** is everything waiting to be fixed, each row carrying the file it happened in and the button that fixes it. **Activity** is one entry per long operation, with its steps, its log and a Cancel. A third tab, **Logic**, appears while you have a formula or a function open, so the page you're computing values for stays on screen beside the editor. The dock starts closed and only takes space from the canvas, never from the docks on either side.

## The status bar

The thin strip along the bottom says what is true right now and nothing else: the **project** (name, branch, problem count), the **document** (path, view, and whether it has unsaved changes), and a **selection** count when you have more than one element picked. Almost every item is a button. Where you are is the jump bar's job, one line above the pane.

## Next

- Learn each region in depth in **[The workspace](/docs/studio/interface)**
- Start writing in **[Edit mode](/docs/studio/editing)** or styling in **[Design mode](/docs/studio/design)**
- Keep your hands on the keyboard with the **[shortcut reference](/docs/studio/interface/shortcuts)**
