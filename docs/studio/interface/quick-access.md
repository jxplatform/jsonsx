---
title: "Quick Access"
description: "Open any file in your project by name with the Quick Access palette — how to open it, what it searches, and its keyboard controls."
code:
  - packages/studio/src/panels/quick-search.ts
---

# Quick Access

Quick Access is the fastest way to open a file: a search palette that drops over the workspace, finds files by name as you type, and opens your pick on :kbd[Enter]. If you know roughly what a file is called, it beats clicking through the file tree every time.

![The Quick Access palette open over the workspace with results for a typed query](../../images/quick-access.png)

## Open it

Arrowing through the results announces the highlighted row, so the list is usable without looking at it — the input and the list beneath it are now connected in the way a screen reader expects, which they were not before.

- Press :kbd[⌘P] (macOS) or :kbd[Ctrl+P] (Windows/Linux) — it works from anywhere in Studio.
- Or click any segment of the **Command Center** pill in the middle of the Command Bar — the segment you click scopes the search to that level.

Press :kbd[Esc] or click outside the palette to dismiss it.

## What it finds

With a project open, type any part of a filename and Quick Access searches the whole project's documents — pages, components, content, and data files alike. Each result shows the filename and the folder it lives in.

Before you type anything, the palette lists your **recently opened** files, so reopening the file you just closed is :kbd[⌘P], :kbd[Enter].

With no project open, the palette lists your recent projects instead — pick one to reopen it. It never mixes the two: with a project open you only ever see that project's files.

## Keyboard controls

- :kbd[↓] and :kbd[↑] move through the results.
- :kbd[Enter] opens the highlighted result in a tab.
- :kbd[Esc] closes the palette.

The mouse works too — click any row to open it.

## Next

- See how opened files behave in **[Tabs and files](/docs/studio/interface/tabs)**
- The rest of the keyboard lives in the **[shortcut reference](/docs/studio/interface/shortcuts)**
