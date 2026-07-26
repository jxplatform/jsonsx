---
title: "Keyboard shortcuts"
description: "Every keyboard shortcut in Jx Studio, grouped by context, with macOS and Windows/Linux keys."
code:
  - packages/studio/src/editor/shortcuts.ts
  - packages/studio/src/editor/inline-edit.ts
  - packages/studio/src/panels/block-action-bar.ts
---

# Keyboard shortcuts

Every shortcut in Jx Studio, grouped by where it applies. macOS uses :kbd[⌘] where Windows and Linux use :kbd[Ctrl]; everything else is the same on all platforms.

## Everywhere

These work throughout Studio, even while typing in a field.

| Action               | macOS     | Windows / Linux    |
| -------------------- | --------- | ------------------ |
| Save the active file | :kbd[⌘S]  | :kbd[Ctrl+S]       |
| Open Quick Access    | :kbd[⌘P]  | :kbd[Ctrl+P]       |
| Open a project       | :kbd[⌘O]  | :kbd[Ctrl+O]       |
| Close the active tab | :kbd[⌘W]  | :kbd[Ctrl+W]       |
| Undo                 | :kbd[⌘Z]  | :kbd[Ctrl+Z]       |
| Redo                 | :kbd[⇧⌘Z] | :kbd[Ctrl+Shift+Z] |

## Canvas — with an element selected

These apply on the canvas when you're not typing.

| Action                               | macOS                           | Windows / Linux   |
| ------------------------------------ | ------------------------------- | ----------------- |
| Duplicate the element                | :kbd[⌘D]                        | :kbd[Ctrl+D]      |
| Copy the element                     | :kbd[⌘C]                        | :kbd[Ctrl+C]      |
| Cut the element                      | :kbd[⌘X]                        | :kbd[Ctrl+X]      |
| Paste                                | :kbd[⌘V]                        | :kbd[Ctrl+V]      |
| Delete the element                   | :kbd[Delete] or :kbd[Backspace] | same              |
| Clear the selection                  | :kbd[Esc]                       | :kbd[Esc]         |
| Insert a paragraph after the element | :kbd[Enter]                     | :kbd[Enter]       |
| Select the previous / next sibling   | :kbd[↑] / :kbd[↓]               | :kbd[↑] / :kbd[↓] |
| Select the parent                    | :kbd[←]                         | :kbd[←]           |
| Select the first child               | :kbd[→]                         | :kbd[→]           |

## Canvas — zoom and pan

| Action                 | macOS                | Windows / Linux      |
| ---------------------- | -------------------- | -------------------- |
| Zoom in                | :kbd[⌘=]             | :kbd[Ctrl+=]         |
| Zoom out               | :kbd[⌘-]             | :kbd[Ctrl+-]         |
| Reset zoom to 100%     | :kbd[⌘0]             | :kbd[Ctrl+0]         |
| Zoom toward the cursor | :kbd[⌘] + scroll     | :kbd[Ctrl] + scroll  |
| Pan                    | scroll               | scroll               |
| Pan sideways           | :kbd[Shift] + scroll | :kbd[Shift] + scroll |
| Pan by dragging        | middle-mouse drag    | middle-mouse drag    |

In **Edit** mode the zoom keys resize the content itself (the text reflows), and the page scrolls instead of panning.

## While editing text

Inside an inline text-editing session on the canvas.

| Action                        | macOS       | Windows / Linux |
| ----------------------------- | ----------- | --------------- |
| Bold                          | :kbd[⌘B]    | :kbd[Ctrl+B]    |
| Italic                        | :kbd[⌘I]    | :kbd[Ctrl+I]    |
| Inline code                   | :kbd[⌘`]    | :kbd[Ctrl+`]    |
| Add a link                    | :kbd[⌘K]    | :kbd[Ctrl+K]    |
| Open the block menu           | :kbd[/]     | :kbd[/]         |
| New paragraph                 | :kbd[Enter] | :kbd[Enter]     |
| Finish editing                | :kbd[Esc]   | :kbd[Esc]       |
| Save (finishes editing first) | :kbd[⌘S]    | :kbd[Ctrl+S]    |

The block menu opens when :kbd[/] is typed at the start of a line or after a space.

## Quick Access palette

| Action                    | Key               |
| ------------------------- | ----------------- |
| Move through the results  | :kbd[↑] / :kbd[↓] |
| Open the highlighted file | :kbd[Enter]       |
| Close the palette         | :kbd[Esc]         |

## Drag and drop

| Action          | Key       |
| --------------- | --------- |
| Cancel the drag | :kbd[Esc] |

## Grid mode

In **Grid** mode the table owns the editing keys: copy, paste, delete, arrows, and :kbd[Enter] act on cells and ranges, and the zoom keys stay with the grid too. The app-level shortcuts — Save, Quick Access, Open project, Close tab, and Undo/Redo — still work as listed above.

## While a dialog is open

A dialog takes the keyboard for as long as it is up: it gets focus when it opens, :kbd[Esc] dismisses it, and focus returns to whatever you were on. Every shortcut on this page stands down meanwhile — the dialog dims the app behind it, so :kbd[Delete], :kbd[Enter], :kbd[⌘S] and the rest cannot reach the page you can't click.

## Next

- See where these fit on the surface itself in **[The canvas](/docs/studio/interface/canvas)**
- Formatting while writing is covered in **[Edit mode](/docs/studio/editing)**
