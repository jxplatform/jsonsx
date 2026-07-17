---
title: "Connectors"
description: "The connector block that makes a class a database connection provider, and how @jxsuite/connector implements it for D1, Supabase, and SQLite."
spec:
  - extensions.md#12
  - extensions.md#8
code:
  - extensions/connector/src/D1.class.json
  - extensions/connector/src/Data.class.json
  - extensions/connector/src/worker.ts
  - extensions/connector/jx-extension.json
---

# Connectors

A **connector** is a class that provides database connections: it knows how to open a dialect against a backing service, sync table schemas into it, emit deployment bindings, and probe reachability. A class becomes a connector when its descriptor carries a top-level `connector` object plus the connector [capability methods](/docs/extending/extensions/capabilities).

This page covers the declaration contract, then walks the `@jxsuite/connector` extension — the reference implementation — to show how a full data layer is assembled from it. If you want to _use_ databases rather than provide one, start with the user-level [Databases](/docs/studio/data) docs instead.

## The connector block

The D1 provider class, `extensions/connector/src/D1.class.json`, declares:

```json
"connector": {
  "provider": "d1",
  "kind": "sqlite",
  "local": "sqlite",
  "serve": "@jxsuite/connector/worker",
  "module": "@jxsuite/connector/d1"
}
```

| Key        | Meaning                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `provider` | Identifier for the backing service (`d1`, `supabase`, `sqlite`).                                              |
| `kind`     | SQL dialect family: `"sqlite"` \| `"postgres"`. Consumed by dependents needing a dialect type (e.g. auth).    |
| `local`    | When `"sqlite"`, the dev server stands this connector in with a local SQLite file (auto-synced on first use). |
| `serve`    | The data-mount module serving this connector's tables.                                                        |

(The class also carries a `module` bare specifier naming the provider implementation for bundler-robust imports, mirroring the `server` block's `module` key.)

## Connector capabilities

The block grants nothing by itself — behavior attaches through static capability methods declared in `$defs.methods` by `role`:

| Role             | Signature                                                                   | Consumers                  |
| ---------------- | --------------------------------------------------------------------------- | -------------------------- |
| `dialect`        | `(connection, env) → Kysely Dialect`                                        | data mounts, auth, deploy  |
| `deploySchema`   | `(tables, connection, { env, dryRun }) → { statements, applied, warnings }` | `jx db push`, Studio push  |
| `bindings`       | `(connection) → wrangler config fragment`                                   | scaffolding, `jx db push`  |
| `testConnection` | `(connection, env) → { ok, error? }`                                        | Studio connections UI, CLI |

All four are `scope: "static"` with `timing: ["compiler", "server"]` — hosts import the implementation and call them without constructing an instance; browser hosts round-trip through the dev server. `env` is where secret values arrive at call time; the `connection` definition itself carries identifiers and env-var names only ([Security and secrets](/docs/extending/extensions/security)).

## The reference implementation

`@jxsuite/connector` builds a complete data layer from these hooks, wired exactly the way a third-party connector would be.

### Providers

Three provider classes each carry a `connector` block plus the four capabilities: **D1** (Cloudflare, binding-backed inside Workers, HTTP-API-backed for deploys and tests), **Supabase** (postgres over postgres-js/Hyperdrive), and **Sqlite** (file-backed via `bun:sqlite`). Kysely is the shared bridge — one JSON-drivable query and schema builder across all three dialects, on Workers, Bun, and node — so a new provider mostly means implementing `dialect`.

### Project sections

The extension also owns two [project sections](/docs/extending/extensions/project-sections):

- `connections` — named connections (`Connections.class.json`). Entries carry identifiers and env-var names only; the Studio settings form uses the `secret` control for values.
- `data` — dynamic tables (`Data.class.json`). Each entry names its connection, a column `schema` (plain Jx field schemas plus relationship refs), an `id` strategy, `timestamps`, `indexes`, `permissions`, and an optional `ownerField`.

### Schema push

`jx db push` (and Studio's **Push Schema** button) plans DDL through each provider's `deploySchema` — **additive-only**: tables and columns are created, never dropped or retyped. `--dry-run` returns the statements without applying. In dev, `local: "sqlite"` connections are stood in with `.jx/data/<connection>.sqlite`, auto-synced on first touch, so pushes and queries work before any cloud account exists.

### The data mount

`Data.class.json` also declares a [server mount](/docs/extending/extensions/server) — `/_jx/data`, order 20 — whose handler (`extensions/connector/src/worker.ts`) serves the canonical wire contract (`GET/POST/PATCH/DELETE /_jx/data/:table[/:id]`). Permission rules are evaluated fail-closed against `ctx.auth` from the auth mount.

### State classes and lowering

Pages consume tables through state classes: `TableQuery`/`TableEntry` for reads, `TableInsert`/`TableUpdate`/`TableDelete` for form-friendly writes. In compiled sites these **lower** to core defs — queries become plain `Request` fetches against `/_jx/data`, actions become inline `Function` handlers — so no extension code ships to the browser. Read-after-write rides the `_v` convention: lowered queries append `_v=${(state._v || 0)}` to their URL and successful writes bump `state._v`, re-running every query effect on the page.

### Grid support

Studio's [data grid](/docs/studio/data/grid) is the owner console over the same tables. It rides the dev server's `/__studio/data/*` routes rather than the public mount — those intentionally bypass table permission rules and are protected by the dev server's loopback/token boundary instead ([Security and secrets](/docs/extending/extensions/security)).

:::doc-note
Everything an editor touches — connections, table schemas, permissions, the push button — is documented for Studio users under [Databases](/docs/studio/data), [Connections](/docs/studio/data/connections), and [Data tables](/docs/studio/data/tables). This page describes the extension machinery those surfaces are built on.
:::

## Related

- [Server mounts](/docs/extending/extensions/server) — the `/_jx/data` mount and the shared context.
- [Capability methods](/docs/extending/extensions/capabilities) — roles, timing, and lowering.
- [First-party extensions](/docs/extending/extensions/first-party) — how connector, auth, and parser fit together.
- [Tutorial: a guestbook extension](/docs/extending/extensions/tutorial-guestbook) — a table-backed feature built on the connector.
