---
title: "Tabs and files"
description: "How tabs work in Jx Studio — opening and switching files, dirty markers, explicit saving, and the per-tab view memory."
code:
  - packages/studio/src/panels/tab-strip.ts
  - packages/studio/src/tabs/tab.ts
  - packages/studio/src/panels/pane-context.ts
---

# Tabs and files

Every file you open in Jx Studio gets a tab in the strip above the canvas. Tabs work the way you'd expect from a browser — and they carry two things worth knowing: a dirty marker, because Studio only saves when you say so, and a memory of how you were viewing each file.

![The tab strip with several open files, one showing the unsaved-changes dot](../../images/tab-strip.png)

## Opening and switching

Open files from the **Files** activity, the **Manage** browser, or [Quick Access](/docs/studio/interface/quick-access) (:kbd[⌘P] on macOS, :kbd[Ctrl+P] on Windows/Linux). Click a tab to switch to it — the Files tree follows along, so the strip and the tree never disagree about where you are.

- Switch back and forth with :kbd[⌃Tab] / :kbd[⌃⇧Tab], which walk the tabs in the order you last used them rather than left to right.
- Close a tab with its **×** button, by middle-clicking it, or with :kbd[⌘W] / :kbd[Ctrl+W].
- Reopen the last one you closed with :kbd[⌘⇧T] / :kbd[Ctrl+Shift+T].
- When more tabs are open than fit, scroll the mouse wheel over the strip, or use the **⌄** button at its right edge to pick from the tabs currently out of view.

## Tab labels

A tab is named by the shortest part of its path that tells it apart from the others, so a project full of files called `index.md` still gives you four distinguishable tabs.

Pages are labelled by their **route** instead — `/`, `/blog`, `/blog/[slug]` — because that is the address the page is published at, and it is what you were thinking of when you opened it.

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

## Drilling into a component

Opening a component from the canvas, the Layers tree or the inspector's **Edit component** action gives it **its own tab**. The page you came from stays open, still on the element you had selected, so you can flip between the two with a click or :kbd[⌃Tab].

The new tab carries a small **↳** marker, and hovering it names the document you drilled in from.

## The context bar

Below the tab strip, a labelled row states three things about the active tab — and only those three:

- **Editor** — which editor is open on this file: **Canvas**, **Code**, **Grid**, **Diff** or **Project Styles**. The list offers only the editors this file actually supports, so it never holds an entry that cannot be picked.
- **View** — for the Canvas editor, **Edit │ Design │ Preview** as one control with three values. See [Modes and views](/docs/studio/interface/modes).
- **Context** — what the page is being rendered _with_: the breakpoint, the color scheme, any feature queries, and whether the layout's own elements are shown. The summary reads at a glance (`Base · Auto`); open it for the full set, and for **Manage contexts…**, which takes you to where breakpoints and schemes are defined. Beside it, **resolving with** carries the document's own data — a picker per URL parameter on a dynamic page, a small field per option on a component.

**Back** and a breadcrumb trail appear at the left when you are inside part of a document that has no file of its own — a repeater's template, or a function body. Click any crumb to jump back up, and Studio puts you back exactly as you left it: same breakpoint, same selected element, same right-panel tab, same zoom.

**Zoom floats over the canvas**, bottom-right, rather than sitting in the bar: the zoom buttons, the percentage (click it for 100%), and a **fit** picker — **Fit page**, **Fit width**, **Actual size**, **No fit** — which is remembered per document, so coming back to a file frames it the way you left it. There is no zoom in **Preview**, which shows the page at its real size in a frame that scrolls itself.

Mode-specific actions sit at the right of the bar — **Export**, in the **Code** editor.

## Next

- Find any file fast with **[Quick Access](/docs/studio/interface/quick-access)**
- Browse the whole project visually in **[Manage](/docs/studio/projects/browse)**
