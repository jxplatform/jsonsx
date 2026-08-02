---
title: "Tabs and files"
description: "How tabs work in Jx Studio — opening and switching files, dirty markers, explicit saving, and the per-tab view memory."
code:
  - packages/studio/src/panels/tab-strip.ts
  - packages/studio/src/tabs/tab.ts
  - packages/studio/src/panels/tab-bar.ts
---

# Tabs and files

Every file you open in Jx Studio gets a tab in the strip above the canvas. Tabs work the way you'd expect from a browser — and they carry two things worth knowing: a dirty marker, because Studio only saves when you say so, and a memory of how you were viewing each file.

![The tab strip with several open files, one showing the unsaved-changes dot](../../images/tab-strip.png)

## Opening and switching

Open files from the **Files** activity, the **Manage** browser, or [Quick Access](/docs/studio/interface/quick-access) (:kbd[⌘P] on macOS, :kbd[Ctrl+P] on Windows/Linux). Click a tab to switch to it.

- Close a tab with its **×** button, by middle-clicking it, or with :kbd[⌘W] / :kbd[Ctrl+W].
- When more tabs are open than fit, scroll the mouse wheel over the strip to slide them.

## Studio saves only when you do

Jx Studio does **not** auto-save. Edits live in the tab until you save:

- A **●** dot on the tab marks unsaved changes, and the **Save** button in the toolbar lights up.
- Save with :kbd[⌘S] / :kbd[Ctrl+S] or the **Save** button — the status bar confirms with "Saved".

:::doc-warning
Closing a tab with unsaved changes discards them. Studio always asks first — choose **Close** in the confirmation only if you really mean to throw the edits away.
:::

Undo and redo are per file as well: each tab keeps its own history, so :kbd[⌘Z] / :kbd[Ctrl+Z] in one tab never unwinds work in another.

:::doc-note
Saving writes the file in place, in your project folder — plain Markdown, JSON, or CSV. Nothing is held in a database; what you save is what git sees. See [Git & publish](/docs/studio/publish).
:::

## Each tab remembers its view

A tab keeps its own view state while it's open. Switch from a Markdown page in **Edit** to a component in **Design** and back, and each returns exactly as you left it:

- its [mode](/docs/studio/interface/modes) and **Preview** toggle,
- its canvas position, and the zoom — but only once you have set one yourself; until then Design keeps fitting the canvas to the panel,
- its selected element and active right-panel tab.

New files open in their natural mode — Markdown in **Edit**, spreadsheets in **Grid**, the project file in **Stylebook**.

## The tab bar

Below the tab strip, a second row carries the controls for the active tab:

- **Back** and a breadcrumb trail, when you've drilled from a page into one of its components — click any crumb to jump back up.
- The zoom controls for the current mode, including **Fit** on the pannable canvases. They are absent in **Preview**, which shows the page at its real size in a frame that scrolls itself.
- The **Preview** toggle, the **Layout** toggle, and the preview pickers described in [Modes and the preview toggle](/docs/studio/interface/modes).
- The **Auto / Light / Dark** color-scheme control, when the project declares a `prefers-color-scheme` breakpoint — it forces the canvas into either scheme (or follows your OS in Auto) without re-rendering. See [Breakpoints](/docs/studio/design/breakpoints).
- Mode-specific actions, like **Export** in **Code** mode.

## Next

- Find any file fast with **[Quick Access](/docs/studio/interface/quick-access)**
- Browse the whole project visually in **[Manage](/docs/studio/projects/browse)**
