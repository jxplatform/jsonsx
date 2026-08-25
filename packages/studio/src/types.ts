/// <reference lib="dom" />
import type { CollabHandle } from "@jxsuite/collab/provider";
import type {
  ContentTypeSchema,
  JxMutableNode,
  JxPath,
  ProjectConfig,
} from "@jxsuite/schema/types";

// ─── Wire types (the Studio Backend Protocol) ───────────────────────────────
/* The request/response shapes every backend serves live in @jxsuite/protocol;
   re-exported here so existing `../types` imports keep working. */

import type {
  AppInfo,
  AssetCapabilities,
  CfConnection,
  CodeServiceResult,
  ComponentMeta,
  DataConnectionsResponse,
  DataConnectionTestResult,
  DataPushResult,
  DataRowDelete,
  DataRowInsert,
  DataRowsQuery,
  DataRowsResult,
  DataRowUpdate,
  DirEntry,
  ExtensionsInfo,
  FsEvent,
  GitBranchesResult,
  GitLogEntry,
  GitStatusResult,
  ImportProgressEvent,
  ImportSiteOptions,
  OutdatedInfo,
  PackageInfo,
  PackageOpResult,
  ProjectListEntry,
  ProjectSchemasResponse,
  RecentProjectEntry,
  ReferencesResult,
  RenameResult,
  SecretsSetRequest,
  SecretsSetResponse,
  StarterInfo,
  UploadResult,
} from "@jxsuite/protocol";

export type {
  AiModelInfo,
  AiModelsResponse,
  AppInfo,
  CfConnection,
  CodeServiceResult,
  ComponentMeta,
  ComponentSlotMeta,
  DataColumnMeta,
  DataConnectionInfo,
  DataConnectionsResponse,
  DataConnectionTestResult,
  DataConnectorInfo,
  DataPushRequest,
  DataPushResult,
  DataPushStep,
  DataRowDelete,
  DataRowInsert,
  DataRowsQuery,
  DataRowsResult,
  DataRowUpdate,
  DirEntry,
  ErrorBody,
  ExtensionContributionInfo,
  ExtensionProjectBlock,
  ExtensionsInfo,
  FsEvent,
  GitBranchesResult,
  GitFileStatus,
  GitLogEntry,
  GitStatusResult,
  ImportProgressEvent,
  ImportSiteOptions,
  JsonValue,
  OutdatedInfo,
  PackageInfo,
  PackageOpResult,
  ProjectListEntry,
  ProjectSchemasResponse,
  PullRequestInfo,
  RecentProjectEntry,
  ReferenceFile,
  ReferenceHit,
  ReferencesResult,
  RenameResult,
  SecretsListResponse,
  SecretsSetRequest,
  SecretsSetResponse,
  StarterInfo,
} from "@jxsuite/protocol";

/** Repository-access onboarding state returned by `StudioPlatform.getAccountStatus`. */
export interface AccountStatus {
  /**
   * GitHub App installations (personal + organization) visible to the signed-in user. `manageUrl`
   * is that installation's own settings page, where the user widens which repositories the App can
   * reach; absent when the platform cannot report one.
   */
  installations: { id: number; account: string | null; manageUrl?: string }[];
  /** Where to install the App (github.com/apps/<slug>/installations/new), when known. */
  appInstallUrl?: string;
}

/** A repository visible to `StudioPlatform.listRepos` (the add-existing-repository picker). */
export interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  permission: "admin" | "write" | "read" | "none";
  /** Already recognized as a Jx project (topic-tagged / cataloged). */
  isJxProject: boolean;
}

/**
 * Where a new project is written. The New Project modal collects this from the user and the backend
 * MUST honor it — no backend may pick a destination on its own (see
 * `StudioPlatform.createDestination`).
 *
 * - `"path"`: `parent` is an absolute filesystem directory; the project lands at
 *   `parent/<directory>`.
 * - `"repo"`: a remote repository — `owner` is a GitHub account or organization login, `repo` the
 *   repository name, `private` its visibility.
 */
export type CreateProjectDestination =
  | { kind: "path"; parent: string }
  | { kind: "repo"; owner: string; repo: string; private: boolean };

/**
 * What a site build reports back.
 *
 * `errors` is a list rather than a thrown exception because a partial build still produced pages:
 * the author is better served by opening the page they asked for with the failures named beside it
 * than by a refusal that says only that something went wrong.
 */
export interface SiteBuildResult {
  routes: number;
  files: number;
  errors: string[];
  /**
   * Origin the built site is browsable at, e.g. `http://127.0.0.1:41234`.
   *
   * The backend names it because only the backend knows it: the built site is served on a port of
   * its own, not on the editor's, since the editor's paths mean the project's SOURCES and a built
   * page means its own output by the very same paths. Absent when the backend serves no preview,
   * and `View: Open in Browser` then says so rather than guessing an origin.
   */
  url?: string;
}

export interface StudioPlatform {
  id: string;
  projectRoot: string;
  /**
   * URL of the canvas iframe document. Optional: when set (chromium serves it from the project
   * server under the studio namespace), the iframe host uses it; otherwise the host falls back to
   * the default dev-server path. Not keyed on `id` — chromium and electrobun both report `id:
   * "desktop"`, but only chromium sets this.
   */
  canvasUrl?: string;
  /**
   * True when this platform resolves {@link canvasUrl} ASYNCHRONOUSLY.
   *
   * Electrobun does: the url is this window's loopback port, fetched over RPC inside `activate()`.
   * Until the canvas fallback was anchored to the bundle it did not matter — the old literal
   * `/packages/studio/canvas.html` resolved to nothing servable under `views://`, so an early frame
   * simply failed and the host rebuilt when the real url landed. Now the fallback RESOLVES:
   * `views://studio/canvas.html` is a document electrobun really stages. An early frame would boot
   * the whole canvas bundle inside the SHELL's app-privileged origin, in a CEF instance running
   * `disable-site-isolation-trials` — and the cross-origin loopback canvas exists precisely so that
   * cannot happen. Declaring it makes the host wait instead.
   *
   * Not keyed on `id`: chromium and electrobun both report `"desktop"`, and only electrobun defers.
   */
  canvasUrlDeferred?: boolean;
  /**
   * Base URL the canvas fetches PROJECT FILES from — component `$ref`s, `$src` modules, images.
   *
   * The renderer resolves a `$ref` with `fetch(url).then(r => r.json())` from inside the iframe, so
   * project files have to exist at a URL, not merely behind {@link readFile}. Hosts that serve the
   * project tree from their web root need no value here: the default is `<canvas
   * origin>/<projectRoot>/`, which is what the dev server and the desktop loopback both already
   * answer.
   *
   * A host whose project files are NOT at a URL-shaped `projectRoot` must set this. Jx Cloud is
   * one: its `projectRoot` is the identifier `owner/repo@branch`, nothing served the tree, and
   * every `$ref` fetch landed on the SPA fallback — which answers HTML at **200**, so `res.ok`
   * passed and the parse died on `Unexpected token '<'`. Images failed the same way in silence.
   *
   * May be absolute or root-relative — a root-relative value is resolved against the canvas origin,
   * because the canvas uses this as `new URL(path, base)` and a relative BASE throws. A missing
   * trailing `/` is added: without it `new URL` drops the last segment.
   */
  documentBaseUrl?: string;
  /**
   * What the canvas ORIGIN answers for a SITE URL — and therefore how Studio must address media.
   *
   * `"site"` (the default when absent): the canvas origin already serves the published site URL
   * space, so `/hero.jpg` and `/styles/main.css` resolve on their own and Studio touches neither.
   * The dev server and the desktop loopback both do — `serveProjectFile` in `@jxsuite/server` IS
   * that URL space — so neither declares anything here and both stay byte-identical.
   *
   * `"repo"`: the host serves PROJECT-RELATIVE paths under {@link documentBaseUrl}, and nothing
   * answers the site URL space. Studio resolves each authored reference to the project file it
   * names and rebases that path onto `documentBaseUrl`. Inert without one — a host that says its
   * site URLs are wrong without saying what is right has told Studio nothing it can act on.
   *
   * This is about the ORIGIN, not the backend: a host whose files are perfectly reachable can still
   * be `"repo"` space, because what decides it is what answers `GET /hero.jpg` on the document the
   * canvas is running in.
   */
  assetSpace?: "site" | "repo";
  /**
   * What this backend will accept as an upload, when it says.
   *
   * Absent, or any field absent, means "no declared limit", and Studio must not invent one — a
   * limit it made up is a file the user cannot upload for no reason anyone can name. A DECLARED
   * limit is different: Studio refuses before spending the round trip and names the number in the
   * refusal, and narrows the file picker's `accept` to match.
   */
  assetCapabilities?: AssetCapabilities;
  activate: (root?: string) => Promise<void>;
  openProject: () => Promise<{
    config: ProjectConfig;
    handle: { root: string; name: string; projectConfig: ProjectConfig };
  } | null>;
  /**
   * How "Open Project" picks a project. Absent: `openProject()` owns picking (native dialog /
   * showDirectoryPicker). `"repo-list"`: Studio shows its repository picker over `listRepos` +
   * `importProject` (write-access repositories) and opens the choice through the recent-projects
   * path — `openProject()` is never called. Cloud sets this: its sessions are URL-bound, so there
   * is no backend dialog to delegate to.
   */
  openProjectPicker?: "repo-list";
  probeRootProject: () => Promise<{
    meta: { root: string; name: string };
    info: {
      isSiteProject: boolean;
      projectConfig?: ProjectConfig | null;
      directories?: string[];
    };
  } | null>;
  listDirectory: (dir: string) => Promise<DirEntry[]>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  /**
   * Store bytes at a project path, and report where they really landed.
   *
   * The result's `path` is the ANSWER, not an echo: a backend may de-duplicate by content hash,
   * append a collision suffix, or normalize a name, and the reference Studio writes into the
   * document has to name what was actually written. This was `Promise<unknown>` and every caller
   * used the REQUESTED path, so any such backend produced documents pointing at files that are not
   * there.
   */
  uploadFile: (path: string, data: string | File | Blob | ArrayBuffer) => Promise<UploadResult>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<RenameResult>;
  /**
   * Where a file or a component tag is used across the project — the read side of the same walker
   * `renameFile` writes through. Backs `capability.findReferences`, and with it the inspector's
   * "Used on N pages", `Selection: Find Usages`, and the reference count inside every delete and
   * rename confirmation.
   *
   * Optional so a backend without the route hides those three renderings rather than reporting a
   * confident zero — the one answer a destructive dialog must never invent. Every shipped host
   * implements it: the walker lives in `@jxsuite/server`, which desktop and cloud both run.
   *
   * At least one of `path` / `tagName` must be given. A `path` naming a component document
   * contributes its own root tag, so one call answers "as a file AND as an element" together.
   */
  findReferences?: (target: { path?: string; tagName?: string }) => Promise<ReferencesResult>;
  createDirectory: (path: string) => Promise<void>;
  /**
   * Subscribe to backend filesystem change events for the active project. Returns an unsubscribe
   * function. Optional: platforms without a watcher omit it and the sidebar stays manual-refresh.
   */
  subscribeFileEvents?: (handler: (events: FsEvent[]) => void) => () => void;
  discoverComponents: (dir?: string) => Promise<ComponentMeta[]>;
  addPackage: (name: string) => Promise<unknown>;
  removePackage: (name: string) => Promise<unknown>;
  listPackages: () => Promise<PackageInfo[]>;
  /**
   * Run `bun install` in the project root. Optional: platforms without a Bun-capable backend omit
   * it and the install-on-open / reinstall affordances are skipped.
   */
  installDependencies?: () => Promise<PackageOpResult>;
  /** Whether the project has uninstalled dependencies (node_modules missing). */
  dependenciesNeedInstall?: () => Promise<boolean>;
  /** List dependencies that have a newer version available. */
  outdatedPackages?: () => Promise<OutdatedInfo[]>;
  /**
   * Rewrite the version range of each named package (preserving its dependencies/devDependencies
   * placement) and run `bun install`. Used by the @jxsuite bump and per-dependency updates.
   */
  setPackageVersions?: (
    updates: { name: string; version: string; dev?: boolean }[],
  ) => Promise<PackageOpResult>;
  /**
   * Desktop-only app/build info (release channel, commit hash, update status). Platforms without a
   * native shell (e.g. the dev server) omit it, and the About screen hides the corresponding
   * section.
   */
  getAppInfo?: () => Promise<AppInfo>;
  codeService: (action: string, payload: unknown) => Promise<CodeServiceResult | null>;
  resolveSiteContext: (filePath: string) => Promise<{
    sitePath: string | null;
    projectConfig?: ProjectConfig;
    fileRelPath?: string;
  }>;
  locateFile: (name: string) => Promise<string | null>;
  searchFiles: (query: string, extensions?: string[]) => Promise<DirEntry[]>;
  /** List the project's registered format classes (auto-discovered from imports). */
  listFormats?: () => Promise<unknown[]>;
  /**
   * List the project's enabled extension packages with their project-section contributions
   * (specs/extensions.md §9/§9.1) — the formats route's sibling `extensions` payload. Optional:
   * platforms without it lose descriptor-contributed settings sections.
   */
  listExtensions?: () => Promise<ExtensionsInfo[]>;
  /**
   * Fetch the project's generated entry schemas (project.schema.json / document.schema.json),
   * PRE-BUNDLED into self-contained documents for editor registration. Optional: without it the
   * JSON editor keeps the bundled core schemas.
   */
  fetchProjectSchemas?: () => Promise<ProjectSchemasResponse>;
  /** Invoke a format capability (parse/serialize) — { format, action, source?, doc?, options? }. */
  formatAction?: (payload: Record<string, unknown>) => Promise<unknown>;
  // ─── Data surface + secrets (owner console; specs/extensions.md §13) ────────
  // Optional as a family: backends without the connector data routes omit them all, and Studio
  // Hides the data grid and connection/push/test actions. Row CRUD is the ADMIN path — it
  // Intentionally bypasses table permission rules; the backend boundary is the gate.
  /** List connector connections with configured state, table names, and provider metadata. */
  dataConnections?: () => Promise<DataConnectionsResponse>;
  /** Probe one connection through the backend's connector registry. */
  dataConnectionTest?: (connection: string) => Promise<DataConnectionTestResult>;
  /** Additive schema push; `dryRun` compiles the plan without applying it. */
  dataPush?: (opts?: { connection?: string; dryRun?: boolean }) => Promise<DataPushResult>;
  /** Page a table's rows with introspected column metadata. */
  dataRows?: (query: DataRowsQuery) => Promise<DataRowsResult>;
  dataInsertRow?: (req: DataRowInsert) => Promise<{ row: Record<string, unknown> }>;
  dataUpdateRow?: (req: DataRowUpdate) => Promise<{ row: Record<string, unknown> }>;
  dataDeleteRow?: (req: DataRowDelete) => Promise<{ ok: boolean }>;
  /** Configured secret env-var NAMES — never values. */
  listSecrets?: () => Promise<string[]>;
  /** Write/remove secrets in the backend store (.dev.vars locally); names-only response. */
  setSecrets?: (req: SecretsSetRequest) => Promise<SecretsSetResponse>;
  fetchPluginSchema: (src: string, prototype?: string, base?: string) => Promise<unknown>;
  /**
   * Resolve a class-prototype config through the backend's `/__jx_resolve__` pipeline (with the
   * project's content types loaded) and return the parsed result. Used by the tab-bar's dynamic
   * route-param picker to enumerate ContentCollection entries. Optional: platforms without a
   * resolve backend omit it and the picker falls back to a plain fetch.
   */
  resolveClass?: (body: Record<string, unknown>) => Promise<unknown>;
  gitStatus: () => Promise<GitStatusResult>;
  gitBranches: () => Promise<GitBranchesResult>;
  gitLog: (limit?: number) => Promise<GitLogEntry[]>;
  gitStage: (files: string[]) => Promise<void>;
  gitUnstage: (files: string[]) => Promise<void>;
  gitCommit: (message: string) => Promise<void>;
  gitPush: (opts?: { setUpstream?: boolean }) => Promise<void>;
  gitPull: () => Promise<void>;
  gitFetch: () => Promise<void>;
  gitCheckout: (branch: string) => Promise<void>;
  gitCreateBranch: (name: string) => Promise<void>;
  gitDiff: (path?: string) => Promise<string>;
  gitShow: (opts: { path: string; ref?: string }) => Promise<string>;
  gitDiscard: (files: string[]) => Promise<void>;
  gitClone?: (url: string) => Promise<{ ok: boolean; root: string }>;
  gitInit: () => Promise<void>;
  /**
   * Build the site to its output directory, so a reader opens what the author is looking at.
   *
   * `View: Open in Browser` runs this first and reports what it says. Optional because it is a
   * capability, not an assumption: a backend that cannot build (a read-only cloud viewer) simply
   * does not declare it, and the command says so rather than opening whatever stale output the last
   * build happened to leave — which for most projects is nothing at all.
   */
  buildSite?: () => Promise<SiteBuildResult>;
  gitAddRemote: (name: string, url: string) => Promise<void>;
  /**
   * How the New Project modal collects a destination, and which `CreateProjectDestination` variant
   * `createProject` requires. `"path"`: a Location field (absolute parent directory) plus a Browse…
   * button over `pickDirectory`. `"repo"`: owner / repository-name / visibility fields. Every
   * backend sets one — a project is never written to a destination the user did not choose.
   */
  createDestination: "path" | "repo";
  createProject: (opts: {
    name: string;
    description?: string;
    url?: string;
    adapter?: string;
    directory: string;
    /** Where to write it. Required; its `kind` matches this platform's `createDestination`. */
    destination: CreateProjectDestination;
    /** Id of a starter template to clone, or "blank"/undefined for the minimal template. */
    starter?: string;
    /** Id of a built-in template variant (from `@jxsuite/create/templates`); undefined = blank. */
    template?: string;
    /** Design quickstart (colors, fonts, logo, breakpoints) applied on top of the scaffold. */
    design?: {
      accent?: string;
      background?: string;
      text?: string;
      bodyFont?: string;
      headingFont?: string;
      media?: Record<string, string>;
      logo?: { name: string; base64: string };
    };
  }) => Promise<{ root: string; config: ProjectConfig }>;
  /**
   * List the starter templates available in the New Project picker. Absent on platforms that don't
   * ship starters (the picker then offers only a blank project).
   */
  listStarters?: () => Promise<StarterInfo[]>;
  /**
   * AI-guided import of an existing site into a new project. Runs in the backend (headless Chrome +
   * fs), streaming progress until the project is written. Absent on platforms without a backend
   * import pipeline — the New Project modal hides its Import tab then.
   */
  importSite?: (
    opts: ImportSiteOptions,
    onProgress: (evt: ImportProgressEvent) => void,
    signal?: AbortSignal,
  ) => Promise<{ root: string; config: ProjectConfig }>;
  /**
   * Open a native directory picker and return the chosen absolute path (null when cancelled). Backs
   * the New Project modal's **Browse…** button on `createDestination: "path"` platforms. Desktop
   * only — the dev server has no native dialog, so its Location field is typed by hand.
   */
  pickDirectory?: () => Promise<string | null>;
  /** Stack B AI assistant: URL of the OpenAI-compatible SSE chat proxy (`/__studio/ai/chat`). */
  aiChatUrl: () => string | Promise<string>;
  // ─── Multi-window (desktop only; undefined on dev-server) ───────────────────
  /**
   * Open a project in a new window, focusing an existing window if it is already open.
   *
   * `focused` says which of the two happened, so the caller reports the outcome instead of
   * announcing the intent — "opened in a new window" is a lie when the project was already open
   * somewhere and that window merely came to the front.
   */
  openProjectInNewWindow?: (root: string) => Promise<{ focused: boolean }>;
  /**
   * Pick a project WITHOUT binding this window to it — the answer to "which project", separated
   * from the act of opening it here. Backs the New Window branch of Open Project: `openProject()`
   * re-roots this window's backend as a side effect of picking, so it cannot ask a question whose
   * answer is "not in this window". Resolves null when the user cancels the picker.
   *
   * Desktop only. Without it Studio does not offer the choice, because it could not honour it.
   */
  pickProject?: () => Promise<{ root: string; name: string } | null>;
  /** Open a fresh welcome window. */
  newWindow?: () => Promise<void>;
  /**
   * Point THIS window's backend at a project and return its config. If the project is already open
   * in another window, that window is focused and `deduped` is true (no project is loaded here).
   */
  setWindowProject?: (root: string) => Promise<{ deduped: boolean; config: ProjectConfig | null }>;
  /** The project root this window's backend is currently bound to. */
  getProjectRoot?: () => Promise<{ root: string | null }>;
  // ─── Recent projects (backend-persisted; undefined on dev-server) ───────────
  /**
   * Read the user-level recent-projects list from a backend store shared across all
   * projects/windows. Platforms without a native backend (dev server) omit it and the studio falls
   * back to localStorage.
   */
  getRecentProjects?: () => Promise<RecentProjectEntry[]>;
  /** Persist the full recent-projects list to the backend store. */
  saveRecentProjects?: (projects: RecentProjectEntry[]) => Promise<void>;
  // ─── Project catalogue (platforms that can enumerate openable projects) ─────
  /**
   * Enumerate every project this platform can open — the dev server's sites under its root, a cloud
   * platform's remote projects. Entry `root` values re-open through the same paths as recent
   * projects (openRecentProject). Absent on desktop, where the OS file system is the catalogue and
   * projects are found via the native picker instead.
   */
  listProjects?: () => Promise<ProjectListEntry[]>;
  /**
   * Open a realtime co-editing session for a project-relative document path. Optional: platforms
   * without a collab backend omit it and Studio edits solo with file-level saves. Resolves null
   * when the backend refuses a room for this doc (binary, oversized). The returned handle's Y.Doc
   * starts empty and fills from the provider — see `@jxsuite/collab/provider` for the contract.
   */
  collab?: (docPath: string) => Promise<CollabHandle | null>;
  // ─── Identity & hosting connections (publish surface) ───────────────────────
  /** The signed-in user's identity, when the platform has one (cloud). */
  getUser?: () => Promise<{ login: string; name?: string; avatarUrl?: string } | null>;
  /**
   * Repository-access onboarding state: the platform's GitHub App installations visible to this
   * user and where to install the App. Cloud-only; when the list is empty Studio's welcome screen
   * prompts the user to install the App (without it, no repos are reachable). Null = unknown (don't
   * prompt).
   */
  getAccountStatus?: () => Promise<AccountStatus | null>;
  /**
   * Browse every repository the platform's account link can reach — personal and organization repos
   * covered by a GitHub App installation on cloud. Backs the "Add Existing Repository" picker;
   * local platforms omit it (the OS picker / clone flow covers them).
   */
  listRepos?: () => Promise<RepoInfo[]>;
  /**
   * Adopt an existing repository as a Jx project and return its catalogue root key (openable via
   * the recent-projects path). Rejects with a structured message when the repository carries no
   * project.json.
   */
  importProject?: (opts: { owner: string; name: string }) => Promise<{ root: string }>;
  /**
   * Open a pull request for the current branch. Cloud platforms implement it against their session;
   * local platforms omit it and Studio falls back to a direct GitHub API call with the user's
   * stored token.
   */
  createPullRequest?: (opts: {
    title: string;
    body?: string;
    head?: string;
    base?: string;
  }) => Promise<{ url: string; number: number }>;
  /** Current Cloudflare connection state, when the platform can broker one. */
  cfConnection?: () => Promise<CfConnection | null>;
  /**
   * Interactively connect a Cloudflare account (hosted OAuth on the cloud platform). Local
   * platforms omit it — the publish UI collects an API token instead and verifies via
   * cfConnection.
   */
  cfConnect?: () => Promise<CfConnection | null>;
  /**
   * Allowlisted Cloudflare API passthrough (accounts, Pages projects and deployments). The backend
   * injects credentials — an OAuth token on the cloud platform, the user's pasted API token locally
   * — so no secret ever rides in the request body.
   */
  cfApi?: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
  // ─── User settings (backend-persisted; undefined on dev-server) ─────────────
  /**
   * Read the user-level settings map (e.g. the AI connection parameters) from a backend store
   * shared across all projects/windows. Platforms without a native backend (dev server) omit it and
   * settings live in localStorage only.
   */
  getSettings?: () => Promise<Record<string, string>>;
  /** Persist the full user-level settings map to the backend store. */
  saveSettings?: (settings: Record<string, string>) => Promise<void>;
}

// ─── Studio Types ───────────────────────────────────────────────────────────

/**
 * A project.json `content` section entry, as the studio consumes it. The parser extension owns the
 * full shape (its project fragment schema is the validation source of truth); the studio only reads
 * these fields.
 */
export interface ContentSectionEntry {
  source?: string;
  format?: string;
  schema?: ContentTypeSchema;
  $elements?: unknown[];
}

export interface CanvasPanel {
  mediaName: string;
  element: HTMLElement;
  canvas: HTMLElement;
  viewport: HTMLElement;
  scrollContainer: HTMLElement;
  _width: number | null;
  /** True when the panel's DOM reflects the current document via a successful live render. */
  ready: boolean;
  /**
   * Effect scope owning the reactive effects created while rendering this panel's content
   * (including child scopes from surgical subtree renders). Stopped when panels are rebuilt.
   */
  renderScope: { stop: () => void; run: <T>(fn: () => T) => T | undefined } | null;
}

export interface FunctionEditDef {
  type: string;
  defName?: string;
  path?: JxPath;
  eventKey?: string;
  key?: string;
  body?: string;
  parameters?: string[];
}

/**
 * Identifies which document position's `$expression` the Bottom dock's Logic tab is editing: a
 * state entry (`type: "def"` + defName) or an element event binding (`type: "event"` + path +
 * eventKey). Mirrors FunctionEditDef, the Monaco function editor's target shape.
 */
export interface FormulaEditDef {
  type: "def" | "event";
  defName?: string;
  path?: JxPath;
  eventKey?: string;
}

export interface GitDiffState {
  filePath: string;
  originalContent: string;
  currentContent: string;
  fileStatus: string;
  originalDoc?: JxMutableNode;
  currentDoc?: JxMutableNode;
  original?: unknown;
}

export interface InlineEditDef {
  path: JxPath;
  mediaName?: string;
}

export interface ProjectState {
  root?: string;
  name: string;
  projectRoot: string;
  isSiteProject: boolean;
  projectConfig: ProjectConfig | null;
  dirs: Map<string, DirEntry[]>;
  expanded: Set<string>;
  selectedPath: string | null;
  searchQuery: string;
  projectDirs?: string[];
  [key: string]: unknown;
}
