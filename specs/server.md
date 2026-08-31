# `@jxsuite/server` Specification

## Development Server with Live Reload, Proxy Resolution, and Studio API

**Version:** 0.2.23
**Status:** Implemented
**Updated:** 2026-08-31
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

The request path is matched in this order (`src/server.ts`), after a leading **deployment base** is
stripped from it:

0. **The base.** A project whose `url` carries a path is served from that path, and a build emits
   every URL under it ([site-architecture.md §14.7](./site-architecture.md)). The server strips that
   prefix once, at the edge, rather than moving the dev root: `localhost:3000/` is unchanged for
   every project that never sets one, and `localhost:3000/m/my-site/assets/x.js` resolves to the
   same file the deployed site serves. Answering only the bare path would mean previewing URLs the
   deployed site never uses, which is the class of bug that is only found in production. The
   boundary is a segment, so `/m/my-sitefile` is not under `/m/my-site`. Everything below — the
   extension mounts included — therefore routes on the bare path, which is the opposite of the
   generated worker, where the base is on the routes themselves because that worker IS the origin.
1. `GET /__reload` — SSE live reload (when watching)
2. `POST /__jx_resolve__` — `$prototype`/`$src` proxy
3. `POST /__jx_server__` — `timing: "server"` function proxy
4. `/_jx/*` — extension server mounts
5. `/__studio/*` — Studio API (collab WebSocket/probe, activate, AI proxy, site import, code services, then the main studio handler)
6. Custom `middleware`
7. Static files — the active project's extension asset mounts ([extensions.md §8.5](./extensions.md)), then the server root, then the active project's `public/`, then the active project root, then npm bare specifiers resolved through `node_modules` and bundled on demand with `Bun.build`. Served HTML gets the live-reload client injected (except the Studio shell, which manages its own state); all responses carry `Cache-Control: no-cache`. Content types come from `Bun.file`'s own inference, corrected only where a registration disagrees with it — `.md` carries the `variant` that names its dialect and `.yaml` is `application/yaml` rather than the retired `text/yaml` (`MEDIA_TYPE_BY_EXTENSION` in `@jxsuite/schema/media-type`, shared with `jx preview`); every other extension keeps the inferred type.

**`public/` precedes the project root, and the project root is a compatibility lane.** The order above is the order a BUILD resolves in ([site-architecture.md §9.3](./site-architecture.md)): a site-absolute `/x` names `public/x` and nothing else. This server also serves the PROJECT TREE's own URL space at the same paths — that is how a Studio canvas fetches a component `$ref` — so the project root still answers, and the two spaces collide wherever a file exists in both.

The order used to be the other way round, which made the preview lie in the one direction that matters: a file at `<root>/hero.jpg` loaded at `/hero.jpg` here and 404'd on the deployed site, and where both copies existed the preview showed the one production would never serve. Serving from the root a site URL that a build would not publish is now a diagnostic naming the file and the fix (move it into `public/`), and the lane is scheduled for removal. The diagnostic is scoped to extensions a build publishes as static assets, so a project document answered from the root — the canvas doing its job — says nothing.

**Asset mounts.** A mount publishes a directory that may sit outside the project root — a content collection's co-located images — at the same site URL the built site will use, so a dev preview and a production page render identically. Each candidate is contained against the mount's own directory (lexical + realpath), and the URL→path mapping refuses `.`/`..`, empty segments, and still-encoded dots or slashes. Mounts come from the section owner's `assets` capability via the per-project context cache, so they refresh when `project.json` changes on disk. The desktop loopback server (`project-server.ts`) resolves them through the same `serveProjectFile` path.

**Extension mounts (`/_jx/*`, `src/jx-mounts.ts`).** Extension classes with a `server` block mount the same fetch-style handlers here that the generated site worker mounts in production — one shared context per project, handlers built via the static `mount(options, ctx)` capability and dispatched by `basePath` prefix. Dev conveniences: `env` is `process.env` merged under the project's `.dev.vars` plus `JX_PROJECT_ROOT`; connector classes with `local: "<provider>"` are stood in by the registry's local provider (e.g. D1 → sqlite at `.jx/data/<connection>.sqlite`); `autoSync: true` syncs table schemas additively on first touch. The per-project runtime is cached and invalidated when `project.json` changes on disk.

### 3.1 Live Reload (`/__reload`)

SSE (Server-Sent Events) endpoint backed by `src/watch.ts`. A chokidar watcher observes the project root, ignoring `node_modules/`, `dist/`, `.cache/`, `.git/`, `.jx/`, `.devenv/`, `.direnv/`, Bun lockfiles, and transient `__test-*` directories by default (override via `watch.ignore`). On a debounced change the watcher:

1. Runs the `preReload` hook, if configured (e.g. `jx dev`'s site rebuild)
2. Selectively rebuilds any `builds` entries whose `match` covers the changed file, broadcasting a reload on success
3. Otherwise broadcasts a reload only when `reloadOnAnyChange` is set

**What a watcher will not watch (`src/watch-policy.ts`).** `watch.ignore` is a rule about names, and two things that break a watcher cannot be recognised by name. Both watchers — this one and the desktop session's (`refactor/watcher.ts`) — therefore compose it with an entry-kind rule:

- **Only directories and regular files are watched.** A unix socket, FIFO or device node answers `fs.watch` with `ENXIO`, which chokidar raises as an `error` event; a watcher without an `error` listener does not log that, it throws. Both watchers listen.
- **Symlinks are contained, not banned.** A link resolving back inside the root is project content and keeps its events; one resolving outside it, or dangling, is dropped. Following a link out of the root turns a project watcher into a walk of the filesystem — `~/.wine/dosdevices/z:` points at `/`, and a launcher that had adopted the home directory as its project root found it.

The second rule is a containment invariant, not a convenience: **a watcher never emits an event for a path outside the root it was given.**

Two event streams share the connection: the default (unnamed) `reload` message that the injected client (`injectSSE`) turns into `location.reload()`, and named `fs` events — coalesced structured filesystem events that the Studio shell subscribes to for its sidebar while the preview iframe ignores them. Heartbeats every 15 s keep connections alive.

**The stream itself is `src/sse.ts`, and this is one of two surfaces speaking it.** The live preview origin (§3.4) has a channel of its own, and what the two share is not "an SSE endpoint" but this specific reading of the contract, which took a defect report to arrive at. Re-deriving it per surface is how one of them silently stops reconnecting.

**Reconnection.** The stream opens with `retry: 500`, and every reload frame carries an `id:`. Both exist for one reason: a dev-server restart drops the connection, and the browser's default reconnection time is measured in seconds — long enough that a save during the window looks like it did nothing. Half a second is right because both ends are on loopback.

The `id:` is **not** a replay cursor. It exists so the browser sends `Last-Event-ID` on reconnect, which is the only way the server can tell a reconnection from a first connection; a reconnecting client is then pushed exactly **one** reload and no history. Nothing is buffered against the id. That is not an unfinished implementation, it is the correct one: the page the client is holding was built before the disconnect, a reload is idempotent and total, so one subsumes every event missed and finishes sooner than a replay would. A first connection is pushed nothing at all — reloading a page that just loaded is a reload loop.

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

### 3.4 Live Site Preview (an origin per project)

> **Status: Implemented.** `src/live-preview.ts`, `src/preview-client.ts`, composing
> `@jxsuite/site`. Reached by `POST /__studio/preview` (§4.1) and by the desktop launchers' own
> `previewSite` RPC.

The project's working tree, browsable as a site, on a loopback origin of its own. This is what
Studio's `Open in Browser` opens (specs/studio.md §10.1): each page is composed on demand — route,
layout, `$elements`, `$site`/`$page`, `<head>` — and handed to `@jxsuite/runtime`, which assembles
the DOM in the reader's browser. No compiler is on the path.

**Why a second origin, when the paths mean the same thing an editing server already serves.**
`site-preview.ts` needs its own origin because a built page addresses its OUTPUT by paths an editing
server reads as SOURCES. That argument does not apply here and two others do:

- **Lifetime.** One tab per project needs one origin per project, and an editing server is per
  WINDOW. The map is keyed by normalized project root and lives for the process, so two windows on
  one project share an origin and no single window's teardown may close it.
- **Isolation.** A previewed page runs the project's own JavaScript, third-party script included. On
  the chromium build the Studio shell is served BY the editing server, so a preview mounted there
  would share `localStorage`, IndexedDB and service-worker scope with the editor.

**What it serves, in the order a published site would answer.** A path is a FILE if the tree has one
there and a ROUTE otherwise; a miss is the project's own `/404` at HTTP 404. Files come from
`@jxsuite/site`'s allowlist, which **defaults closed**: `public/`, `components/`, `layouts/`,
`pages/`, `assets/`, `media/`, `content/`, `data/` and `styles/`, never `project.json`, a lockfile,
a `wrangler.*` or a dotfile. That is deliberately NOT `serveProjectFile`'s rule, which serves the
whole project root — on the editor's origin that is Studio addressing files it already holds paths
for, and on an origin running project script it is a way to read `.dev.vars`.

Every response carries `Cache-Control: private, no-store` (a composed page is a function of a tree
that changes under it and is not revalidatable), `X-Robots-Tag: noindex, nofollow`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

**The host's own surfaces live under `/__jx_live__/`**, dispatched ahead of everything: the
`@jxsuite/runtime` browser bundle (immutable), the reload client, `project.json`'s `style` as a
stylesheet, the reload stream, a retarget acknowledgement and a liveness probe. Not `/_jx/` — that
is the extension-mount namespace, which a previewed page still needs — and not `/__studio__/`,
because a preview origin must not look like the editor's.

**The overlay is what makes it the canvas rather than the disk.** Studio publishes the bytes a save
would write for each dirty document and this origin prefers them at every read. They are held in
memory and written nowhere, so there is no file to go stale and a crash leaves the preview showing
the saved state. The store is keyed by project root and lives independently of a running origin,
because the editor's flush on the way to opening a tab publishes BEFORE the origin exists — an
overlay tied to the origin's lifetime would lose the newest edit on the one render the author is
watching for. It is bounded, and eviction is REPORTED rather than silent: an overlay that quietly
forgets a document shows the saved bytes for a file the author is actively editing with nothing
anywhere to explain the difference.

**A page is whatever format its extension parses, not only JSON.** `@jxsuite/site` composes `.json`
itself and asks the host for anything else, which is the seam that decides whether a markdown page
renders at all; this origin fills it with the project's own extension registry, so `pages/index.md`
composes here exactly as it does in a build. The registry is a function of `project.json`'s
`extensions`, so the CONFIG is what it is built from — building it from the project root alone
yields an empty registry, and the page then reports that it needs a parser this host does not run
while the host is in fact running one. `project.json` is read through the overlay like every other
read, so adding an extension in Studio takes effect on the next reload rather than on the next save.
A host without a registry — a Worker, where a format's parser is not reachable — still routes the
page and reports it by name, which is the failure the seam exists to make legible.

**The project's own components register without being declared**, by the rule `imports.md` §1.4
states: the composer walks the composed document against the tree and points `$elements` at every
`components/<tag>.json` it names, transitively. Nothing else here would — a build discovers those
tags by scanning HTML it has already rendered and there is no build on this path, so taking
`$elements` literally left a page's own components as inert unknown tags while the canvas beside it
rendered them.

**Reload is the §3.1 stream, shared.** The same reading of the EventSource contract — `retry:`, the
`id:` that arms `Last-Event-ID`, one reload on resume and none on a first connection — is defined
once in `src/sse.ts` and composed by both surfaces. A change coalesces: a save fires the overlay
retraction and the filesystem watcher both, and both compose to identical bytes, so one save is one
reload. The window has a maximum as well as a debounce, because a git checkout emits hundreds of
events closer together than the debounce and a pure trailing timer would starve until it finished.
The watcher is the session's existing one with a second consumer, never a second watcher: two
chokidars on one tree double the inotify watch count and can disagree about what §3.1's policy
ignores.

**A retarget is acknowledged, not assumed.** Asked to point this project's tab at a route, the
origin sends a named `navigate` event and waits briefly for a client to say it took it. A closed
tab's stream drops promptly, but a frozen or back/forward-cached one looks connected and will not
act, so the answer a caller acts on is an acknowledgement rather than a client count. When the wait
loses the race the caller opens a tab, which is the visible failure and the deliberate choice.

**The resolver runs here, behind a credential of its own.** `/__jx_resolve__` and `/__jx_server__`
are mounted and gated exactly as §4.2 gates them — token, Origin, Host, Fetch Metadata — against a
token minted per preview origin, so compromising an editing server's does not hand this one over.
The page's own POST is same-origin, which the strict policy admits. Without them a content
collection renders as an empty list, because `ContentEntry` always needs a server: that is the
difference between previewing a site and previewing its chrome. The exposure this widens is stated
rather than implied — third-party script inside a previewed page reaches two routes that `import()`
project code — and it is a change of venue rather than of kind, since the cross-origin canvas iframe
already holds a token for the same two routes and renders the same documents.

**No Content-Security-Policy is sent, and the reason is not oversight.** Template strings need
`'unsafe-eval'` and the shell inlines a module script and a JSON block, so any policy this could
send today would contain `'unsafe-eval'` plus `'unsafe-inline'` or a hash. A permissive policy that
protects nothing is worse than none, because it reads like a control.

---

## 4. Studio API (`/__studio/*`)

> **Status: Implemented.** The routes ship, and so does the failure half: every failure is an
> RFC 9457 problem document (§4.3), from one registry the docs are generated from, guarded by
> `scripts/check-error-shapes.ts`. `gitPull`'s `409 {conflicts}` — the one failure the route table
> has always published and never produced — is produced now.

The reference implementation of the Studio Backend Protocol, serving Studio's Platform Abstraction Layer (specs/desktop.md §3, §5).

### 4.1 Endpoints

The canonical endpoint list is the `STUDIO_ROUTES` table in `@jxsuite/protocol` (`packages/protocol/src/routes.ts`) — roughly 60 routes, each with method, path, core-vs-optional flag, contract summary, and degradation note. A generated reference lives in the docs (`docs/extending/embedding/backend-protocol.md`). This spec no longer enumerates them; the families are:

- **Site preview and build** — `POST /__studio/preview` renders the working tree at a route on the live origin (§3.4) and reports whether a client already holding this project's preview took it; `POST|DELETE /__studio/preview/overlay` publishes and retracts one document's unsaved bytes; `POST /__studio/build` runs the compiler and names where the output is browsable
- **Session / project** — activate, project metadata/probing, site enumeration, project creation, directory location (placing a `showDirectoryPicker()` handle on disk by the id it wrote into a hidden `.jx-loc-id`, so the New Project **Location** field gets a real folder chooser in the browser — specs/desktop.md §8.2.1), starters, AI-guided site import (NDJSON progress stream, whose terminal line carries what the run found)
- **Filesystem** — directory listing and project-wide search on one route (`files?dir=` / `files?glob=`), file CRUD, upload, rename (with refactor report, and a reset of any co-editing room keyed to the old path), locate. Both listing shapes answer in **stable path order**: `readdir` and glob scans report in filesystem order, which varies with a directory's write history, and Studio's collection grid inserts rows in listing order, so an unsorted listing reaches the user as a table that reshuffles itself between opens. Codepoint order, not locale collation, so two implementations agree.
- **Realtime co-editing** — `GET /__studio/collab`: a WebSocket upgrade speaking the `@jxsuite/collab` wire envelope (one socket per project, documents multiplexed by path); a plain GET answers the capability probe. Implemented in `src/collab.ts`: rooms seed from the file on disk, persistence is explicit (flush on save, plus graceful shutdown), and genuinely external file changes bump the doc epoch and reset subscribers.
  A **rename is not an external change** — it comes from this API's own route — but it moves a file out from under a room keyed to its path, so the rename handler reports the OLD path through the same reset. Without it the room survives the move holding pre-rename content and the shutdown flush writes it back, recreating the file the rename deleted; a room enters the flush worklist on its seed transaction, so an unedited document is not exempt. A host mounting `handleStudioApi` itself supplies the hook (`onFileMoved`); `createDevServer` wires it.
- **Documents / components / formats** — component discovery, CEM extraction, the project's format/extension registry, the extension catalogue this backend can offer (extensions.md §9.2), generated project schemas, format parse/serialize dispatch, plugin schemas, code services (§5)
- **Packages** — dependency list/add/remove/install, an install-staleness check, the newest published version of
  every dependency (`packages/versions`, reported whether or not the pin is behind — comparing them is the
  client's job), bulk version updates
- **Git** — status, branches, log, stage/unstage, commit, push/pull/fetch, checkout, branch, diff/show, discard, init, remotes, clone, PR
- **Data surface + secrets** — connector connections, connection test, additive schema push, row paging/CRUD, secret env-var names (never values)
- **AI proxy** — SSE chat proxy and model catalogue
- **Cloudflare publish** — allowlisted API passthrough

Handlers are dispatched inside the `/__studio/*` branch in this order: collab → activate → AI (`ai-api.ts`) → import-site (`import-api.ts`) → code services (`code-api.ts`) → the main studio handler (`studio-api.ts`).

**Path space: server-root-relative in, project-relative out.** A client path parameter — `?path=`, `?dir=`, a `from`/`to` in a body — is resolved against the **server root**. Every path in a response is relative to the **active project root** (`activeProjectRoot ?? root`). The two roots are the same in most deployments, which is exactly why the rule has to be written down rather than inferred: where they differ, the two conventions are indistinguishable by inspection, and a parameter resolved against the wrong one names a file that does not exist. The Studio-side translator is `serverPath()` in `packages/studio/src/platforms/devserver.ts`, and it is the only one — the PAL (specs/desktop.md §3.1) is project-relative in both directions, so an adapter that also stripped a prefix off a reply would be translating twice.

This binds the refactor routes in particular, because their sweep runs in the project's space while their parameters arrive in the server's: `GET /__studio/references` re-expresses its target into the project root before scanning, and `POST /__studio/file/rename` reports `from`/`to` in the project's space on both its success and its failure branch.

> **Status: Implemented.** `src/studio-api.ts` and companions.

### 4.2 Security

> **Status: Implemented.** Both entry points apply the gate, and the gate now reads
> `Sec-Fetch-*` as well as `Origin`/`Host`. The three surfaces the loopback project server used to
> dispatch ahead of it — the AI proxy, the `/_jx/*` extension mounts, and project files at their
> natural URLs — are gated at the strength each one warrants.

Both server entry points share one set of primitives (`src/net-guard.ts`), applied at different strengths:

**Dev server (`createDevServer`).** Defends against a malicious web page and local traversal:

- **Loopback bind** (`127.0.0.1`) by default is the primary control; a `hostname` option (`--host` on the `jx dev` CLI) can widen it for containers, which removes that control and must only be used behind trusted isolation
- **Origin/Host gate** on every privileged surface — the RCE-capable `/__jx_resolve__` / `/__jx_server__` routes (both do dynamic `import()`), the `/_jx/` extension mounts, and the whole `/__studio/*` API: a loopback (or absent) Origin is accepted, a non-loopback Origin or Host is rejected (anti-CSRF, anti-DNS-rebinding). The browser Studio and the served site are same-origin, so they pass; an external page does not. No token is used — same-origin does not need one
- **File containment**: every static path and every caller-supplied relative or absolute `$src` / `$base` / `$implementation` resolved before a dynamic `import()` passes a lexical `relative()` check **plus a realpath re-check** (`containedPath`), so a `../` or absolute path cannot escape and a symlink cannot point outside the tree; over-encoded paths are rejected after a single decode. A **bare-specifier** `$src` is exempt: it resolves only through Node's `node_modules` lookup (an installed package), so the class file — and the sibling `$implementation` it names, even one above the class directory — is trusted as that package's own code; the containment check still binds a project-local relative `$src`
- **A target outside the active project is a `400`, never a zero-result `200`.** `assertAccessible` admits anything under the server root, which is wider than the sweep the refactor routes then run; a path that clears the guard but falls outside the active project has no answer, and reporting "no references" for it would be a confident lie about a question that was never asked. Containment is therefore checked twice for those routes, once per root, with distinct outcomes
- **Two-root activation**: filesystem operations go through `assertAccessible(filePath, root, activeProjectRoot)` — the path must sit under the server root **or** the active project root Studio bound via `POST /__studio/activate`, which itself only accepts a root contained under the server root, an explicit `allowedRoots` entry, a project this server just created (below), or **a project the account already owns** — an absolute directory holding a `project.json` somewhere under the user's home directory (`isOwnedProjectDir`). That last clause is what makes an _existing_ project openable at all: projects live outside the server root as a matter of course, so `?project=/abs/path`, the Open Project picker and the recent-projects list would otherwise be able to bind nothing but a project inside the served checkout. Requiring both the `project.json` and home containment keeps a hostile page on the loopback origin from binding the server to `/etc` or to another account's files. A refused activation is an **error the client must surface**, never a silent fallback: the endpoints that take no `dir` (the git surface especially) resolve against `activeProjectRoot || root`, so a swallowed refusal would silently run against whatever tree the server is serving
- **The import stream's terminal line reports the run, not just its location.** `POST /__studio/import-site` streams progress and ends with the new root, the project configuration, AND a summary of what the pipeline produced: the pages it emitted, the file count, the soft failures it recorded, and — when `verify` was requested — a per-page fidelity score against the original. Every field is optional, so a backend that sends none is conformant and an older client ignores them; no protocol version moves. It matters because the pipeline computed all of it and the endpoint used to discard it, leaving a caller able to say that an import had happened and nothing about what it found. `verify` is opt-in: it compiles the emitted project and drives a second browser pass, roughly doubling the run.

- **The stream also names the destination before the run finishes.** A crawl takes minutes, and a caller that has to wait for the terminal line to learn WHERE the project is spends all of them with nothing to show. The pipeline creates the destination and gives it a valid `project.json` before it launches a browser, and the endpoint re-emits that as a line of its own: `{"type":"ready","root":"…"}`, with the root in the platform's own form. It is a separate line rather than a field on a progress message because a root parsed out of prose breaks when the prose is reworded, and because the two answer different questions — _where is it_ and _what did it find_. Optional in both directions: a backend that never sends one is conformant, and a client that ignores it opens the project at the end as before. The emit phase rewrites that file completely, so nothing on the `ready` line is a claim about the result.

- **Project creation is the one deliberate exception to root containment.** A new project belongs wherever the user pointed the New Project modal's Location field (specs/desktop.md §4.5), which is normally _outside_ the server root — containing it there would mean scaffolding into whatever tree the dev server happens to serve. `POST /__studio/create-project` and `POST /__studio/import-site` therefore take an explicit absolute parent and check it with `assertCreatableParent(parent, root, allowedRoots)` instead of `assertAccessible`. That guard **requires** an absolute path (a request without a destination is a 400 — the server never falls back to its own root) and admits only the server root, a configured `allowedRoots` entry, or the account's home directory, so a hostile page on the loopback origin cannot scaffold into system paths. Roots created this way are remembered for the duration of the process so the very next `/__studio/activate` can open them; the create response reports a root-relative path when the project landed under the server root and an absolute one otherwise

**Fetch Metadata.** `Sec-Fetch-Site` states the requester's intent directly, which `Origin` cannot: a same-origin GET omits `Origin` entirely, so the gate has to accept an absent one — a hole `Sec-Fetch-Site` does not have. The predicate is folded into `originHostGate`, so it reaches every gated surface without a single new call site.

Under the **strict** policy, which every privileged route uses:

| `Sec-Fetch-Site` | Decision                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| absent           | **accept** — see below                                                     |
| `same-origin`    | accept — the served page                                                   |
| `none`           | accept — a typed URL or a bookmark                                         |
| `cross-site`     | accept **only** a top-level document navigation: a person following a link |
| `same-site`      | **deny**                                                                   |

**Denying `same-site` is stricter than the standard's Resource Isolation Policy, and deliberate.** On `127.0.0.1` there is no meaningful "site" wider than the origin, so `same-site` means _a different port on this machine_ — precisely the other-local-process threat a loopback bind cannot address.

**An absent header is accepted, and that is a hard requirement rather than a concession.** The header is browser-supplied: curl omits it, Bun-native clients omit it, the desktop RPC bridge omits it, and `packages/server/tests/**` builds well over a hundred bare `Request`s. Requiring it would refuse every non-browser client on the machine while stopping no attacker, because the threat model here is a _page_ — and a page always sends it. The test pinning this is named `fetchMetadataAbsentIsAccepted`, so deleting it is loud.

A second, looser **`embeddable`** policy exists for one reason: the desktop canvas renders the project inside an iframe on a **different origin**, so that page's own subresources — its images, its stylesheets, its modules — legitimately arrive `cross-site`. Refusing them would break the canvas; accepting them on a route that can write a file or run an `import()` would hand away the containment. The difference is a property of the surface, named at the call site.

**Never CORS.** No response from either entry point carries an `Access-Control-Allow-*` header, and `scripts/check-error-shapes.ts` bans one outright. The whole loopback model rests on the browser refusing cross-origin reads, so a single such header would hand that containment away. There is none in the repository today, and that fact is load-bearing rather than incidental — which is exactly what needs a check, since nothing in the code makes it visible.

**The loopback block, not one address.** IANA reserves `127.0.0.0/8` and every address in it is this machine, so `127.0.0.2` is loopback exactly as `127.0.0.1` is; recognizing only the canonical spelling would reject a client for nothing. `0.0.0.0` is accepted as a **Host** — a server bound to it in a container is reached at that literal — and **never as an Origin**, since no page is ever served from `http://0.0.0.0`.

**Loopback project server (`src/project-server.ts`, used by the desktop launchers).** Adds, on top of the above, a **per-server token** as the hard gate on the WebSocket RPC upgrade, the resolve/import routes, and the AI proxy — the desktop canvas iframe is cross-origin, so it carries the token in its URL where the same-origin dev server does not need one.

The RPC socket carries traffic in **both** directions. A frame with an `id` answers something the shell asked; a frame with a `method` and **no** `id` is the server speaking first (`ProjectServerHandle.push`), which is how the desktop launchers deliver what is not an answer to anything: batched filesystem events for the sidebar — the loopback twin of the dev server's named `fs` SSE event (§3.1) — and a request that a window come forward. A push may be addressed to one window id or broadcast, and reports how many sockets it reached, so a launcher can tell "delivered" from "nobody is listening yet".

Which instrument gates which surface is a judgement about who calls it, not a uniform strength:

- **Token** on the RPC upgrade, `/__jx_resolve__`, `/__jx_server__`, `/__studio__/import-site`, and `/__studio__/ai/*`. Each either runs code, writes files, or spends the user's own API credit; an ungated AI proxy is an open relay for any process on the machine, and it was dispatched ahead of every gate until this closed.
- **Origin/Host + Fetch Metadata, no token**, on `/_jx/*` and on project files at their natural URLs. These are fetched by the canvas iframe's own page, whose requests carry no `?token=` — a page cannot rewrite the URLs its own content asks for — so the token is the wrong instrument and the origin check is the right one. Both use the `embeddable` policy, because that iframe is cross-origin by construction.

**The token is compared in constant time**, and may be presented as `Authorization: Bearer` as well as `?token=`. The query form stays because an iframe's `src` is the only place it can carry one; the header is accepted additively for everything else, since a secret in a URL is logged, referred and shoulder-surfable.

### 4.3 Failure Shape

> **Status: Implemented.** `src/problem.ts` and the `PROBLEM_TYPES` registry in
> `@jxsuite/protocol`; `scripts/check-error-shapes.ts` keeps the old shapes from regrowing.

**Every failure is an RFC 9457 problem document** at `application/problem+json`.

There were four shapes before — `Response.json({error}, {status})`, a bare-text body, a 200
carrying an `upstreamError` field, and a thrown string that became an empty 500 — and the Studio
client carried a separate reader for each. The cost was not the inconsistency. It was that a failure
could reach the user with **no detail at all**, because the reader that ran was not the one for the
shape that arrived.

**The type is the contract.** Problem types live in one table (`PROBLEM_TYPES`), in the same idiom
as `STUDIO_ROUTES`: declared once, exported as data, rendered into the docs by the same generator.
A type is a _class_ of failure a client might handle differently, never a message — "the project
root was refused" is a type, "root /x/y was refused" is a `detail`. Two consequences:

- **`type` URIs are absolute**, under `https://jxsuite.com/problems/`. RFC 9457 permits a relative
  reference resolved against the request URL, which on a dev server is
  `http://127.0.0.1:3000/problems/…` and serves nothing.
- **The status belongs to the type, not to the call site.** A type answerable with two statuses is
  two types. `401` and `403` are therefore separate: one asks the client to authenticate, the other
  says no, and collapsing them would make a missing API key indistinguishable from a refused root.

**`instance` is never emitted.** It identifies one occurrence, and Jx has no per-occurrence
resource to point at; a field whose only possible value is a fabricated URI is noise that looks like
information.

**`error` is emitted as a deprecated alias of `detail`, for one release.** That is the whole
sequencing device: every existing client reads `body.error`, so emitting both lets the server change
shape without a synchronized release across every client call site. The clients follow, then a
one-line change deletes the alias. Nothing new is written against it.

**Three places where a problem document would be wrong**, and each stays as it is:

- **The code services** (§5) answer **200**. A syntax error in the author's snippet is the _result_
  of a lint or a format, not a failure of the request that asked for one.
- **The AI model catalogue** answers **200** with an `upstreamError` field. It is degraded success:
  the catalogue is still delivered, from defaults.
- **In-stream frames are not response bodies.** By the time an SSE `error` frame is written the
  response has begun with a 200 and no status can change. The adoption there is that the frame
  **carries** a problem (`problem` beside the existing `message`), rather than being replaced by
  one. The same reasoning covers the RPC bridge's `{error, id}` envelope in `project-server.ts`.

**The client keeps one reader.** `problemDetail` reads a problem's `detail`, the legacy `error`, and
finally the type's `title` — most-specific first, since a `title` describes the type rather than the
occurrence. It answers `null` when a body says nothing, so a caller can supply better words than any
generic fallback. A problem's `type` also **is** the structured error code the Studio UI already
branched on: `problemSlug` derives it, and `installUrl` is the extension member (§3.2) that the
`needs-installation-access` type documents.

**No CORS, ever.** The guard script bans `Access-Control-Allow-*` outright. It is not a shape rule:
the whole loopback model rests on the browser refusing cross-origin reads (§4.2), so one such header
would hand that containment away. There is none in the repository today, and that fact is
load-bearing rather than incidental — which is exactly what needs a check, since nothing in the code
makes it visible.

---

## 5. Code Services (`/__studio/code/*`)

OXC-powered code quality services for Studio's function-body editors.

| Endpoint                     | Tool             | Description                                | Status          |
| ---------------------------- | ---------------- | ------------------------------------------ | --------------- |
| `POST /__studio/code/format` | `oxfmt`          | Format JavaScript snippet                  | **Implemented** |
| `POST /__studio/code/minify` | `Bun.Transpiler` | Minify JavaScript snippet                  | **Implemented** |
| `POST /__studio/code/lint`   | `oxlint`         | Lint JavaScript snippet (JSON diagnostics) | **Implemented** |

Snippets are function _bodies_: the handler wraps them in a synthetic function before formatting/linting, unwraps the result, and remaps diagnostic line/column positions back to the snippet.

The remapping is a constant: the wrapper is one synthetic header line, so a diagnostic loses one line and a fixed byte count (`adjustDiagnostics`). It is named here because it is the kind of thing that invites a source map, and a source map for a constant offset is more machinery than the thing it maps — see §8.

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

## 8. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md).

| Standard                                                                                                  | Class         | Binds      | Evidence                                                                                                                              | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WHATWG Fetch](https://fetch.spec.whatwg.org/)                                                            | **Adopted**   | §4.2       | packages/server/src/net-guard.ts, packages/server/tests/net-guard.test.ts                                                             | The same-origin policy is the containment, so **no** response from either entry point carries an `Access-Control-Allow-*` header. Emitting one would hand the containment away. That absence is now enforced rather than merely true: `scripts/check-error-shapes.ts` bans the header outright, because nothing in the code makes a load-bearing absence visible.                                                                                                                                                                                                                                                                        |
| [IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry) | **Adopted**   | §4.2       | packages/server/src/net-guard.ts, packages/server/tests/net-guard.test.ts                                                             | The whole `127.0.0.0/8` loopback block is recognized, not the canonical spelling alone — every address in it reaches this machine, so rejecting `127.0.0.2` would refuse a client while granting nothing. `0.0.0.0` (the unspecified address) is accepted as a `Host` and never as an `Origin`.                                                                                                                                                                                                                                                                                                                                          |
| [WHATWG HTML](https://html.spec.whatwg.org/)                                                              | **Subset**    | §3.1, §3.4 | packages/server/src/sse.ts, packages/server/tests/sse.test.ts, packages/server/src/watch.ts, packages/server/tests/watch-gaps.test.ts | The Server-Sent Events section, including the reconnection half: `retry: 500` opens the stream, reload frames carry an `id:`, and a reconnect carrying `Last-Event-ID` is pushed one reload. Absent, deliberately: the event buffer that would make `Last-Event-ID` a replay cursor. A reload is idempotent and total, so one subsumes every missed event — §3.1 states why, and a test asserts that three missed reloads produce one. Two surfaces bind it and ONE defines it: `sse.ts` is the stream, composed by the dev server's `/__reload` and by the live preview origin's own channel.                                           |
| [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111)                                                        | **Adopted**   | §3         | packages/server/src/server.ts                                                                                                         | Every dev-server response carries `Cache-Control: no-cache`, so a browser revalidates rather than applying its heuristic freshness to an edited file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)                                                        | **Subset**    | §4.3       | packages/server/src/problem.ts, packages/server/scripts/check-error-shapes.ts, packages/server/tests/problem.test.ts                  | Every failure is `application/problem+json` with an absolute `type`, a type-stable `title` and a per-occurrence `detail`, from one registry the docs are generated from. Absent, deliberately: `instance`, which would have to be fabricated since Jx has no per-occurrence resource. Three surfaces stay 200 and §4.3 says why — a lint result, a degraded catalogue, and an in-stream frame that carries a problem rather than being one.                                                                                                                                                                                              |
| [Fetch Metadata Request Headers](https://www.w3.org/TR/fetch-metadata/)                                   | **Divergent** | §4.2       | packages/server/src/net-guard.ts, packages/server/tests/net-guard.test.ts                                                             | `Sec-Fetch-Site` is read on every gated surface, folded into `originHostGate` so there are no new call sites. Two deviations, both toward strictness or usability: `same-site` is **denied**, where the Resource Isolation Policy allows it — on loopback a "site" wider than the origin is just another port on this machine — and an **absent** header is accepted, because it is browser-supplied and requiring it would refuse curl, Bun-native clients and the desktop bridge while stopping no page. A second `embeddable` policy admits the cross-origin canvas iframe's own subresources.                                        |
| [ECMA-426](https://ecma-international.org/publications-and-standards/standards/ecma-426/)                 | **Rejected**  | §5         | —                                                                                                                                     | because: the only mapping the code services perform is subtracting one synthetic header line and a fixed byte offset from each diagnostic, which is exact, total, and four lines of arithmetic. A source map would encode that constant as a generated artefact the snippet does not otherwise need, and every consumer would have to learn to read it. The snippets are function bodies edited in place, never shipped, so nothing downstream has a debugger to point at them.                                                                                                                                                          |
| [RFC 7464](https://www.rfc-editor.org/rfc/rfc7464)                                                        | **Rejected**  | §4.1       | —                                                                                                                                     | because: the only advantage over the `application/x-ndjson` already in use is that a record containing a raw newline cannot break framing, and the producer is always `JSON.stringify`, which escapes newlines — so the framing is unambiguous already. Adopting it would break every client and test and make a dev-server debug stream ungreppable. The defect that looked like a framing problem was not one: the reader dropped unparseable lines in silence, so an import finished looking clean while the user never learned what it skipped. They are counted and reported now (`packages/studio/src/services/import-client.ts`). |

## Changelog

- **0.2.23** (2026-08-31) — The route-group summary names the extension catalogue the dev server serves (extensions.md §9.2).
- **0.2.22** (2026-08-29) — A deployment base declared by the project's url is stripped from the request path at the edge, so the dev server answers both the bare and the based spelling.
- **0.2.21** (2026-08-27) — A rename resets any co-editing room keyed to the old path, so a shutdown flush cannot recreate the moved file.
- **0.2.20** (2026-08-27) — Directory listing and project-wide search answer in stable path order, in both implementations.
- **0.2.19** (2026-08-27) — The Studio API's path space is written down: server-root-relative in, project-relative out; a refactor target outside the active project is a 400, not a zero-result 200.
- **0.2.18** (2026-08-27) — The preview origin registers the project's own components without a declaration.
- **0.2.17** (2026-08-27) — The preview origin composes non-JSON pages through the project's extension registry, built from its config.
- **0.2.16** (2026-08-27) — The live site preview origin: an origin per project serving the working tree, with the overlay, the shared reload stream and its own resolver credential.
- **0.2.15** (2026-08-26) — the import stream names its destination on a ready line, before the crawl finishes (§4.2).
- **0.2.14** (2026-08-26) — Packages family: `GET /__studio/packages/versions` reports every dependency's newest published version, behind or not, replacing the outdated-only check.
- **0.2.13** (2026-08-26) — the import stream's done line carries the run summary, and accepts an opt-in verify pass (§4).
- **0.2.12** (2026-08-25) — §3: the static-file order now matches a build — public/ precedes the project root, which survives as a compatibility lane that warns.
- **0.2.11** (2026-08-22) — §3.1: watch-policy.ts — watchers watch only directories and regular files, and contain symlinks to the root, so a socket cannot throw and a link out cannot walk the filesystem.
- **0.2.10** (2026-08-20) — The loopback project server's RPC socket carries server-initiated frames (ProjectServerHandle.push) — the loopback twin of the dev server's named fs SSE event, and the channel a desktop launcher raises a window over (§4.2).
- **0.2.9** (2026-08-18) — §4.2: the Studio shell's report-only Trusted Types header is removed — see spec.md §21.5.
- **0.2.8** (2026-08-18) — §4.2: both entry points send the Studio shell a report-only Trusted Types policy, and nothing else.
- **0.2.7** (2026-08-16) — §4.2 Fetch Metadata on every gated surface, the loopback block, a constant-time token, and the three ungated project-server routes closed; gap:fetch-metadata closed.
- **0.2.6** (2026-08-16) — §4.3 every failure is an RFC 9457 problem document, guarded; gitPull produces the 409 the route table publishes; gap:studio-problem-details closed.
- **0.2.5** (2026-08-16) — §5 and §8 record the source-map decision — a constant header offset is not a source map (ECMA-426, Rejected).
- **0.2.4** (2026-08-16) — §3 static responses correct the two content types where the platform default disagrees with the registration.
- **0.2.3** (2026-08-16) — §3.1 the SSE stream advertises retry: 500 and answers Last-Event-ID with one reload; gap:sse-reconnect closed.
- **0.2.2** (2026-08-15) — Add §8 Standards Alignment; §4 and §4.2 marked Partial — the failure contract is unspecified and the project server does not gate uniformly.
- **0.2.1** (2026-07-25) — Activation admits an existing project of the account's own (project.json under the home directory); a refused activation must surface as an error rather than fall back to the server root.
- **0.2.0** (2026-07-25) — POST /__studio/create-project requires an explicit absolute destination parent — the server no longer falls back to its own root. Adds assertCreatableParent (root, allowedRoots, or home; absolute only), remembers created roots for a following activate, and returns an absolute root for projects outside the server root.
- **0.1.9** (2026-07-23) — Serve extension asset mounts ahead of the project root in the static-file chain (§3).
- **0.1.8** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.7** (2026-07-22) — Fix failing tests (`56e073f8`).
- **0.1.6** (2026-07-22) — Harden dev server and unify runtime/compiler evaluation (`47a1d4c9`).
- **0.1.5** (2026-07-17) — Align spec.md, site-architecture, desktop, server, extensions with reality (`c61ba567`).
- **0.1.4** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).
- **0.1.3** (2026-04-23) — Rebrand to jxsuite (`2897a4e8`).
- **0.1.2** (2026-04-16) — Landing site + working exports + release-it + linting (`a8409b5f`).
- **0.1.1** (2026-04-15) — Rebrand to Jx / Jx Platform (`abc63f2d`).
- **0.1.0** (2026-04-10) — Consolidate specs (`80ca313f`).

---

_`@jxsuite/server` Specification v0.2.23_
