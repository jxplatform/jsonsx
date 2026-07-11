# `@jxsuite/connector`

> Database connections and dynamic data tables for Jx sites.

## Overview

`@jxsuite/connector` is the Jx extension bridging sites to live databases. It contributes two
project.json sections and serves them over the canonical `/_jx/data` wire contract
(specs/extensions.md §11–§12):

- **`connections`** — named database connections. Entries carry identifiers and env-var _names_
  only (`binding`, `databaseId`, `urlEnv`, `hyperdriveId`); secret values live in `.dev.vars`
  locally and the platform secret store in production. Providers: Cloudflare **D1**, **Supabase**
  (postgres over postgres-js/Hyperdrive), and file-backed **Sqlite** (bun:sqlite).
- **`data`** — dynamic tables. Each entry names its connection, a column `schema` (plain Jx field
  schemas plus relationship refs — see specs/relationships.md), an `id` strategy
  (`"uuid"` | `"integer"`), `timestamps`, `indexes`, `permissions`
  (`public | none | authenticated | owner | role:<r>`), and an optional `ownerField`.

Kysely is the data bridge: one JSON-drivable query/schema builder across D1, postgres, and
sqlite, on Workers, Bun, and node.

## Enable it

```json
{
  "extensions": ["@jxsuite/parser", "@jxsuite/connector"],
  "connections": { "main": { "provider": "sqlite" } },
  "data": {
    "comments": {
      "connection": "main",
      "permissions": { "read": "public", "insert": "public" },
      "schema": {
        "type": "object",
        "properties": { "message": { "type": "string" } },
        "required": ["message"]
      }
    }
  }
}
```

Then `jx schema` (regenerates the project schemas) and `jx db push [--dry-run]` (additive-only
schema sync — tables and columns are created, never dropped or retyped). In dev, the server
stands D1 connections in with local SQLite at `.jx/data/<connection>.sqlite`, auto-synced on
first touch.

## State classes

- `TableQuery` / `TableEntry` — rows (content filter grammar: `filter`, `sort`, `limit`,
  `offset`, `include`) and single rows by id (`#/$params/<name>` refs resolve against the route).
- `TableInsert` / `TableUpdate` / `TableDelete` — form-friendly write actions
  (`"onsubmit": { "$ref": "#/state/addComment" }` reads the form's FormData).

In compiled sites these **lower** to core defs (specs/extensions.md §8.3): queries become plain
`Request` fetches against `/_jx/data`, actions become inline `Function` handlers — no extension
code ships to the browser. Read-after-write rides the `_v` convention: lowered queries append
`_v=${(state._v || 0)}` to their URL and successful writes bump `state._v`, re-running every
query effect on the page.

## Permissions (fail-closed)

`public` rules pass without auth; `none` always denies; every other rule requires the auth
extension's hooks on the shared server context — absent auth means 401. Defaults: read `public`,
writes `none`. Owner rules scope reads/writes via `ownerField`.

## Field-union extras

Table columns are plain core field schemas plus relationship refs, so this package ships **no**
`schemas.fields` fragment — the manifest convention (a fragment whose `$defs` members join the
per-project field union) exists for extensions that need shapes beyond the core union.

## Versioning

Published to npm as `@jxsuite/connector` — TypeScript source, like every `@jxsuite` package,
following the monorepo's release train. Extensions may depend on core packages
(`@jxsuite/schema`) but never the reverse; the auth extension builds on this package's
`resolveDialect` seam and permission types (`@jxsuite/connector/types`).
