# `@jxsuite/auth`

> Better Auth sessions, sign-in flows, and table permissions for Jx sites.

## Overview

`@jxsuite/auth` is the Jx extension putting users behind the connector's data tables. It owns the
project.json `auth` section and mounts [Better Auth](https://better-auth.com) at
`/_jx/auth`, publishing the `ctx.auth = { getSession, authorize }` hooks on the shared server
context (specs/extensions.md §11). That mount runs at **order 10**, ahead of the connector's
`/_jx/data` mount (order 20). With it active, table permission rules beyond `public`/`none` come
alive:

| Rule            | Grants                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `authenticated` | Any signed-in user.                                                                               |
| `owner`         | Inserts stamp the table's `ownerField` with the user id; reads/updates/deletes scope to that row. |
| `role:<r>`      | Users whose `role` column equals `<r>`.                                                           |

Without the auth mount the data mount **fails closed**: only `public` rules pass.

Declaring an `ownerField` makes that column authoritative: **every** session-granted insert
(`authenticated`, `owner`, `role:<r>`) stamps it with the signed-in user's id, so clients can
never forge ownership.

The auth system tables (`user`, `session`, `account`, `verification`) live on an ordinary
connector connection, named by `auth.connection` and defaulting to the project's first-declared
connection. Better Auth's additive migrations create them: `jx db push` (or the Studio's push
button) plans them as `kind: "auth"` steps after the connector plan, and the dev server also syncs
them on first touch of `/_jx/auth`.

## Enable it

```json
{
  "extensions": ["@jxsuite/parser", "@jxsuite/connector", "@jxsuite/auth"],
  "connections": { "main": { "provider": "sqlite" } },
  "auth": {
    "connection": "main",
    "methods": { "emailPassword": true },
    "redirects": { "afterSignIn": "/", "afterSignOut": "/" }
  },
  "data": {
    "comments": {
      "connection": "main",
      "permissions": { "read": "public", "insert": "authenticated", "update": "owner" },
      "ownerField": "author_id",
      "schema": {
        "type": "object",
        "properties": { "message": { "type": "string" }, "author_id": { "type": "string" } },
        "required": ["message"]
      }
    }
  }
}
```

Secrets never enter project.json (specs/extensions.md §13): set the signing secret under the env
var named by `auth.secretEnv` (default `BETTER_AUTH_SECRET`) in `.dev.vars` locally and via
`wrangler secret put` in production. Social providers name their credential env vars the same way
(`providers.github.clientIdEnv`, defaulting to `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`).

## Page UX

```json
{
  "state": {
    "session": { "$prototype": "Session" },
    "auth": { "$prototype": "AuthActions" }
  }
}
```

- **`Session`** resolves to `{ userId, role?, user }` or `null` and updates live via
  `subscribe()`. Outside browsers it resolves to `null`, so statically generated pages always
  render the signed-out state.
- **`AuthActions`** resolves to `{ signInEmail, signUpEmail, signInSocial, signOut }`. Wire a
  form's `onsubmit` to `{ "$ref": "auth.signInEmail" }` and the handler reads the form's
  `email`/`password` fields, refreshes the session store, bumps the `_v` read-after-write version,
  and applies `auth.redirects`.

## v1 cuts

- **No email transport**: no verification or password-reset emails ship in v1, so email/password
  accounts are live immediately after sign-up.
- **Roles are edited via the data grid**: declare role names in `auth.roles` (this adds the
  `role` column to the user table); assign them by editing user rows in the Studio's data grid.
  Sign-up input can never set a role.
- **Public-insert abuse**: a table with `insert: "public"` accepts writes from anyone on the
  internet. Prefer `authenticated` inserts, or accept the risk knowingly (rate limiting /
  Turnstile are future work).

## Versioning

Published to npm as `@jxsuite/auth`, TypeScript source like every `@jxsuite` package, following
the monorepo's release train. Depends on `@jxsuite/connector` (the `resolveDialect` seam and the
permission/hook types it publishes for dependents); core packages never depend on this extension.
