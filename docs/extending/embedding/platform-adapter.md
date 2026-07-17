---
title: "Writing a platform adapter"
description: "Implement the StudioPlatform interface for your host: core and optional members, registration before Studio boots, and the project-open flow."
spec:
  - desktop.md#3 # platform abstraction layer
  - desktop.md#4 # project loading
  - desktop.md#5 # backend API contract
code:
  - packages/studio/src/platform.ts
  - packages/studio/src/types.ts
  - packages/studio/src/platforms/devserver.ts
  - packages/desktop/src/platform.ts
---

# Writing a platform adapter

A platform adapter is a plain JavaScript object implementing the `StudioPlatform` interface, registered once before Studio boots. Every backend-touching operation in Studio — file I/O, project loading, git, component discovery, the AI proxy — goes through the registered adapter; Studio itself never fetches a backend URL directly. Write one when your host can't simply serve the HTTP protocol (see the [embedding overview](/docs/extending/embedding) for that decision).

The authoritative interface is `StudioPlatform` in `packages/studio/src/types.ts`. It is wider than the sketch in the desktop spec §3.1 — the real interface adds git, packages, collaboration, the data surface, and publish members on top of the original file and project operations.

## The interface surface

Core members are required on every adapter. Grouped by family:

| Family          | Members                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity        | `id`, `projectRoot` (get/set), `canvasUrl?`                                                                                                                                                                    |
| Session/project | `activate`, `openProject`, `probeRootProject`, `createProject`, `resolveSiteContext`                                                                                                                           |
| Filesystem      | `listDirectory`, `readFile`, `writeFile`, `uploadFile`, `deleteFile`, `renameFile`, `createDirectory`, `locateFile`, `searchFiles`, `discoverComponents`                                                       |
| Git             | `gitStatus`, `gitBranches`, `gitLog`, `gitStage`, `gitUnstage`, `gitCommit`, `gitPush`, `gitPull`, `gitFetch`, `gitCheckout`, `gitCreateBranch`, `gitDiff`, `gitShow`, `gitDiscard`, `gitInit`, `gitAddRemote` |
| Packages        | `listPackages`, `addPackage`, `removePackage`                                                                                                                                                                  |
| Services        | `codeService`, `fetchPluginSchema`, `aiChatUrl`                                                                                                                                                                |

All paths passed into adapter methods are project-relative; translating them to whatever the backend expects (a server-root prefix, an absolute path, a repo path) is the adapter's job. A core member may still answer "not available" through its return type — `codeService` resolves `null` on platforms without code tooling — but the member itself must exist.

### Optional members and degradation

Everything else on the interface is optional, and each optional member maps to an optional protocol route whose `degradation` field describes exactly what Studio does without it. Omit what your backend can't support:

| Family             | Members                                                                                                      | When absent                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Live sync          | `subscribeFileEvents`, `collab`                                                                              | Sidebar is manual-refresh; editing is solo with file-level saves  |
| Install pipeline   | `installDependencies`, `dependenciesNeedInstall`, `outdatedPackages`, `setPackageVersions`                   | Install/update affordances hide; manifest-only edits still work   |
| Catalogue/scaffold | `listProjects`, `listStarters`, `importSite`, `pickDirectory`, `gitClone`                                    | Welcome-screen catalogue, starters, import, and clone flows hide  |
| Formats/schemas    | `listFormats`, `listExtensions`, `fetchProjectSchemas`, `formatAction`, `resolveClass`                       | Only `.json` documents open; editors fall back to bundled schemas |
| Data + secrets     | `dataConnections`, `dataConnectionTest`, `dataPush`, `dataRows`, row CRUD, `listSecrets`, `setSecrets`       | The Data grid and connection/push/secret controls hide            |
| Publish            | `cfConnection`, `cfConnect`, `cfApi`, `createPullRequest`                                                    | Publish panel explains git-push publishing; PRs go via user token |
| Desktop shell      | `getAppInfo`, `openProjectInNewWindow`, `newWindow`, `setWindowProject`, `getProjectRoot`, recents, settings | Single-window; recents and settings persist in `localStorage`     |
| Cloud identity     | `getUser`, `getAccountStatus`, `listRepos`, `importProject`                                                  | No signed-in identity or repository picker                        |

Studio always checks for presence before calling an optional member, so an omitted member is never an error. The [protocol route reference](/docs/extending/reference/studio-routes) is the complete degradation catalogue.

## Registration

Registration is a module-level setter backed by a global, so an adapter can be registered from a separate script bundle that loads before `studio.js`:

```ts
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
```

The desktop app does exactly this — a four-line init bundle injected ahead of the Studio bundle:

```ts
// packages/desktop/src/init.ts — loaded before studio.js
import { registerPlatform } from "@jxsuite/studio/platform";
import { createDesktopPlatform } from "./platform";

registerPlatform(createDesktopPlatform());
```

If nothing has registered by the time Studio boots, it self-registers the dev-server adapter: `if (!hasPlatform()) registerPlatform(createDevServerPlatform())`. So an embedder that serves the HTTP protocol needs no registration code at all, and one that doesn't must win the race by loading its init script first.

## The project-open flow

Opening a project is the one flow the adapter owns end to end, because the picking UI is inherently platform-specific:

1. The user triggers **Open Project**; Studio calls `getPlatform().openProject()`.
2. The adapter presents its own picker — a native file dialog on desktop, `showDirectoryPicker()` in Chrome, a project list on cloud — and resolves the choice to a project root containing `project.json`.
3. It returns `{ config, handle: { root, name, projectConfig } }`, or `null` if the user cancelled (never throw for a cancel).
4. Studio initializes project state from the handle: file tree, component registry, expanded directories.

Two supporting members round out the flow. `activate(root)` tells the backend which project root subsequent operations (and static file serving) should resolve against — the dev-server adapter calls it whenever `projectRoot` is set. `probeRootProject()` runs at startup to auto-detect whether the backend's root is itself a project, powering the zero-click open in dev mode.

## Two real adapters

### Dev server (`packages/studio/src/platforms/devserver.ts`)

The reference adapter is a stateless wrapper over `fetch`: every member maps 1:1 to a `/__studio/*` route, and its only state is the active project root, which it prefixes onto outgoing paths and strips from responses (`serverPath`/`stripRoot`). Its `openProject` shows how client-side picking meets a server-side backend — the browser picks a directory, then the adapter matches it to a server path:

```ts
// openProject, abbreviated: match the picked directory to a server-known project
const sitesRes = await fetch("/__studio/sites");
const sites = await readJson<SiteEntry[]>(sitesRes);
const match = sites.find((s: SiteEntry) => JSON.stringify(s.config) === JSON.stringify(config));

if (!match) {
  // Project is outside dev server root — ask the server to find it by directory name
  const findRes = await fetch(`/__studio/find-project?name=${encodeURIComponent(dirHandle.name)}`);
  // …
}
```

### Desktop (`packages/desktop/src/platform.ts`)

The desktop adapter translates the same interface into ElectroBun RPC: each member is a one-line `rpc.request.*` call into Bun-side handlers (`openProject()` is literally `return await rpc.request.openProject()`, backed by a native file dialog in the Bun process). Beyond the mapping, it patches `window.fetch` so the runtime's dev-proxy endpoints (`/__jx_resolve__`, `/__jx_server__`) also ride the RPC bridge, and it implements the desktop-only families — multi-window, backend-persisted recents and settings, `getAppInfo`.

## Related

- [Embedding overview](/docs/extending/embedding) — choosing between an adapter and the HTTP protocol
- [The backend protocol](/docs/extending/embedding/backend-protocol) — the semantics your adapter must preserve
- [Protocol route reference](/docs/extending/reference/studio-routes) — every route with optionality and degradation
