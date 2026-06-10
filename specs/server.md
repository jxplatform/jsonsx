# `@jxsuite/server` Specification

## Development Server with Live Reload, Proxy Resolution, and Studio API

**Version:** 2.0.0-draft
**Status:** In Progress
**License:** MIT

---

## 1. Overview

`@jxsuite/server` is a Bun-native development server for Jx projects. It provides live reload, `$src`/`$prototype` proxy resolution, `timing: "server"` function execution, a filesystem API for Studio, and OXC-powered code services.

---

## 2. Entry Point

```js
import { createDevServer } from "@jxsuite/server";

createDevServer({
  root: "./my-project",
  port: 3000,
  buildOptions: { entrypoints: ["./index.html"] },
});
```

> **Status: Implemented.**

---

## 3. Core Endpoints

### 3.1 Live Reload (`/__reload`)

SSE (Server-Sent Events) endpoint. The server watches the project directory via `chokidar` and pushes change events to connected browsers. The runtime injects a small SSE client that triggers page reload on change.

> **Status: Implemented.** `watch.js` handles file watching + SSE broadcasting.

### 3.2 `$prototype`/`$src` Proxy (`POST /__jx_resolve__`)

When the runtime encounters an external `$prototype` with `$src` during development, it sends a POST request to the dev server for server-side resolution. The server:

1. Reads the module at `$src` (supports `.js`, `.class.json`)
2. For `.class.json`: reads the schema, follows `$implementation`, imports the JS module
3. For `.js`: imports directly and extracts the named export
4. Instantiates the class with the provided config
5. Calls `resolve()` or reads `.value`
6. Returns the resolved value as JSON

This avoids CORS issues, enables Node.js-only dependencies (e.g. `glob`, `fs`), and provides a consistent resolution path for all `$src` specifiers.

#### `.class.json` Resolution

When `$src` points to a `.class.json` file:

1. Read the JSON schema
2. Check for `$implementation` key
3. If present: import the implementation module, use its exported class
4. If absent: dynamically construct a class from the schema (`classFromSchema`)
5. Instantiate with config and resolve

> **Status: Implemented.** `resolve.js` handles full resolution pipeline.

### 3.3 Server Function Proxy (`POST /__jx_server__`)

Executes `timing: "server"` functions during development. The runtime sends:

```json
{
  "$src": "./dashboard.server.js",
  "$export": "fetchMetrics",
  "arguments": { "userId": 42 }
}
```

The server imports the module, calls the exported function with the provided arguments, and returns the result as JSON.

> **Status: Implemented.** `resolve.js` `handleServerFunction()`.

---

## 4. Studio Filesystem API (`/__studio/*`)

A REST API for the Studio visual builder to manage project files.

### 4.1 Endpoints

| Method | Path                    | Description                                           | Status          |
| ------ | ----------------------- | ----------------------------------------------------- | --------------- |
| GET    | `/__studio/project`     | Project metadata (name, root)                         | **Implemented** |
| GET    | `/__studio/files`       | Directory listing with glob support                   | **Implemented** |
| GET    | `/__studio/file`        | Read file contents                                    | **Implemented** |
| PUT    | `/__studio/file`        | Write file contents                                   | **Implemented** |
| DELETE | `/__studio/file`        | Delete file                                           | **Implemented** |
| POST   | `/__studio/file/rename` | Rename/move file                                      | **Implemented** |
| GET    | `/__studio/components`  | Custom element discovery (hyphenated `tagName` files) | **Implemented** |
| GET    | `/__studio/search`      | Search file contents                                  | **Implemented** |

### 4.2 Security

All file operations are constrained to the project root via `assertUnderRoot()` — path traversal attempts are rejected.

> **Status: Implemented.** `studio-api.js` with full CRUD and path traversal protection.

---

## 5. Code Services (`/__studio/code/*`)

OXC-powered code quality services for the Studio's function body editor.

| Endpoint                     | Tool             | Description                                | Status          |
| ---------------------------- | ---------------- | ------------------------------------------ | --------------- |
| `POST /__studio/code/format` | `oxfmt`          | Format JavaScript snippet                  | **Implemented** |
| `POST /__studio/code/minify` | `Bun.Transpiler` | Minify JavaScript snippet                  | **Implemented** |
| `POST /__studio/code/lint`   | `oxlint`         | Lint JavaScript snippet (JSON diagnostics) | **Implemented** |

> **Status: Implemented.** `code-api.js` with diagnostic remapping.

---

## 6. Build Pipeline

### 6.1 `buildAll(options)`

Uses `Bun.build` to bundle entrypoints. Supports:

- Multiple entrypoints
- Selective rebuild (only changed files)
- Watch mode integration with live reload

### 6.2 `rebuild(changedPath)`

Incremental rebuild triggered by file watcher. Only reprocesses affected entrypoints.

> **Status: Implemented.** `build.js`.

---

## 7. Dependencies

| Package    | Purpose                              |
| ---------- | ------------------------------------ |
| `chokidar` | File watching for live reload        |
| `oxfmt`    | JavaScript formatting (via code API) |
| `oxlint`   | JavaScript linting (via code API)    |

Bun built-ins: `Bun.serve`, `Bun.build`, `Bun.Transpiler`.

---

_`@jxsuite/server` Specification v2.0.0-draft_
