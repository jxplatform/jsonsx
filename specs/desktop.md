# Jx Studio Desktop Architecture

## Platform Abstraction, Project Loading, and Component Scoping

**Version:** 0.3.18-draft
**Status:** Pending
**Updated:** 2026-08-22
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
12. [Standards Alignment](#12-standards-alignment)

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
| **Multi-window / shell** | `openProjectInNewWindow?`, `pickProject?`, `newWindow?`, `setWindowProject?`, `getProjectRoot?`, `getAppInfo?`, backend-persisted settings                                                                                     |

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

Each deployment target either pre-registers its adapter before Studio initializes, or hands Studio a signal to build one itself. The desktop init bundle pre-registers the RPC-backed adapter on `__jxPlatform`.

**Where the init bundle is loaded from is a declared slot, not a string replace.** `studioShellHtml({ boot })` (studio.md §11.2) emits the module tags ahead of the studio entry. Both hosts used to obtain this by an exact-string `replace()` on the shipped `index.html`'s script tag; only the cloud's checked that the replace had matched, so a whitespace change upstream would have produced a packaged desktop app with no platform registered at all — which then self-registers the dev-server adapter and fetches `/__studio/*` against a `views://` origin. The ordering constraint below is unchanged and is why `boot` is a list rather than a single hook. The cloud shell (the platform repo's `edit-init`) instead publishes a `window.__jxCloud` signal — the bound project, or `null` for the project-less hub — and lets the studio entry construct the adapter, so the cloud adapter (and the collab WebSocket client's `yjs` instance) lives **inside** the studio bundle rather than the shell; a second bundled `yjs` in the shell would break collab's cross-module `instanceof` checks. When nothing pre-registered, the studio entry resolves the default adapter — cloud when `__jxCloud` was signalled, else the dev server:

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
   - With a project already open on a platform that implements **both** `openProjectInNewWindow` and `pickProject`, Studio first asks **where** (§4.2a) and routes the answer
   - Otherwise Studio calls `getPlatform().openProject()` and the platform presents its native project opening flow
   - On success, Studio receives `{ config, handle }` and initializes the file tree

### 3.5 Leaving the Webview

**Both** desktop launchers register Studio's preview-navigation override
(`@jxsuite/studio/preview-navigate`) so a link clicked in Preview mode goes to the **user's default
browser** via an `openExternal` RPC, not to the editor's own window. Following a link in Preview
exists to see the page behave like the deployed thing — routing, history, devtools — and neither a
webview nor a frameless Chromium `--app` window is that; navigating either would also replace the
editor. `View: Open in Browser` (§9.5) and the sign-in redirect (§3.6) use the same seam.

The Bun side hands the URL over in two steps, and the second is not redundancy. ElectroBun's
`Utils.openExternal` comes from `electrobun/bun` — the module the chromium launcher is defined by
never loading — so when that is the only path, **every** URL on that build is silently dropped: a
preview click did nothing at all and sign-in reported "Could not open a browser". The fallback hands
the URL to the desktop's own opener (`xdg-open`, `open`, `rundll32 url.dll,FileProtocolHandler`) as a
single argument with no shell, and only for `http`, `https` and `mailto`. The scheme restriction is
the point of having a list at all: an opener resolves a scheme to whatever handler the desktop
registered for it, and the pages whose links arrive here are a project's own content.

Refusal is a **return value**, not an exception — `{ ok: false }` — because both steps can decline
without anything going wrong. A caller that branches only on a rejection loses the click, which is
what both platform adapters did before. On a genuine refusal Studio's own `window.open` default
applies.

### 3.6 Signing In

> **Status: Implemented.**

The desktop signs in to a provider with the **loopback redirect** of
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) §7.3, protected by
[PKCE](https://www.rfc-editor.org/rfc/rfc7636). The browser Studio keeps GitHub's device flow, and
must: it has no loopback server to redirect to, and GitHub's device endpoints send no CORS headers,
so the page cannot reach them either.

**The device flow is the wrong tool for a desktop app.** RFC 8628 designed it for clients that
cannot show a browser or take typed input. A desktop app has both, and paying that price anyway
means the user copies a code between two windows while the app polls a token endpoint on a timer.

Four properties are load-bearing, and each is a real attack or a real failure if dropped:

| Property                                                          | Why                                                                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The redirect host is the literal `127.0.0.1`, never `localhost`   | §8.3 — a name resolves, and a `hosts` entry or a resolver answering `::1` sends the code somewhere the app is not listening |
| `S256`, never `plain`                                             | The code is the whole credential for a client with no secret; `plain` puts the verifier in the authorization request        |
| `state` is unguessable, single-use, and compared in constant time | Any local page can navigate a browser to the callback; without this the app adopts an attacker's account                    |
| The provider's page opens in the **user's own browser**           | §8.12 — an embedded webview can read what the user types into the provider's login form, and carries no existing session    |

**No client secret is sent.** A desktop app cannot keep one (§8.5): shipping it puts it in every
copy of the binary, where it is a secret in name only. The PKCE verifier is what authenticates the
exchange.

**The callback route is exempt from the project server's token gate, and only from that.** The
provider redirects the user's browser to the `redirect_uri` it was given, and a page cannot append a
secret to a URL it does not compose — a token gate there would make the flow impossible rather than
safe. The Host check and Fetch Metadata still apply (§4.2 of `server.md`), and an IdP redirect is
exactly the one cross-site shape the strict policy admits: a top-level GET document navigation. The
callback page carries `Referrer-Policy: no-referrer`, because the authorization code is in that
request's query string until it is exchanged.

**Where the token rests.** In the app's own config directory, in a file written owner-only
(`0600`), **not** in `localStorage` and **not** in the settings store — the settings store is handed
to the webview wholesale by `getSettings`. The RPC surface answers _whether_ a token exists and
performs a sign-in; it never returns the store. The limitation is stated rather than hidden: the
file is plaintext, and another process running as the same user can read it. The OS keychain is the
right answer and a native dependency per platform; this is strictly better than a browser storage
entry and no better than that.

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
        │
        ├─── A project is open AND the platform has openProjectInNewWindow + pickProject:
        │    ask WHERE first (§4.2a). "New Window" never reaches openProject().
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

### 4.2a Where the Project Opens

> **Status: Implemented.**

A window holds one project, so opening another is a question with two answers, and Studio asks it whenever both are available: **This Window** or **New Window**, with the open project named in the prompt.

**The question is only asked where it can be honoured.** That takes two PAL members, not one:

| Member                   | What it provides                                                              |
| ------------------------ | ----------------------------------------------------------------------------- |
| `openProjectInNewWindow` | Somewhere else to open into                                                   |
| `pickProject`            | An answer to _which project_ that does not bind **this** window to the answer |

`openProject()` picks **and binds** — the platform re-roots the calling window's session as part of presenting its dialog. That is correct for This Window and unusable for New Window, where the asking window must be left exactly as it was. A platform with only `openProjectInNewWindow` cannot carry out either answer faithfully, so no choice is offered and Open Project behaves as it does with one window.

```
"New Window"
        │
        ▼
platform.pickProject()            → { root, name } | null   (binds nothing, anywhere)
        │                              │
        │                              └── null (cancelled): nothing opens, nothing is reported
        ▼
platform.openProjectInNewWindow(root)
        │
        ▼
Returns { focused }
        │
        ├─── focused: false — a window was created for the project; it loads the project itself
        │    and adds its own recent-projects entry
        │
        └─── focused: true — a window already had this project and was raised instead
        ▼
Studio reports what happened. The asking window's project, tabs and backend binding are untouched
on every branch above.
```

**The outcome is reported, never the intent.** The three results — opened here, opened in a new window, raised an existing window — are distinguishable, and a cancelled picker is silent. Announcing the chosen target instead produces reports of things that did not happen: "Opening the project in a new window…" over a dismissed file dialog, or over a window that merely came to the front.

**An empty window is its own verb.** `newWindow` opens a welcome window with no project, and it is the `view.newWindow` command (`Cmd/Ctrl+Shift+N`, gated on the same multi-window capability every member above is) — not a menu item. It was a menu item, and only ElectroBun's native application menu had it, so on a launcher whose window has no menu bar the member existed on the platform and could not be run. The native menu keeps the item and **claims no accelerator**: a chord with two owners fires twice, which is two welcome windows from one press.

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

> **Status: Implemented.** Both halves are specified. The route table is canonical and complete,
> and the failure shape is RFC 9457 `application/problem+json` from the `PROBLEM_TYPES` registry in
> `@jxsuite/protocol` — one table, generated into the docs beside the routes, so a backend
> implementer reads the failure vocabulary in the same breath as the success one. `server.md` §4.3
> holds the reasoning, including the three surfaces that deliberately stay 200.

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
┌───────────────────────────────────────────────────────────────┐
│  One window = one launcher process                            │
│                                                               │
│  ┌────────────────────────┐  HTTP + WS  ┌───────────────────┐ │
│  │  Bun launcher          │◄───────────►│  Chromium --app   │ │
│  │  createProjectServer() │             │  @jxsuite/studio  │ │
│  │  one ProjectSession    │             │  chromium/        │ │
│  │  fs watcher            │             │   platform.ts     │ │
│  └───────────┬────────────┘             └───────────────────┘ │
└──────────────┼────────────────────────────────────────────────┘
               │  <data>/jx-studio/windows/<pid>.json
               ▼
      ┌────────────────────┐
      │  window registry   │  ← every other launcher on this machine
      └────────────────────┘
```

The backend is `createProjectServer()` from `@jxsuite/server` — the same loopback-bound factory
each ElectroBun window stands up (§7.1), with the same token gate, the same `/__studio__/` asset
namespace and the same WS-RPC dispatch. It is **not** the dev server, and Studio does **not**
register the dev-server adapter: `packages/desktop/src/chromium/platform.ts` is this launcher's own
PAL implementation, translating each member into a WS request against `chromium/index.ts`'s handler
map. `packages/desktop/tests/_rpc-parity.ts` reads the request names back out of `rpc-schema.ts` and
fails when either launcher declares one it does not answer.

The WS carries traffic in both directions. Frames with an `id` answer something the shell asked;
frames with a `method` and **no** `id` are the launcher speaking first (`ProjectServerHandle.push`),
which is how filesystem events reach the sidebar and how a focus request reaches a window.

### 9.2 Launcher (`chromium/index.ts`)

The entry point performs, in order:

1. Resolves the project root: the first positional argument, else `JSONSX_PROJECT_ROOT`, else the
   working directory **but only when it holds a `project.json`** — unless `JX_STUDIO_NO_PROJECT`
   marks it a welcome window (§9.4). A root that was named is taken at its word; the one nobody
   typed has to prove itself, because the launcher is also started from a desktop entry and from a
   shell sitting anywhere. Adopting a directory that is not a project bought nothing — the shell
   shows the welcome screen either way, since `probeRootProject` reads the same `project.json` —
   and cost a recursive filesystem watch of, in the reported case, the whole home directory
   (what such a watcher will and will not descend into is `server.md` §3.1)
2. **Raises an existing window instead of opening a second one** for a project already open (§9.4)
3. Locates a Chromium binary via `CHROMIUM_BIN` or PATH (`chromium`, `chromium-browser`,
   `google-chrome`, `google-chrome-stable`); this binary is also the import pipeline's browser
4. Starts `createProjectServer()` on an ephemeral loopback port, and hosts the sign-in redirect on it
5. Points the session's filesystem-event sink at the server's push channel, so the sidebar is live.
   **Registering the sink is what starts the watcher, and the session watches a project or nothing
   at all:** with no `project.json` at the root it logs one line and declines, because that is the
   same root `probeRootProject` reports as "no project" — a recursive watch of it would be a scan
   of a user's directory tree on behalf of a project the window is not showing. Nothing is lost by
   waiting, since every way a project can arrive (`openProject`, `createProject`,
   `setWindowProject`) re-roots the session and arms the watcher then
6. Publishes itself in the window registry and starts watching for focus requests
7. Launches Chromium with app-mode flags:
   - `--app=<serverUrl>/__studio__/index.html?token=<rpcToken>` — frameless window, gated surface
   - `--no-first-run --no-default-browser-check` — suppress first-run prompts
   - `--window-size=1400,900`
   - `--user-data-dir=<profile>` — this window's profile (§9.4)
   - `--ozone-platform=wayland --enable-features=UseOzonePlatform` — when `WAYLAND_DISPLAY` is set
8. Leaves the registry and exits when the browser window closes

### 9.3 Nix Package

The flake's `packages.default` produces a fully sandboxed NixOS package:

- **Build dependencies** are fetched via [bun2nix](https://github.com/nix-community/bun2nix), which generates a `bun.nix` lockfile mapping all packages to fixed-output derivations — no network access needed during build
- **`bun.nix` auto-refresh:** The root `package.json` postinstall script runs `bun2nix -o bun.nix` after every `bun install`, keeping the nix lockfile in sync with `bun.lock`
- **Build phase** runs `bun run build` (compiler, runtime, studio, schema) and `pre-build.ts` (bundles the studio init bridge and copies assets)
- **Install phase** copies `packages/`, `extensions/` and `node_modules` into the nix store with plain `cp -r`, then deletes dangling symlinks (`find … -xtype l -delete`) rather than dereferencing with `cp -rL`. The prune is why `packages/desktop/tests/nix-bundle-completeness.test.ts` exists: it reads the copied directories back out of `package.nix` and asserts every `@jxsuite/*` dependency of the desktop app lands under one of them, after `extensions/parser` was once pruned out of the bundle silently
- **Wrapper** creates a `jx-studio` binary that runs `bun run packages/desktop/src/chromium/index.ts` with `CHROMIUM_BIN` and `JX_STUDIO_ASSETS` pre-set to nix store paths. The first positional argument is the **project root**; there is no flag surface

**The desktop entry and the window have to agree.** A taskbar or dock does not read the process,
the title or `--class`: it takes the window's Wayland `app_id` (X11: `WM_CLASS`) and looks for an
entry claiming it. Two things were in the way, and each hid the other:

- The entry was installed through `desktopItems`, which takes the **store path's basename** — so it
  shipped as `<hash>-jx-studio.desktop`, an id that changed with every rebuild. It is installed by
  hand at a fixed name now.
- Chromium derives an `--app` window's id from the shell URL and the profile directory and
  **ignores `--class`** — measured across two ports and two `--user-data-dir` values, all producing
  `chrome-127.0.0.1____studio___index.html-Default`, and there is no switch to override it
  (`--wm-class-name` / `--wm-class-class` are Electron's, and absent from the binary).

So the entry declares that derived string in `StartupWMClass`, which makes a file in
`packages/desktop/` depend on a URL composed in `chromium/index.ts`. `chromium/app-id.ts` owns the
derivation and the shell path the launcher builds the URL from, and the test beside it asserts the
entry carries exactly what the launcher produces — because the failure mode is silent. Nothing
errors; the icon is a generic square, and everything else about the app still works, which is why
it survived in the app launcher (which reads the file, never the window) while the taskbar showed
nothing.

**Which ref a consumer gets.** `packages/desktop/package.nix` builds `src = lib.cleanSource ../..`
— whatever tree was fetched — so the ref names the release. `main` is the development trunk and
gives the tip; **`release` holds only released code**, advanced by CI to each `desktop-v*` tag once
that tag has both produced its installers and passed a real `nix build`. A NixOS user therefore
pins the branch, not the trunk:

```
$ nix run github:jxsuite/jx/release
$ nix build github:jxsuite/jx/release && ./result/bin/jx-studio [project-root]
```

Locally, `nix build` (no ref) builds the working tree, which is what a contributor wants.

**And the consumer downloads it.** The release publishes `packages.<system>.default` to
`https://jxsuite.cachix.org`, and the flake's own `nixConfig` names that cache, so
`nix run github:jxsuite/jx/release` fetches the app rather than producing it. What is published is
essentially one store path. Everything else in the runtime closure — Chromium, Bun, glibc — is
already on `cache.nixos.org`, and any path carrying a cache's signature is filtered out of the
push, so what remains is precisely the `bun install` plus `bun run build` a user would otherwise
run. Their build-time inputs are never fetched either: Nix does not realise the inputs of a
derivation whose output it can substitute, which is why the ~1000 npm tarball derivations `bun.nix`
pins do not have to be published for the substitution to be complete.

The push is best-effort by design — a cache is an optimisation, and failing it must not fail the
job `release` advances behind, whose worst case is the behaviour that preceded the cache. What is
not best-effort is **noticing**. `verify-cache` runs after the branch moves and asks two things of
the released ref: does the cache hold the path evaluation produces, and does `nix build
--max-jobs 0` — substitute or fail — succeed against `github:jxsuite/jx/release`. Either answering
no opens an issue. The second question is also the only check anywhere that the store path CI
published is the one a consumer's flake fetch evaluates to; CI builds a git checkout and a user
builds a GitHub tarball, and nothing else in the pipeline would notice if those stopped agreeing.

Nix honours a flake's `nixConfig` substituters only for a user in `trusted-users`, so an
unprivileged NixOS account ignores the cache and builds from source anyway. That is a property of
Nix rather than of this packaging, and the install page carries the `nix.settings` form that
survives it.

`release` never advances to a commit whose flake does not build: `.github/workflows/nix.yml` builds
`.#default` at the tag and asserts the wrapper's `CHROMIUM_BIN` and `JX_STUDIO_ASSETS` resolve, and
the branch moves only if that succeeds. When it does not, the branch stays where it is and an issue
is opened — a stale ref that works beats a fresh one that does not. The same workflow runs on any
pull request touching `flake.nix`, `bun.nix`, `bun.lock` or `packages/desktop/**`, which is the
first time the flake has been built by CI at all.

**Both architectures are built; only one is a gate.** `meta.platforms` has always claimed
`aarch64-linux`, and nothing had ever built it — the `forThisHost` filter that trims `bun.nix` to
the host's `os`/`cpu` had only been exercised on x86_64. The release therefore runs a second leg on
an arm runner, and that leg is **advisory**: it is absent from `advance-release-branch`'s `needs`,
because a first-ever aarch64 failure freezing `release` would strand every x86 user over an
architecture nobody has received yet. It becomes a gate once it has been green across several
releases.

**The workflow also runs on pushes to `main`, and that trigger is about the cache rather than the
check.** A GitHub Actions cache is branch-scoped: a pull request may read the default branch's
cache, never another pull request's. With no run on `main` there is no base cache to inherit, so
each PR would refetch from scratch the roughly one thousand fixed-output npm tarball derivations
`bun.nix` pins — the half of the closure `cache.nixos.org` does not carry and never will, because
those derivations exist only here. A release-PR merge consequently builds twice, once through the
`push` trigger and once through release-please's `workflow_call`; they sit in different concurrency
groups, and the `push` leg is what leaves `main` warm for the next PR.

### 9.4 Windows Are Processes

> **Status: Implemented.**

An ElectroBun window is a `BrowserWindow` inside one process, so its window manager is a `Map`
(§7.1). Chromium owns its own browser process, and the only thing that lives exactly as long as one
`--app` window is the launcher that started it — so **on this build a window is a process**, and
`newWindow` / `openProjectInNewWindow` spawn another launcher rather than another object.

That makes the window list the one thing a `Map` cannot be: an answer that spans processes. It is a
directory of one small owner-only file per window, named for its pid:

```
<data>/jx-studio/windows/<pid>.json     ← written and deleted by that window, nobody else
<data>/jx-studio/windows/<pid>.focus    ← written by ANOTHER window to ask this one forward
```

**One writer per file is the whole concurrency design.** Nothing read-modify-writes a shared
document, so two launchers starting at the same instant cannot lose each other's row, and a launcher
that dies without cleaning up leaves a row whose pid no longer resolves — pruned by the next window
to read the directory, with no daemon to have missed the death. `JX_STUDIO_WINDOWS_DIR` relocates
the store, which is what keeps a test run out of the real user's windows.

**A focus request is a file, not a signal.** A pid the OS has recycled would receive a signal meant
for a process that no longer exists, and `SIGUSR2` terminates a process that installed no handler.
A file only the real launcher watches for is inert to anyone else. The request is consumed before
the window is raised, so a window asked twice comes forward twice.

**Raising is the page's job.** Nothing on the Bun side can bring a Chromium `--app` window forward,
so the launcher relays the request to its shell as a `focusWindow` push and the page calls
`window.focus()`. A window manager that refuses the raise leaves the window where it is.

**Every window needs a profile directory of its own**, because Chromium's process singleton is keyed
on it: two windows sharing one directory would be one browser process, and the second launcher's
window would be handed to the first launcher's browser pointing at a server about to die. A
project's window uses `<root>/.jx/chromium-profile`, so its Studio layout, theme and open tabs
survive a restart; a welcome window has no project to key on and takes the lowest `welcome-<n>` slot
no live window is using. The parent chooses the child's directory (`JX_STUDIO_PROFILE_DIR`) because
only the parent can see which ones are taken.

**Dedupe is by normalized root** — resolved, symlinks followed, case-folded on Windows — and it
applies at three points: launching for a project already open (which raises that window and exits),
`openProjectInNewWindow`, and `setWindowProject`. The third excludes the calling window, so
re-rooting never dedupes against itself.

### 9.5 What This Build Does Not Implement, and Why

Two PAL families are absent on purpose, and their absence is a claim recorded in
`CHROMIUM_RPC_EXEMPT`:

- **The self-updater.** This build is installed and replaced by whatever packaged it. It has no feed
  to check, so it answers the About screen through `appInfo` — version, channel (`system` when the
  Nix wrapper's `JX_STUDIO_ASSETS` is set, `development` otherwise), commit — and reports **no**
  update status rather than an "Up to date" it never verified. ElectroBun answers the same request
  from its updater, so the About screen has one shape and each launcher fills in only what it knows.
- **Client-side window decorations.** Studio draws minimize/maximize/close only when the launcher
  exposes `windowControls`, which ElectroBun does because its `BrowserWindow` is frameless. A
  Chromium `--app` window is decorated by the desktop environment, and a second set of buttons
  inside the page would minimize and close nothing.

Everything else the ElectroBun launcher implements, this one implements: `buildSite` behind
`View: Open in Browser`, `subscribeFileEvents` behind the live sidebar, `findReferences`,
`importSite`, the data and secrets surfaces, the native folder and project pickers (via the XDG
desktop portal, §8.2.1), and sign-in (§3.6).

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

- [x] Implement `chromium/index.ts` launcher (project server + Chromium `--app`)
- [x] Wayland support via `--ozone-platform=wayland` auto-detection
- [x] Sandboxed `nix build` via bun2nix (no `__noChroot`, no network at build time)
- [x] `makeWrapper` producing `jx-studio` binary with bundled Chromium and Bun
- [x] Auto-refresh `bun.nix` via postinstall hook
- [x] Its own PAL adapter over `createProjectServer`, not the dev-server adapter (§9.1)
- [x] Multi-window through the cross-process window registry (§9.4)
- [x] Live sidebar sync and `View: Open in Browser`, over the server-to-client push channel (§9.1)
- [x] About-screen build info via `appInfo`, with no update status it cannot verify (§9.5)

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

## 12. Standards Alignment

External standards this specification binds itself to. Vocabulary and cell grammar: [`standards.md`](./standards.md). ElectroBun and Chromium are implementations rather than standards, so §7–§9 cite nothing.

| Standard                                           | Class        | Binds | Evidence                                                                                                                                                                                            | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) | **Subset**   | §5    | packages/protocol/src/problem.ts, packages/protocol/src/problems.ts, packages/protocol/tests/problem.test.ts, packages/studio/src/platform-errors.ts, packages/studio/tests/platform-errors.test.ts | The contract now defines one failure shape, so the platform layer carries one reader instead of five: `problemDetail` reads a problem's `detail`, the legacy `error`, then the type's `title`. A problem's `type` **is** the structured error code the UI already branched on — `problemSlug` derives it and `installUrl` is the extension member its type documents. Absent: `instance`, and the WebSocket RPC envelope, which is a frame rather than a response body. |
| [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) | **Adopted**  | §3.6  | packages/server/src/oauth-loopback.ts, packages/desktop/src/github-signin.ts, packages/server/tests/oauth-loopback.test.ts, packages/desktop/tests/github-signin.test.ts                            | The desktop signs in through a loopback redirect hosted on the project server: the literal `127.0.0.1` (§8.3), the provider's page in the user's own browser (§8.12), no client secret (§8.5), and a callback exempt from the token gate but not from the Host or Fetch Metadata checks. The browser Studio keeps the device flow, because a page has no loopback server to redirect to.                                                                                |
| [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636) | **Adopted**  | §3.6  | packages/server/src/oauth-loopback.ts, packages/desktop/src/github-signin.ts, packages/server/tests/oauth-loopback.test.ts, packages/desktop/tests/github-signin.test.ts                            | Every authorization-code exchange binds a verifier. `S256` only — `plain` is not implemented, and the test asserts the challenge is not the verifier rather than merely asserting the method string.                                                                                                                                                                                                                                                                    |
| [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) | **Rejected** | §3.6  | —                                                                                                                                                                                                   | because: the flow this would configure now exists, and the provider it talks to publishes no metadata document at either well-known URI. Discovery would be a request that always 404s, followed by the hard-coded endpoints below it. A second provider that does publish one is what would make this worth having.                                                                                                                                                    |
| [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) | **Rejected** | §3.6  | —                                                                                                                                                                                                   | because: Jx issues and validates no JWTs. The desktop holds an opaque provider access token, and the loopback server's own gate is a random per-server token compared in constant time. The strongest posture against the JWT BCP's failure modes — `alg: none`, unverified `kid`, confused audiences — is not having a JWT, and adopting one to be conformant would create every risk it then manages.                                                                 |

## Changelog

- **0.3.18-draft** (2026-08-22) — 3.3 the init bundle loads through a declared boot slot rather than an exact-string replace on the shipped document.
- **0.3.17-draft** (2026-08-22) — §9.2: the session watches a project or nothing — a root with no project.json is declined rather than scanned recursively.
- **0.3.16-draft** (2026-08-22) — §9.2: the launcher adopts its working directory as a project root only when that directory holds a project.json — a named root is still taken at its word.
- **0.3.15-draft** (2026-08-21) — §9.3: released builds are published to jxsuite.cachix.org and the flake names it, so a consumer substitutes jx-studio instead of building it; verify-cache proves that after each release. The release also builds aarch64-linux as an advisory leg beside the x86_64 gate, and nix.yml runs on pushes to main so pull requests inherit a warm Actions cache for the npm tarball derivations cache.nixos.org cannot serve.
- **0.3.14-draft** (2026-08-20) — §9.3: the desktop entry ships under a stable id and claims the app_id Chromium actually gives an --app window, so the taskbar/dock can resolve the brand icon.
- **0.3.13-draft** (2026-08-20) — Chromium launcher reaches PAL parity: its own adapter over createProjectServer (§9.1), multi-window through a cross-process window registry (§9.4), a server-to-client push channel behind live sidebar sync and focus, buildSite behind View: Open in Browser, appInfo for the About screen, and an OS-opener fallback so preview links and sign-in leave the app at all (§3.5, §9.5). New Window becomes the `view.newWindow` command rather than a native-menu-only item, and the native menu drops its duplicate accelerators (§4.2a).
- **0.3.12-draft** (2026-08-19) — §9.3 documents the release branch as the ref a Nix consumer pins, and the nix build that gates it; corrects the install phase, which has used cp -r plus a dangling-symlink prune and src/chromium/index.ts since before this text was written.
- **0.3.11-draft** (2026-08-16) — §3.6 the desktop signs in with an RFC 8252 loopback redirect and PKCE; the token rests in a 0600 credential store, not localStorage. RFC 8414 and RFC 7519 recorded Rejected as vacuous. Closes gap:native-oauth and gap:oauth-pkce.
- **0.3.10-draft** (2026-08-16) — §5 the contract's failure half is specified — one RFC 9457 registry; gap:backend-failure-contract closed.
- **0.3.9-draft** (2026-08-15) — Add §12 Standards Alignment; §5 marked Partial — the Backend API Contract specifies no failure shape.
- **0.3.8-draft** (2026-08-13) — Open Project asks where a project should open (§4.2a): New Window is routed through pickProject + openProjectInNewWindow, and the outcome is reported rather than the target.
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

_Jx Studio Desktop Architecture Specification v0.3.18-draft_
