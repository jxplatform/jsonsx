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

export interface StudioPlatform {
  id: string;
  projectRoot: string;
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
  }) => Promise<{ root: string; config: ProjectConfig }>;
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
}

/** A recently-opened project, keyed by its re-openable `root` (platform-specific). */
export interface RecentProjectEntry {
  name: string;
  root: string;
  timestamp: number;
}

// ─── Studio Types ───────────────────────────────────────────────────────────

export interface CanvasPanel {
  mediaName: string;
  element: HTMLElement;
  canvas: HTMLElement;
  overlay: HTMLElement;
  overlayClk: HTMLElement;
  viewport: HTMLElement;
  scrollContainer: HTMLElement;
  dropLine: HTMLElement;
  _width: number | null;
  /** True when the panel's DOM reflects the current document via a successful live render. */
  ready: boolean;
  /** Breakpoints active for this panel's width (persisted for surgical patch re-application). */
  activeBreakpoints: Set<string> | null;
  /** Render context captured from the last successful live render (null until then). */
  liveCtx: PanelLiveCtx | null;
  /**
   * Effect scope owning the reactive effects created while rendering this panel's content
   * (including child scopes from surgical subtree renders). Stopped when panels are rebuilt.
   */
  renderScope: { stop: () => void; run: <T>(fn: () => T) => T | undefined } | null;
}

/** Per-panel context persisted by a successful live render so patches can re-render subtrees. */
export interface PanelLiveCtx {
  scope: Record<string, unknown>;
  canvasMode: string;
  layoutWrapped: boolean;
  pageContentPrefix: (string | number)[] | null;
  pageContentOffset: number;
  arrayPaths: Set<string>;
  pathMapper: (created: Node, path: (string | number)[], def: unknown) => void;
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
