---
title: "The dev server"
description: "The @jxsuite/server development server: live reload over SSE, the Studio API, and the proxies that run server-side code while you develop."
spec:
  - server.md#1 # overview
  - server.md#2 # entry point
  - server.md#3.1 # live reload
  - server.md#3.2 # $prototype/$src proxy
  - server.md#3.3 # server function proxy
code:
  - packages/server/src/server.ts
  - packages/server/src/watch.ts
  - packages/server/src/resolve.ts
---

# The dev server

During development you don't run the compiled `dist/` output — you run your source files through the Jx dev server, a Bun-native server from `@jxsuite/server`. It serves the project directory as-is, reloads the browser when files change, executes server-side code on your behalf, and backs Studio's file operations.

## Starting it

The whole server is one call, `createDevServer`:

```js
// server.js
import { createDevServer } from "@jxsuite/server";

await createDevServer({
  root: import.meta.dir,
  port: 3000,
});
```

Run it with `bun run server.js` and open `http://localhost:3000/`. The full options surface:

| Option       | Default    | What it does                                                                                                                                     |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `root`       | (required) | Project root to serve; every file operation is contained to it.                                                                                  |
| `port`       | `3000`     | Listen port.                                                                                                                                     |
| `builds`     | `[]`       | `Bun.build` entries (`entrypoints`, `outdir`, optional `match`, `label`) bundled at startup and selectively rebuilt when a changed file matches. |
| `watch`      | `true`     | File watching + live reload. Pass `false` to disable, or an options object for the watcher.                                                      |
| `studio`     | `true`     | Mounts the `/__studio/*` API that Jx Studio talks to.                                                                                            |
| `middleware` | —          | `(req, url) => Response \| null` — your own routes, checked before static file serving.                                                          |

:::doc-note
Scaffolded projects wire `bun run dev` to `jx dev`, but that subcommand is not part of the current `jx` CLI (see [CLI commands](/docs/framework/build/cli)). Until it lands, start the dev server with a `server.js` like the one above — the Jx monorepo's own `bun run dev` does exactly this.
:::

## Live reload

The server watches `root` (ignoring `node_modules/`, `dist/`, `.git/`, and friends) and exposes a Server-Sent Events endpoint at `/__reload`. Every `.html` file it serves gets a one-line client injected before `</body>`:

```html
<script>
  new EventSource("/__reload").onmessage = () => location.reload();
</script>
```

Save a file and every connected page reloads. When the changed file matches a `builds` entry's `match` pattern, that bundle is rebuilt first, so the reload picks up fresh output. The one exception is the Studio editor itself: Studio pages never get the reload script, because Studio refreshes edited files in place and a full reload would discard open tabs and undo history.

## How Studio is served

Studio is a static web app plus a REST API — the dev server provides both. With `studio: true` (the default), the server mounts `/__studio/*`: project metadata, file listing, read/write/delete/rename, component discovery, content search, code formatting and linting for the function-body editor, and a realtime co-editing WebSocket at `/__studio/collab`. Every filesystem operation is validated to stay under `root`, so path traversal is rejected.

Studio's UI assets are ordinary static files under the served root; opening a project in Studio activates its directory on the server, which then also resolves project files, and `public/` contents at the site root, exactly as the production build would. The desktop app doesn't use this server — it embeds its own loopback-only, token-gated variant — but it speaks the same API.

## Running server-side code: the two proxies

Production builds compile server-side work into generated handlers. In development there is no build, so the runtime hands that work to the dev server through two POST endpoints. You don't call either one yourself — they exist so documents behave the same in dev as after `jx build`.

### Module resolution (`POST /__jx_resolve__`)

When a document uses an external class — a `$prototype` entry with a `$src` — the browser can't always resolve it: the module may need Node-only APIs like the filesystem, or live behind CORS. The runtime posts the entry (its `$src`, `$prototype`, `$export`, and config) to the dev server, which imports the module server-side (`.js` directly, `.class.json` via its `$implementation`), instantiates the class with the config, resolves it, and returns the value as JSON. Reactive entries re-resolve when their inputs change.

### Server functions (`POST /__jx_server__`)

Functions marked `timing: "server"` never ship to the browser. In development the runtime posts the call instead:

```json
{
  "$src": "./dashboard.server.js",
  "$export": "fetchMetrics",
  "arguments": { "userId": 42 }
}
```

The server imports the module, invokes the export with the arguments object, and returns the result as JSON. In production the same calls hit the generated server handler — see [How compilation works](/docs/framework/build).

Extensions that declare server mounts (for example the data API) are served under `/_jx/*` with the same wire contract as the generated production worker, so data-backed documents work identically in both environments.

## Static files and npm packages

Anything the other routes don't claim is served from disk: files under `root` at their natural URLs, then files under the active Studio project, then the project's `public/` directory mapped to the site root — mirroring where assets live in production. Bare npm specifiers in URLs (such as `@jxsuite/parser/…`) are resolved through `node_modules`, bundled on demand with `Bun.build`, and cached for the life of the server. All responses are sent with `Cache-Control: no-cache` so a plain reload never serves a stale bundle.

## Related

- [CLI commands](/docs/framework/build/cli) — what `bun create @jxsuite` scaffolds and what `jx` can run
- [How compilation works](/docs/framework/build) — what replaces the proxies in production
- [Site architecture](/docs/framework/site) — the directory layout the server serves
