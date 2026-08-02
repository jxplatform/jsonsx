---
title: "Keyboard shortcuts"
description: "Every keyboard shortcut in Jx Studio, grouped by context, with macOS and Windows/Linux keys."
spec:
  - studio.md#10
code:
  - packages/studio/src/editor/shortcuts.ts
  - packages/studio/src/editor/inline-edit.ts
  - packages/studio/src/canvas/iframe-editable-root.ts
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

These apply when a block is selected but the cursor is not in its text — after picking a row in the
layers panel, for instance. Once the cursor is in the text it owns these keys; see **Writing** below.

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

In **Edit** mode the zoom keys resize the content itself (the text reflows), and the page scrolls instead of panning. In **Preview** there is nothing to zoom or pan — the page scrolls in its own frame, and the keys on this page that would change the document are refused.

## Writing

With the cursor in text on the canvas.

### Moving and selecting

| Action                                | macOS                           | Windows / Linux                 |
| ------------------------------------- | ------------------------------- | ------------------------------- |
| Put the cursor somewhere              | click                           | click                           |
| Move through the page, block to block | :kbd[↑] :kbd[↓] :kbd[←] :kbd[→] | :kbd[↑] :kbd[↓] :kbd[←] :kbd[→] |
| Start / end of line                   | :kbd[Home] / :kbd[End]          | :kbd[Home] / :kbd[End]          |
| Select, including across blocks       | :kbd[Shift] + move, or drag     | :kbd[Shift] + move, or drag     |
| Put the cursor away                   | :kbd[Esc]                       | :kbd[Esc]                       |

### Changing the text

| Action                     | macOS                                | Windows / Linux   |
| -------------------------- | ------------------------------------ | ----------------- |
| Bold                       | :kbd[⌘B]                             | :kbd[Ctrl+B]      |
| Italic                     | :kbd[⌘I]                             | :kbd[Ctrl+I]      |
| Inline code                | :kbd[⌘`]                             | :kbd[Ctrl+`]      |
| Add a link                 | :kbd[⌘K]                             | :kbd[Ctrl+K]      |
| Open the block menu        | :kbd[/]                              | :kbd[/]           |
| New paragraph              | :kbd[Enter]                          | :kbd[Enter]       |
| Line break, same paragraph | :kbd[Shift+Enter]                    | :kbd[Shift+Enter] |
| Join onto the block above  | :kbd[Backspace] at the block's start | same              |
| Pull the next block up     | :kbd[Delete] at the block's end      | same              |
| Copy / cut / paste text    | :kbd[⌘C] / :kbd[⌘X] / :kbd[⌘V]       | :kbd[Ctrl] + same |
| Save                       | :kbd[⌘S]                             | :kbd[Ctrl+S]      |

With the cursor in text these are text operations: they copy the words you highlighted, not the
block they sit in. The element versions in the table above only apply when nothing has the cursor.

The block menu opens when :kbd[/] is typed at the start of a line or after a space. Saving always
writes what is on screen — your writing reaches the document as you pause, so there is no need to
finish anything first.

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
