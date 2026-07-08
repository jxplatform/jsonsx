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
  createProject: route("POST", "/__studio/create-project", "Scaffold a project → {root, config}"),
  starters: route(
    "GET",
    "/__studio/starters",
    "Starter templates (StarterInfo[])",
    "The New Project picker offers only blank/templates.",
  ),

  // ─── Filesystem ───────────────────────────────────────────────────────────
  files: route("GET", "/__studio/files", "List a directory (DirEntry[])"),
  fileRead: route("GET", "/__studio/file", "Read a file's text content"),
  fileWrite: route("PUT", "/__studio/file", "Write a file's text content"),
  fileDelete: route("DELETE", "/__studio/file", "Delete a file"),
  fileUpload: route("POST", "/__studio/file/upload", "Upload binary content to a path"),
  fileRename: route("POST", "/__studio/file/rename", "Rename/move (+ refactor report)"),
  locate: route("POST", "/__studio/locate", "Find a file by name → {path | null}"),
  collab: route(
    "GET",
    "/__studio/collab",
    "Realtime co-editing: a WebSocket upgrade speaking the @jxsuite/collab wire envelope (one " +
      "socket per project, documents multiplexed by path; y-protocols sync + project-level " +
      "awareness in lib0 binary frames — see @jxsuite/collab/envelope for the frame layout and " +
      "the docEpoch/doc-reset lifecycle). A plain GET (no Upgrade) answers {collab: true, " +
      "version} as the capability probe.",
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
    "The project's format registry entries",
    "Only .json documents open (backs listFormats).",
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
