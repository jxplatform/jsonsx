/// <reference lib="dom" />
import type {
  JsonValue as SchemaJsonValue,
  JxMutableNode,
  JxPath,
  ProjectConfig,
} from "@jxsuite/schema/types";

// ─── Git & Platform Types ───────────────────────────────────────────────────

export interface GitFileStatus {
  status: string;
  path: string;
  staged?: boolean;
}

export interface GitStatusResult {
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
  isRepo: boolean;
  remotes: string[];
}

export interface GitBranchesResult {
  current: string;
  branches: string[];
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface ComponentSlotMeta {
  name: string;
  description?: string;
  fallback?: (JxMutableNode | string)[];
}

export interface ComponentMeta {
  tagName: string;
  $id?: string | null;
  path: string;
  props?: { name: string; type?: string; default?: JsonValue; [k: string]: unknown }[];
  slots?: ComponentSlotMeta[];
  hasElements?: boolean;
}

export interface PackageInfo {
  name: string;
  version: string;
  /** True when the dependency lives in `devDependencies` rather than `dependencies`. */
  dev?: boolean;
}

/** A dependency with a newer version available, as reported by `bun outdated` / the npm registry. */
export interface OutdatedInfo {
  name: string;
  /** The version range pinned in package.json (e.g. "^0.19.0"). */
  current: string;
  /** The newest published version. */
  latest: string;
  /** The newest version satisfying the current range, if known. */
  wanted?: string;
  dev?: boolean;
}

/** Result of a package mutation that runs `bun install` (install / set-versions). */
export interface PackageOpResult {
  ok: boolean;
  /** Combined stdout/stderr from the bun invocation, surfaced to the user on failure. */
  log?: string;
}

/** Desktop app/build info surfaced in the About screen. */
export interface AppInfo {
  version: string;
  channel: string;
  hash: string;
  /** Human-readable update status (e.g. "Up to date", "Update available"), if known. */
  updateStatus?: string;
}

export interface CodeServiceResult {
  code?: string;
  diagnostics?: unknown[];
  [key: string]: unknown;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
}

/** A filesystem change pushed from the backend (project-relative, forward-slashed path). */
export interface FsEvent {
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
  isDir: boolean;
}

/** Result of a rename, including the references rewritten across the project (refactor report). */
export interface RenameResult {
  ok: boolean;
  from: string;
  to: string;
  isDir?: boolean;
  references?: {
    filesChanged: number;
    refsUpdated: number;
    files: { path: string; count: number }[];
  };
  errors?: { path: string; error: string }[];
  tag?: { from: string; to: string; filesChanged: number; refsUpdated: number };
  tagSkipped?: string;
  error?: string;
}

/** A starter template surfaced in the New Project picker (mirrors @jxsuite/starters StarterMeta). */
export interface StarterInfo {
  id: string;
  name: string;
  industry: string;
  tagline: string;
  description: string;
  features: string[];
  accent: string;
  /** Preview image as a self-contained `data:` URI. */
  thumbnail: string;
}

/** A progress line from the AI-guided site import (mirrors @jxsuite/import ImportProgressEvent). */
export interface ImportProgressEvent {
  phase: string;
  message: string;
  current?: number;
  total?: number;
}

/** Options for {@link StudioPlatform.importSite}. */
export interface ImportSiteOptions {
  /** The live site to clone; must be http(s). */
  url: string;
  /** Display name for the new project. */
  name: string;
  /** Destination directory (platform-interpreted: project-relative on the dev server). */
  directory: string;
  /** Max crawl depth; 0 = single page. */
  depth: number;
  /** Max pages to capture. */
  maxPages: number;
  /** Refine component/prop names with the LLM (requires a key). */
  aiComponents: boolean;
  /** OpenAI-compatible credentials, from the user's AI settings. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
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

/** A recently-opened project, keyed by its re-openable `root` (platform-specific). */
export interface RecentProjectEntry {
  name: string;
  root: string;
  timestamp: number;
}

/** One entry in the platform's project catalogue (see StudioPlatform.listProjects). */
export interface ProjectListEntry {
  /** Display name (project.json name, repository name, ...). */
  name: string;
  /** Re-openable root key (server-relative path, owner/repo, absolute path). */
  root: string;
  /** Optional one-line descriptor shown under the name (path, permission, ...). */
  description?: string | undefined;
}

// ─── Studio Types ───────────────────────────────────────────────────────────

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

/**
 * A JSON document value, or `undefined` to signal property removal in the mutators. Re-uses the
 * schema's precise recursive JSON model.
 */
export type JsonValue = SchemaJsonValue | undefined;
