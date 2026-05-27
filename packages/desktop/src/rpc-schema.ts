import type { RPCSchema } from "electrobun/bun";

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
}

export interface ComponentMeta {
  tagName: string;
  $id?: string | null;
  path: string;
  props?: { name: string; type?: string; default?: unknown }[];
  hasElements?: boolean;
}

export interface SiteConfig {
  name?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ProjectHandle {
  root: string;
  name: string;
  projectConfig: SiteConfig;
}

export interface OpenProjectResult {
  config: SiteConfig;
  handle: ProjectHandle;
}

export interface CodeServiceResult {
  code?: string;
  diagnostics?: unknown[];
  [key: string]: unknown;
}

// ─── Git types ───────────────────────────────────────────────────────────────

export interface GitFileStatus {
  status: string;
  path: string;
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

export interface PackageInfo {
  name: string;
  version: string;
}

// ─── Update types ────────────────────────────────────────────────────────────

export interface UpdateLocalInfo {
  version: string;
  hash: string;
  baseUrl: string;
  channel: string;
  name: string;
  identifier: string;
}

export interface UpdateStatus {
  version: string | null;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string | null;
}

// ─── RPC Schema ───────────────────────────────────────────────────────────────

export type StudioRPC = {
  bun: RPCSchema<{
    requests: {
      openProject: {
        params: void;
        response: OpenProjectResult | null;
      };
      listDirectory: {
        params: { dir: string };
        response: DirEntry[];
      };
      readFile: {
        params: { path: string };
        response: string;
      };
      readFileAsDataUrl: {
        params: { path: string };
        response: string;
      };
      writeFile: {
        params: { path: string; content: string };
        response: void;
      };
      deleteFile: {
        params: { path: string };
        response: void;
      };
      renameFile: {
        params: { from: string; to: string };
        response: void;
      };
      createDirectory: {
        params: { path: string };
        response: void;
      };
      uploadFile: {
        params: { path: string; data: string };
        response: void;
      };
      resolveSiteContext: {
        params: { filePath: string };
        response: { sitePath: string | null };
      };
      discoverComponents: {
        params: { dir?: string };
        response: ComponentMeta[];
      };
      codeService: {
        params: { action: string; payload: unknown };
        response: CodeServiceResult | null;
      };
      locateFile: {
        params: { name: string };
        response: string | null;
      };
      fetchPluginSchema: {
        params: { src: string; prototype?: string; base?: string };
        response: unknown | null;
      };
      // Git
      gitStatus: {
        params: void;
        response: GitStatusResult;
      };
      gitBranches: {
        params: void;
        response: GitBranchesResult;
      };
      gitLog: {
        params: { limit?: number };
        response: GitLogEntry[];
      };
      gitStage: {
        params: { files: string[] };
        response: void;
      };
      gitUnstage: {
        params: { files: string[] };
        response: void;
      };
      gitCommit: {
        params: { message: string };
        response: void;
      };
      gitPush: {
        params: { setUpstream?: boolean };
        response: void;
      };
      gitPull: {
        params: void;
        response: void;
      };
      gitFetch: {
        params: void;
        response: void;
      };
      gitCheckout: {
        params: { branch: string };
        response: void;
      };
      gitCreateBranch: {
        params: { name: string };
        response: void;
      };
      gitDiff: {
        params: { path?: string };
        response: string;
      };
      gitShow: {
        params: { path: string; ref?: string };
        response: string;
      };
      gitDiscard: {
        params: { files: string[] };
        response: void;
      };
      gitInit: {
        params: void;
        response: void;
      };
      gitAddRemote: {
        params: { name: string; url: string };
        response: void;
      };
      // Files
      searchFiles: {
        params: { query: string };
        response: DirEntry[];
      };
      // Packages
      addPackage: {
        params: { name: string };
        response: void;
      };
      removePackage: {
        params: { name: string };
        response: void;
      };
      listPackages: {
        params: void;
        response: PackageInfo[];
      };
      createProject: {
        params: {
          name: string;
          description?: string;
          url?: string;
          adapter?: string;
          directory: string;
        };
        response: { root: string; config: ProjectConfig };
      };
      // Updates
      updaterGetLocalInfo: {
        params: void;
        response: UpdateLocalInfo;
      };
      updaterCheckForUpdate: {
        params: void;
        response: UpdateStatus;
      };
      updaterDownloadUpdate: {
        params: void;
        response: UpdateStatus;
      };
      updaterApplyUpdate: {
        params: void;
        response: void;
      };
      updaterGetStatus: {
        params: void;
        response: UpdateStatus;
      };
      // Window controls
      windowMinimize: {
        params: void;
        response: void;
      };
      windowMaximize: {
        params: void;
        response: void;
      };
      windowClose: {
        params: void;
        response: void;
      };
      windowGetFrame: {
        params: void;
        response: { x: number; y: number; width: number; height: number };
      };
      windowSetFrame: {
        params: { x: number; y: number; width: number; height: number };
        response: void;
      };
      // AI Assistant
      aiAuthStatus: {
        params: void;
        response: { authenticated: boolean; error?: string };
      };
      aiCreateSession: {
        params: { message: string; systemPrompt?: string };
        response: { id: string };
      };
      aiSendMessage: {
        params: { id: string; message: string };
        response: void;
      };
      aiStreamUrl: {
        params: { id: string };
        response: string;
      };
      aiStopSession: {
        params: { id: string };
        response: void;
      };
      aiDeleteSession: {
        params: { id: string };
        response: void;
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      fileChanged: { path: string };
      updateReady: { version: string };
    };
  }>;
};
