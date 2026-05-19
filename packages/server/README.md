# `@jxsuite/server`

> Bun-native development server for Jx projects with live reload, proxy resolution, and Studio API.

## Overview

`@jxsuite/server` provides a single `createDevServer()` call that covers live reload, `$src`/`$prototype` proxy resolution (Node.js-side), `timing: "server"` function execution, a Studio filesystem API, and OXC-powered code services.

## Installation

```bash
bun add @jxsuite/server
```

## Usage

```js
import { createDevServer } from "@jxsuite/server";

await createDevServer({
  root: "./my-project",
  port: 3000,
  builds: [{ entrypoints: ["./index.html"], outdir: "./dist", label: "app" }],
});
```

## Endpoints

### Live reload — `GET /__reload`

SSE endpoint. `chokidar` watches the project root and pushes change events to connected browsers, triggering automatic page reload.

### `$prototype`/`$src` proxy — `POST /__jx_resolve__`

Resolves external `$prototype` data sources server-side. Supports `.js` modules and `.class.json` schemas. Avoids browser CORS issues and enables Node.js-only dependencies (`fs`, `glob`, etc.).

### Server functions — `POST /__jx_server__`

Executes `timing: "server"` function entries during development. The runtime sends `{ $src, $export, arguments }` and receives the return value as JSON.

### Studio filesystem API — `/__studio/*`

REST API for the Studio visual builder:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/__studio/project` | Project metadata |
| GET | `/__studio/files` | Directory listing |
| GET/PUT/DELETE | `/__studio/file` | Read / write / delete file |
| POST | `/__studio/file/rename` | Rename or move file |
| GET | `/__studio/components` | Discover custom elements |
| GET | `/__studio/search` | Search file contents |

All file operations are constrained to the project root (path traversal is rejected).

### Code services — `/__studio/code/*`

OXC-powered tools for the Studio function body editor:

| Endpoint | Tool | Description |
|----------|------|-------------|
| `POST /__studio/code/format` | oxfmt | Format a JS snippet |
| `POST /__studio/code/minify` | `Bun.Transpiler` | Minify a JS snippet |
| `POST /__studio/code/lint` | oxlint | Lint a JS snippet |

## Build pipeline

`buildAll(options)` uses `Bun.build` to bundle entrypoints. Incremental rebuilds (`rebuild(changedPath)`) are triggered by the file watcher and reprocess only affected entrypoints.

## Dependencies

| Package | Purpose |
|---------|---------|
| `chokidar` | File watching for live reload |

Bun built-ins used: `Bun.serve`, `Bun.build`, `Bun.Transpiler`.

## License

MIT
