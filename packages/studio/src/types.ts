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
  CfConnection,
  CodeServiceResult,
  ComponentMeta,
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
  RenameResult,
  StarterInfo,
} from "@jxsuite/protocol";

export type {
  AiModelInfo,
  AiModelsResponse,
  AppInfo,
  CfConnection,
  CodeServiceResult,
  ComponentMeta,
  ComponentSlotMeta,
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
  RenameResult,
  StarterInfo,
} from "@jxsuite/protocol";

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
  activate: (root?: string) => Promise<void>;
  openProject: () => Promise<{
    config: ProjectConfig;
    handle: { root: string; name: string; projectConfig: ProjectConfig };
  } | null>;
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
  uploadFile: (path: string, data: string | File | Blob | ArrayBuffer) => Promise<unknown>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<RenameResult>;
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
  gitAddRemote: (name: string, url: string) => Promise<void>;
  createProject: (opts: {
    name: string;
    description?: string;
    url?: string;
    adapter?: string;
    directory: string;
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
   * Open a native directory picker and return the chosen absolute path (null when cancelled).
   * Desktop only; the dev server interprets directories relative to its root instead.
   */
  pickDirectory?: () => Promise<string | null>;
  /** Stack B AI assistant: URL of the OpenAI-compatible SSE chat proxy (`/__studio/ai/chat`). */
  aiChatUrl: () => string | Promise<string>;
  // ─── Multi-window (desktop only; undefined on dev-server) ───────────────────
  /** Open a project in a new window, focusing an existing window if it is already open. */
  openProjectInNewWindow?: (root: string) => Promise<void>;
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

export interface DocumentStackEntry {
  document: JxMutableNode;
  documentPath: string | null;
  selection: JxPath | null;
  dirty?: boolean;
  mode?: string;
  sourceFormat?: string | null;
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
