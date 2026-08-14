---
title: "Redirects"
description: "Edit a site's redirect rules as a table in Jx Studio, with checks for chains, loops, and rules a real page already shadows, plus _redirects and CSV import."
spec:
  - site-architecture.md#11.4
code:
  - packages/studio/src/grid/redirects.ts
  - packages/studio/src/grid/redirects-grid.ts
---

# Redirects

When a page moves, its old URL should keep working — a redirect maps the one to the other. Studio edits the whole set as a table, and checks it for the three mistakes that a redirect file cannot show you by reading it.

Open it with **Edit Redirects** from [Quick Access](/docs/studio/interface/quick-access). The table opens as a document tab, and the checks run as it opens.

## The table

Three columns, all editable:

| Column          | What it holds                                                              |
| --------------- | -------------------------------------------------------------------------- |
| **Source**      | the path a visitor asks for — `/old-page`, or a pattern like `/blog/:slug` |
| **Destination** | where they land: another path on the site, or a full URL somewhere else    |
| **Status**      | `301`, `302`, `307`, `308`, or `200`                                       |

`301` is a permanent move and is what a new row gets. `200` is a **rewrite** — the destination's content is served at the source's URL and the address bar doesn't change.

It's a grid, so everything in **[Grid mode](/docs/studio/editing/grid)** applies here: double-click to edit, add and delete rows, select ranges, find and replace, undo, and one batched **Save** (:kbd[⌘S] / :kbd[Ctrl+S]) that writes every pending change at once. The view menu keeps saved views, column order and sorting per table.

Saving writes the `redirects` block of `project.json` as a single transaction — the same door, the same undo, and the same refusal-with-a-Problem as every other project setting. A `301` is written in the short form (`"/old-page": "/new-page"`); any other status becomes an object with its `destination` and `status`. Empty the table and the key is removed rather than left behind as `{}`.

A save is refused whole rather than half-written, so the site never ends up with some of its old URLs working. Studio checks, before it writes, that:

- every row has a source and a destination;
- every status is one of the five the column offers;
- no two rows claim the same source.

The reason stays attached to the rows that caused it, and they stay pending until you fix them.

## What Studio checks

Three checks run over the whole rule set — on open, on every save, and whenever you ask. None of them is visible by reading the file, which is why they exist. Each finding becomes a [Problem](/docs/studio/interface/problems-and-progress) grouped under **Redirects**, naming the rule and carrying a button back to the table.

- **Chain** — a rule whose destination is itself a rule: `/a → /b → /c`. It works, and it costs the visitor a second round trip. Worse, each hop is cached separately, so a correction to the last hop can sit behind a cached earlier one. The fix is to point the first rule straight at the final destination, and the Problem prints the whole path it walked.
- **Loop** — the rules come back around to a source already visited, so a request for it never reaches a page. This is the one filed as an **error**: it isn't a slow page, it's a broken one.
- **Shadow** — a rule for a path the project already has a real page at. Two hosts give two different answers and neither is what you meant by writing both: a host that serves static files before consulting `_redirects` answers with the page, so the rule never fires; meanwhile the build writes its redirect file over that page in `dist/` and warns. Remove the rule or the page.

**Validate Redirects** runs the same three checks on demand — the thing you want after fixing one. When nothing is wrong it says how many rules it checked and that it found no chains, loops or shadowed rules.

:::doc-note
A destination containing `:param` or `*` is not followed. Where it actually lands depends on the request, so calling it a chain would be a guess — Studio reports nothing about it in either direction.
:::

:::doc-warning
The shadow check needs the site's real routes. If `pages/` can't be listed, the run says so and reports **chains and loops only** — reporting a clean bill from a short route list would make every shadowed rule look fine.
:::

## Import an existing set

**Import Redirects…** opens a paste box that takes either format:

- a Netlify/Cloudflare **`_redirects`** file — `source destination [status]`, one rule per line, `#` comments and blank lines skipped, and a forcing `!` after the status tolerated;
- **CSV** with a `source,destination,status` header. The source column also answers to `from`, `old` or `path`; the destination column to `to`, `new` or `target`; the status column to `code`. With no recognizable header, the first three columns are read positionally — which is what makes a two-column paste out of a spreadsheet work.

Studio picks the reader by looking for a comma on the first line that isn't blank or a comment, and tells you which one ran, because that guess can be wrong.

Imported rows are **staged, not written**. They arrive as pending rows in the table for you to read before you save — an import is the one set of redirects nobody has gone through line by line. Two things are never silent:

- a source the table already holds is skipped, and named;
- a line that couldn't be read is listed with its line number.

:::doc-tip
The [AI assistant](/docs/studio/ai/chat) can drive all three of these — open the table, import a pasted `_redirects` file, or check the rules and report what it found.
:::

## Next

- **[Redirects](/docs/framework/site/redirects)** — what the build emits from these rules, and how each host reads it
- **[Routing](/docs/framework/site/routing)** — how real pages claim their URLs, which is what a shadow collides with
- **[Publish](/docs/studio/publish)** — getting the change live
