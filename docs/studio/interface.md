---
title: "The workspace"
description: "Every region of the Jx Studio window: the Command Bar, the Navigator rail and dock, the pane grid, the Inspector, the Bottom dock, and the status bar."
spec:
  - studio.md#3.1
  - studio.md#16
code:
  - packages/studio/src/panels/toolbar.ts
  - packages/studio/src/panels/activity-bar.ts
  - packages/studio/src/panels/left-panel.ts
  - packages/studio/src/files/files.ts
  - packages/studio/src/panels/right-panel.ts
  - packages/studio/src/panels/bottom-dock.ts
  - packages/studio/src/panels/statusbar.ts
  - packages/studio/src/ui/panel-resize.ts
---

# The workspace

The Jx Studio window is one workspace with a fixed set of regions: the **Command Bar** across the top, the **Navigator** (a labelled rail and the panel it opens) on the left, the **pane grid** in the middle with the canvas in it, the **Inspector** on the right, the **Bottom dock** under the panes, and the **status bar** along the bottom. This page walks through each one. For a quicker orientation, start with **[A tour of Jx Studio](/docs/start/studio-tour)**.

![The Jx Studio workspace with the canvas in the center, panels on both sides, and the Command Bar across the top](../images/hero.png)

## Command Bar

The bar across the top of the window. Everything in it is a command, so what you see here, what the [command palette](/docs/studio/interface/quick-access) offers and what a keyboard shortcut does can never disagree.

From left to right:

- The **⬢ menu** holds the commands that don't need a permanent button — **Open Project…**, **Open Recent…**, **New Project…**, **Open Library**, **Preferences…**, **Zen Mode**, and the rest — each with its own keyboard shortcut printed beside it.
- The **layout tabs** — **Write · Design · Build · Ship** — are named arrangements of the workspace. Clicking one sets the Navigator panel, the dock widths, the Inspector tab and the Bottom dock in a single step. Double-click a tab to rename it, and press **+** to save whatever is on screen now as a layout of your own. Layouts are remembered per project.
- The **Command Center pill** sits in the middle: `◈ project › document › selection`, with :kbd[⌘K] at its right end. It is the app's address — it always names the project you're in, the document you're editing and the element you have selected — and each segment is a button that opens the palette already scoped to that level. Click the pill's empty space to open the palette with nothing pre-picked.
- The **verb cluster** on the right holds the four actions worth a permanent button: **Save**, **Open in Browser**, **Undo** and **Redo**. A greyed-out one tells you in its tooltip what it is waiting for.
- **Dock toggles** for the Navigator (:kbd[⌘B]), the Inspector (:kbd[⌘⌥B]) and the Bottom dock (:kbd[⌘J]).

In the desktop app, the window's minimize, maximize and close controls also live in this row.

**Open in Browser** (:kbd[⇧⌘O] on macOS, :kbd[Ctrl+Shift+O] on Windows/Linux) opens the built version of the page you're editing, at its real route, in your own browser — the fastest way to check the actual page rather than the canvas's approximation of it. It is always there: when the open file has no route it's disabled and its tooltip says why — a component isn't a page, a `[slug]` route needs a value picked on the pane context bar first, and a project that doesn't build a site has nothing to serve.

:::doc-tip
A layout reconfigures the workspace; it never takes anything away. Every panel stays on the rail, on its shortcut and in the palette after any layout is applied.
:::

## Navigator rail

The vertical strip on the far left. Every button carries a **text label under its icon**, and the buttons are split into two labelled groups, because a panel is either about your whole project or about the one document in front of you:

**Project**

- **Files** (:kbd[⌘1]) — the project file tree. Open, rename and organize the files in your project folder. **New File…** — from the panel's toolbar, or from a folder's right-click menu — opens the [creation dialog](#creating-a-file) with `untitled.json` pre-filled and only the name part selected, so typing replaces the name and keeps the extension. Studio picks the starting content from the extension you give it. Drag files in from your desktop and they upload into whichever folder you drop them on — see [Media](/docs/studio/projects/media).
- **Source Control** (:kbd[⌘3]) — the built-in git client. A badge counts changed files. See [Git & publish](/docs/studio/publish).
- **Problems** (:kbd[⌘4]) — everything that needs fixing, with a badge counting it. The button is on the rail because "how many things need fixing" is a question you ask without opening anything; the list itself opens in the [Bottom dock](#bottom-dock).

**Document**

- **Outline** (:kbd[⌘5]) — the element structure of the open page or component, as a tree you can select and reorder. In **Project Styles** it lists the style targets instead.
- **Page** (:kbd[⌘6]) — the page's title, description and social preview.
- **Data** (:kbd[⌘7]) — the values, data sources and functions the document knows about, with what each one currently resolves to. See [Script & logic](/docs/studio/logic).
- **Packages** (:kbd[⌘8]) — the components and packages the open document pulls in.

Clicking the button of the panel that's already open collapses the Navigator; clicking any button brings it back. A document-level panel with no document open says what it needs rather than showing an empty box.

**Insert** — the palette of elements and components you can add to a page — is not on the rail, because it is something you reach for at the moment you're placing something rather than a view you sit in. Run **Show Insert** from the palette (:kbd[⌘K]) to open it in the Navigator.

At the foot of the rail sit **About** — the app version, its release channel and the update status — and **Settings**, which opens this project's settings: breakpoints and color schemes, data shapes, content types, dependencies. See [Project settings](/docs/studio/projects/settings). The settings that belong to Studio itself rather than to a project — the theme, the AI provider, your accounts, the keyboard sheet — are in **[Preferences](/docs/studio/interface/preferences)** (:kbd[⌘,]).

## Navigator dock

The dock to the right of the rail shows one panel at a time, under a header naming the panel and the level it works at — `FILES · project`, `OUTLINE · document`. That header is how you always know which panel you're looking at and whether closing the last document would empty it.

Drag the dock's inner edge to resize it — up to half the window — and double-click that edge to snap back to the default width.

## Creating a file

There is one creation flow, and every surface that makes a file uses it — **New File…** in the Files tree, **New** in the [Library](/docs/studio/projects/browse), and **New Entry** for a content collection. Wherever you start from, the dialog behaves the same way:

- **It says where the file is going**, above the field — `Creating in content/blog/`, or _Creating in the project root_. The destination is part of the gesture you made, never guessed from a filter or a fallback.
- **A name that folder already has is refused at the field.** The dialog stays open and tells you `about.md already exists in content/blog/.`, so nothing is overwritten and there is nothing to undo. A blank name, or one with no letters or digits left in it, is refused the same way.
- **What it asks for depends on whether the extension is already settled.** The Files tree and the Library's **New** ask for a **file name** and take it as typed, so the extension is yours to choose — `untitled.json` and `untitled` are the respective prefills, with only the name part selected. **New Entry** for a content collection asks for a **display name** instead, because that collection already fixes the extension: `My First Post` becomes `my-first-post.md`.

The new file is written with the starting content its type calls for: a content entry is seeded from its content type's fields, so it is valid the moment it exists. Creating from the Library or from a collection opens the new file for you as well.

:::doc-note
If the write itself fails, the reason arrives as a **Problem** in the [Bottom dock](#bottom-dock) carrying the path, rather than as a toast that scrolls away — the thing you have to do next is about that path.
:::

## Panes and the canvas

The middle of the window is the **pane grid**: one editor pane, or two side by side (:kbd[⌘\] splits, :kbd[⌘⌥0] focuses the second one). Each pane has its own strip of open documents along its top and its own context bar below that, and renders one document in one editor — Canvas, Code, Grid, Diff, Library or Project Styles. See **[Documents and panes](/docs/studio/interface/tabs)**.

A Canvas pane renders the open file live. Panning, zooming, selection and direct manipulation are covered in **[The canvas](/docs/studio/interface/canvas)**. A page's **Document Header** — title, route, layout picker and the SEO block — is drawn at the top of the artefact itself, inside the stage, because it is part of the document rather than a view of it.

## Inspector

The dock on the right inspects whatever is selected, in four tabs:

- **Content** (:kbd[⌘⇧1]) — the selected element's settings: its text, links, images and component options.
- **Style** (:kbd[⌘⇧2]) — the visual inspector: spacing, typography, color, layout and more. See [Design mode](/docs/studio/design).
- **Logic** (:kbd[⌘⇧3]) — what the element does on click, input, submit and other interactions. See [Script & logic](/docs/studio/logic).
- **Assistant** (:kbd[⌘⇧4]) — the [AI assistant](/docs/studio/ai), as a tab in this dock rather than a column of its own, so showing it never narrows the canvas.

Every tab renders under a header naming the tab and what it is pointed at — the selected element, or the open document when nothing is selected. Resize the dock by dragging its inner edge, or collapse it with :kbd[⌘⌥B].

:::doc-note
Studio remembers your layout — dock widths and which docks are collapsed carry over to your next session, per project.
:::

## Bottom dock

Press :kbd[⌘J] for the dock under the pane grid. It sits in the panes' column only, so opening it never narrows the Navigator or the Inspector, and it opens **collapsed** — an empty list shouldn't spend canvas to say nothing.

- **Problems** — everything Studio is waiting for you to fix, grouped by where it came from. A row can carry the file it happened in (click it to open the file) and a disclosure with the captured log. When there is something to do about it, the row shows the button for it — the real command, with its own name, its shortcut, and its reason when it isn't available yet. Dismiss a row you've dealt with, or clear the list.
- **Activity** — one entry per long operation: a title, a status line, the steps it's working through, a streaming log, and **Cancel** when the operation can be cancelled. An entry outlives the run, so you can read what a publish or an import actually did after it finished — and a failure leaves both the entry and a Problem carrying its log.

Drag the dock's top edge to resize it, or close it with the **×** in its tab strip.

:::doc-note
Almost nothing in Studio blocks the whole app any more. Installing dependencies is the exception, and even there the progress dialog offers **Run in the background** and leaves its Activity entry behind either way.
:::

## Status bar

The strip along the bottom carries **ambient state only** — things that are true until something changes them — in three fields, in the same order as the levels above them:

- **Project** — the project name, the git branch with its ahead/behind counts, a count of open problems, and who else is in the document with you.
- **Document** — the document's path, the pane's effective view (`Edit`, `Design`, `Preview`, `Code`, `Grid`, `Library`…) in the same words the [pane context bar](/docs/studio/interface/tabs#the-pane-context-bar) uses, and the save state in words: **Unsaved changes**, **Saved**, **Saved 2 minutes ago**, or **Read-only** when a collaborator holds the file.
- **Selection** — the selected element and the chain of elements above it, each step clickable so you can jump to any ancestor.

Nearly every item is a button that runs the command behind it: the project name opens your recents, the branch reveals Source Control, the problem count opens the Bottom dock, **Unsaved changes** saves.

:::doc-note
Outcomes don't appear here. Something that happened at a moment and is reversible appears as a **toast** that retires itself; something that must be fixed becomes a **Problem** in the Bottom dock; something wrong with a value you just typed is shown at the field you typed it in.
:::

## Next

- Work with several documents at once in **[Documents and panes](/docs/studio/interface/tabs)**
- Meet the editors and views in **[Modes and views](/docs/studio/interface/modes)**
- Work directly on the page in **[The canvas](/docs/studio/interface/canvas)**
- Learn the **[keyboard shortcuts](/docs/studio/interface/shortcuts)**
