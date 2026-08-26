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
  - packages/desktop/src/chromium/platform.ts
---

# Writing a platform adapter

A platform adapter is a plain JavaScript object implementing the `StudioPlatform` interface, registered once before Studio boots. Every backend-touching operation in Studio goes through the registered adapter: file I/O, project loading, git, component discovery, the AI proxy. Studio itself never fetches a backend URL directly. Write one when your host can't simply serve the HTTP protocol (see the [embedding overview](/docs/extending/embedding) for that decision).

The authoritative interface is `StudioPlatform` in `packages/studio/src/types.ts`. It is wider than the sketch in the desktop spec §3.1. The real interface adds git, packages, collaboration, the data surface, and publish members on top of the original file and project operations.

## The interface surface

Core members are required on every adapter. Grouped by family:

| Family          | Members                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity        | `id`, `projectRoot` (get/set), `canvasUrl?`, `documentBaseUrl?`, `assetSpace?`, `assetCapabilities?`                                                                                                           |
| Session/project | `activate`, `openProject`, `probeRootProject`, `createDestination`, `createProject`, `resolveSiteContext`                                                                                                      |
| Filesystem      | `listDirectory`, `readFile`, `writeFile`, `uploadFile`, `deleteFile`, `renameFile`, `createDirectory`, `locateFile`, `searchFiles`, `discoverComponents`                                                       |
| Git             | `gitStatus`, `gitBranches`, `gitLog`, `gitStage`, `gitUnstage`, `gitCommit`, `gitPush`, `gitPull`, `gitFetch`, `gitCheckout`, `gitCreateBranch`, `gitDiff`, `gitShow`, `gitDiscard`, `gitInit`, `gitAddRemote` |
| Packages        | `listPackages`, `addPackage`, `removePackage`                                                                                                                                                                  |
| Services        | `codeService`, `fetchPluginSchema`, `aiChatUrl`                                                                                                                                                                |

All paths passed into adapter methods are project-relative; translating them to whatever the backend expects (a server-root prefix, an absolute path, a repo path) is the adapter's job. A core member may still answer "not available" through its return type (`codeService` resolves `null` on platforms without code tooling), but the member itself must exist.

`uploadFile` is the one member that carries binary. It takes `string | File | Blob | ArrayBuffer`, and every caller (the image field's Upload button, a file dropped on the canvas or the Files panel, the Library) hands it whatever the browser gave them, usually a `File`. If your transport is HTTP you can post that body straight through. **If your transport serializes its arguments** (JSON over RPC or a WebSocket, as the desktop adapters do), a `File` becomes `{}` on the wire: base64-encode it in the adapter before the call and decode it in the backend. `@jxsuite/studio/base64` exports `toBase64` for exactly this, and it passes a `string` through untouched so callers that already hold base64 keep working.

It answers `UploadResult` (`{ path, size? }`), and **`path` is the answer, not an echo**. Report where the bytes really landed: a store that de-duplicates by content hash, appends a collision suffix, or normalizes a name writes somewhere other than the path it was asked for, and the reference Studio puts in the document has to name the file that exists. A backend that writes exactly where it was told still reports it, so no caller has to know which kind of backend it is talking to.

`documentBaseUrl` is the other declaration worth knowing about. The canvas renders in an iframe and resolves a component `$ref` by fetching it (`readFile` is not reachable from that realm), so **project files have to exist at a URL**. The default base is `<canvas origin>/<projectRoot>/`, which is already correct for any backend that serves the project tree from its web root: the dev server does, and so does the desktop's loopback server.

Set `documentBaseUrl` when your `projectRoot` is an **identifier instead of a served path**. Jx Cloud's is `owner/repo@branch`, so the default addressed nothing and every `$ref` fetch missed. Point it at whatever route serves your project tree, ending in `/`; Studio appends the project-relative path to it.

:::doc-warning
If your host answers a missing file with a single-page fallback (the app shell at **HTTP 200** where a 404 belongs), a wrong base does not fail cleanly. The fetch succeeds, and the renderer reports `Unexpected token '<', "<!doctype "…` from the JSON parser. Studio now names that case explicitly, but the cure is a base that resolves.
:::

`assetSpace` says what your ORIGIN answers for a **site URL**. A host whose files are perfectly reachable through `readFile` can still need this, because what decides it is what answers `GET /hero.jpg` on the document the canvas is running in.

Leave it absent when that origin already serves the published site URL space. The dev server and the desktop loopback both do, so neither declares anything and `/hero.jpg` resolves natively.

Set it to `"repo"` when nothing does, and set `documentBaseUrl` with it. `"repo"` is inert on its own, because a host that says its site URLs are wrong without saying what is right has told Studio nothing it can act on. Studio then resolves every authored reference to the **project file** it names and addresses that file under your base: `/hero.jpg` is `public/hero.jpg`, and a content entry's `./images/hero.png` is `content/posts/images/hero.png`. Both are real repository paths, so you need no `public/`→root mapping, no asset-mount mapping, and no route beyond the one already serving project files.

:::doc-note
A site URL is resolved the way a **build** would resolve it. The editing servers do it differently: `serveProjectFile` tries the project root before `public/`, so a file at `<root>/hero.jpg` loads at `/hero.jpg` in a dev preview and 404s on the deployed site. With no filesystem to probe, the canvas has to pick one answer, and the one that makes the preview agree with production is the build's.
:::

`assetCapabilities` declares what your backend will accept as an upload: `maxUploadBytes` and an `accept` string in `<input accept>` syntax. Both are optional and absence means "no declared limit": Studio will not invent one, because a limit it made up is a file the user cannot upload for no reason anyone can name. Declare a limit and Studio refuses oversized files before spending the round trip, naming the number, and narrows the file picker to your `accept`. Nothing widens it.

`createDestination` is a value your adapter declares: set it to `"path"` if your backend writes projects to a filesystem, or `"repo"` if a project is a remote repository. Studio uses it to decide which destination fields the New Project modal collects, and hands the answer back to `createProject` as `opts.destination`. **Your adapter must honor that destination and must not substitute one of its own**. A create with no usable destination is an error, not a cue to fall back to a default directory or account.

### Optional members and degradation

Everything else on the interface is optional, and each optional member maps to an optional protocol route whose `degradation` field describes exactly what Studio does without it. Omit what your backend can't support:

| Family             | Members                                                                                                                     | When absent                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Live sync          | `subscribeFileEvents`, `collab`                                                                                             | Sidebar is manual-refresh; editing is solo with file-level saves                                                                              |
| Install pipeline   | `installDependencies`, `dependenciesNeedInstall`, `packageVersions`, `setPackageVersions`                                   | Install/update affordances hide; the Packages table's **Latest** column stays empty; manifest-only edits still work                           |
| Catalogue/scaffold | `listProjects`, `listStarters`, `importSite`, `pickDirectory`, `gitClone`                                                   | Welcome-screen catalogue, starters, import, and clone flows hide; without `pickDirectory` the New Project **Location** field is typed by hand |
| Formats/schemas    | `listFormats`, `listExtensions`, `fetchProjectSchemas`, `formatAction`, `resolveClass`                                      | Only `.json` documents open; editors fall back to bundled schemas                                                                             |
| Data + secrets     | `dataConnections`, `dataConnectionTest`, `dataPush`, `dataRows`, row CRUD, `listSecrets`, `setSecrets`                      | The Data grid and connection/push/secret controls hide                                                                                        |
| Publish            | `cfConnection`, `cfConnect`, `cfApi`, `createPullRequest`                                                                   | Publish panel explains git-push publishing; PRs go via user token                                                                             |
| Site preview       | `buildSite`                                                                                                                 | **Open in Browser** reports that this target cannot build a preview                                                                           |
| Desktop shell      | `getAppInfo`, `openProjectInNewWindow`, `pickProject`, `newWindow`, `setWindowProject`, `getProjectRoot`, recents, settings | Single-window; recents and settings persist in `localStorage`                                                                                 |
| Cloud identity     | `getUser`, `getAccountStatus`, `listRepos`, `importProject`                                                                 | No signed-in identity or repository picker                                                                                                    |

Studio always checks for presence before calling an optional member, so an omitted member is never an error. The [protocol route reference](/docs/extending/reference/studio-routes) is the complete degradation catalogue.

:::doc-tip
**`buildSite` may build or may render, and it says which.** The contract is "produce something
browsable at real routes on an origin of your own, and name it in `url`" — not "run the compiler".
An adapter that cannot build at all (a hosted backend runs no project JS and has no bundler, image
pipeline or filesystem) can still serve the working tree as a site and let `@jxsuite/runtime`
assemble each page in the reader's browser. Report `mode: "live"` when it does, and Studio's toast
tells the author what they are looking at; omit `mode`, or send `"built"`, for compiler output. A
live preview carries no prerendered HTML, optimized images, islands, emitted `sitemap.xml`/`_headers`
or `timing: "server"` results — and, uniquely, it carries edits nobody has saved yet.
:::

:::doc-note
**`collab` probes before it connects, and the probe decides more than availability.** Both bundled adapters GET the collab URL once and pass the `protocols` it lists to the wire client, which offers one as `Sec-WebSocket-Protocol`. An adapter that skips the probe and opens the socket directly must offer no subprotocol at all: a client whose offer goes unechoed fails the connection outright ([RFC 6455 §4.1](https://www.rfc-editor.org/rfc/rfc6455#section-4.1)), so an unconditional offer breaks co-editing against every backend that predates negotiation. See [the backend protocol](/docs/extending/embedding/backend-protocol).
:::

### Capabilities beyond the interface

Your host may be able to do things no other host can. Keep those **off** `StudioPlatform` and let Studio feature-detect them on `globalThis.__jxPlatform`. That is how the desktop's `updater` and window controls work, and it is what lets the same Studio code run where they do not exist.

One consequence worth knowing before it bites you: annotating your factory's return type as `StudioPlatform` erases the extras from every caller, including your own tests. Let the type be inferred and assert conformance instead. That also stops the optional members you _did_ implement from reading as possibly-absent:

```typescript
export function createMyPlatform() {
  const platform = {/* … interface members …, plus your extras */};
  // On the identifier, not the object literal: a fresh literal gets excess property checks.
  return platform satisfies StudioPlatform;
}
```

A browser-hosted adapter can still offer `pickDirectory`: `@jxsuite/studio/directory-picker` exports `canPickDirectory()` and `pickDirectoryPath(locate)`, which drive `showDirectoryPicker()` and hand you the picked folder's `name` plus the random id it wrote into a hidden `.jx-loc-id` there. Your `locate` callback resolves that pair to an absolute path (the dev server does it with `GET /__studio/locate-directory`). Omit the member when `canPickDirectory()` is false, so Studio hides the button. One that always returns null leaves a dead button on screen.

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

The desktop app does exactly this with a four-line init bundle injected ahead of the Studio bundle:

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
2. The adapter presents its own picker (a native file dialog on desktop, `showDirectoryPicker()` in Chrome, a project list on cloud) and resolves the choice to a project root containing `project.json`.
3. It returns `{ config, handle: { root, name, projectConfig } }`, or `null` if the user cancelled (never throw for a cancel).
4. Studio initializes project state from the handle: file tree, component registry, expanded directories.

On a host that can hold several windows, step 1 has a question in front of it. A window holds one project, so with one already open Studio asks **This Window** or **New Window**, but only when the adapter implements `pickProject` alongside `openProjectInNewWindow`. `openProject()` picks _and_ binds: presenting the dialog re-roots the calling window's backend, which is right for This Window and fatal for New Window. `pickProject()` is the same picker with the binding left out: it resolves `{ root, name }` (or `null` for a cancel) and touches nothing, so Studio can hand the root to `openProjectInNewWindow(root)` and leave the asking window exactly as it was. Implement one without the other and Studio quietly stops asking, because it could not carry out the answer.

Two supporting members round out the flow. `activate(root)` tells the backend which project root subsequent operations (and static file serving) should resolve against. The dev-server adapter calls it whenever `projectRoot` is set. It must **reject when the backend refuses the root**, rather than resolving quietly: operations that carry no explicit directory resolve against the backend's own root, so a swallowed refusal leaves the session reading and writing the wrong tree. `probeRootProject()` runs at startup to auto-detect whether the backend's root is itself a project, powering the zero-click open in dev mode.

## Two real adapters

### Dev server (`packages/studio/src/platforms/devserver.ts`)

The reference adapter is a stateless wrapper over `fetch`: every member maps 1:1 to a `/__studio/*` route, and its only state is the active project root, which it prefixes onto outgoing paths and strips from responses (`serverPath`/`stripRoot`). Its `openProject` shows how client-side picking meets a server-side backend. The browser picks a directory, then the adapter matches it to a server path:

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

**Settings are written as patches.** `patchSettings({ set, remove })` changes only the keys it names and answers with the store as it then stands; a key named by neither must be left alone. That is a correctness rule and not an optimisation. A whole-map write means every writer implicitly claims the whole store, so a second window holding a different view of it silently overwrites the first. It also means a key your adapter has never heard of survives a write.

The desktop adapter translates the same interface into ElectroBun RPC: each member is a one-line `rpc.request.*` call into Bun-side handlers (`openProject()` is literally `return await rpc.request.openProject()`, backed by a native file dialog in the Bun process). Beyond the mapping, it patches `window.fetch` so the runtime's dev-proxy endpoints (`/__jx_resolve__`, `/__jx_server__`) also ride the RPC bridge, and it implements the desktop-only families: multi-window, backend-persisted recents and settings, `getAppInfo`.

### Desktop, Chromium build (`packages/desktop/src/chromium/platform.ts`)

The NixOS build runs Studio in a Chromium `--app` window and talks to its launcher over a WebSocket instead of ElectroBun's bridge, so it is a **second adapter over the same handler names**, one `request(method, params)` helper per member. It is a useful thing to read if you are writing your own: it implements the same optional families as the ElectroBun adapter, over a completely different transport, and the two are checked against one declaration (`packages/desktop/tests/_rpc-parity.ts`).

Two lessons from it generalize to any adapter:

- **A member you do not implement is a feature the user does not get, silently.** Studio probes for methods and does not ask what kind of host you are, so the launcher answered `buildSite` over RPC for months while its adapter never exposed the method. **Open in Browser** reported that this backend could not build a preview. If you add a backend handler, add the member in the same change.
- **Not every absent member is a gap.** This adapter deliberately omits the updater family (the system package manager owns updates, so there is no feed to report on) and `windowControls` (the desktop environment decorates the window, so Studio must not draw its own buttons). Omission is how you say "not here"; the alternative is a control that does nothing.

Its transport also carries messages the launcher sends **unprompted**: a frame with a `method` and no request id. That is how `subscribeFileEvents` is fed, and how another window asks this one to come forward. If your host can push, a subscription member is a local handler plus a dispatch line. No polling needed.

## Related

- [Embedding overview](/docs/extending/embedding): choosing between an adapter and the HTTP protocol
- [The backend protocol](/docs/extending/embedding/backend-protocol): the semantics your adapter must preserve
- [Protocol route reference](/docs/extending/reference/studio-routes): every route with optionality and degradation
