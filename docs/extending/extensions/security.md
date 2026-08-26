---
title: "Security and secrets"
description: "The extension security model: secret names ride the wire and values never do, plus the permission boundaries extensions and hosts must respect."
spec:
  - extensions.md#13
  - extensions.md#11
code:
  - extensions/connector/src/Connections.class.json
  - extensions/auth/src/worker.ts
  - packages/server/src/dev-vars.ts
---

# Security and secrets

Extensions run real code in three privileged places: the build, the dev server, and the deployed-site worker. The rules on this page are what keep that safe. They are load-bearing for every extension, first-party or third-party, and hosts enforce the ones they can.

## Names ride the wire, values never

**Secrets never enter `project.json`.** Committed config carries identifiers and env-var _names_ only:

```json
{
  "connections": {
    "main": { "provider": "supabase", "urlEnv": "SUPABASE_DB_URL" }
  },
  "auth": { "secretEnv": "BETTER_AUTH_SECRET" }
}
```

The same rule extends to everything derived from config: schema fragments describe name fields, `projectData` results expose the section under `_project.<key>` without secrets, and mount `options` are inlined into the generated worker as identifiers only. Secret _values_ reach extension code exclusively through the `env` argument of capability calls (`mount` handlers, `dialect`, `deploySchema`, `testConnection`) at request or invocation time.

Where the values actually live:

- **Local development**: `<project>/.dev.vars`, git-ignored (the wrangler convention). The dev server merges it over `process.env` when constructing mount environments (`packages/server/src/dev-vars.ts`).
- **Production**: `wrangler secret put <NAME>`, or the hosting platform's secret store.
- **Studio**: secret entry goes through the platform's secrets surface (`/__studio/secrets`); its list endpoint returns **names only**, never values. The `"secret"` [settings form control](/docs/extending/extensions/project-sections) writes there, never to `project.json`. The user-facing walkthrough is [Auth and secrets](/docs/studio/data/auth-and-secrets).

## Permission boundaries

Two layers of authorization exist on a running site, and they are deliberately different:

**The public mount surface (`/_jx/*`)** is governed by declared rules. The connector's table permissions (`public | none | authenticated | owner | role:<r>`) are evaluated on every request, and the system **fails closed**: a mount that gates writes on authorization must deny everything except explicitly-public rules when `ctx.auth` is absent from the [shared server context](/docs/extending/extensions/server). Absent auth means 401, not a silent grant. The auth mount's own `getSession` returns `null` on any backend failure for the same reason. Declared `ownerField` columns are stamped server-side with the session's user id, so clients can never forge ownership.

**The Studio data routes (`/__studio/data/*`)** are the owner console: they intentionally bypass table permission rules and are protected by the dev server's loopback/token boundary instead. Cloud backends hosting Studio must gate them on collaboration permission ([Backend protocol](/docs/extending/embedding/backend-protocol)).

:::doc-warning
A table with `insert: "public"` accepts writes from anyone on the internet. Prefer `authenticated` inserts, or accept the risk knowingly. Rate limiting and CAPTCHA are not part of the current contract.
:::

## What extensions may do

- Own a `basePath` under `/_jx/` and serve any routes inside it. Conflicts are a registry error, so no extension can shadow another's subtree.
- Read secret values from `env` at request time, and publish cooperation hooks on the shared context for later mounts (`ctx.auth` is the model).
- Contribute steps to the schema push via `deploySchema`, tagged with their own section key.
- Declare a `"secret"` control in `$studio.settings` so Studio routes the value to the secret store.

## What extensions may not do

- Write secret values into `project.json`, return them from `projectData`, or accept them through mount `options`, because the generated worker inlines options as committed JSON.
- Claim routes outside `/_jx/`, or a `basePath` another extension owns.
- Grant access when their auth dependency is missing. Fail closed, always.
- Be imported by core packages. The dependency rule (`core never depends on extensions`) is CI-enforced, and hosts import extension code only to invoke the static capabilities its descriptors declare, never for side effects.

## Related

- [Server mounts](/docs/extending/extensions/server): the shared context and the fail-closed rule in situ.
- [Connectors](/docs/extending/extensions/connectors): how connections keep secrets out of committed config.
- [Auth and secrets](/docs/studio/data/auth-and-secrets): the same model from the Studio user's chair.
- [Protocol route reference](/docs/extending/reference/studio-routes): the `/__studio/*` surface, including secrets and data routes.
