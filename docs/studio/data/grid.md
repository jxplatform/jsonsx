---
title: "Data grid"
description: "Browse and edit live database rows in Jx Studio's data grid: paging, typed cells, batched Save, add and delete rows — and how it differs from file grids."
code:
  - packages/studio/src/grid/sources/connector-source.ts
  - packages/studio/src/grid/grid-open.ts
  - packages/studio/src/grid/grid-panel.ts
  - packages/server/src/data-api.ts
---

# Data grid

The data grid is **[Grid mode](/docs/studio/editing/grid)** pointed at a database table: the same spreadsheet surface — typed cells, range selection, fill down, find & replace, one batched **Save** — but the rows come from a live database instead of files in your project. Use it to check what visitors have submitted, fix a bad value, seed test rows, or clean out old data.

![A database table open as a grid tab with the toolbar and pager visible](../../images/data-grid.png)

## Open a table

Click **Open Data Grid** in the action row of _Settings > Connections_ or _Settings > Data Tables_. The picker lists every grid-able source in one place — pages and content collections under **Project**, then a **Data** group per connection with its tables. A connection with no tables yet shows "No tables — push a schema first": define and push in **[Data tables](/docs/studio/data/tables)**, then come back.

Each table opens as its own tab, so you can keep a grid alongside the page you're building.

## Read the columns

Columns come straight from the real database, so the grid always shows what's actually there — including columns your schema no longer mentions, and the account tables the auth extension creates. Three columns are managed for you and read-only: the id column (pinned at the left) and the `created_at` / `updated_at` timestamps. Everything else edits with the control its type calls for — text, number, checkbox for booleans, a date field for dates; structured values show as JSON text.

## Page through rows

Big tables aren't loaded whole: the grid shows 50 rows at a time, with **‹ Prev** / **Next ›** and the current range next to the total count in the toolbar. The **Filter rows** box searches within the rows currently loaded — use the pager to move through the rest. Per-column filters and click-to-sort, which file grids offer, aren't available on database grids yet.

## Edit, add, delete

Editing works exactly as in **[Grid mode](/docs/studio/editing/grid)** — double-click a cell, edit ranges, **Fill Down**, **Replace**, undo and redo — and nothing touches the database until **Save**:

- **Add Row** appends a pending row; fill in its cells (required fields must be provided).
- **Delete Rows** marks the selected rows; they're removed on save, after a confirmation.
- **Save** (:kbd[⌘S] / :kbd[Ctrl+S]) writes the whole batch — the button counts your pending changes.

On save, each row becomes its own write to the database. Rows that succeed are done; a row the database refuses — a missing required value, a wrong type — stays pending with the reason attached to its cells, so you can fix it and save again. There are no stale-file checks here because there are no files: the database itself is the authority, and **Refresh** re-reads it at any time.

:::doc-warning
Database rows aren't files in your project — they're not in version control, and a saved deletion cannot be undone. Studio confirms before deleting, but after that the rows are gone.
:::

## Where it's different from file grids

|                 | File grids (collections, pages, CSV)                                     | Data grid                  |
| --------------- | ------------------------------------------------------------------------ | -------------------------- |
| Rows are        | files in your project                                                    | rows in a database         |
| Loaded          | whole                                                                    | 50 per page                |
| Save writes     | files (frontmatter, CSV cells)                                           | one database write per row |
| Conflict safety | stale-file detection                                                     | per-row database errors    |
| Undo after save | revert the file in [Source control](/docs/studio/publish/source-control) | none — the write is live   |

## User accounts in the grid

With the auth extension enabled, its `user` and session tables show up in the picker like any other table. Editing user rows here is also how roles are assigned — see **[Auth and secrets](/docs/studio/data/auth-and-secrets)**.

## Next

- **[Grid mode](/docs/studio/editing/grid)** — the shared spreadsheet surface in full: ranges, fill down, find & replace
- **[Data tables](/docs/studio/data/tables)** — change what columns a table has
