---
title: "Grid mode"
description: "Edit collections, CSV files, and page metadata as a spreadsheet in Jx Studio: typed cells, fill down, find & replace, and one batched Save."
code:
  - packages/studio/src/grid/grid-panel.ts
  - packages/studio/src/grid/grid-view.ts
  - packages/studio/src/grid/grid-controller.ts
  - packages/studio/src/grid/grid-open.ts
  - packages/studio/src/grid/sources/content-source.ts
  - packages/studio/src/grid/sources/csv-file-source.ts
---

# Grid mode

Grid turns tabular content into a spreadsheet on the canvas: rows and columns, range selection, copy and paste, and a single **Save** that writes every pending change at once. Reach for it when editing entries one file at a time is too slow — renaming a category across fifty posts, or fixing prices in a product sheet.

<!-- TODO(screenshot): grid-mode — a content collection open as a grid with edited cells highlighted and the Save button showing a count -->

## Open a grid

- **A CSV file** — open it from **Files** (or Quick Access); spreadsheet files open straight into Grid.
- **A content collection** — right-click the collection's folder in **Files** and choose **Edit Collection in Grid**.
- **All pages** — right-click the `pages` folder and choose **Edit Pages in Grid**.
- **From the Data activity** — click **Open Data Grid** for a picker that lists pages, every collection, and connected database tables in one place.

## Edit cells

Double-click a cell to edit it. Columns are typed, so each kind gets the right control:

- Text and number cells — type; number cells clean up currency symbols and commas for you.
- On/off cells — a checkbox; choice cells — a dropdown; date cells — a date field.
- List cells — chips: :kbd[Enter] or a comma adds one, :kbd[Backspace] removes the last, and each chip has its own remove button.
- Image cells open the media picker, and relationship cells — a field that points at another collection — open a picker of that collection's entries.

Edited cells are highlighted, and nothing touches your files yet — everything waits for **Save**. Undo and redo (:kbd[⌘Z] / :kbd[Ctrl+Z]) work on grid edits like anywhere else.

## Work in ranges

- Drag across cells to select a range. Copy and paste work on ranges — including pasting rows copied from a real spreadsheet.
- :kbd[Delete] or :kbd[Backspace] clears the selected cells, as one undoable step.
- **Fill Down** copies the range's first row into every row below it (:kbd[⌘D] / :kbd[Ctrl+D]).
- **Replace** opens find & replace across all text cells; **Replace All** buffers the whole replacement as one undoable change — save to apply it.
- **Filter rows** searches across every column; each column header also has its own filter box and click-to-sort.
- Drag column headers to reorder them and drag their edges to resize — each grid remembers its column layout.

## Add and remove rows

- **Add Row** appends a pending row. In a collection or pages grid, fill in its **Path** cell — the file the new entry will become.
- **Delete Rows** marks the selected rows for deletion; they're removed when you save, after a confirmation.
- Added and marked rows are tinted until you save.

## Save — one batch

Nothing writes until you click **Save** — the button counts your pending changes (:kbd[⌘S] / :kbd[Ctrl+S] does the same). On save, Studio checks required cells, confirms any deletions, writes everything, and reports what saved. If a change can't be written, that cell stays pending with the reason attached — fix it and save again.

Studio also protects you from crossed wires:

- A row whose file is open in a tab with unsaved changes won't save — save or close that tab first.
- If a file changed on disk after the grid loaded (a teammate's edit, for example), its row is marked stale and skipped rather than overwritten. **Refresh** reloads from disk — asking first if you have pending edits.

:::doc-warning
Saving with rows marked for deletion permanently deletes those entry files. Studio asks for confirmation before it does.
:::

## Collection and pages grids

A collection grid shows one row per entry file and one column per field of the collection's content type, plus any extra fields found in the entries — the **Path** column stays pinned at the left. The pages grid does the same for every Markdown page under `pages/`, with title and description first. Editing a cell edits that entry's **[frontmatter](/docs/studio/editing/frontmatter)**; collections themselves are defined in **[Content types](/docs/studio/projects/content-types)**.

:::doc-note
Saving a collection or pages row rewrites that file's frontmatter block from scratch — hand-written comments and key order inside it aren't preserved. The "rewrites frontmatter" note in the grid toolbar is the reminder.
:::

## CSV grids

A CSV file opens as a grid tab with **Code** as its raw-text alternate, and saves as one atomic step: if the file changed on disk underneath you, the save stops instead of overwriting it. Only the cells you actually edited are rewritten — untouched cells keep their exact original text, so a one-cell fix produces a one-cell diff.

## Next

- The keys the grid claims for itself, and the ones that stay global: **[Keyboard shortcuts](/docs/studio/interface/shortcuts)**
- Bulk-edit the fields behind your content: **[Frontmatter and page metadata](/docs/studio/editing/frontmatter)**
