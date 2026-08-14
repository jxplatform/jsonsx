// oxlint-disable typescript/no-invalid-void-type -- Electrobun RPCSchema uses `void` to mark no-payload params/responses
import type { RPCSchema } from "electrobun/main";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type { FsEventPayload, ReferencesResult, RenameReport } from "@jxsuite/server/refactor";
import type { StarterMeta } from "@jxsuite/starters";
import type {
  ComponentMeta,
  DataConnectionsResponse,
  DataConnectionTestResult,
  DataPushRequest,
  DataPushResult,
  DataRowDelete,
  DataRowInsert,
  DataRowsQuery,
  DataRowsResult,
  DataRowUpdate,
  ExtensionsInfo,
  SecretsListResponse,
  SecretsSetRequest,
  SecretsSetResponse,
} from "@jxsuite/protocol";

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
}

/* Re-exported, not re-declared. A hand copy of this lived here and drifted: `default?: unknown` and
   `fallback?: unknown[]` where the protocol says `JsonValue` and `(JxMutableNode | string)[]`, which
   made every discoverComponents result unassignable to the PAL's own signature — invisible while this
   package went untypechecked. The wire shape belongs to @jxsuite/protocol; keep it there. */
export type { ComponentMeta } from "@jxsuite/protocol";

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

/** A recently-opened project, keyed by its absolute `root` path. */
export interface RecentProjectEntry {
  name: string;
  root: string;
  timestamp: number;
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
  /** True when the dependency lives in `devDependencies` rather than `dependencies`. */
  dev?: boolean;
}

/** A dependency with a newer version available, as reported by `bun outdated` / the npm registry. */
export interface OutdatedInfo {
  name: string;
  current: string;
  latest: string;
  wanted?: string;
  dev?: boolean;
}

/** Result of a package mutation that runs `bun install` (install / set-versions). */
export interface PackageOpResult {
  ok: boolean;
  log?: string;
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

export interface StudioRPC {
  bun: RPCSchema<{
    requests: {
      openProject: {
        params: void;
        response: OpenProjectResult | null;
      };
      /**
       * Hand a URL to the OS. Studio's Preview routes link clicks here so the target opens in the
       * user's real browser rather than a webview with no address bar, history or devtools.
       */
      openExternal: {
        params: { url: string };
        response: { ok: boolean };
      };
      listDirectory: {
        params: { dir: string };
        response: DirEntry[];
      };
      readFile: {
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
        response: RenameReport;
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
      // Class / server-function resolution (mirrors dev-server /__jx_resolve__ & /__jx_server__)
      jxResolve: {
        params: { body: string };
        response: { status: number; body: string };
      };
      jxServerFunction: {
        params: { body: string };
        response: { status: number; body: string };
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
      /**
       * Build the site to its output directory, so `View: Open in Browser` opens what the author is
       * looking at rather than whatever the last build left on disk.
       *
       * Errors come back in the payload, not as a rejection: a partial build still produced pages,
       * and the author is better served by the page they asked for with the failures named beside
       * it.
       */
      buildSite: {
        params: void;
        /* `url` is the origin the result is browsable at — its own port, because this window's
           project server answers for the project's SOURCES and a built page addresses its OUTPUT
           by the same paths. */
        response: { routes: number; files: number; errors: string[]; url?: string };
      };
      // Files
      /* `extensions` mirrors the PAL's second argument (the format registry's document extensions);
         declaring only `query` silently dropped it and made Quick Access .json-only on desktop. */
      searchFiles: {
        params: { query: string; extensions?: string[] };
        response: DirEntry[];
      };
      /* Where a file / component tag is used. Declared AND handled in the same change: this is the
         request that would otherwise repeat searchFiles' failure — a usage count that silently
         answers "0" is indistinguishable from a component nobody has placed yet, and a delete
         confirmation would then promise nothing breaks. The parity test is the guard. */
      findReferences: {
        params: { path?: string; tagName?: string };
        response: ReferencesResult;
      };
      // Formats
      listFormats: {
        params: void;
        response: Record<string, unknown>[];
      };
      // Extensions payload — the formats channel's sibling (specs/extensions.md §9/§9.1)
      /* The studio wire shape, not `Record<string, unknown>[]`: the PAL declares
         `listExtensions?: () => Promise<ExtensionsInfo[]>`, so a loose response type here made the
         whole desktop platform object unassignable to StudioPlatform. */
      listExtensions: {
        params: void;
        response: ExtensionsInfo[];
      };
      // Pre-bundled per-project entry schemas for Monaco (project.schema.json / document.schema.json)
      fetchProjectSchemas: {
        params: void;
        response: {
          project?: Record<string, unknown>;
          document?: Record<string, unknown>;
        };
      };
      formatAction: {
        params: {
          format: string;
          action: string;
          source?: string;
          doc?: Record<string, unknown>;
          options?: Record<string, unknown>;
        };
        response: unknown;
      };
      // Data surface + secrets — desktop twins of /__studio/data/* + /__studio/secrets
      // (@jxsuite/protocol shapes; names-only secrets, owner-console row CRUD)
      dataConnections: {
        params: void;
        response: DataConnectionsResponse;
      };
      dataConnectionTest: {
        params: { connection: string };
        response: DataConnectionTestResult;
      };
      dataPush: {
        params: DataPushRequest;
        response: DataPushResult;
      };
      dataRows: {
        params: DataRowsQuery;
        response: DataRowsResult;
      };
      dataInsertRow: {
        params: DataRowInsert;
        response: { row: Record<string, unknown> };
      };
      dataUpdateRow: {
        params: DataRowUpdate;
        response: { row: Record<string, unknown> };
      };
      dataDeleteRow: {
        params: DataRowDelete;
        response: { ok: boolean };
      };
      listSecrets: {
        params: void;
        response: SecretsListResponse;
      };
      setSecrets: {
        params: SecretsSetRequest;
        response: SecretsSetResponse;
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
      installDependencies: {
        params: void;
        response: PackageOpResult;
      };
      dependenciesNeedInstall: {
        params: void;
        response: boolean;
      };
      outdatedPackages: {
        params: void;
        response: OutdatedInfo[];
      };
      setPackageVersions: {
        params: { updates: { name: string; version: string; dev?: boolean }[] };
        response: PackageOpResult;
      };
      createProject: {
        params: {
          name: string;
          description?: string;
          url?: string;
          adapter?: string;
          directory: string;
          /** Chosen by the user in the New Project modal; the backend never picks one. */
          destination: { kind: "path"; parent: string };
          starter?: string;
          template?: string;
          design?: {
            accent?: string;
            background?: string;
            text?: string;
            bodyFont?: string;
            headingFont?: string;
            media?: Record<string, string>;
            logo?: { name: string; base64: string };
          };
        };
        response: { root: string; config: ProjectConfig };
      };
      listStarters: {
        params: void;
        response: StarterMeta[];
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
      // AI Assistant (Stack B)
      aiChatUrl: {
        params: void;
        response: string;
      };
      // AI-guided site import: the token-gated NDJSON endpoint on the shared services server.
      importSiteUrl: {
        params: void;
        response: string;
      };
      // Native directory picker (New Project import destination).
      pickDirectory: {
        params: void;
        response: { path: string | null };
      };
      // Native project.json picker that binds NOTHING — the choice without the consequence, so
      // "open it in a new window" can ask which project without re-rooting the window that asked.
      pickProject: {
        params: void;
        response: { root: string; name: string } | null;
      };
      // Window management (multi-window)
      newWindow: {
        params: void;
        response: void;
      };
      openProjectInNewWindow: {
        // A window was created for the project, or one already had it and came to the front.
        // The response says which, so the caller can report what actually happened.
        params: { root: string };
        response: { focused: boolean };
      };
      setWindowProject: {
        params: { root: string };
        response: { deduped: boolean; config: SiteConfig | null };
      };
      getProjectRoot: {
        params: void;
        response: { root: string | null };
      };
      // Phase 7: the cross-origin loopback canvas URL for this window, or null on the views:// path.
      getCanvasUrl: {
        params: void;
        response: { canvasUrl: string | null };
      };
      listOpenWindows: {
        params: void;
        response: { id: number; projectRoot: string | null }[];
      };
      // Recent projects (process-shared, user-level store)
      getRecentProjects: {
        params: void;
        response: RecentProjectEntry[];
      };
      saveRecentProjects: {
        params: { projects: RecentProjectEntry[] };
        response: void;
      };
      // User settings (process-shared, user-level store)
      getSettings: {
        params: void;
        response: Record<string, string>;
      };
      saveSettings: {
        params: { settings: Record<string, string> };
        response: void;
      };
    };
    messages: Record<string, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      fileChanged: { path: string };
      updateReady: { version: string };
      onFileEvents: { events: FsEventPayload[] };
    };
  }>;
}
