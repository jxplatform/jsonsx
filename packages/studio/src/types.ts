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

export interface ComponentMeta {
  tagName: string;
  $id?: string | null;
  path: string;
  props?: { name: string; type?: string; default?: JsonValue; [k: string]: unknown }[];
  hasElements?: boolean;
}

export interface PackageInfo {
  name: string;
  version: string;
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
  renameFile: (from: string, to: string) => Promise<void>;
  createDirectory: (path: string) => Promise<void>;
  discoverComponents: (dir?: string) => Promise<ComponentMeta[]>;
  addPackage: (name: string) => Promise<unknown>;
  removePackage: (name: string) => Promise<unknown>;
  listPackages: () => Promise<PackageInfo[]>;
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
  aiAuthStatus: () => Promise<{ authenticated: boolean; error?: string }>;
  aiCreateSession: (opts: { message: string; systemPrompt?: string }) => Promise<{ id: string }>;
  aiSendMessage: (id: string, message: string) => Promise<void>;
  aiStreamUrl: (id: string) => string | Promise<string>;
  aiStopSession: (id: string) => Promise<void>;
  aiDeleteSession: (id: string) => Promise<void>;
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
