# Jx Studio Desktop Architecture

## Platform Abstraction, Project Loading, and Component Scoping

**Version:** 0.3.7-draft
**Status:** Pending
**Updated:** 2026-08-11
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

The PAL is a plain JavaScript object conforming to a `StudioPlatform` interface. It is registered once at startup on `globalThis` (§3.3) and accessed through `getPlatform()`.

### 3.1 Interface

The canonical `StudioPlatform` interface is `packages/studio/src/types.ts` — roughly 70 members today. This spec deliberately does not duplicate it; the summary below names the member families and the model that governs them. The transport-level view of the same contract is the `STUDIO_ROUTES` table in `@jxsuite/protocol` (§5.1).

| Family                   | Representative members                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Session / project**    | `id`, `projectRoot`, `activate`, `openProject`, `openProjectPicker?`, `probeRootProject`, `createDestination`, `createProject`, `pickDirectory?`, `listStarters?`, `importSite?`, `listProjects?`, recent-projects persistence |
| **Filesystem**           | `listDirectory`, `readFile`, `writeFile`, `uploadFile`, `deleteFile`, `renameFile`, `findReferences?`, `createDirectory`, `locateFile`, `searchFiles`, `subscribeFileEvents?`                                                  |
| **Documents / formats**  | `discoverComponents`, `listFormats?`, `listExtensions?`, `fetchProjectSchemas?`, `formatAction?`, `fetchPluginSchema`                                                                                                          |
| **Packages**             | `listPackages`, `addPackage`, `removePackage`, `installDependencies?`, `outdatedPackages?`, `setPackageVersions?`                                                                                                              |
| **Git**                  | `gitStatus`, `gitCommit`, `gitPush`, `gitPull`, `gitDiff`, `gitCheckout`, `gitClone?`, `createPullRequest?`, …                                                                                                                 |
| **Collab**               | `collab?` (realtime co-editing handle per document)                                                                                                                                                                            |
| **Data / secrets**       | `dataConnections?`, `dataRows?`, row CRUD, `dataPush?`, `listSecrets?`, `setSecrets?`                                                                                                                                          |
| **Publish / identity**   | `getUser?`, `getAccountStatus?`, `listRepos?`, `importProject?`, `cfConnection?`, `cfConnect?`, `cfApi?`                                                                                                                       |
| **Code services / AI**   | `codeService` (§5.3), `resolveClass?`, `aiChatUrl`                                                                                                                                                                             |
| **Multi-window / shell** | `openProjectInNewWindow?`, `newWindow?`, `setWindowProject?`, `getProjectRoot?`, `getAppInfo?`, backend-persisted settings                                                                                                     |

**Core vs. optional, and degradation.** Required members are the minimal backend every platform implements. Optional members (marked `?` in the interface) each back an optional protocol route; Studio feature-detects them and degrades gracefully when they are absent — hiding the corresponding UI or falling back to a client-side path. Each optional route's `degradation` note in `STUDIO_ROUTES` records exactly what turns off (e.g. no `collab` → Studio edits solo with file-level saves; no `importSite` → the New Project modal hides its Import tab).

**Launcher-only extras are not interface members.** A platform may carry capabilities that only one shell can have — the desktop's `updater` and `windowControls` are the two today. These deliberately stay **out** of `StudioPlatform`: Studio reaches them by feature-detecting `globalThis.__jxPlatform` against its own local shape (see `resize-edges.ts`, `panels/toolbar.ts`), which is what lets the same shell code run unchanged where they do not exist. The consequence for adapter authors is that a factory annotated `(): StudioPlatform` **erases its own extras** — every caller, including its tests, then sees an object without them. Let the return type be inferred and assert conformance instead (`return platform satisfies StudioPlatform`), which also keeps the optional members the launcher does implement from reading as possibly-absent at the call site.

### 3.2 Types

The wire shapes the interface exchanges (`DirEntry`, `ComponentMeta`, `GitStatusResult`, `DataRowsQuery`, `StarterInfo`, …) live in `@jxsuite/protocol` and are re-exported from `packages/studio/src/types.ts`, so every backend serializes the same JSON the dev server does. Project configuration is the `ProjectConfig` type from `@jxsuite/schema/types` (the parsed `project.json`). `openProject()` resolves to `{ config, handle }`, where the handle is `{ root, name, projectConfig }` — `root` is a filesystem path locally and a project ID on cloud.

### 3.3 Registration

Registration lives in `packages/studio/src/platform.ts` and stores the adapter on `globalThis.__jxPlatform` — a global rather than a module-level variable, so a separate init bundle (e.g. the desktop `init.js`) can register the platform **before** the studio bundle loads, without needing to share module instances with it:

```typescript
// packages/studio/src/platform.ts
const g = globalThis as unknown as { __jxPlatform?: StudioPlatform };

export function registerPlatform(platform: StudioPlatform) {
  g.__jxPlatform = platform;
}

export function getPlatform() {
  if (!g.__jxPlatform) {
    throw new Error("No platform registered. Call registerPlatform() before starting Studio.");
  }
  return g.__jxPlatform;
}

export function hasPlatform() {
  return g.__jxPlatform != null;
}
```

Each deployment target either pre-registers its adapter before Studio initializes, or hands Studio a signal to build one itself. The desktop init bundle pre-registers the RPC-backed adapter on `__jxPlatform`. The cloud shell (the platform repo's `edit-init`) instead publishes a `window.__jxCloud` signal — the bound project, or `null` for the project-less hub — and lets the studio entry construct the adapter, so the cloud adapter (and the collab WebSocket client's `yjs` instance) lives **inside** the studio bundle rather than the shell; a second bundled `yjs` in the shell would break collab's cross-module `instanceof` checks. When nothing pre-registered, the studio entry resolves the default adapter — cloud when `__jxCloud` was signalled, else the dev server:

```javascript
// Desktop (init bundle, loaded before studio.js) — pre-registers its adapter
import { registerPlatform } from "@jxsuite/studio/platform";
registerPlatform(createDesktopPlatform());

// Cloud shell (edit-init, loaded before studio.js) — publishes a signal, not an adapter
globalThis.__jxCloud = { project }; // project: CloudProject | null

// Studio entry (studio.ts) — build the default adapter when none was pre-registered
if (!hasPlatform()) {
  registerPlatform(resolveDefaultPlatform()); // cloud when __jxCloud is set, else dev server
}
```

### 3.4 Studio Startup Sequence

1. Platform adapter calls `registerPlatform(impl)`
2. Studio calls `loadProject()`:
   - If a project was previously open and the handle is still valid, reopen it
   - Otherwise, show the welcome state ("Open a project to get started")
3. When the user triggers "Open Project":
   - With `openProjectPicker: "repo-list"` (cloud), Studio shows its own repository picker over `listRepos` + `importProject` (write-access repositories only) and opens the choice through the recent-projects path — `openProject()` is never called
   - Otherwise Studio calls `getPlatform().openProject()` and the platform presents its native project opening flow
   - On success, Studio receives `{ config, handle }` and initializes the file tree

### 3.5 Leaving the Webview

The desktop shell registers Studio's preview-navigation override (`@jxsuite/studio/preview-navigate`)
so a link clicked in Preview mode goes to the **user's default browser** via an `openExternal` RPC onto
`Utils.openExternal`, not to this webview. Following a link in Preview exists to see the page behave
like the deployed thing — routing, history, devtools — and a webview with no address bar is not that;
navigating it would also replace the editor. When the shell is unavailable or the OS refuses, the
studio's own `window.open` default still applies.

---

## 4. Project Loading

### 4.1 The project.json Contract

A project is identified by its `project.json` file. This is the single point of entry for all deployment targets:

- **Desktop:** User selects `project.json` via native file dialog. The parent directory becomes the project root.
- **Dev server:** User selects the folder containing `project.json` via `showDirectoryPicker()`. Studio reads `project.json` from the directory to validate it.
- **Cloud:** User picks from a repository list (`openProjectPicker: "repo-list"` — GitHub repositories with write access, Jx-tagged repos first). Selection runs `importProject`, which probes the repository's `project.json` and resolves the catalogue root key Studio navigates to.

What that list contains is bounded by the App's grant, not by the account's repositories, so the picker (both modes — Open Project and Add Existing Repository) also renders a **repository-access footer** built from `getAccountStatus()`:

| Affordance                | Source                      | Effect                                                                        |
| ------------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| One link per installation | `installations[].manageUrl` | Opens that installation's repository-access settings on GitHub (new tab)      |
| "Another account…"        | `appInstallUrl`             | Installs the App on an account that has none                                  |
| Refresh                   | —                           | Re-runs `listRepos` + `getAccountStatus` in place, without closing the dialog |

The footer is omitted entirely when the status is unknown or nothing is linkable (a platform without `getAccountStatus`, a failed hydrate, or installations that report no `manageUrl` and no install URL) — Studio never renders a dead access link.

The `project.json` file is **required** for project-level features. Studio can still open individual `.json` files for standalone component editing (see §4.3).

### 4.2 Project Open Flow

```
User clicks "Open Project"
        │
        ├─── openProjectPicker: "repo-list" (Cloud): Studio's repository picker
        │    → listRepos → write-access repos, Jx-tagged first → user picks
        │    → importProject → { root } → opens via the recent-projects path
        │    (openProject() is never called)
        ▼
platform.openProject()
        │
        ├─── Desktop: Utils.openFileDialog({ allowedFileTypes: "json", canChooseFiles: true })
        │    → user picks project.json → read + parse → derive project root from parent dir
        │
        └─── Dev server: showDirectoryPicker()
        │    → user picks folder → read project.json from dir → parse + validate
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

> **Status: Pending.** Current builds have no user-facing entry point into standalone single-file editing — Studio always opens a project (`project.json`), and documents open inside that project context. The `build.format: "single"` project option is reserved for this workflow but currently unused. The behavior below is the design target.

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
  projectConfig: {/* parsed project.json */},
  dirs: new Map(), // Cached directory listings
  expanded: new Set(), // Expanded tree nodes
  selectedPath: null,
  searchQuery: "",
};
```

### 4.5 Project Create Flow

> **Status: Implemented.**

A new project is written **only** where the user said to put it. No backend picks a destination on its own, and none falls back to its own root — an unspecified destination is an error, not a default.

**The wizard is two steps, and the second collects identity only.** Step 1 (_Choose a starting point_) offers the starter gallery — with one **Start from scratch** card at its end for the minimal scaffold — plus the Import and Agent sources on their own tabs. Step 2 (_Name your project_) collects the project name and the destination, and nothing else: the site's URL, its deployment adapter and its design tokens are project settings, editable for the life of the project, so they are not creation-time decisions. **Cancel is available on both steps**, alongside the underlay, `Escape` and the header close button; dismissing the modal while an import is streaming aborts the run rather than trapping the user behind it.

`StudioPlatform.createDestination` declares which kind of destination the platform takes, and the New Project modal renders the matching fields on its Name step:

| `createDestination` | Platforms           | Fields collected                            | `createProject({ destination })`                             |
| ------------------- | ------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `"path"`            | Desktop, dev server | **Location** (absolute parent), folder name | `{ kind: "path", parent }` → project at `parent/<directory>` |
| `"repo"`            | Cloud               | **Owner**, **Repository**, **Visibility**   | `{ kind: "repo", owner, repo, private }`                     |

```
User fills the Parameters step (name, destination, slug)
        │
        ├─── createDestination: "path"
        │    Location field, prefilled by nothing — required.
        │    Browse… renders only when the platform implements pickDirectory()
        │      ├── Electrobun desktop: native Utils.openFileDialog
        │      ├── NixOS chromium desktop: native XDG desktop portal
        │      ├── Dev server: showDirectoryPicker(), path recovered via a marker file (§8.2.1)
        │      └── A browser without the File System Access API: omitted — the path is typed
        │
        └─── createDestination: "repo"
             Owner picker over getAccountStatus().installations + listRepos() owners
             (free-text when neither is available), repository name, visibility
        ▼
platform.createProject({ …, destination })
        │
        ├─── Desktop: RPC → session refuses a non-"path" or relative destination,
        │    then scaffolds at resolve(destination.parent, directory)
        ├─── Dev server: POST /__studio/create-project → 400 without a destination;
        │    the parent is checked with assertCreatableParent (specs/server.md §4.2)
        └─── Cloud: POST /api/v1/projects { owner, repo, private, … } → the repo is
             created under the chosen account, never a server-side default
        ▼
Returns { root, config } and the modal opens it
```

A live preview under the fields shows the resolved destination (`/home/you/Sites/my-site`, or `acme/my-site`) before anything is written.

**Every created project is a git repository.** A scaffold that is not under version control has no undo for its first destructive action, and nothing in the app says so. On the create path — every source, including Import and Agent — Studio therefore binds the backend to the new root (`activate`), reads `gitStatus`, and runs `gitInit` when the tree is not already a repository. It is skipped entirely on `createDestination: "repo"` platforms, where the project _is_ a repository by construction, and a git failure is reported without failing the create: the project that was written stays written.

**Import shares this destination.** The Import tab is one of the three New Project sources, so it collects the same Location field and sends the resolved absolute path as `ImportSiteOptions.directory`. A relative directory reaching a backend means a caller skipped the field and is refused.

---

## 5. Backend API Contract

The Backend API Contract defines the operations that any Studio backend must support. The current `@jxsuite/server` endpoints map directly to these operations. Other backends (ElectroBun Bun process, cloud API) implement the same operations through their own transport.

### 5.1 Canonical Route Table

The canonical, complete list of backend operations is the `STUDIO_ROUTES` table in `packages/protocol/src/routes.ts` — roughly 60 routes, each carrying its method, literal dev-server path, core-vs-optional flag, one-line contract summary, and (for optional routes) a `degradation` note. A generated human-readable reference is published in the docs (`docs/extending/embedding/backend-protocol.md`). This spec no longer duplicates the table.

Conventions:

- Paths are the dev server's literal `/__studio/*` endpoints; transport-mapped backends (RPC bridges, gateway prefixes) preserve the sub-path and the request/response shapes, which live in `@jxsuite/protocol` alongside the table.
- `STUDIO_PROTOCOL_VERSION` bumps when a route's shape changes incompatibly.
- File search has no dedicated endpoint: `GET /__studio/files?glob=<pattern>` searches matching files project-wide (the same route that lists a directory with `?dir=`), backing `searchFiles()`.

A few illustrative rows (see the table for the rest):

| Operation           | `@jxsuite/server` endpoint      | PAL method                 |
| ------------------- | ------------------------------- | -------------------------- |
| List directory      | `GET /__studio/files?dir=`      | `listDirectory(dir)`       |
| Search contents     | `GET /__studio/files?glob=`     | `searchFiles(query, exts)` |
| Read file           | `GET /__studio/file?path=`      | `readFile(path)`           |
| Write file          | `PUT /__studio/file?path=`      | `writeFile(path, content)` |
| Rename file         | `POST /__studio/file/rename`    | `renameFile(from, to)`     |
| Find references     | `GET /__studio/references`      | `findReferences(target)?`  |
| Discover components | `GET /__studio/components?dir=` | `discoverComponents(dir)`  |
| Realtime co-editing | `GET /__studio/collab` (WS)     | `collab(docPath)`          |

### 5.2 Project Operations

| Operation        | `@jxsuite/server` endpoint       | PAL method                              |
| ---------------- | -------------------------------- | --------------------------------------- |
| Open project     | N/A (client-side dialog)         | `openProject()`                         |
| Project metadata | `GET /__studio/project`          | Derived from `ProjectHandle`            |
| Create project   | `POST /__studio/create-project`  | `createProject({ destination })` (§4.5) |
| Pick a folder    | `GET /__studio/locate-directory` | `pickDirectory?()` (§8.2.1)             |

### 5.3 Code Services

| Operation   | `@jxsuite/server` endpoint   | PAL method                       |
| ----------- | ---------------------------- | -------------------------------- |
| Format code | `POST /__studio/code/format` | `codeService("format", payload)` |
| Lint code   | `POST /__studio/code/lint`   | `codeService("lint", payload)`   |
| Minify code | `POST /__studio/code/minify` | `codeService("minify", payload)` |

`codeService(action, payload)` is a **required** member of the real interface, but it is null-returning: platforms without server-side code tooling implement it as a stub that resolves `null`, and callers treat a null result as "no service available" (editors skip format-on-open/save and show no lint markers). The three routes are correspondingly optional in `STUDIO_ROUTES`, with those degradations recorded on each entry.

### 5.4 Runtime Services

| Operation               | `@jxsuite/server` endpoint | Caller                    |
| ----------------------- | -------------------------- | ------------------------- |
| Resolve $prototype/$src | `POST /__jx_resolve__`     | The runtime (direct POST) |
| Execute server function | `POST /__jx_server__`      | The runtime (direct POST) |

These are **not** PAL methods — the runtime POSTs to `/__jx_resolve__` and `/__jx_server__` directly, on every platform. The dev server and the loopback project server (which token-gates them) serve the routes as plain HTTP. In the ElectroBun shell there is no HTTP backend for the webview, so the desktop adapter bridges them by patching `window.fetch` (`packages/desktop/src/platform.ts`): POSTs to those two paths are intercepted and forwarded over RPC to the Bun process (`jxResolve` / `jxServerFunction` handlers), and every other request falls through to the original fetch. The only PAL member in this area is the optional `resolveClass?`, which **Studio itself** (not the runtime) uses to resolve class-prototype configs through the same `/__jx_resolve__` pipeline (e.g. the pane context bar's route-param picker, in its "resolving with" popover).

Optional PAL members may not exist on all platforms. Studio feature-detects them by presence before calling:

```javascript
const platform = getPlatform();
if (platform.collab) {
  const handle = await platform.collab(docPath);
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

**Packaged static data.** In a packaged build, ElectroBun inlines the whole bun-side JS graph into `app/bun/index.js`, so `import.meta.dirname` in every inlined module resolves to `app/bun/` at runtime. Static data directories read relative to it — `@jxsuite/create`'s `template/` and `templates/`, and `@jxsuite/starters`' `registry.json` and `sites/` — must therefore be staged to those exact paths by `build.copy` in `electrobun.config.ts`. The `postBuild` hook verifies the staged bundle (including the studio view assets) and fails the build on any omission.

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

#### 8.2.1 Picking a destination folder

> **Status: Implemented.**

Choosing where a **new** project goes (§4.5) cannot use any of the three steps above: the folder is empty by definition, so there is no `project.json` to read and nothing for `/__studio/sites` to match. The handle still carries no path.

**This applies only to the plain dev-server browser session.** Every packaged build already has a real native folder dialog that returns a filesystem path directly, and keeps it — electrobun uses `Utils.openFileDialog`, and the NixOS chromium build uses the XDG desktop portal. A browser page has no such option, so it gets the fallback below rather than no **Browse…** button at all.

There, the handle is made to identify itself. Using the `readwrite` grant the picker just issued, `pickDirectoryPath` (`@jxsuite/studio/directory-picker`) tags the folder with a hidden `LOCATION_ID_FILE` — `.jx-loc-id`, defined in `@jxsuite/protocol` because the writer and the reader must agree on it — whose **contents** are a freshly generated 128-bit id, and asks the backend which directory carries that id:

```
Browse… (user gesture)
  → showDirectoryPicker({ id: "jx-new-project-location", mode: "readwrite" })
  → write <random 32-hex id> into <picked>/.jx-loc-id
  → GET /__studio/locate-directory?name=&id=
      ($HOME/.jx-loc-id holds the id → $HOME; else scan **/<name>/.jx-loc-id under $HOME)
      → on match: delete the tag, return the directory
  → finally: handle.removeEntry(".jx-loc-id")
```

**Identity is in the contents, not the filename.** A candidate whose `.jx-loc-id` does not hold this exact id is skipped, so neither a second folder sharing the basename nor a tag left behind by a crashed session can redirect a create — a fixed filename plus a content match is exact where a path shape is only probable. `name` still narrows the scan the way `/__studio/find-project` does. The backend deletes the winning tag as soon as it has served its purpose, and the client removes it too, so nothing is left in the user's new project folder on any path.

Every failure — no API, cancel, a read-only grant, a folder the backend cannot place — resolves `null`, which the modal treats identically to "no folder chosen" and leaves the Location field untouched. On a browser without the File System Access API the dev-server adapter omits `pickDirectory` entirely, so the button is hidden rather than dead, and the Location field is typed.

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

Because a cloud project _is_ a repository, the adapter sets `createDestination: "repo"` and the New Project modal collects a repository location — owner (personal account or organization), repository name, and visibility — instead of a folder (§4.5). The adapter forwards all three to the API, which resolves the owner against the session login to choose between the personal and organization creation endpoints. Nothing about the destination is defaulted server-side.

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

## Changelog

- **0.3.7-draft** (2026-08-11) — Name the pane context bar's resolving-with popover rather than the tab bar, which P8 deleted.
- **0.3.6-draft** (2026-08-03) — §3.1/§5.1: findReferences? PAL member and the GET /__studio/references route — the read side of the rename refactor's walker.
- **0.3.5-draft** (2026-08-02) — searchFiles, gitShow and openExternal RPC handlers registered on both launchers; styles/ staged into the packaged app.
- **0.3.4-draft** (2026-07-31) — List the cfConnect? PAL member in the Publish/identity family — it ships in StudioPlatform and backs the hosted Cloudflare OAuth flow, but the table omitted it.
- **0.3.3-draft** (2026-07-29) — PAL: launcher-only capabilities (updater, windowControls) stay off the StudioPlatform interface; adapter factories infer their return type and assert conformance instead of annotating it away.
- **0.3.2-draft** (2026-07-29) — The desktop shell routes Studio preview links to the user's default browser via Utils.openExternal (§3.5).
- **0.3.1-draft** (2026-07-25) — Repo picker gains a repository-access footer: per-installation manage links, install-on-another-account, and Refresh.
- **0.3.0-draft** (2026-07-25) — New Project requires a user-chosen destination: StudioPlatform gains the required createDestination declaration, createProject takes a required destination (path parent or repo owner/name/visibility), and §4.5 defines the create flow. No backend picks a location.
- **0.2.7-draft** (2026-07-24) — Cloud platform registers inside studio.js via a window.__jxCloud signal (single yjs for collab).
- **0.2.6-draft** (2026-07-24) — Document packaged static-data staging into app/bun (create templates, starters) and postBuild bundle verification.
- **0.2.5-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.2.4-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.2.3-draft** (2026-07-17) — Align spec.md, site-architecture, desktop, server, extensions with reality (`c61ba567`).
- **0.2.2-draft** (2026-07-13) — Run formatter (`9e776783`).
- **0.2.1-draft** (2026-05-20) — Run formatter (`8ba47930`).
- **0.2.0-draft** (2026-05-17) — Remove auto-detection script and update documentation for NixOS desktop runtime (`6b746644`).
- **0.1.6-draft** (2026-05-16) — Update desktop spec (`9453ea1f`).
- **0.1.5-draft** (2026-04-23) — Oxfmt (`af32c08c`).
- **0.1.4-draft** (2026-04-23) — Rebrand to jxsuite (`2897a4e8`).
- **0.1.3-draft** (2026-04-22) — Consolidate project config schema and rename as such (`e3523dbf`).
- **0.1.2-draft** (2026-04-16) — Landing site + working exports + release-it + linting (`a8409b5f`).
- **0.1.1-draft** (2026-04-15) — Rebrand to Jx / Jx Platform (`abc63f2d`).
- **0.1.0-draft** (2026-04-15) — Implement platform abstraction (`962ba588`).

---

_Jx Studio Desktop Architecture Specification v0.3.7-draft_
