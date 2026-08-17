/// <reference lib="dom" />
import { streamImport } from "@jxsuite/studio/import-client";
import { toBase64 } from "@jxsuite/studio/base64";
import type {
  ComponentMeta,
  CreateProjectDestination,
  ExtensionsInfo,
  ImportProgressEvent,
  ImportSiteOptions,
  RecentProjectEntry,
  ReferencesResult,
  RenameResult,
  StarterInfo,
  StudioPlatform,
} from "@jxsuite/studio/types";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type {
  DataConnectionsResponse,
  DataConnectionTestResult,
  DataPushResult,
  DataRowDelete,
  DataRowInsert,
  DataRowsQuery,
  DataRowsResult,
  DataRowUpdate,
  SecretsListResponse,
  SecretsSetRequest,
  SecretsSetResponse,
} from "@jxsuite/protocol";
import type {
  CodeServiceResult,
  DirEntry,
  GitBranchesResult,
  GitLogEntry,
  GitStatusResult,
  OutdatedInfo,
  PackageInfo,
  PackageOpResult,
} from "../rpc-schema";

/* Inferred return type with a `satisfies` conformance check at the bottom, so callers see which of
   the PAL's OPTIONAL members this launcher actually implements — annotating `StudioPlatform` made
   every one of them `| undefined` at the call site, including in this package's own tests. */
export function createDesktopPlatform() {
  // The project server gates the WS upgrade on the token. The launcher passes it in the shell URL
  // (?token=…); read it here before the shell strips it from the address bar after boot.
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const ws = new WebSocket(`ws://${location.host}/?token=${encodeURIComponent(token)}`);
  // The canvas iframe runs the in-iframe runtime, which authenticates its dev-proxy loopback
  // Resolve/server fetches with this same per-process rpcToken (?rpcToken=…). Thread it onto the
  // Canvas URL when present so createProjectServer does not 403 those fetches; keep the bare path
  // Otherwise so a token-less/dev context stays byte-identical. Mirrors electrobun's getCanvasUrl.
  const canvasUrl = token
    ? `/__studio__/canvas.html?rpcToken=${encodeURIComponent(token)}`
    : "/__studio__/canvas.html";
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as {
      id: number;
      error?: string;
      result?: unknown;
    };
    const p = pending.get(msg.id);
    if (!p) {
      return;
    }
    pending.delete(msg.id);
    if (msg.error) {
      p.reject(new Error(msg.error));
    } else {
      p.resolve(msg.result);
    }
  });

  const ready = new Promise<void>((resolve) => {
    ws.addEventListener("open", () => resolve());
  });

  function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return ready.then(
      () =>
        new Promise((resolve, reject) => {
          const id = (nextId += 1);
          pending.set(id, { reject, resolve });
          ws.send(JSON.stringify({ id, method, params }));
        }),
    );
  }

  const platform = {
    id: "desktop" as const,

    /* New projects go where the user says: the modal's Location field, with Browse… backed by the
       XDG portal dialog below. The backend refuses a create without one. */
    createDestination: "path" as const,

    projectRoot: "",

    // The chromium project server serves the canvas iframe doc under /__studio__/. Only chromium
    // Sets this; electrobun and the dev server leave it unset and keep their default canvas path.
    // The ?rpcToken (computed above) authenticates the in-iframe runtime's loopback resolve/server
    // Fetches, mirroring electrobun's getCanvasUrl RPC.
    canvasUrl,

    async activate() {
      // No-op: the chromium platform needs no activation step
    },

    async openProject() {
      return request("openProject") as Promise<{
        config: ProjectConfig;
        handle: { root: string; name: string; projectConfig: ProjectConfig };
      } | null>;
    },

    async probeRootProject() {
      try {
        const content = await request("readFile", { path: "project.json" });
        const config = JSON.parse(content as string) as { name?: string };
        // Resolve the absolute backend root so the recent-projects list gets a re-openable key.
        const { root } = (await request("getProjectRoot")) as { root: string | null };
        return {
          info: {
            directories: [] as string[],
            isSiteProject: true as const,
            projectConfig: config as ProjectConfig,
          },
          meta: { name: config.name || "project", root: root || "." },
        };
      } catch {
        // The launcher's root defaults to the launch cwd, which usually holds no project.json.
        // Report "no project" (null) so the studio shows the welcome screen — returning a phantom
        // Non-site project instead sets projectState and suppresses the welcome screen for the
        // Whole session (mirrors the electrobun platform's probeRootProject contract).
        return null;
      }
    },

    async getProjectRoot() {
      return request("getProjectRoot") as Promise<{ root: string | null }>;
    },

    async setWindowProject(root: string) {
      return request("setWindowProject", { root }) as Promise<{
        deduped: boolean;
        config: ProjectConfig | null;
      }>;
    },

    // ─── Recent projects (user-level store, shared across per-project profiles) ──

    async getRecentProjects() {
      return request("getRecentProjects") as Promise<RecentProjectEntry[]>;
    },

    async saveRecentProjects(projects: RecentProjectEntry[]) {
      await request("saveRecentProjects", { projects });
    },

    /*
     * GitHub sign-in, launcher-only like the electrobun launcher's: the browser Studio has no
     * loopback server to redirect to and keeps the device flow, so this is not a PAL member.
     */
    githubAuth: {
      signIn: (force = false) => request("githubSignIn", { force }) as Promise<{ token: string }>,
      signOut: () => request("githubSignOut") as Promise<{ ok: boolean }>,
      status: () => request("githubToken") as Promise<{ stored: boolean }>,
    },

    // ─── User settings (user-level store, shared across per-project profiles) ──

    async getSettings() {
      return request("getSettings") as Promise<Record<string, string>>;
    },

    async saveSettings(settings: Record<string, string>) {
      await request("saveSettings", { settings });
    },

    async resolveSiteContext(filePath: string) {
      return request("resolveSiteContext", { filePath }) as Promise<{
        sitePath: string | null;
        projectConfig?: ProjectConfig;
        fileRelPath?: string;
      }>;
    },

    async listDirectory(dir: string) {
      return request("listDirectory", { dir }) as Promise<DirEntry[]>;
    },

    async readFile(path: string) {
      return request("readFile", { path }) as Promise<string>;
    },

    async writeFile(path: string, content: string) {
      return request("writeFile", { content, path }) as Promise<void>;
    },

    // The WS transport JSON-serializes params, so binary must be base64 before it goes on the wire
    // (a File/Blob would serialize to `{}`); the backend base64-decodes. A string passes through.
    async uploadFile(path: string, data: string | File | Blob | ArrayBuffer) {
      return request("uploadFile", { data: await toBase64(data), path }) as Promise<unknown>;
    },

    async deleteFile(path: string) {
      return request("deleteFile", { path }) as Promise<void>;
    },

    async renameFile(from: string, to: string) {
      return request("renameFile", { from, to }) as Promise<RenameResult>;
    },

    async findReferences(target: { path?: string; tagName?: string }) {
      return request("findReferences", target) as Promise<ReferencesResult>;
    },

    async createDirectory(path: string) {
      return request("createDirectory", { path }) as Promise<void>;
    },

    async discoverComponents(dir?: string) {
      return request("discoverComponents", { dir }) as Promise<ComponentMeta[]>;
    },

    async codeService(action: string, payload: unknown) {
      return request("codeService", {
        action,
        payload,
      }) as Promise<CodeServiceResult | null>;
    },

    async locateFile(name: string) {
      return request("locateFile", { name }) as Promise<string | null>;
    },

    async fetchPluginSchema(src: string, prototype?: string, base?: string) {
      return request("fetchPluginSchema", {
        base,
        prototype,
        src,
      }) as Promise<unknown>;
    },

    async gitStatus() {
      return request("gitStatus") as Promise<GitStatusResult>;
    },

    async gitBranches() {
      return request("gitBranches") as Promise<GitBranchesResult>;
    },

    async gitLog(limit?: number) {
      return request("gitLog", { limit }) as Promise<GitLogEntry[]>;
    },

    async gitStage(files: string[]) {
      return request("gitStage", { files }) as Promise<void>;
    },

    async gitUnstage(files: string[]) {
      return request("gitUnstage", { files }) as Promise<void>;
    },

    async gitCommit(message: string) {
      return request("gitCommit", { message }) as Promise<void>;
    },

    async gitPush(opts?: { setUpstream?: boolean }) {
      return request("gitPush", opts || {}) as Promise<void>;
    },

    async gitPull() {
      return request("gitPull") as Promise<void>;
    },

    async gitFetch() {
      return request("gitFetch") as Promise<void>;
    },

    async gitCheckout(branch: string) {
      return request("gitCheckout", { branch }) as Promise<void>;
    },

    async gitCreateBranch(name: string) {
      return request("gitCreateBranch", { name }) as Promise<void>;
    },

    async gitDiff(path?: string) {
      return request("gitDiff", { path }) as Promise<string>;
    },

    async gitDiscard(files: string[]) {
      return request("gitDiscard", { files }) as Promise<void>;
    },

    async gitShow(opts: { path: string; ref?: string }) {
      return request("gitShow", opts) as Promise<string>;
    },

    async gitInit() {
      await request("gitInit");
    },

    async gitAddRemote(name: string, url: string) {
      await request("gitAddRemote", { name, url });
    },

    async searchFiles(query: string, extensions?: string[]) {
      return request("searchFiles", { extensions, query }) as Promise<DirEntry[]>;
    },

    async listFormats() {
      return request("listFormats", {}) as Promise<Record<string, unknown>[]>;
    },

    /** The extensions payload behind descriptor-contributed settings sections. */
    async listExtensions() {
      return request("listExtensions", {}) as Promise<ExtensionsInfo[]>;
    },

    /** Pre-bundled per-project entry schemas for Monaco registration. */
    async fetchProjectSchemas() {
      return request("fetchProjectSchemas", {}) as Promise<{
        project?: Record<string, unknown>;
        document?: Record<string, unknown>;
      }>;
    },

    // ─── Data surface + secrets (owner console; names-only secrets) ────────────

    async dataConnections() {
      return request("dataConnections", {}) as Promise<DataConnectionsResponse>;
    },

    async dataConnectionTest(connection: string) {
      return request("dataConnectionTest", { connection }) as Promise<DataConnectionTestResult>;
    },

    async dataPush(opts?: { connection?: string; dryRun?: boolean }) {
      return request("dataPush", opts ?? {}) as Promise<DataPushResult>;
    },

    async dataRows(query: DataRowsQuery) {
      return request("dataRows", { ...query }) as Promise<DataRowsResult>;
    },

    async dataInsertRow(req: DataRowInsert) {
      return request("dataInsertRow", { ...req }) as Promise<{ row: Record<string, unknown> }>;
    },

    async dataUpdateRow(req: DataRowUpdate) {
      return request("dataUpdateRow", { ...req }) as Promise<{ row: Record<string, unknown> }>;
    },

    async dataDeleteRow(req: DataRowDelete) {
      return request("dataDeleteRow", { ...req }) as Promise<{ ok: boolean }>;
    },

    async listSecrets() {
      const res = (await request("listSecrets", {})) as SecretsListResponse;
      return res.names;
    },

    async setSecrets(req: SecretsSetRequest) {
      return request("setSecrets", { ...req }) as Promise<SecretsSetResponse>;
    },

    /**
     * Class resolution over HTTP: the project server gates `/__jx_resolve__` on the RPC token (a
     * token-less fetch 403s), so pass the token captured from the shell URL.
     *
     * @param {Record<string, unknown>} body
     */
    async resolveClass(body: Record<string, unknown>) {
      const res = await fetch(`/__jx_resolve__?token=${encodeURIComponent(token)}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(`Class resolution failed: ${res.status}`);
      }
      return (await res.json()) as unknown;
    },

    /** @param {Record<string, unknown>} payload */
    async formatAction(payload: Record<string, unknown>) {
      return request("formatAction", payload);
    },

    async addPackage(name: string) {
      return request("addPackage", { name }) as Promise<unknown>;
    },

    async removePackage(name: string) {
      return request("removePackage", { name }) as Promise<unknown>;
    },

    async listPackages() {
      return request("listPackages") as Promise<PackageInfo[]>;
    },

    async installDependencies() {
      return request("installDependencies") as Promise<PackageOpResult>;
    },

    async dependenciesNeedInstall() {
      return request("dependenciesNeedInstall") as Promise<boolean>;
    },

    async outdatedPackages() {
      return request("outdatedPackages") as Promise<OutdatedInfo[]>;
    },

    async setPackageVersions(updates: { name: string; version: string; dev?: boolean }[]) {
      return request("setPackageVersions", { updates }) as Promise<PackageOpResult>;
    },

    async createProject(opts: {
      name: string;
      description?: string;
      url?: string;
      adapter?: string;
      directory: string;
      /* The full PAL union, not just the `path` variant this launcher can act on: the parameter is
         contravariant, so narrowing it here makes the whole platform object unassignable to
         StudioPlatform. `createDestination: "path"` is what actually stops Studio sending a repo. */
      destination: CreateProjectDestination;
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
    }) {
      const { destination } = opts;
      if (destination.kind !== "path") {
        throw new Error("This launcher creates projects on disk; repo destinations are cloud-only");
      }
      return request("createProject", { ...opts, destination }) as Promise<{
        root: string;
        config: ProjectConfig;
      }>;
    },

    async listStarters() {
      return request("listStarters") as Promise<StarterInfo[]>;
    },

    /**
     * Folder chooser for the New Project modal. This build has a real native dialog — the XDG
     * desktop portal, driven from the Bun side — which returns a filesystem path directly. It is
     * deliberately used in preference to Chrome's `showDirectoryPicker()`, whose handle carries no
     * path and would have to be placed by writing a marker file and scanning for it (§8.2.1). That
     * fallback exists only for the plain dev-server browser session, which has no native option at
     * all.
     */
    async pickDirectory() {
      const result = (await request("pickDirectory")) as { path: string | null };
      return result.path;
    },

    // AI-guided site import: streams NDJSON progress from the token-gated loopback endpoint. The
    // Modal resolves the destination before calling (specs/desktop.md §4.5), so `directory` is
    // Already absolute — a relative one means a caller skipped the Location field.
    async importSite(
      opts: ImportSiteOptions,
      onProgress: (evt: ImportProgressEvent) => void,
      signal?: AbortSignal,
    ) {
      const { directory } = opts;
      if (!/^(?:[a-zA-Z]:[\\/]|\/)/.test(directory)) {
        throw new Error("A destination folder is required.");
      }
      return streamImport(
        `/__studio__/import-site?token=${encodeURIComponent(token)}`,
        { ...opts, directory },
        onProgress,
        signal,
      );
    },

    /*
     * AI Assistant (Stack B: OpenAI-compatible SSE proxy on the local chromium server).
     *
     * Tokened, like every other surface that spends something. The route forwards to a provider on
     * the user's own key, so an ungated one is an open relay for any process on the machine — and
     * the project server dispatched it ahead of every gate until it was closed (server.md §4.2).
     */
    aiChatUrl() {
      return `/__studio__/ai/chat?token=${encodeURIComponent(token)}`;
    },
  };

  // On the identifier, not the literal: a fresh literal would get excess property checks.
  return platform satisfies StudioPlatform;
}
