---
title: "Server mounts"
description: "How an extension class mounts routes under /_jx/ in the deployed-site worker and the dev server: the server block, mount order, and the shared context."
spec:
  - extensions.md#11
  - extensions.md#11.1
code:
  - extensions/auth/src/Auth.class.json
  - extensions/auth/src/worker.ts
  - extensions/connector/src/Data.class.json
  - extensions/connector/src/worker.ts
---

# Server mounts

An extension class contributes live routes to a deployed Jx site — and to the dev server — when its descriptor carries a top-level `server` object plus a `mount` capability. That is the whole admission test: no plugin API to register against, no HTTP framework to adopt. The generated site worker and the dev server both discover the block through the [extension registry](/docs/extending/extensions/anatomy) and dispatch requests to the handler your `mount` method returns.

This page covers the declaration, the handler contract, how mounts cooperate through the shared context, and the section-owner `deploySchema` hook that lets a mounted section contribute to schema pushes.

## The server block

The auth extension's section class, `extensions/auth/src/Auth.class.json`, declares its mount in one line:

```json
"server": { "basePath": "/_jx/auth", "order": 10, "module": "@jxsuite/auth/worker" }
```

| Key        | Meaning                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `basePath` | The route subtree this mount owns. Must be under `/_jx/`. Conflicts are a registry error.              |
| `order`    | Mount order (ascending). Earlier mounts run first and may populate the shared context.                 |
| `module`   | Bare specifier the generated worker imports, which survives bundling; falls back to `$implementation`. |

Every mount lives under `/_jx/` — the reserved subtree for extension routes on a running site — and each `basePath` has exactly one owner. Two extensions claiming the same subtree fail the registry build instead of shadowing each other.

## The mount capability

`mount` is a static [capability method](/docs/extending/extensions/capabilities) with `timing: ["server"]`. It returns a **fetch-style handler**:

```ts
(request: Request, env: Record<string, unknown>) => Promise<Response>;
```

You need no HTTP framework: the generated worker wraps each handler itself (`app.all('<basePath>/*', c => handler(c.req.raw, c.env))`), and the dev server dispatches to it directly.

`mount(options, ctx)` receives:

- `options` — JSON inlined at generation time, plus host-provided values (the section manifest, resolved class constructors). Because it is baked into the worker, it may carry identifiers only — never secret values. See [Security and secrets](/docs/extending/extensions/security).
- `ctx` — the shared server context, described below.

Here is the auth extension's real mount, abbreviated from `extensions/auth/src/worker.ts`:

```ts
export const Auth = {
  mount(options: AuthMountOptions, ctx: JxServerContext) {
    const state = createAuthMountState();
    ctx.auth = {
      authorize: (input) => Promise.resolve(evaluatePermission(input)),
      getSession: async (request, env) => {
        try {
          const auth = await getAuthForEnv(state, options, env);
          return await getSessionContext(auth, request);
        } catch {
          return null; // fail-closed: an unreachable auth backend means signed out
        }
      },
    };
    return (request: Request, env: Env): Promise<Response> =>
      handleAuthRequest(request, env, options, state);
  },
};
```

The pattern to copy: set up per-isolate state in the closure, publish anything later mounts need onto `ctx`, and return the handler. Secret values (the signing secret, database URLs) never appear here — they arrive through `env` on each request.

## Mount order and the shared context

Each worker isolate creates **one** mutable `JxServerContext` object and passes it to every mount in ascending `order`. Mounts communicate through it:

```ts
interface JxServerContext {
  auth?: {
    getSession(request: Request, env: Record<string, unknown>): Promise<SessionInfo | null>;
    authorize(input: AuthorizeInput, env: Record<string, unknown>): Promise<AuthorizeDecision>;
  };
  [key: string]: unknown;
}
```

The first-party extensions demonstrate the choreography: the auth mount (order 10) sets `ctx.auth`; the connector's data mount (order 20) consumes it to evaluate table permission rules. Pick an order above the mounts you depend on — the guestbook example mounts at order 30 so both hooks are already in place.

**Fail-closed rule**: a mount that gates writes on authorization must deny everything except explicitly-public rules when `ctx.auth` is absent. The data mount does exactly this — without the auth extension, only `public` permission rules pass.

The connector's data mount is the canonical consumer, serving the wire contract every table rides on:

```
GET    /_jx/data/:table        ?filter=<json>&sort=<json>&limit=&offset=&include=
GET    /_jx/data/:table/:id
POST   /_jx/data/:table
PATCH  /_jx/data/:table/:id
DELETE /_jx/data/:table/:id
```

:::doc-note
The dev server constructs mounts the same way the generated worker does, so `jx dev` exercises the identical code path — including `ctx` ordering and the fail-closed behavior. See [The dev server](/docs/extending/embedding/dev-server).
:::

## Section-owner deploySchema

Connector classes declare a `deploySchema` capability to sync tables ([Connectors](/docs/extending/extensions/connectors)). A **non-connector** [project-section class](/docs/extending/extensions/project-sections) may declare one too, letting its section contribute steps to the schema push (`jx db push`, the Studio push button). The signature differs — there is no single connection definition to hand over:

```
deploySchema(sectionValue, projectConfig, { env, dryRun?, connection?, connectors? })
  → { steps, applied, warnings, connection }
```

- `steps` are ready push-plan entries (`{ kind, table?, summary, sql?, connection? }`). Hosts append them **after** the connector plan and default each step's `kind` to the contributing section key — the auth extension's Better Auth system-table migration lands as `kind: "auth"` steps this way.
- `connectors` carries the same provider stand-ins the mounts receive, so dev pushes hit the `local:` stand-in databases.
- When a push is filtered to a `connection` the section does not live on, return empty steps.

Hosts stay extension-agnostic throughout: registry dispatch only, no extension imports, no hardcoded section names. `Auth.deploySchema` in `extensions/auth/src/worker.ts` is the working reference.

## Related

- [Capability methods](/docs/extending/extensions/capabilities) — roles, `timing`, and how hosts invoke statics.
- [Security and secrets](/docs/extending/extensions/security) — why mount options carry identifiers only.
- [Tutorial: a guestbook extension](/docs/extending/extensions/tutorial-guestbook) — a mount built end to end.
- [Protocol route reference](/docs/extending/reference/studio-routes) — the `/__studio/*` routes, a separate surface from `/_jx/*` mounts.
