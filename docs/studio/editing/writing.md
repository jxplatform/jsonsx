---
title: "Writing and formatting"
description: "Write directly on the page in Jx Studio's Edit mode: paragraphs, the inline formatting toolbar, links, clean pasting, and text inside components."
spec:
  - studio.md#8.2
  - studio-ui-guidelines.md#8.3
code:
  - packages/studio/src/canvas/iframe-editable-root.ts
  - packages/studio/src/canvas/iframe-position.ts
  - packages/studio/src/canvas/editable-actions.ts
  - packages/studio/src/editor/content-slice.ts
  - packages/studio/src/editor/inline-edit.ts
  - packages/studio/src/editor/inline-format.ts
  - packages/studio/src/editor/inline-link.ts
  - packages/studio/src/panels/block-action-bar.ts
  - packages/studio/src/canvas/iframe-inline-edit.ts
---

# Writing and formatting

In Edit mode you write on the real page: click any text — a heading, a paragraph, a list item, a table cell — and the cursor lands exactly where you clicked, ready to type. There is no separate preview to keep in sync; the page you're editing is the page.

![A paragraph mid-edit on the canvas with the formatting toolbar above it](../../images/inline-editing.png)

## Moving around

There is nothing to start or stop. The cursor is simply on the page, the way it is in a document editor:

- **Click** any text to put the cursor there.
- **Arrow keys** move it through the whole page, from the end of one block into the next.
- :kbd[Home] / :kbd[End], word motion, and :kbd[Page Up] / :kbd[Page Down] all work as they do anywhere else.
- **Drag** — or hold :kbd[Shift] and move — to select, including across several blocks at once.
- :kbd[Esc] puts the cursor away.

Your writing is saved into the document as you pause, so :kbd[⌘S] (macOS) / :kbd[Ctrl+S] (Windows/Linux) always writes what is on screen, mid-sentence or not.

## What you can click into

Anything that holds text: headings, paragraphs, list items, table cells, captions, definition
lists, a disclosure's summary. Which ones those are comes from the page's own format rather than a
fixed list, so a Markdown page and a component page each get the right answer.

Two cases where the cursor lands somewhere you might not expect, and both are deliberate:

- **A block quote** holds paragraphs, so clicking one puts the cursor in the paragraph inside it —
  which is the thing you actually want to type in.
- **A link** is part of a paragraph, not a block of its own. Clicking one puts the cursor in the
  paragraph, so you can type through and around the link and it stays intact.

Code blocks are not editable this way; their whitespace is significant, so they are left alone.

## Paragraphs

Press :kbd[Enter] to end the paragraph and start a new one. Split a paragraph in the middle and everything after the cursor moves into the new one, with your cursor following — you just keep typing. :kbd[Shift+Enter] stays in the same paragraph instead of starting a new block.

:kbd[Backspace] at the very start of a block joins it onto the one above, and :kbd[Delete] at the very end pulls the next one up — the cursor lands where the two met. Deleting a selection that spans blocks does the same thing: what is left of the first and last block joins together.

To make the next block something other than a paragraph — a heading, a list, an image — type :kbd[/] and pick from the menu: **[Slash commands](/docs/studio/editing/slash-commands)**.

## The formatting toolbar

The floating toolbar above the block carries the formatting buttons (the same bar described in **[The canvas](/docs/studio/interface/canvas)**). Select some text first, then click a button to format it — click again to remove the format:

- Paragraphs, list items, and table cells offer **Bold**, **Italic**, **Underline**, **Strikethrough**, **Superscript**, **Subscript**, **Code**, and **Link**.
- Headings offer the shorter set: **Bold**, **Italic**, **Code**, and **Link**.

With nothing selected the format buttons are disabled — they act on a range — and only **Link** stays clickable. The keyboard versions: :kbd[⌘B] / :kbd[Ctrl+B] for bold, :kbd[⌘I] / :kbd[Ctrl+I] for italic, :kbd[⌘`] / :kbd[Ctrl+`] for code.

## Links

1. Select the text to link.
2. Click the **Link** button, or press :kbd[⌘K] / :kbd[Ctrl+K].
3. Type the address and press :kbd[Enter] (or click **Apply**).

Put the cursor inside an existing link and open the same popover to see its address — **Update** changes it, **Remove** unlinks the text while keeping the words.

## Insert data

The **Insert data** button beside the format group opens a searchable list of the data available on your page. Pick an entry and Studio drops a live placeholder into your sentence — it shows the real value when the page renders. Inside a repeating list you also get the current item's fields and its position. Where that data comes from is covered in **[Logic](/docs/studio/logic)**.

## Pasting

Paste is always plain text: copy from a website or a Word document and you get the words — never the fonts, colors, or stray markup they were wrapped in. Add your own formatting after pasting.

## Text inside components

Click text inside a component instance — a card title, a button label — and you edit that one instance's text in place. It's a single plain value rather than free-form content, so the rules tighten:

- :kbd[Enter] finishes and keeps the change; :kbd[Esc] cancels it.
- Formatting, slash commands, and paragraph splits are off.
- The toolbar's name badge shows which component option you're editing (for example `product-card · title`).

Text that a component fills from data can't be edited this way — typing over it would break its connection to the data. Change the source data instead, or click **Edit Component** in the toolbar to open the component itself.

:::doc-note
Behind the scenes, Studio keeps the markup tidy as you type — adjacent formats merge, empty leftovers are removed — and saves the result as plain Markdown in the page's file, so bold is just `**bold**` on disk.
:::

## Typing in other scripts

Input methods that compose characters from several keystrokes — Japanese, Chinese, Korean, Vietnamese and others — work the way they do anywhere else on the page. Studio leaves your composition alone until you accept it, then records the finished text as one edit. Nothing is saved mid-composition, and a co-author's change never lands on top of what you are still typing.

## Next

- Insert whole blocks from the keyboard with **[Slash commands](/docs/studio/editing/slash-commands)**
- All the keys in one place: **[Keyboard shortcuts](/docs/studio/interface/shortcuts)**
