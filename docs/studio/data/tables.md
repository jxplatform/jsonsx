---
title: "Data tables"
description: "Define database tables in Jx Studio's Data Tables section: the visual field schema, ids, indexes, permissions — and the additive, dry-run Push Schema flow."
code:
  - extensions/connector/src/Data.class.json
  - extensions/connector/src/columns.ts
  - extensions/connector/src/ddl.ts
  - packages/studio/src/panels/data-grid.ts
  - packages/studio/src/ui/form-controls.ts
---

# Data tables

A data table is like a content type for live data: a name, a set of fields, and the connection its rows are stored in. You define tables here; **Push Schema** then creates them in the actual database. Open the **Settings** gear at the bottom of the activity bar, then _Settings > Data Tables_ — tables on the left, the selected table's editor on the right.

<!-- TODO(screenshot): data-table-editor — the Data Tables section with a table selected, showing the connection picker and field schema builder -->

## Create a table

1. Click **New Entry** at the bottom of the table list.
2. Type a name — "Comments" becomes `comments` — and click **Create**.

The new table starts empty, readable by everyone and writable by no one. First pick its **connection** — a dropdown of the entries from **[Connections](/docs/studio/data/connections)**.

## Build the fields

The **schema** editor is the same visual field builder as **[content types](/docs/studio/projects/content-types)**: each field has a name, a type (string, number, boolean, array, object, reference), an optional format for string and array fields, and a **Req** toggle. Required fields must be provided whenever a row is inserted.

A **reference** field links a row to something else — its **Target** picker lists your content types, and the row stores the target entry's id. How references resolve is the same story as content **[relationships](/docs/framework/site/relationships)**.

:::doc-note
Under the hood a table's fields are ordinary Jx field schemas in the `data` section of `project.json`. The schema format also allows table-to-table references — a to-one reference becomes a `<field>_id` column, and a to-many reference between two tables materializes a junction table on push — but the visual Target picker currently offers content types; table targets are written in the JSON directly.
:::

## Table options

- **id** — how rows are identified: `uuid` (random text ids, the default) or `integer` (1, 2, 3…).
- **timestamps** — on by default; every row gets `created_at` and `updated_at` columns the server maintains for you.
- **indexes** — column names to index for faster lookups; an inner list makes one composite index.
- **permissions** — who may do what, one rule per action (`read`, `insert`, `update`, `delete`). Rules are `public` (anyone), `none` (no one), `authenticated` (any signed-in user), `owner` (the row's owner), or `role:<name>`. Defaults are read `public` and every write `none` — nothing is writable until you say so. Every rule beyond `public` and `none` needs the auth extension; without it those actions are simply denied. The rules are explained in **[Auth and secrets](/docs/studio/data/auth-and-secrets)**.
- **ownerField** — the column that records which user a row belongs to; required for `owner` rules, and stamped automatically on signed-in inserts.

## Push the schema

Defining a table describes it; pushing creates it. Click **Push Schema** in the action row:

1. Studio first compiles a **plan** — a dry run, nothing touched yet — and shows it as a list of steps: tables to create, columns to add, indexes, junction tables, and (with the auth extension) its account tables. Warnings appear below the steps. If everything already matches, the dialog says "Nothing to push — the schema is up to date" and there is no apply button.
2. Click **Apply** to execute the plan, or **Cancel** to back out. The dialog then reports "Schema applied." — or the errors, with nothing half-done claimed.

From the Data Tables section a push covers every connection; from the Connections section, selecting a connection first scopes the push to it.

Pushes are **additive only**: they create missing tables and columns and never drop, rename, or retype anything that exists. Removing a field from a schema leaves its column (and its data) in place — the plan notes such drift as a warning instead of destroying data. This makes pushing safe to run repeatedly.

The same push runs from a terminal or CI as `jx db push`, with the same plan and `--dry-run` flag — see the **[CLI reference](/docs/framework/build/cli)**.

## Using tables from pages

Rows never pass through your project files — pages talk to the tables live. In the **[State panel](/docs/studio/logic/state)**, the connector's sources appear in the **+ Add…** picker alongside the built-in **[data sources](/docs/studio/logic/data-sources)**: a table query lists rows with filter, sort, and limit rules (the same grammar as content collections); a table entry fetches one row by id; and the insert, update, and delete actions are made to be wired to a form's submit event. After a successful write, queries on the page refresh themselves.

To see and fix the rows by hand, open the **[Data grid](/docs/studio/data/grid)**.

## Next

- **[Data grid](/docs/studio/data/grid)** — browse, insert, and edit rows
- **[Auth and secrets](/docs/studio/data/auth-and-secrets)** — make permission rules beyond `public` work
