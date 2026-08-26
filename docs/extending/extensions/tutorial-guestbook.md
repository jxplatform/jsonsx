---
title: "Tutorial: a guestbook extension"
description: "Assemble a moderated, auth-gated guestbook from extension parts: a project section, a dynamic table, a /_jx/ server mount, and lowered page actions."
spec:
  - extensions.md#15
  - extensions.md#11
  - extensions.md#12
code:
  - extensions/connector/src/Data.class.json
  - extensions/connector/src/TableQuery.class.json
  - extensions/connector/src/TableInsert.class.json
  - extensions/auth/src/worker.ts
---

# Tutorial: a guestbook extension

This tutorial builds `@acme/jx-guestbook`, the spec's second worked example: a moderated, auth-gated guestbook a site enables with one `extensions` line. Where the [TOML tutorial](/docs/extending/extensions/tutorial-toml-format) exercised the format surface, this one demonstrates the full stack: a `project.json` section with a Studio settings form, a dynamic table, a server mount cooperating with auth, and page state that compiles down to core defs. It builds **on** the connector and auth extensions as dependencies rather than reimplementing them. Plan on about an hour, reading the first-party sources alongside.

**Prerequisites**: [Project sections](/docs/extending/extensions/project-sections), [Server mounts](/docs/extending/extensions/server), and [Connectors](/docs/extending/extensions/connectors); a test project with `@jxsuite/connector` and `@jxsuite/auth` already enabled ([Databases](/docs/studio/data)).

The spec describes this example at the architecture level, and this tutorial keeps that altitude: each step pins down the declarations and points at the first-party file implementing the same pattern, rather than reprinting implementation code.

## 1. Manifest and fragment

Scaffold the package the same way as the [TOML tutorial](/docs/extending/extensions/tutorial-toml-format): a `package.json` with a `"jx"` field, a `jx-extension.json` naming one section class (say `Guestbook`), and (because this extension owns a `project.json` section) a project [schema fragment](/docs/extending/extensions/schema-composition) listed under `schemas.project`.

The fragment's schema defines the section value, `{ table, moderation }`: which table entries land in, and whether they await approval. The section class declares ownership plus a generic settings form:

```json
"project": { "key": "guestbook" },
"$studio": { "settings": { "layout": "form" } }
```

You should now see, after enabling the extension in your test project and running `jx schema`, a `guestbook` key validating in `project.json`, and a **Guestbook** section rendered from your fragment in Studio's Settings, with no Studio code written. The connector's `extensions/connector/schemas/project.fragment.schema.json` and `Data.class.json` are the fuller reference for this step.

## 2. The table

The guestbook stores entries in an ordinary connector table instead of hand-rolled SQL. Declare a `projectData` [capability](/docs/extending/extensions/capabilities) on the section class that materializes a `data`-style table definition from the section value (columns `name` and `message`, readable by anyone, writable by signed-in users):

```json
{
  "permissions": { "read": "public", "insert": "authenticated" },
  "schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "message": { "type": "string" }
    }
  }
}
```

Because this is a standard table definition, entries flow through the connector's standard mount and DDL sync: `jx db push` creates the table additively, the dev server's local SQLite stand-in serves it immediately, and the Studio [data grid](/docs/studio/data/grid) doubles as your moderation console. No custom SQL anywhere.

## 3. The mount

Moderation needs server-side logic, so the class also declares a [server block](/docs/extending/extensions/server):

```json
"server": { "basePath": "/_jx/guestbook", "order": 30 }
```

Order 30 places it after auth (10) and the data mount (20), so by the time your `mount(options, ctx)` runs, `ctx.auth` is published and `/_jx/data` is live. The mount returns a fetch-style handler that reads `ctx.auth` for session lookups and proxies moderated writes into `/_jx/data/guestbook`, accepting a public submission, stamping it unapproved when `moderation` is on, and letting the table's own permission rules govern everything else. `Auth.mount` in `extensions/auth/src/worker.ts` is the pattern to copy: per-isolate state in the closure, the handler as the return value, secrets only ever read from `env`.

You should now see `jx dev` answering under `/_jx/guestbook`, with the same behavior the generated worker will have in production.

## 4. The page

The visitor-facing page needs no extension-specific runtime. It uses the connector's state classes: a `TableQuery` entry listing approved entries, and a form whose submit posts through a `TableInsert` action. Both are [lowered](/docs/extending/extensions/capabilities) at compile time, so queries become plain `Request` fetches and the action becomes an inline `Function` handler. No extension code ships to the browser, and the `_v` read-after-write convention re-runs the listing query as soon as a write lands.

## 5. Ship it

A project adds the package and syncs:

```json
{ "extensions": ["@jxsuite/parser", "@jxsuite/connector", "@jxsuite/auth", "@acme/jx-guestbook"] }
```

Then `jx schema && jx db push`. You should now have a moderated, auth-gated guestbook with `project.json` validation, a Studio settings section, and dev-server parity. None of it required changes to any core package.

## What you built

| Piece               | Mechanism                                  | First-party reference                            |
| ------------------- | ------------------------------------------ | ------------------------------------------------ |
| `guestbook` section | `project` block + schema fragment          | `extensions/connector/src/Data.class.json`       |
| Settings form       | `$studio.settings` (`layout: "form"`)      | `extensions/auth/src/Auth.class.json`            |
| Entries table       | `projectData` → connector table definition | `extensions/connector/src/Data.class.json`       |
| `/_jx/guestbook`    | `server` block + `mount`, order 30         | `extensions/auth/src/worker.ts`                  |
| Page state          | `TableQuery` / `TableInsert`, lowered      | `extensions/connector/src/TableQuery.class.json` |

## Next steps

- [Security and secrets](/docs/extending/extensions/security): the fail-closed rules your mount inherits.
- [Server mounts](/docs/extending/extensions/server): the shared-context contract in full.
- [First-party extensions](/docs/extending/extensions/first-party): the three packages this tutorial leaned on.
