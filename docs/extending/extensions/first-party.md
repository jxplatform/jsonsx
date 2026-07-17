---
title: "First-party extensions"
description: "What @jxsuite/parser, @jxsuite/connector, and @jxsuite/auth each contribute: sections, formats, classes, server mounts, and Studio settings."
spec:
  - extensions.md#2
code:
  - extensions/parser/jx-extension.json
  - extensions/connector/jx-extension.json
  - extensions/auth/jx-extension.json
---

# First-party extensions

Three extensions ship with Jx, and they are deliberately unprivileged: each is wired through the same manifest, admission blocks, and capability roles available to any third-party package. That makes them two things at once — the batteries most projects start with, and the reference implementations to crib from when you build your own. This page maps what each one contributes; follow the links for the mechanics.

| Package              | Sections              | Formats       | Server mounts          | Connector providers  |
| -------------------- | --------------------- | ------------- | ---------------------- | -------------------- |
| `@jxsuite/parser`    | `content`             | Markdown, CSV | —                      | —                    |
| `@jxsuite/connector` | `connections`, `data` | —             | `/_jx/data` (order 20) | D1, Supabase, Sqlite |
| `@jxsuite/auth`      | `auth`                | —             | `/_jx/auth` (order 10) | —                    |

## @jxsuite/parser — content and Markdown

The content layer, and the model [format extension](/docs/extending/extensions/formats).

- **Section**: `content` — file-based content collections, owned by the `Content` class (`referenceable`, so collections join the relationships vocabulary). Its `projectData` and `resolvePaths` capabilities load collections into `_project.content` and expand `$paths` for pages discovery.
- **Formats**: `Markdown` (`.md`, admitted to pages, components, and content; an `exportTarget` with parse, serialize, discover, and load capabilities) and `Csv` (`.csv`, content-only, `remote: true` so sources may be `http(s)` URLs).
- **Classes**: `MarkdownCollection`, `ContentCollection`, `ContentEntry` — glob-and-query state prototypes over content files.
- **Schemas**: the only first-party package shipping a `document` fragment as well as a `project` one — its content-source shapes join both [composed schemas](/docs/extending/extensions/schema-composition).
- **Studio settings**: the **Content Types** section, a `layout: "map"` master-detail with the `schema-builder` control for frontmatter fields.

User-level docs: [Content collections](/docs/framework/site/content-collections) and [Jx Markdown](/docs/framework/site/jx-markdown).

## @jxsuite/connector — connections and data tables

The data layer, and the reference for both the [connector block](/docs/extending/extensions/connectors) and a [server mount](/docs/extending/extensions/server).

- **Sections**: `connections` (named database connections; identifiers and env-var names only) and `data` (dynamic tables: column schema, id strategy, indexes, permissions, `ownerField`; `referenceable`).
- **Providers**: `D1`, `Supabase`, and `Sqlite` classes, each with the four connector capabilities (`dialect`, `deploySchema`, `bindings`, `testConnection`) over a shared Kysely bridge.
- **Mount**: `/_jx/data` (order 20) — the canonical table wire contract, fail-closed against `ctx.auth`.
- **Classes**: `TableQuery`, `TableEntry`, `TableInsert`, `TableUpdate`, `TableDelete` — state prototypes that [lower](/docs/extending/extensions/capabilities) to core `Request`/`Function` defs in compiled sites.
- **Studio settings**: **Connections** and **Data Tables** sections (`layout: "map"`), with the `secret` control for connection URLs and the `schema-builder` for table fields; **Test Connection** and **Push Schema** ride the connector capabilities.

User-level docs: [Databases](/docs/studio/data), [Connections](/docs/studio/data/connections), [Data tables](/docs/studio/data/tables), [Data grid](/docs/studio/data/grid).

## @jxsuite/auth — sessions and permissions

Better Auth behind the connector's tables, and the reference for mount cooperation through the shared context.

- **Section**: `auth` — sign-in methods, redirects, roles, and the connection its system tables (`user`, `session`, `account`, `verification`) live on.
- **Mount**: `/_jx/auth` (order 10) — Better Auth's routes, publishing `ctx.auth = { getSession, authorize }` for the data mount to authorize against. Without it, table rules beyond `public`/`none` deny.
- **Push contribution**: a section-owner `deploySchema` capability contributes the system-table migration to `jx db push` as `kind: "auth"` steps ([Server mounts](/docs/extending/extensions/server)).
- **Classes**: `Session` (the live session, `null` when signed out — and always `null` outside browsers, so static pages render signed-out) and `AuthActions` (`signInEmail`, `signUpEmail`, `signInSocial`, `signOut` handlers to wire onto forms). Both default to client timing via `$studio.stateDefaults`.
- **Studio settings**: the **Authentication** section (`layout: "form"`), with the `secret` control for `secretEnv` — the signing secret itself never touches `project.json` ([Security and secrets](/docs/extending/extensions/security)).

User-level docs: [Auth and secrets](/docs/studio/data/auth-and-secrets).

## How they depend on each other

Auth depends on the connector (its dialect seam and permission types); both may depend on core packages; core packages never depend on any of them. That direction is CI-enforced, and it is what guarantees the claim these pages keep making: anything the first-party extensions do, yours can do too.

## Related

- [The anatomy of an extension](/docs/extending/extensions/anatomy) — manifests, admission blocks, and the registry.
- [Connectors](/docs/extending/extensions/connectors) and [Server mounts](/docs/extending/extensions/server) — the machinery connector and auth are built on.
- [Tutorial: a TOML format extension](/docs/extending/extensions/tutorial-toml-format) and [Tutorial: a guestbook extension](/docs/extending/extensions/tutorial-guestbook) — build your own alongside these references.
