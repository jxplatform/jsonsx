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

The dev server and the desktop's `createProjectServer` share one set of primitives (`packages/server/src/net-guard.ts`); the dev server applies all but the token:

- **Loopback bind** (`127.0.0.1`) by default is the primary control — other local processes and LAN pages can't read a loopback page's location. A `hostname` option (`jx dev --host`) can widen the bind for containers, but that removes the control and should only be used behind trusted isolation.
- **Origin/Host gate** guards every privileged surface — the RCE-capable `/__jx_resolve__` / `/__jx_server__` routes, the `/_jx/` mounts, and the whole `/__studio/*` API. A loopback (or absent) Origin passes; a cross-origin Origin or a rebinding Host is rejected. The browser Studio and the served site are same-origin, so they pass — a malicious external page does not. The dev server needs no token because it is same-origin; the desktop server, whose canvas iframe is cross-origin, adds a per-server token on top.
- **Fetch Metadata** is read on the same surfaces. `Sec-Fetch-Site` says what a request _intends_, which `Origin` can't: a same-origin `GET` sends no `Origin` at all, so that check has to accept an absent one. `same-origin` and `none` pass; `cross-site` passes only as a top-level document navigation (a person clicking a link); **`same-site` is rejected** — on loopback there's no "site" bigger than the origin, so `same-site` means _another port on your machine_. A request with no `Sec-Fetch-*` at all passes, because curl, Bun's fetch and the desktop bridge don't send it and the threat here is a browser page, which always does.
- **File containment** (`containedPath`) pairs a lexical `relative()` check with a `realpath` re-check, so a `../` or absolute path can't escape and a symlink can't point outside the project root. It guards static serving, `assertAccessible` for the filesystem API, and every `$src` / `$base` / `$implementation` resolved before a dynamic `import()`. Over-encoded paths are rejected after a single decode.
- **Two-root activation**: `assertAccessible(filePath, root, activeProjectRoot)` allows a path under the server root or the project root Studio bound via `POST /__studio/activate`. Activation itself accepts four kinds of root: one contained under the server root, an explicit `allowedRoots` entry, a project this server just created, or a project the account already owns — an absolute directory holding a `project.json` under the user's home directory. That last kind is what opens an _existing_ project: projects normally live outside whatever tree the server happens to serve. Anything else is a `403`, and a refused activation is an error to show the user — the endpoints that take no `dir` (the git surface especially) fall back to the server's own root, so swallowing the refusal would quietly act on the wrong tree.

:::doc-warning
The resolve proxies import and execute arbitrary project code by design. Keep the loopback bind, and if you must widen it, put the server behind trusted isolation — the Origin/Host gate assumes the network itself is not hostile.
:::

:::doc-note
**One route is exempt from the token, and only from the token: the OAuth callback** (`/__jx_oauth__/callback`) on the desktop's project server. An identity provider redirects the user's own browser there, and a page cannot append a secret to a URL it does not compose — a token gate would make sign-in impossible rather than safe. The `state` parameter does that job: unguessable, single-use, short-lived, compared in constant time. The Host and Fetch Metadata checks still apply, and an IdP redirect is exactly the one cross-site shape they admit — a top-level document navigation.
:::

:::doc-note
**No response ever carries an `Access-Control-Allow-` header.** The entire model rests on the browser refusing cross-origin reads, so one CORS header would give that away. A check enforces the absence rather than trusting it — nothing in the code makes a load-bearing absence visible.
:::

## Related

- [The dev server](/docs/framework/build/dev-server) — the user-level page: options, live reload, the proxies from the document author's view
- [The backend protocol](/docs/extending/embedding/backend-protocol) — the contract this server is the reference for
- [Protocol route reference](/docs/extending/reference/studio-routes) — every `/__studio/*` route it serves
- [Extension security model](/docs/extending/extensions/security) — the trust boundaries extensions themselves live under
