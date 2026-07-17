---
title: "Dev server internals"
description: "Inside @jxsuite/server, the protocol's reference implementation: the route chain, the Studio API mount, the resolve proxies, and the security model."
spec:
  - server.md#3 # core endpoints
  - server.md#4 # studio filesystem API
  - server.md#4.2 # security
  - server.md#5 # code services
code:
  - packages/server/src/server.ts
  - packages/server/src/studio-api.ts
  - packages/server/src/resolve.ts
  - packages/server/src/jx-mounts.ts
  - packages/server/src/project-server.ts
---

# Dev server internals

`@jxsuite/server` is the reference implementation of the [backend protocol](/docs/extending/embedding/backend-protocol): a Bun-native dev server whose `/__studio/*` mount is the literal route table, plus the proxies and services that make documents behave in development as they do in production. This page is the architecture tour for backend implementers — for using the server day to day, see [the dev server](/docs/framework/build/dev-server) in the Framework section.

## One handler, an ordered route chain

`createDevServer()` stands up a single `Bun.serve` fetch handler that checks routes in a fixed order; the first claimant wins, and anything unclaimed falls through to static file serving:

1. `/__reload` — the SSE live-reload endpoint (skipped when `watch: false`).
2. `POST /__jx_resolve__` — the `$prototype`/`$src` resolution proxy.
3. `POST /__jx_server__` — the `timing: "server"` function proxy.
4. `/_jx/*` — extension server mounts.
5. `/__studio/*` — the Studio API (skipped when `studio: false`): the collab WebSocket upgrade, `activate`, then the AI, site-import, and code sub-APIs, then `handleStudioApi` for everything else.
6. Custom `middleware`, if the embedder passed one.
7. Static files: project files at their natural URLs, the active project's tree, `public/` at the site root, and bare npm specifiers resolved through `node_modules` and bundled on demand.

Ordering is load-bearing: the privileged endpoints must be claimed before the static fallback can ever see their paths, and `middleware` deliberately sits after the protocol routes so an embedder cannot accidentally shadow them.

## The Studio API mount and activation

`handleStudioApi` (in `studio-api.ts`) implements the protocol's route table against the filesystem. Its central piece of state is the **active project root**: `POST /__studio/activate` stores an absolute path, and from then on file operations, static serving, and format dispatch resolve against it. This is what lets one server open projects that live outside its own `root`.

Format and extension behavior is served from a per-project **extension registry**, built by scanning the project's dependencies and cached against `project.json`'s mtime — edit the manifest and the next request rebuilds the registry. The `formats`, `format`, and `project-schemas` routes all answer from it.

## The resolve proxies

`resolve.ts` implements the two endpoints the runtime uses to run server-side code during development. `handleResolve` takes a `$prototype`/`$src` entry, imports the module server-side (`.js` directly; `.class.json` via its `$implementation`, or a class constructed from the schema), instantiates it with the config, and returns the resolved value. `handleServerFunction` imports a module and invokes a named export with an arguments object. Both do dynamic `import()` of project code — they are remote-code-execution surfaces by design, which is why the security model below exists.

`code-api.ts` adds the code services behind the `codeService` platform member: `oxfmt` formatting, `oxlint` diagnostics, and `Bun.Transpiler` minification for the function-body editor.

## Extension server mounts

`jx-mounts.ts` dispatches `/_jx/*` to extension classes that declare a `server` block — the same fetch-style handlers the generated site worker mounts in production, so data-backed documents work identically in both environments. In development it adds conveniences: `env` is `process.env` merged under the project's `.dev.vars` plus `JX_PROJECT_ROOT`, connectors with a `local` provider get stood in locally (D1 becomes SQLite under `.jx/data/`), and table schemas sync additively on first touch. See [server mounts](/docs/extending/extensions/server) for the extension-author side.

## The security model

Every filesystem route is contained by `assertAccessible`, which allows a path under either the server root or the explicitly activated project root and rejects everything else:

```ts
// packages/server/src/studio-api.ts
export function assertAccessible(filePath: string, root: string, activeProjectRoot: string | null) {
  const rel = relative(root, filePath);
  if (!rel.startsWith("..") && !rel.startsWith("/")) {
    return;
  }
  if (activeProjectRoot) {
    const relActive = relative(activeProjectRoot, filePath);
    if (!relActive.startsWith("..") && !relActive.startsWith("/")) {
      return;
    }
  }
  throw new Error("Path outside project root");
}
```

The dev server assumes a trusted localhost during development. The desktop app cannot, so it embeds a hardened variant, `createProjectServer` (in `project-server.ts`), with a layered model worth copying in any embedding:

- **Loopback bind** (`127.0.0.1`) is the primary control — other local processes and LAN pages can't read a loopback page's location, so they can't steal its token.
- **A per-server token** is the hard gate on every privileged surface: the WebSocket RPC upgrade and the two resolve routes (RCE-capable, as above).
- **Origin/Host checks** are best-effort defense in depth — loopback-or-absent Origin accepted, non-loopback Host rejected on privileged routes (anti-DNS-rebinding).
- **File containment** pairs the lexical `relative()` check with a `realpath` re-check, so symlinks can't escape the project root.

:::doc-warning
If you host the resolve proxies anywhere beyond a trusted loopback, gate them the way `project-server.ts` does — they import and execute arbitrary project code by design.
:::

## Related

- [The dev server](/docs/framework/build/dev-server) — the user-level page: options, live reload, the proxies from the document author's view
- [The backend protocol](/docs/extending/embedding/backend-protocol) — the contract this server is the reference for
- [Protocol route reference](/docs/extending/reference/studio-routes) — every `/__studio/*` route it serves
- [Extension security model](/docs/extending/extensions/security) — the trust boundaries extensions themselves live under
