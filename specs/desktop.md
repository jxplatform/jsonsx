# Jx Studio Desktop Architecture

## Platform Abstraction, Project Loading, and Component Scoping

**Version:** 1.0.0-draft
**Status:** Proposed
**License:** MIT

---

## Table of Contents

1. [Overview](#1-overview)
2. [Design Constraints](#2-design-constraints)
3. [Platform Abstraction Layer](#3-platform-abstraction-layer)
4. [Project Loading](#4-project-loading)
5. [Backend API Contract](#5-backend-api-contract)
6. [Component Scoping](#6-component-scoping)
7. [ElectroBun Integration](#7-electrobun-integration)
8. [Chrome Development Mode](#8-chrome-development-mode)
9. [NixOS Chromium App-Mode](#9-nixos-chromium-app-mode)
10. [SaaS / Cloud Mode](#10-saas--cloud-mode)
11. [Implementation Roadmap](#11-implementation-roadmap)

---

## 1. Overview

Jx Studio is designed for three deployment targets that share a single core codebase:

| Target            | Runtime                           | Backend                       | Storage                   | Status                       |
| ----------------- | --------------------------------- | ----------------------------- | ------------------------- | ---------------------------- |
| **Desktop app**   | ElectroBun (Bun + native webview) | Bun process (local)           | Filesystem                | All platforms except NixOS   |
| **NixOS desktop** | Chromium `--app` + Bun            | `@jxsuite/server` (localhost) | Filesystem via dev server | NixOS only (via `nix build`) |
| **Dev mode**      | Chrome                            | `@jxsuite/server` (localhost) | Filesystem via dev server | Active (Studio development)  |
| **SaaS/PaaS**     | Browser                           | Cloud API server              | Database / object storage | Future                       |

### 1.1a Platform Strategy

The desktop runtime is chosen at **build time**, not runtime:

- **NixOS** → Chromium app-mode exclusively. ElectroBun cannot be built in a Nix sandbox, and Chromium provides superior Wayland support.
- **All other platforms** (macOS, Windows, non-NixOS Linux) → ElectroBun exclusively. Provides native CEF webview with embedded Bun process.

The studio package (`@jxsuite/studio`) contains all UI logic and is backend-agnostic. It communicates with its environment through a **Platform Abstraction Layer (PAL)** — an interface that each deployment target implements. The server package (`@jxsuite/server`) is one such implementation; the ElectroBun Bun process is another; a cloud API server is a third.

### 1.1 Relationship to Other Specs

- **[Studio Spec](studio.md)** — Defines the visual builder: canvas, layer tree, inspector, state model, keyboard shortcuts. This spec does not alter any of that.
- **[Site Architecture Spec](site-architecture.md)** — Defines project structure (`project.json`, `pages/`, `content/`, etc.), routing, layouts, content collections. This spec defines how Studio _discovers and opens_ those projects.
- **[Server Spec](server.md)** — Defines the `@jxsuite/server` dev server endpoints. This spec defines a backend API contract that the server must satisfy, and that other backends can also satisfy.

---

## 2. Design Constraints

### 2.1 Consistency

The UX and APIs must be consistent regardless of where the project lives. A user opening a project from the local filesystem, from a dev server, or from cloud storage should see the same file tree, the same component list, and the same editing experience. The underlying storage is an implementation detail hidden behind the PAL.

### 2.2 Modularity

The studio package is the heart of every deployment. It imports no platform-specific modules directly. Platform bindings are injected at startup via `registerPlatform()`. The server package is a flexible backend — not the only backend. Any service that implements the Backend API Contract (§5) is a valid backend.

### 2.3 Flexibility

Studio must run in Chrome during its own development (the current workflow). It must also run inside ElectroBun's native webview. And eventually inside a plain browser against a cloud API. No deployment target may require capabilities that break the others — platform-specific features (native dialogs, filesystem access) are accessed exclusively through the PAL.

---

## 3. Platform Abstraction Layer

The PAL is a plain JavaScript object conforming to a `StudioPlatform` interface. It is registered once at startup and accessed through a module-level getter.

### 3.1 Interface

```typescript
interface StudioPlatform {
  /** Unique identifier for this platform */
  id: "desktop" | "devserver" | "cloud";

  /**
   * Open a project.
   * Presents a platform-appropriate dialog (native file dialog, browser
   * directory picker, or cloud project selector) filtered to project.json.
   * Returns the parsed project.json config and an opaque project handle,
   * or null if the user cancelled.
   */
  openProject(): Promise<{
    config: SiteConfig;
    handle: ProjectHandle;
  } | null>;

  /**
   * List directory contents relative to the project root.
   * Returns entries with name, path (project-relative), type, size, modified.
   */
  listDirectory(dir: string): Promise<DirEntry[]>;

  /** Read a file's contents as text, relative to project root. */
  readFile(path: string): Promise<string>;

  /** Write text content to a file, relative to project root. */
  writeFile(path: string, content: string): Promise<void>;

  /** Delete a file, relative to project root. */
  deleteFile(path: string): Promise<void>;

  /** Rename or move a file within the project. */
  renameFile(from: string, to: string): Promise<void>;

  /** Create a directory, relative to project root. */
  createDirectory(path: string): Promise<void>;

  /**
   * Discover all custom element components in the project.
   * Returns component metadata (tagName, path, state schema, etc.)
   * scoped to the given directory (defaults to project root).
   */
  discoverComponents(dir?: string): Promise<ComponentMeta[]>;

  /**
   * Search file contents within the project.
   * Returns matching files with line/column context.
   */
  searchFiles?(query: string, glob?: string): Promise<SearchResult[]>;

  /**
   * Format, lint, or minify a code snippet.
   * Only available on platforms with server-side code tooling.
   */
  codeService?(action: "format" | "lint" | "minify", code: string): Promise<CodeServiceResult>;

  /**
   * Resolve a $prototype/$src entry server-side.
   * Only available on platforms with a Bun/Node backend.
   */
  resolvePrototype?(payload: ResolvePayload): Promise<any>;

  /**
   * Execute a timing: "server" function.
   * Only available on platforms with a Bun/Node backend.
   */
  executeServerFunction?(payload: ServerFunctionPayload): Promise<any>;
}
```

### 3.2 Types

```typescript
interface DirEntry {
  name: string;
  path: string; // Project-relative
  type: "file" | "directory";
  size?: number;
  modified?: string; // ISO 8601
}

interface ComponentMeta {
  tagName: string;
  path: string; // Project-relative
  state?: Record<string, any>;
  $defs?: Record<string, any>;
}

interface ProjectHandle {
  /** Project root identifier. Filesystem path for local, project ID for cloud. */
  root: string;
  /** Display name, from project.json `name` field. */
  name: string;
  /** The parsed project.json content. */
  projectConfig: SiteConfig;
}

interface SiteConfig {
  name?: string;
  url?: string;
  defaults?: Record<string, any>;
  $head?: any[];
  $media?: Record<string, string>;
  style?: Record<string, any>;
  state?: Record<string, any>;
  redirects?: Record<string, any>;
  build?: Record<string, any>;
}
```

### 3.3 Registration

```javascript
// packages/studio/platform.js
let _platform = null;

export function registerPlatform(platform) {
  _platform = platform;
}

export function getPlatform() {
  if (!_platform)
    throw new Error("No platform registered. Call registerPlatform() before starting Studio.");
  return _platform;
}
```

Each deployment target calls `registerPlatform()` before Studio initializes:

```javascript
// Desktop (ElectroBun main view init)
import { registerPlatform } from "@jxsuite/studio/platform.js";
import { createDesktopPlatform } from "@jxsuite/studio-desktop";
registerPlatform(createDesktopPlatform());

// Dev server (browser, served by @jxsuite/server)
import { registerPlatform } from "@jxsuite/studio/platform.js";
import { createDevServerPlatform } from "@jxsuite/studio/platforms/devserver.js";
registerPlatform(createDevServerPlatform());
```

### 3.4 Studio Startup Sequence

1. Platform adapter calls `registerPlatform(impl)`
2. Studio calls `loadProject()`:
   - If a project was previously open and the handle is still valid, reopen it
   - Otherwise, show the welcome state ("Open a project to get started")
3. When the user triggers "Open Project":
   - Studio calls `getPlatform().openProject()`
   - The platform presents its native project opening flow
   - On success, Studio receives `{ config, handle }` and initializes the file tree

---

## 4. Project Loading

### 4.1 The project.json Contract

A project is identified by its `project.json` file. This is the single point of entry for all deployment targets:

- **Desktop:** User selects `project.json` via native file dialog. The parent directory becomes the project root.
- **Dev server:** User selects the folder containing `project.json` via `showDirectoryPicker()`. Studio reads `project.json` from the directory to validate it.
- **Cloud:** User selects a project from a project list. The cloud backend locates the project's `project.json` equivalent in its data store.

The `project.json` file is **required** for project-level features. Studio can still open individual `.json` files for standalone component editing (see §4.3).

### 4.2 Project Open Flow

```
User clicks "Open Project"
        │
        ▼
platform.openProject()
        │
        ├─── Desktop: Utils.openFileDialog({ allowedFileTypes: "json", canChooseFiles: true })
        │    → user picks project.json → read + parse → derive project root from parent dir
        │
        ├─── Dev server: showDirectoryPicker()
        │    → user picks folder → read project.json from dir → parse + validate
        │
        └─── Cloud: fetch project list → user picks → fetch project.json from storage
        │
        ▼
Returns { config, handle } or null
        │
        ▼
Studio initializes project state:
  - projectState.projectRoot = handle.root
  - projectState.projectConfig = config
  - projectState.isSiteProject = true
  - Load root directory listing
  - Load component registry
  - Auto-expand key directories (pages/, layouts/, components/)
  - Switch to Files tab
```

### 4.3 Single File Mode

When a user opens an individual `.json` file (via "Open File" or by double-clicking in an already-open project tree), Studio enters **single file mode**:

- The canvas loads the document as a standalone component
- No project tree is shown (unless a project is already open)
- Components sidebar shows only components declared or imported by this file (see §6.1)
- File operations (save, etc.) operate on the individual file

Single file mode is the default when no project is loaded. It is also active within a project when editing an individual component — but the project context remains available.

### 4.4 State Shape

```javascript
// After opening a project:
projectState = {
  root: "/Users/alice/Sites/my-site", // Absolute path (local) or project ID (cloud)
  name: "My Site", // From project.json
  projectRoot: ".", // Relative path prefix for API calls
  isSiteProject: true,
  projectConfig: {
    /* parsed project.json */
  },
  dirs: new Map(), // Cached directory listings
  expanded: new Set(), // Expanded tree nodes
  selectedPath: null,
  searchQuery: "",
};
```

---

## 5. Backend API Contract

The Backend API Contract defines the operations that any Studio backend must support. The current `@jxsuite/server` endpoints map directly to these operations. Future backends (ElectroBun Bun process, cloud API) implement the same operations through their own transport.

### 5.1 File Operations

| Operation           | `@jxsuite/server` endpoint      | PAL method                 |
| ------------------- | ------------------------------- | -------------------------- |
| List directory      | `GET /__studio/files?dir=`      | `listDirectory(dir)`       |
| Read file           | `GET /__studio/file?path=`      | `readFile(path)`           |
| Write file          | `PUT /__studio/file?path=`      | `writeFile(path, content)` |
| Delete file         | `DELETE /__studio/file?path=`   | `deleteFile(path)`         |
| Rename file         | `POST /__studio/file/rename`    | `renameFile(from, to)`     |
| Discover components | `GET /__studio/components?dir=` | `discoverComponents(dir)`  |
| Search contents     | `GET /__studio/search?q=`       | `searchFiles(query, glob)` |

### 5.2 Project Operations

| Operation        | `@jxsuite/server` endpoint | PAL method                   |
| ---------------- | -------------------------- | ---------------------------- |
| Open project     | N/A (client-side dialog)   | `openProject()`              |
| Project metadata | `GET /__studio/project`    | Derived from `ProjectHandle` |

### 5.3 Code Services (Optional)

| Operation   | `@jxsuite/server` endpoint   | PAL method                    |
| ----------- | ---------------------------- | ----------------------------- |
| Format code | `POST /__studio/code/format` | `codeService("format", code)` |
| Lint code   | `POST /__studio/code/lint`   | `codeService("lint", code)`   |
| Minify code | `POST /__studio/code/minify` | `codeService("minify", code)` |

### 5.4 Runtime Services (Optional)

| Operation               | `@jxsuite/server` endpoint | PAL method                       |
| ----------------------- | -------------------------- | -------------------------------- |
| Resolve $prototype/$src | `POST /__jx_resolve__`     | `resolvePrototype(payload)`      |
| Execute server function | `POST /__jx_server__`      | `executeServerFunction(payload)` |

Optional methods may not exist on all platforms. Studio must check for their presence before calling:

```javascript
const platform = getPlatform();
if (platform.codeService) {
  const result = await platform.codeService("format", code);
}
```

---

## 6. Component Scoping

The Components sidebar adapts its contents based on context: what is currently open and whether a site project is loaded.

### 6.1 Single File Mode (No Project)

When editing a standalone component with no project loaded:

- **Shown:** Components declared in the file's `$defs`, plus components referenced via `$ref` or custom element `tagName` that resolve to other `.json` files
- **Not shown:** A global component scan. There is no project root to scan.

The component list is derived by walking the document tree and extracting:

1. `$defs` entries that define reusable sub-components
2. `$ref` paths that point to other `.json` files (these are the "imported" components)
3. Custom element `tagName` values that match known component files

### 6.2 Site Project Mode (Root Level)

When a project is loaded and the user is at the project level (e.g. in the file tree, or no specific document is open):

- **Shown:** All components discovered across the entire site (`components/`, co-located `_prefixed` files, any `.json` with a custom-element `tagName`)
- **Scope label:** "All Components" or the site name

### 6.3 Site Project Mode (Document Level)

When a project is loaded and the user opens a specific page, layout, or component:

| Section    | Contents                                                                              |
| ---------- | ------------------------------------------------------------------------------------- |
| **Active** | Components directly referenced by the current document (same logic as §6.1)           |
| **Global** | All other components in the project that are _not_ referenced by the current document |

This two-tier separation lets the user quickly find components already in use ("Active") while still having access to the full project library ("Global") for drag-and-drop insertion.

### 6.4 Resolution Logic

```
openDocument(doc, projectState):

  activeComponents = extractReferences(doc)
    // Walk doc tree, collect $ref paths, custom tagNames, $defs

  if projectState?.isSiteProject:
    allComponents = platform.discoverComponents()
    globalComponents = allComponents.filter(c => !activeComponents.includes(c))
    render:
      "Active" section  → activeComponents
      "Global" section  → globalComponents
  else:
    render:
      flat list → activeComponents
```

### 6.5 Updating on Navigation

When the user navigates into a sub-component (via `pushDocument()` in the state model), the "Active" set updates to reflect the new document's references. The "Global" set adjusts accordingly. When the user navigates back (`popDocument()`), the previous scope is restored.

---

## 7. ElectroBun Integration

### 7.1 Architecture

```
┌─────────────────────────────────────────────────────┐
│                   ElectroBun App                     │
│                                                      │
│  ┌─────────────────┐    RPC    ┌──────────────────┐ │
│  │   Bun Process    │◄────────►│  Native Webview   │ │
│  │                  │          │                    │ │
│  │  - File I/O      │          │  - @jxsuite/studio  │ │
│  │  - Utils.*       │          │  - @jxsuite/runtime │ │
│  │  - Code services │          │  - Lit + Spectrum  │ │
│  │  - Build / SSG   │          │  - Monaco          │ │
│  └─────────────────┘          └──────────────────┘ │
│                                                      │
└─────────────────────────────────────────────────────┘
```

The Bun process owns all filesystem and OS operations. The webview contains Studio's UI. Communication happens via ElectroBun's RPC bridge.

### 7.2 Desktop Platform Adapter

The desktop platform adapter runs in the **webview** and translates PAL calls into RPC calls to the Bun process:

```javascript
// packages/studio-desktop/platform.js (runs in webview)
export function createDesktopPlatform() {
  return {
    id: "desktop",

    async openProject() {
      // RPC to Bun process → Utils.openFileDialog()
      const result = await rpc.openProject();
      if (!result) return null;
      return { config: result.config, handle: result.handle };
    },

    async listDirectory(dir) {
      return rpc.listDirectory(dir);
    },

    async readFile(path) {
      return rpc.readFile(path);
    },

    async writeFile(path, content) {
      return rpc.writeFile(path, content);
    },

    // ... etc
  };
}
```

### 7.3 Bun-Side Handlers

The Bun process implements the actual operations:

```javascript
// src/bun/studio-handlers.js (runs in Bun process)
import { Utils } from "electrobun/bun";
import { readdir, readFile, writeFile, unlink, rename, stat } from "fs/promises";
import { resolve, relative, join, basename } from "path";

let projectRoot = null;

export async function handleOpenProject() {
  const paths = await Utils.openFileDialog({
    startingFolder: projectRoot || homedir(),
    allowedFileTypes: "json",
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
  });

  if (!paths || paths.length === 0) return null;

  const filePath = paths[0];
  if (basename(filePath) !== "project.json") return null;

  const raw = await readFile(filePath, "utf8");
  const config = JSON.parse(raw);
  projectRoot = resolve(filePath, "..");

  return {
    config,
    handle: {
      root: projectRoot,
      name: config.name || basename(projectRoot),
      projectConfig: config,
    },
  };
}

export async function handleListDirectory(dir) {
  const absDir = resolve(projectRoot, dir);
  assertUnderRoot(absDir, projectRoot);
  const entries = await readdir(absDir, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    path: relative(projectRoot, join(absDir, e.name)),
    type: e.isDirectory() ? "directory" : "file",
  }));
}

// ... readFile, writeFile, deleteFile, renameFile, discoverComponents
```

### 7.4 App Structure

```
jx-studio-app/
├── electrobun.config.js         # ElectroBun build config
├── src/
│   ├── bun/
│   │   ├── main.js              # App entry: create window, register RPC handlers
│   │   ├── studio-handlers.js   # PAL implementation (filesystem, dialogs)
│   │   └── code-services.js     # oxfmt, oxlint, Bun.Transpiler
│   └── views/
│       └── studio/
│           ├── index.html        # Studio HTML shell
│           └── init.js           # registerPlatform(createDesktopPlatform())
├── package.json
└── node_modules/
    ├── @jxsuite/studio/           # UI package (the studio itself)
    ├── @jxsuite/runtime/          # Canvas rendering
    └── electrobun/               # Framework
```

---

## 8. Chrome Development Mode

During Studio's own development, the studio runs in Chrome served by `@jxsuite/server`. This is the current workflow and must remain fully functional.

### 8.1 Dev Server Platform Adapter

```javascript
// packages/studio/platforms/devserver.js
export function createDevServerPlatform() {
  return {
    id: "devserver",

    async openProject() {
      // Use Chrome's showDirectoryPicker API
      if (!("showDirectoryPicker" in window)) {
        throw new Error("showDirectoryPicker not available");
      }

      const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });

      // Read project.json from the chosen directory
      let siteHandle;
      try {
        siteHandle = await dirHandle.getFileHandle("project.json");
      } catch {
        throw new Error("No project.json found in selected folder");
      }

      const file = await siteHandle.getFile();
      const config = JSON.parse(await file.text());

      // Resolve server-relative path by matching against known sites
      const sitesRes = await fetch("/__studio/sites");
      const sites = await sitesRes.json();
      const match = sites.find((s) => JSON.stringify(s.config) === JSON.stringify(config));

      if (!match) {
        throw new Error("Selected project is not under the dev server root");
      }

      return {
        config,
        handle: {
          root: match.path,
          name: config.name || match.path.split("/").pop(),
          projectConfig: config,
        },
      };
    },

    async listDirectory(dir) {
      const serverDir = projectPath(dir);
      const res = await fetch(`/__studio/files?dir=${encodeURIComponent(serverDir)}`);
      if (!res.ok) throw new Error("Failed to list directory");
      const entries = await res.json();
      for (const e of entries) e.path = stripProjectRoot(e.path);
      return entries;
    },

    async readFile(path) {
      const res = await fetch(`/__studio/file?path=${encodeURIComponent(projectPath(path))}`);
      if (!res.ok) throw new Error("Failed to read file");
      return res.text();
    },

    async writeFile(path, content) {
      const res = await fetch(`/__studio/file?path=${encodeURIComponent(projectPath(path))}`, {
        method: "PUT",
        body: content,
      });
      if (!res.ok) throw new Error("Failed to write file");
    },

    // ... deleteFile, renameFile, discoverComponents, codeService, etc.
  };
}
```

### 8.2 Why showDirectoryPicker, Not showOpenFilePicker

In Chrome, `showOpenFilePicker` returns a `FileSystemFileHandle` with no way to access the parent directory or derive a filesystem path. The dev server needs a server-relative path to scope file operations. `showDirectoryPicker` solves this by:

1. Giving the user a folder selection experience (they pick the project folder)
2. Letting Studio read `project.json` from the `FileSystemDirectoryHandle` to validate
3. Matching against the server's `/__studio/sites` endpoint to resolve the server-relative path

For the **desktop app**, `Utils.openFileDialog` with `canChooseFiles: true` and `allowedFileTypes: "json"` gives us the file path directly, so the user can pick `project.json` explicitly.

---

## 9. NixOS Chromium App-Mode

> **Status: Implemented.** Available via `nix build` and `bun run desktop:chromium`.

On NixOS, ElectroBun cannot be built in a Nix sandbox, and system Chromium provides superior Wayland support. The desktop app therefore uses Chromium in `--app` mode, which provides a frameless, app-like window.

### 9.1 Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  Chromium App-Mode                        │
│                                                          │
│  ┌──────────────────┐           ┌──────────────────────┐ │
│  │   Bun Process     │  HTTP     │  Chromium --app       │ │
│  │                   │◄────────►│                        │ │
│  │  @jxsuite/server  │          │  @jxsuite/studio       │ │
│  │  - File I/O       │          │  @jxsuite/runtime      │ │
│  │  - Studio API     │          │  Lit + Spectrum        │ │
│  │  - Code services  │          │  Monaco                │ │
│  └──────────────────┘          └──────────────────────┘ │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Unlike ElectroBun (which uses WebSocket RPC between the Bun process and a native webview), the Chromium app-mode runtime reuses the `@jxsuite/server` dev server as its backend. The Bun process starts the server on a random port, then launches Chromium with `--app=<serverUrl>/studio/index.html`. Studio registers the `DevServerPlatform` adapter — the same one used in Chrome development mode.

### 9.2 Launcher (`chromium-mode.ts`)

The entry point (`packages/desktop/src/chromium-mode.ts`) performs:

1. Starts `@jxsuite/server` on a random port with middleware for studio assets and project public files
2. Locates a Chromium binary via `CHROMIUM_BIN` env var or PATH lookup (`chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`)
3. Launches Chromium with app-mode flags:
   - `--app=<serverUrl>/studio/index.html` — frameless window
   - `--no-first-run --no-default-browser-check` — suppress first-run prompts
   - `--window-size=1400,900`
   - `--user-data-dir=<projectRoot>/.jx/chromium-profile` — isolated profile
   - `--ozone-platform=wayland --enable-features=UseOzonePlatform` — when `WAYLAND_DISPLAY` is set
4. Exits when the browser window closes

### 9.3 Nix Package

The flake's `packages.default` produces a fully sandboxed NixOS package:

- **Build dependencies** are fetched via [bun2nix](https://github.com/nix-community/bun2nix), which generates a `bun.nix` lockfile mapping all packages to fixed-output derivations — no network access needed during build
- **`bun.nix` auto-refresh:** The root `package.json` postinstall script runs `bun2nix -o bun.nix` after every `bun install`, keeping the nix lockfile in sync with `bun.lock`
- **Build phase** runs `bun run build` (compiler, runtime, studio, schema) and `pre-build.ts` (bundles the studio init bridge and copies assets)
- **Install phase** copies `chromium-mode.ts`, studio assets, and dereferenced `node_modules` (via `cp -rL` to resolve workspace symlinks) into the nix store
- **Wrapper** creates a `jx-studio` binary that runs `bun chromium-mode.ts` with `CHROMIUM_BIN` and `JX_STUDIO_ASSETS` pre-set to nix store paths

```
$ nix build
$ ./result/bin/jx-studio [project-root]
```

---

## 10. SaaS / Cloud Mode

> **Status: Future.** This section describes the target architecture for a hosted Studio deployment.

### 10.1 Cloud Platform Adapter

A cloud adapter replaces filesystem operations with API calls to a remote service. The project root becomes a project ID rather than a filesystem path. All PAL methods translate to REST or WebSocket calls to the cloud API.

### 10.2 Storage Backend

The cloud backend stores projects in a database with an abstraction equivalent to the filesystem:

| Filesystem concept  | Cloud equivalent                       |
| ------------------- | -------------------------------------- |
| `project.json`      | Project record with config JSON column |
| Directory listing   | Query files table by parent path       |
| File read/write     | Row-level CRUD on files table          |
| Component discovery | Query files table by naming convention |

The same PAL interface means Studio code doesn't change — only the adapter implementation.

### 10.3 Collaboration (Future)

A cloud backend can extend the PAL with collaboration features:

```typescript
interface CollaborativePlatform extends StudioPlatform {
  onRemoteChange(callback: (change: FileChange) => void): void;
  lockFile(path: string): Promise<boolean>;
  unlockFile(path: string): Promise<void>;
}
```

These are additive — Studio checks for their presence and enables collaboration UI when available.

---

## 11. Implementation Roadmap

### Phase 1: PAL Extraction ✅

Extract the platform abstraction from Studio's current inline `fetch()` calls:

- [x] Define `StudioPlatform` interface in `packages/studio/src/platform.js`
- [x] Implement `DevServerPlatform` wrapping current `fetch("/__studio/*")` calls
- [x] Replace all direct `fetch("/__studio/*")` in `studio.js` with `getPlatform().*` calls
- [x] Implement `showDirectoryPicker()` flow in `DevServerPlatform.openProject()`
- [ ] Update component sidebar to implement Active/Global scoping (§6)
- [x] Add `GET /__studio/sites` endpoint for dev server project matching

### Phase 2: Desktop App Skeleton ✅

Package Studio as an ElectroBun app:

- [x] Scaffold ElectroBun project with Studio as the main view
- [x] Implement `DesktopPlatform` adapter (RPC bridge to Bun process)
- [x] Implement Bun-side file handlers (read, write, list, delete, rename, discover)
- [x] Wire `Utils.openFileDialog()` for `openProject()` with `project.json` filter
- [ ] Port code services (format, lint, minify) to run in Bun process directly (currently stubbed)
- [x] Verify full editing flow: open project, browse files, edit component, save

### Phase 2b: NixOS Chromium App-Mode ✅

Package Studio as a NixOS-native app using Chromium `--app` mode:

- [x] Implement `chromium-mode.ts` launcher (server + Chromium `--app`)
- [x] Wayland support via `--ozone-platform=wayland` auto-detection
- [x] Sandboxed `nix build` via bun2nix (no `__noChroot`, no network at build time)
- [x] `makeWrapper` producing `jx-studio` binary with bundled Chromium and Bun
- [x] Auto-refresh `bun.nix` via postinstall hook

### Phase 3: Feature Parity

Ensure desktop app matches dev-mode capabilities:

- [ ] Live preview in canvas with hot reload on file change
- [ ] `$prototype`/`$src` resolution via Bun process imports
- [ ] `timing: "server"` function execution
- [ ] Build / SSG pipeline accessible from Studio toolbar
- [ ] Drag-and-drop component insertion from sidebar

### Phase 4: Cloud Adapter (Future)

- [ ] Define cloud API specification (REST endpoints mirroring PAL)
- [ ] Implement `CloudPlatform` adapter
- [ ] Project authentication and authorization
- [ ] Real-time collaboration via WebSocket change feed

---

_Jx Studio Desktop Architecture Specification v1.0.0-draft_
