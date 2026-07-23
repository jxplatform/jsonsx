# `@jxsuite/server` Specification

## Development Server with Live Reload, Proxy Resolution, and Studio API

**Version:** 2.1.0
**Status:** Implemented
**Updated:** 2026-07-22
**License:** MIT

---

## 1. Overview

`@jxsuite/server` is a Bun-native development server for Jx projects. Its TypeScript modules live in `src/` (`server.ts`, `dev.ts`, `watch.ts`, `build.ts`, `resolve.ts`, `studio-api.ts`, `code-api.ts`, `ai-api.ts`, `import-api.ts`, `collab.ts`, `jx-mounts.ts`, `data-api.ts`, `dev-vars.ts`, `packages.ts`, `project-server.ts`, `refactor/`). It provides:

- Live reload over SSE, driven by a chokidar file watcher
- `$src`/`$prototype` proxy resolution and `timing: "server"` function execution (`/__jx_resolve__`, `/__jx_server__`)
- Registry-driven extension server mounts under `/_jx/*` (specs/extensions.md §11)
- The Studio Backend Protocol under `/__studio/*` — the reference implementation of the `STUDIO_ROUTES` table in `@jxsuite/protocol` (~60 routes), including realtime co-editing over WebSocket
- OXC-powered code services for Studio's function-body editors
- A CLI entry, `@jxsuite/server/dev`, that `jx dev` spawns
- A shared loopback project-server factory (`project-server.ts`) reused by the desktop launchers

---

## 2. Entry Point

```ts
import { createDevServer } from "@jxsuite/server";

await createDevServer({
  root: "./my-project",
  port: 3000,
  builds: [{ entrypoints: ["./src/app.js"], outdir: "./dist", match: /src/, label: "app" }],
});
```

Options (`src/server.ts`):

| Option       | Type                                                                | Default | Description                                                                                                                                                |
| ------------ | ------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`       | `string` (required)                                                 | —       | Project root, absolute or relative.                                                                                                                        |
| `port`       | `number`                                                            | `3000`  | Listen port (`0` = ephemeral).                                                                                                                             |
| `builds`     | `{ entrypoints, outdir, match?, label? }[]`                         | `[]`    | `Bun.build` entries; `match` (RegExp or predicate) scopes which file changes trigger a rebuild of that entry.                                              |
| `watch`      | `boolean \| { ignore?, debounce?, reloadOnAnyChange?, preReload? }` | `true`  | File watching + SSE. `preReload(filename)` runs before each reload broadcast (this is how `jx dev` rebuilds the site); `false` disables watching entirely. |
| `studio`     | `boolean`                                                           | `true`  | Enable the `/__studio/*` API (including the collab WebSocket).                                                                                             |
| `middleware` | `(req, url) => Response \| null \| Promise<...>`                    | —       | Custom route handler consulted after the built-in APIs, before static files.                                                                               |

Returns the `Bun.serve` server object (`idleTimeout: 120` so SSE heartbeats and long AI streams survive).

**`@jxsuite/server/dev` — the `jx dev` entry (`src/dev.ts`).** `jx dev` (implemented in `@jxsuite/compiler`'s `dev-command.ts`) resolves `@jxsuite/server/dev` from the _project's_ node_modules and spawns it under Bun: `bun <entry> [--root <dir>] [--port <n>]` (the jx bin runs under Node; the server is Bun-native). For a site project (a `project.json` at the root) the entry:

1. Builds the site up front via `@jxsuite/compiler/site` `buildSite()` (build errors print, the server still starts)
2. Serves the built pages from `dist/` via a middleware (`createDistMiddleware`) ahead of the static-source fallback, mapping directory URLs to their `index.html` and injecting the SSE live-reload client into built HTML
3. Passes `watch: { preReload: () => rebuild(), reloadOnAnyChange: true }` so every change rebuilds the site **before** the reload broadcast — the browser always reloads into fresh output

A non-site root gets a plain `createDevServer`. `parseDevArgs` and `createDistMiddleware` are exported for tests; the boot runs only under `import.meta.main`.

---

## 3. Core Endpoints

The request path is matched in this order (`src/server.ts`):

1. `GET /__reload` — SSE live reload (when watching)
2. `POST /__jx_resolve__` — `$prototype`/`$src` proxy
3. `POST /__jx_server__` — `timing: "server"` function proxy
4. `/_jx/*` — extension server mounts
5. `/__studio/*` — Studio API (collab WebSocket/probe, activate, AI proxy, site import, code services, then the main studio handler)
6. Custom `middleware`
7. Static files — server root, then the active project root, then its `public/` (mirroring production), then npm bare specifiers resolved through `node_modules` and bundled on demand with `Bun.build`. Served HTML gets the live-reload client injected (except the Studio shell, which manages its own state); all responses carry `Cache-Control: no-cache`.

**Extension mounts (`/_jx/*`, `src/jx-mounts.ts`).** Extension classes with a `server` block mount the same fetch-style handlers here that the generated site worker mounts in production — one shared context per project, handlers built via the static `mount(options, ctx)` capability and dispatched by `basePath` prefix. Dev conveniences: `env` is `process.env` merged under the project's `.dev.vars` plus `JX_PROJECT_ROOT`; connector classes with `local: "<provider>"` are stood in by the registry's local provider (e.g. D1 → sqlite at `.jx/data/<connection>.sqlite`); `autoSync: true` syncs table schemas additively on first touch. The per-project runtime is cached and invalidated when `project.json` changes on disk.

### 3.1 Live Reload (`/__reload`)

SSE (Server-Sent Events) endpoint backed by `src/watch.ts`. A chokidar watcher observes the project root, ignoring `node_modules/`, `dist/`, `.cache/`, `.git/`, `.jx/`, `.devenv/`, `.direnv/`, Bun lockfiles, and transient `__test-*` directories by default (override via `watch.ignore`). On a debounced change the watcher:

1. Runs the `preReload` hook, if configured (e.g. `jx dev`'s site rebuild)
2. Selectively rebuilds any `builds` entries whose `match` covers the changed file, broadcasting a reload on success
3. Otherwise broadcasts a reload only when `reloadOnAnyChange` is set

Two event streams share the connection: the default (unnamed) `reload` message that the injected client (`injectSSE`) turns into `location.reload()`, and named `fs` events — coalesced structured filesystem events that the Studio shell subscribes to for its sidebar while the preview iframe ignores them. Heartbeats every 15 s keep connections alive.

### 3.2 `$prototype`/`$src` Proxy (`POST /__jx_resolve__`)

When the runtime encounters an external `$prototype` with `$src` during development, it POSTs to the dev server for server-side resolution. The server:

1. Resolves the module at `$src` (supports `.js`/`.ts`, `.class.json`, and bare package specifiers via the project's `node_modules`)
2. For `.class.json`: parses the schema, follows `$implementation`, imports the JS module; without one, constructs the class dynamically from the schema (`classFromSchema`)
3. For plain modules: imports directly and extracts the named export
4. Instantiates the class with the provided config — with the project context (`project.json` plus extension-loaded sections such as `content`) available, so registry classes like `ContentEntry` resolve against real project data
5. Calls `resolve()` or reads `.value` and returns the result as JSON

This avoids CORS issues, enables Node.js-only dependencies (e.g. `glob`, `fs`), and provides a consistent resolution path for all `$src` specifiers. Manifest-registered extension classes resolve by `$prototype` name alone — the project's extension registry maps the name to its `.class.json`.

> **Status: Implemented.** `src/resolve.ts` handles the full resolution pipeline (project-context cache keyed on `project.json` mtime). The loopback project server (`src/project-server.ts`) serves the same route token-gated for the desktop shells.

### 3.3 Server Function Proxy (`POST /__jx_server__`)

Executes `timing: "server"` functions during development. The runtime sends:

```json
{
  "$src": "./dashboard.server.js",
  "$export": "fetchMetrics",
  "arguments": { "userId": 42 }
}
```

The server imports the module and calls the exported function as `fn(args, env)` — the arguments object plus an environment binding (`process.env` in the dev proxy, matching the compiled production route's `fn(args, c.env)`) — then returns the result as JSON. Reactive re-execution (`signal: true`) is driven runtime-side via `effect()`.

> **Status: Implemented.** `src/resolve.ts` `handleServerFunction()`.

---

## 4. Studio API (`/__studio/*`)

The reference implementation of the Studio Backend Protocol, serving Studio's Platform Abstraction Layer (specs/desktop.md §3, §5).

### 4.1 Endpoints

The canonical endpoint list is the `STUDIO_ROUTES` table in `@jxsuite/protocol` (`packages/protocol/src/routes.ts`) — roughly 60 routes, each with method, path, core-vs-optional flag, contract summary, and degradation note. A generated reference lives in the docs (`docs/extending/embedding/backend-protocol.md`). This spec no longer enumerates them; the families are:

- **Session / project** — activate, project metadata/probing, site enumeration, project creation, starters, AI-guided site import (NDJSON progress stream)
- **Filesystem** — directory listing and project-wide search on one route (`files?dir=` / `files?glob=`), file CRUD, upload, rename (with refactor report), locate
- **Realtime co-editing** — `GET /__studio/collab`: a WebSocket upgrade speaking the `@jxsuite/collab` wire envelope (one socket per project, documents multiplexed by path); a plain GET answers the capability probe. Implemented in `src/collab.ts`: rooms seed from the file on disk, persistence is explicit (flush on save, plus graceful shutdown), and genuinely external file changes bump the doc epoch and reset subscribers.
- **Documents / components / formats** — component discovery, CEM extraction, the project's format/extension registry, generated project schemas, format parse/serialize dispatch, plugin schemas, code services (§5)
- **Packages** — dependency list/add/remove/install, staleness and outdated checks, bulk version updates
- **Git** — status, branches, log, stage/unstage, commit, push/pull/fetch, checkout, branch, diff/show, discard, init, remotes, clone, PR
- **Data surface + secrets** — connector connections, connection test, additive schema push, row paging/CRUD, secret env-var names (never values)
- **AI proxy** — SSE chat proxy and model catalogue
- **Cloudflare publish** — allowlisted API passthrough

Handlers are dispatched inside the `/__studio/*` branch in this order: collab → activate → AI (`ai-api.ts`) → import-site (`import-api.ts`) → code services (`code-api.ts`) → the main studio handler (`studio-api.ts`).

> **Status: Implemented.** `src/studio-api.ts` and companions.

### 4.2 Security

Both server entry points share one set of primitives (`src/net-guard.ts`), applied at different strengths:

**Dev server (`createDevServer`).** Defends against a malicious web page and local traversal:

- **Loopback bind** (`127.0.0.1`) by default is the primary control; a `hostname` option (`--host` on the `jx dev` CLI) can widen it for containers, which removes that control and must only be used behind trusted isolation
- **Origin/Host gate** on every privileged surface — the RCE-capable `/__jx_resolve__` / `/__jx_server__` routes (both do dynamic `import()`), the `/_jx/` extension mounts, and the whole `/__studio/*` API: a loopback (or absent) Origin is accepted, a non-loopback Origin or Host is rejected (anti-CSRF, anti-DNS-rebinding). The browser Studio and the served site are same-origin, so they pass; an external page does not. No token is used — same-origin does not need one
- **File containment**: every static path and every caller-supplied relative or absolute `$src` / `$base` / `$implementation` resolved before a dynamic `import()` passes a lexical `relative()` check **plus a realpath re-check** (`containedPath`), so a `../` or absolute path cannot escape and a symlink cannot point outside the tree; over-encoded paths are rejected after a single decode. A **bare-specifier** `$src` is exempt: it resolves only through Node's `node_modules` lookup (an installed package), so the class file — and the sibling `$implementation` it names, even one above the class directory — is trusted as that package's own code; the containment check still binds a project-local relative `$src`
- **Two-root activation**: filesystem operations go through `assertAccessible(filePath, root, activeProjectRoot)` — the path must sit under the server root **or** the active project root Studio bound via `POST /__studio/activate`, which itself only accepts a root contained under the server root or an explicit `allowedRoots` entry

**Loopback project server (`src/project-server.ts`, used by the desktop launchers).** Adds, on top of the above, a **per-server token** as the hard gate on the WebSocket RPC upgrade and the resolve/import routes — the desktop canvas iframe is cross-origin, so it carries the token in its URL where the same-origin dev server does not need one.

---

## 5. Code Services (`/__studio/code/*`)

OXC-powered code quality services for Studio's function-body editors.

| Endpoint                     | Tool             | Description                                | Status          |
| ---------------------------- | ---------------- | ------------------------------------------ | --------------- |
| `POST /__studio/code/format` | `oxfmt`          | Format JavaScript snippet                  | **Implemented** |
| `POST /__studio/code/minify` | `Bun.Transpiler` | Minify JavaScript snippet                  | **Implemented** |
| `POST /__studio/code/lint`   | `oxlint`         | Lint JavaScript snippet (JSON diagnostics) | **Implemented** |

Snippets are function _bodies_: the handler wraps them in a synthetic function before formatting/linting, unwraps the result, and remaps diagnostic line/column positions back to the snippet.

> **Status: Implemented.** `src/code-api.ts` (oxfmt via its Node API, oxlint via its CLI binary, minification via `Bun.Transpiler`).

---

## 6. Build Pipeline

### 6.1 `buildAll(builds)`

Runs `Bun.build` for each configured entry (`entrypoints`, `outdir`, optional `label` for logging). Called once at startup when `builds` is non-empty.

### 6.2 `rebuild(builds, changedPath)`

Incremental rebuild triggered by the file watcher: only entries whose `match` (RegExp or predicate) covers the changed path are rebuilt, and a successful rebuild triggers the reload broadcast.

> **Status: Implemented.** `src/build.ts`.

---

## 7. Dependencies

| Package                                 | Purpose                                                       |
| --------------------------------------- | ------------------------------------------------------------- |
| `chokidar`                              | File watching for live reload                                 |
| `kysely`                                | SQL building for the connector data surface                   |
| `zod`                                   | Request validation                                            |
| `@jxsuite/protocol`                     | The canonical `STUDIO_ROUTES` table and wire types            |
| `@jxsuite/collab`                       | Realtime co-editing rooms and wire envelope                   |
| `@jxsuite/compiler`                     | Site builds, extension/format registry host, project sections |
| `@jxsuite/schema`                       | Class parsing, project schemas, extension registry            |
| `@jxsuite/create` / `@jxsuite/starters` | Project scaffolding and starter templates                     |
| `@jxsuite/import`                       | AI-guided site import pipeline                                |
| `@jxsuite/runtime`                      | Shared runtime types                                          |

`oxfmt` and `oxlint` are resolved from the workspace for the code services. Bun built-ins: `Bun.serve`, `Bun.build`, `Bun.Transpiler`, `Bun.file`, `Bun.Glob`.

## Changelog

- **2.1.0** (2026-07-22) — Baseline: spec versioning + changelog introduced.

---

_`@jxsuite/server` Specification v2.1.0_
