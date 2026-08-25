/**
 * Studio Backend Protocol — the canonical route table. The dev server
 * (@jxsuite/server) is the reference implementation; every other backend
 * (desktop RPC bridge, cloud platforms) serves the same shapes, either at
 * these literal paths or through an equivalent transport. Optional routes
 * back optional StudioPlatform members — Studio degrades without them, as
 * described by each entry's `degradation`.
 *
 * @license MIT
 */

/** Bumped when a route's request/response shape changes incompatibly. */
export const STUDIO_PROTOCOL_VERSION = 1;

/**
 * Hidden file a browser-hosted Studio drops into a folder chosen with `showDirectoryPicker()` so
 * the backend can find it (specs/desktop.md §8.2.1). Its contents are a one-shot random id; the
 * backend matches on those contents, not on the filename, and deletes the file once it matches.
 *
 * Lives here because the writer (`@jxsuite/studio/directory-picker`) and the reader (the backend
 * serving `locateDirectory`) must agree on it, and this package is the contract both already
 * share.
 */
export const LOCATION_ID_FILE = ".jx-loc-id";

export type StudioRouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface StudioRoute {
  path: string;
  method: StudioRouteMethod;
  /** True when a backend may omit the route (its PAL member is optional). */
  optional: boolean;
  /** One-line contract summary. */
  summary: string;
  /** What Studio does when an optional route is absent. */
  degradation?: string;
}

const route = (
  method: StudioRouteMethod,
  path: string,
  summary: string,
  degradation?: string,
): StudioRoute => ({
  method,
  path,
  optional: degradation !== undefined,
  summary,
  ...(degradation === undefined ? {} : { degradation }),
});

/**
 * Every protocol route, keyed by a stable name. Paths are the dev server's literal `/__studio/*`
 * endpoints; transport-mapped backends (RPC, gateway prefixes) preserve the sub-path and shapes.
 */
export const STUDIO_ROUTES = {
  // ─── Session / project ────────────────────────────────────────────────────
  activate: route("POST", "/__studio/activate", "Bind the backend to a project root"),
  project: route("GET", "/__studio/project", "Root project metadata {name, root}"),
  projectInfo: route(
    "GET",
    "/__studio/project-info",
    "Probe a directory: {isSiteProject, projectConfig?, directories?}",
  ),
  resolveSite: route(
    "GET",
    "/__studio/resolve-site",
    "Resolve the owning site of a file path {sitePath, projectConfig?, fileRelPath?}",
  ),
  sites: route(
    "GET",
    "/__studio/sites",
    "Enumerate site projects [{config, path}] (backs listProjects)",
    "The welcome screen's Projects catalogue stays hidden.",
  ),
  findProject: route(
    "GET",
    "/__studio/find-project",
    "Locate a project directory by name outside the root",
    "openProject falls back to config-matching only.",
  ),
  locateDirectory: route(
    "GET",
    "/__studio/locate-directory",
    `Resolve the absolute path of a showDirectoryPicker() folder by the id in its ${LOCATION_ID_FILE}`,
    "The New Project Location field loses its Browse… button and is typed by hand.",
  ),
  createProject: route(
    "POST",
    "/__studio/create-project",
    "Scaffold a project at a caller-chosen destination → {root, config}",
  ),
  starters: route(
    "GET",
    "/__studio/starters",
    "Starter templates (StarterInfo[])",
    "The New Project picker offers only blank/templates.",
  ),
  importSite: route(
    "POST",
    "/__studio/import-site",
    "Clone a live website into a project; streams NDJSON progress",
    "The New Project Import tab is unavailable.",
  ),

  // ─── Filesystem ───────────────────────────────────────────────────────────
  files: route(
    "GET",
    "/__studio/files",
    "List a directory (DirEntry[]); with ?glob=<pattern>, search matching files project-wide",
  ),
  fileRead: route("GET", "/__studio/file", "Read a file's text content"),
  fileWrite: route("PUT", "/__studio/file", "Write a file's text content"),
  fileDelete: route("DELETE", "/__studio/file", "Delete a file"),
  fileUpload: route(
    "POST",
    "/__studio/file/upload",
    "Upload binary content to a path → UploadResult {path, size?}. `path` is the answer, not an " +
      "echo: a store that de-duplicates, suffixes, or normalizes names reports what it really wrote",
  ),
  /**
   * A project file as its own BYTES, at its own URL.
   *
   * `fileRead` answers `{ path, content }`, which is right for the editor and useless to the
   * renderer: `@jxsuite/runtime` resolves a component `$ref` with `fetch(url).then(r => r.json())`
   * and expects the DOCUMENT, and an `<img src>` cannot be a JSON envelope at all. So a backend
   * whose origin does not serve the site's own URL space serves this instead, declares `assetSpace:
   * "repo"`, and Studio addresses every project file under it.
   *
   * The path is appended to the prefix, so this is the one route whose `path` is a PREFIX rather
   * than a whole path. It was a textual assertion on both sides of the cloud seam before it was a
   * route; naming it here is what makes that assertion a contract.
   */
  documentRaw: route(
    "GET",
    "/__studio/raw/",
    "A project file as its own bytes, at its own URL — the mount a canvas renders against when " +
      "the editor origin does not serve the site's URL space. The project-relative path is " +
      "appended to this prefix",
    "The canvas cannot address project files by URL, so a host whose origin does not serve the " +
      "site URL space renders no component $refs and no images.",
  ),
  fileRename: route("POST", "/__studio/file/rename", "Rename/move (+ refactor report)"),
  references: route(
    "GET",
    "/__studio/references",
    "Where a file or a component tag is used (?path=&tag=, at least one) → ReferencesResult " +
      "{files, filesReferencing, refsTotal} — the read side of the rename refactor's own walker, " +
      "cached until the backend's watcher sees the tree move (backs findReferences)",
    'Usage counts are hidden: no "Used on N pages" in the inspector, no Selection: Find Usages, ' +
      "and delete/rename confirmations state no reference count.",
  ),
  locate: route("POST", "/__studio/locate", "Find a file by name → {path | null}"),
  collab: route(
    "GET",
    "/__studio/collab",
    "Realtime co-editing: a WebSocket upgrade speaking the @jxsuite/collab wire envelope (one " +
      "socket per project, documents multiplexed by path; y-protocols sync + project-level " +
      "awareness in lib0 binary frames — see @jxsuite/collab/envelope for the frame layout and " +
      "the docEpoch/doc-reset lifecycle). A plain GET (no Upgrade) answers {collab, protocols, " +
      "version} as the capability probe, and `protocols` is the subprotocol negotiation: the " +
      "client offers one of them as Sec-WebSocket-Protocol and the server echoes it, or the " +
      "client offers none when the server advertises none, because RFC 6455 §4.1 fails a " +
      "connection whose offer went unechoed.",
    "Realtime co-editing is unavailable; Studio edits solo with file-level saves",
  ),

  // ─── Documents / components / formats ─────────────────────────────────────
  components: route("GET", "/__studio/components", "Discover components (ComponentMeta[])"),
  cem: route(
    "GET",
    "/__studio/cem",
    "Custom-elements manifest of an npm dependency",
    "Dependency components lose prop/slot metadata.",
  ),
  formats: route(
    "GET",
    "/__studio/formats",
    "The project's format registry entries plus a sibling `extensions` array — per enabled " +
      "extension its manifest identity and project-section contributions (ExtensionsInfo[]; " +
      "backs listFormats and listExtensions).",
    "Only .json documents open (backs listFormats); descriptor-contributed settings sections " +
      "do not appear.",
  ),
  projectSchemas: route(
    "GET",
    "/__studio/project-schemas",
    "The project's generated entry documents (project.schema.json / document.schema.json), " +
      "PRE-BUNDLED into self-contained schemas — {project, document} (backs fetchProjectSchemas). " +
      "Regenerated on demand when missing or older than project.json.",
    "The JSON editor falls back to the bundled core schemas (extension sections get no " +
      "editor validation/completion).",
  ),
  format: route(
    "POST",
    "/__studio/format",
    "Dispatch a format capability {format, action: parse|serialize, source?|doc?}",
    "Non-JSON documents cannot be parsed/serialized (backs formatAction).",
  ),
  pluginSchema: route(
    "GET",
    "/__studio/plugin-schema",
    "Extract a $studio schema from a class source",
    "Plugin property panels fall back to generic JSON editing.",
  ),
  codeFormat: route(
    "POST",
    "/__studio/code/format",
    "Format posted source {code, path?} → {code, errors}",
    "Code editors skip format-on-open/save (codeService returns null).",
  ),
  codeMinify: route(
    "POST",
    "/__studio/code/minify",
    "Minify posted source {code} → {code}",
    "Compiled-output minification is skipped.",
  ),
  codeLint: route(
    "POST",
    "/__studio/code/lint",
    "Lint posted source {code, path?} → {diagnostics}",
    "Code editors show no lint markers.",
  ),

  // ─── Site build ───────────────────────────────────────────────────────────
  /**
   * Build the site to its output directory, so what a reader opens is what the author sees.
   *
   * `View: Open in Browser` runs this first. Without it the reader gets whatever the last build
   * left on disk — which for most projects is nothing, and for the rest is yesterday — while the
   * canvas beside them shows today. A preview that silently shows stale output is worse than one
   * that says it cannot open.
   *
   * The reply also names `url`, the ORIGIN the result is browsable at. It is not this server's:
   * these paths mean the project's SOURCES, and a built page addresses its own OUTPUT by the same
   * paths (`/components/x.js` is the formula module here and the custom element there), so a
   * backend serves the built site somewhere of its own and says where.
   */
  buildSite: route(
    "POST",
    "/__studio/build",
    "Build the site to its output directory → {routes, files, errors, url}",
    "Open in Browser reports that this target cannot build a preview.",
  ),

  // ─── Packages ─────────────────────────────────────────────────────────────
  packages: route("GET", "/__studio/packages", "List dependencies (PackageInfo[])"),
  packagesAdd: route("POST", "/__studio/packages/add", "Add a dependency"),
  packagesRemove: route("POST", "/__studio/packages/remove", "Remove a dependency"),
  packagesInstall: route(
    "POST",
    "/__studio/packages/install",
    "Run the package manager install",
    "Install/reinstall affordances are hidden; manifest-only edits still work.",
  ),
  packagesNeedsInstall: route(
    "GET",
    "/__studio/packages/needs-install",
    "Whether node_modules is stale",
    "The install-on-open prompt never shows.",
  ),
  packagesOutdated: route(
    "GET",
    "/__studio/packages/outdated",
    "Dependencies with newer versions (OutdatedInfo[])",
    "The update affordances are hidden.",
  ),
  packagesSetVersions: route(
    "POST",
    "/__studio/packages/set-versions",
    "Rewrite dependency ranges and install",
    "Bulk version updates are hidden.",
  ),

  // ─── Git ──────────────────────────────────────────────────────────────────
  gitStatus: route("GET", "/__studio/git/status", "Working-tree status (GitStatusResult)"),
  gitBranches: route("GET", "/__studio/git/branches", "Branch list (GitBranchesResult)"),
  gitLog: route("GET", "/__studio/git/log", "Recent commits (GitLogEntry[])"),
  gitStage: route("POST", "/__studio/git/stage", "Stage files"),
  gitUnstage: route("POST", "/__studio/git/unstage", "Unstage files"),
  gitCommit: route("POST", "/__studio/git/commit", "Commit staged (else all dirty) files"),
  gitPush: route("POST", "/__studio/git/push", "Push (cloud: sync check — commits land on push)"),
  gitPull: route("POST", "/__studio/git/pull", "Pull/fast-forward; 409 {conflicts} on overlap"),
  gitFetch: route("POST", "/__studio/git/fetch", "Refresh remote tracking state"),
  gitCheckout: route("POST", "/__studio/git/checkout", "Switch branches"),
  gitCreateBranch: route("POST", "/__studio/git/create-branch", "Create a branch"),
  gitDiff: route("GET", "/__studio/git/diff", "Unified diff of dirty files (or one path)"),
  gitShow: route("GET", "/__studio/git/show", "File content at a ref"),
  gitDiscard: route("POST", "/__studio/git/discard", "Discard working changes"),
  gitInit: route("POST", "/__studio/git/init", "Initialize a repository"),
  gitAddRemote: route("POST", "/__studio/git/add-remote", "Add a remote"),
  gitClone: route(
    "POST",
    "/__studio/git/clone",
    "Clone a repository",
    "The welcome screen hides Clone Git Repository.",
  ),
  gitPr: route(
    "POST",
    "/__studio/git/pr",
    "Open a pull request → PullRequestInfo",
    "Studio falls back to a direct GitHub API call with the user's token.",
  ),

  // ─── Data surface (connector domain owner console) ───────────────────────
  // These routes intentionally bypass table permission rules — the backend boundary
  // (dev-server loopback/token, cloud collaboration permission) is the gate
  // (specs/extensions.md §13). Secret VALUES never ride them; env-var NAMES only.
  dataConnections: route(
    "GET",
    "/__studio/data/connections",
    "Connector connections with configured/missingSecrets/isDefault state, reachable table " +
      "names, and registry-descriptor provider metadata (DataConnectionsResponse; backs " +
      "dataConnections)",
    "The connections settings section shows no status, and data-domain actions stay hidden.",
  ),
  dataConnectionTest: route(
    "POST",
    "/__studio/data/connections/test",
    "Probe a connection {connection} → DataConnectionTestResult (backs dataConnectionTest)",
    "The Test Connection action is hidden.",
  ),
  dataPush: route(
    "POST",
    "/__studio/data/push",
    "Additive schema push {connection?, dryRun?} → DataPushResult (plan of DataPushStep[], " +
      "applied, warnings/errors; backs dataPush)",
    "The Push Schema action is hidden; schemas deploy via `jx db push` instead.",
  ),
  dataRows: route(
    "GET",
    "/__studio/data/rows",
    "Page a table (DataRowsQuery params) → DataRowsResult {rows, total, columns} (backs dataRows)",
    "The data grid is unavailable.",
  ),
  dataInsertRow: route(
    "POST",
    "/__studio/data/rows",
    "Insert a row {table, connection?, values} → {row} (backs dataInsertRow)",
    "The data grid hides its add-row footer.",
  ),
  dataUpdateRow: route(
    "PUT",
    "/__studio/data/rows",
    "Update a row keyed on its primary key {table, connection?, pk, set} → {row} (backs " +
      "dataUpdateRow)",
    "Data grid cells are read-only.",
  ),
  dataDeleteRow: route(
    "DELETE",
    "/__studio/data/rows",
    "Delete a row (?table=&pk=&connection=) → {ok} (backs dataDeleteRow)",
    "The data grid hides row deletion.",
  ),

  // ─── Secrets (names only) ─────────────────────────────────────────────────
  secretsList: route(
    "GET",
    "/__studio/secrets",
    "Configured secret env-var NAMES, never values (SecretsListResponse; backs listSecrets)",
    "Secret fields cannot show set/unset state.",
  ),
  secretsSet: route(
    "PUT",
    "/__studio/secrets",
    "Write/remove secrets in the backend store (.dev.vars locally) {set?, remove?} → names " +
      "(backs setSecrets)",
    "The secret form control renders disabled; secrets are edited in .dev.vars by hand.",
  ),

  // ─── AI proxy ─────────────────────────────────────────────────────────────
  aiChat: route(
    "POST",
    "/__studio/ai/chat",
    "StreamEvent SSE chat proxy {messages, tools, systemPrompt, model}",
  ),
  aiModels: route("GET", "/__studio/ai/models", "Model catalogue (AiModelsResponse)"),

  // ─── Cloudflare publish surface ───────────────────────────────────────────
  cfProxy: route(
    "POST",
    "/__studio/cf/proxy",
    "Allowlisted Cloudflare API passthrough {path, method?, body?} (backs cfApi)",
    "The Publish panel explains the git-push publishing path instead.",
  ),
} as const satisfies Record<string, StudioRoute>;

/** A stable route name in {@link STUDIO_ROUTES}. */
export type StudioRouteName = keyof typeof STUDIO_ROUTES;

/** Names of every route a minimal (core) backend must implement. */
export function coreRouteNames(): StudioRouteName[] {
  return (Object.keys(STUDIO_ROUTES) as StudioRouteName[]).filter(
    (name) => !STUDIO_ROUTES[name].optional,
  );
}

/** Names of the optional routes (each backs an optional StudioPlatform member). */
export function optionalRouteNames(): StudioRouteName[] {
  return (Object.keys(STUDIO_ROUTES) as StudioRouteName[]).filter(
    (name) => STUDIO_ROUTES[name].optional,
  );
}
