/// <reference lib="dom" />
import { streamImport } from "@jxsuite/studio/import-client";
import { toBase64 } from "@jxsuite/studio/base64";
import { setPreviewNavigateHandler } from "@jxsuite/studio/preview-navigate";
import type {
  AppInfo,
  ComponentMeta,
  CreateProjectDestination,
  ExtensionsInfo,
  FsEvent,
  ImportProgressEvent,
  ImportSiteOptions,
  RecentProjectEntry,
  ReferencesResult,
  RenameResult,
  SiteBuildResult,
  SitePreviewResult,
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
  SettingsPatch,
} from "@jxsuite/protocol";
import type {
  CodeServiceResult,
  DirEntry,
  GitBranchesResult,
  GitLogEntry,
  GitStatusResult,
  PackageInfo,
  PackageOpResult,
  PackageVersionInfo,
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

  /* Server-initiated frames (`method`, no `id`) — the twin of electrobun's `handlers.messages`.
     A launcher speaks first for the things the shell cannot ask about: a file changed under the
     project root, or another window asked this one to come forward. */
  const messages: Record<string, (params: never) => void> = {
    /* Raise this window. The launcher relays it when a second window is asked to open a project
       this one already holds; nothing else in the shell can bring an OS window forward. */
    focusWindow: () => {
      try {
        window.focus();
      } catch {
        // A window manager that refuses the raise simply leaves the window where it is.
      }
    },
    /* Batched filesystem changes from the backend watcher — the sidebar's live sync. */
    onFileEvents: (params: { events?: FsEvent[] }) => {
      const { events } = params;
      if (events && events.length > 0) {
        fileEventHandler?.(events);
      }
    },
    /* Another window's settings change. Every chromium window is its own process, so this is the
       only way one hears about another. */
    settingsChanged: (params: { settings?: Record<string, string> }) => {
      if (params.settings) {
        settingsHandler?.(params.settings);
      }
    },
  };

  // The studio sidebar's live-sync subscriber, if any. Set via subscribeFileEvents below.
  let fileEventHandler: ((events: FsEvent[]) => void) | null = null;
  /** The settings kernel's subscriber, so another window's change reaches this one. */
  let settingsHandler: ((settings: Record<string, string>) => void) | null = null;

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as {
      id?: number;
      method?: string;
      params?: unknown;
      error?: string;
      result?: unknown;
    };
    if (msg.method) {
      // Unsolicited: dispatch by name. An unknown method is a newer launcher talking to an older
      // Shell, which is not an error — it is a message this build has no use for.
      messages[msg.method]?.(msg.params as never);
      return;
    }
    const p = msg.id === undefined ? undefined : pending.get(msg.id);
    if (!p) {
      return;
    }
    pending.delete(msg.id!);
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
          nextId += 1;
          const id = nextId;
          pending.set(id, { reject, resolve });
          ws.send(JSON.stringify({ id, method, params }));
        }),
    );
  }

  /*
   * Preview link clicks go to the user's REAL browser, not this app window.
   *
   * Following a link in Preview exists to see the page behave like the deployed thing — routing,
   * history, devtools. A Chromium `--app` window has no address bar and no tab strip, so it is not
   * that, and navigating THIS one would replace the editor. The Bun side hands the URL to the OS
   * (`Utils.openExternal`); on failure the studio's own `window.open` default still applies.
   *
   * `View: Open in Browser` reuses the same seam, which is why it belongs here and not only on
   * electrobun: without it the built page opened in a second frameless app window.
   */
  setPreviewNavigateHandler((url: string) => {
    const fallback = () => {
      window.open(url, "_blank", "noopener,noreferrer");
    };
    /* `{ ok: false }` is a REFUSAL, not a rejection — the backend answers the request either way.
       Branching only on a thrown error left the click doing nothing at all whenever the desktop had
       no opener to hand it to. */
    void request("openExternal", { url })
      .then((result) => {
        if (!(result as { ok?: boolean } | null)?.ok) {
          fallback();
        }
      })
      .catch(fallback);
  });

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

    async patchSettings(patch: SettingsPatch) {
      return request("patchSettings", { patch }) as Promise<Record<string, string>>;
    },

    subscribeSettings(handler: (settings: Record<string, string>) => void) {
      settingsHandler = handler;
      return () => {
        settingsHandler = null;
      };
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
      return (await request("uploadFile", { data: await toBase64(data), path })) as {
        path: string;
        size: number;
      };
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

    /**
     * Live filesystem sync for the sidebar.
     *
     * The launcher watches the project root for the whole life of the window (it re-arms itself
     * whenever the root changes) and pushes batched events as `onFileEvents` frames, so this only
     * has to say where they go. Without it the chromium sidebar refreshed only when asked, and a
     * file written by a terminal — or by the AI assistant — stayed invisible until then.
     */
    subscribeFileEvents(handler: (events: FsEvent[]) => void) {
      fileEventHandler = handler;
      return () => {
        if (fileEventHandler === handler) {
          fileEventHandler = null;
        }
      };
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

    /**
     * Build the site to its output directory and name the origin it is browsable at.
     *
     * `View: Open in Browser` runs this before it opens anything, so the reader sees the OUTPUT the
     * author's document produces rather than whatever the last build happened to leave on disk. The
     * origin is the backend's to name: the built site is served on a port of its own, because this
     * launcher's own paths mean the project's SOURCES and a built page means its output by those
     * very same paths.
     */
    async buildSite() {
      return request("buildSite") as Promise<SiteBuildResult>;
    },

    /**
     * The live preview, and the origin is the backend's to name for the same reason the built
     * site's is: it is served on a port of its own, per project rather than per window, so a tab
     * outlives the window that opened it.
     */
    async previewSite(opts: { route: string }) {
      return request("previewSite", opts) as Promise<SitePreviewResult>;
    },

    async setPreviewOverlay(path: string, contents: string) {
      await request("setPreviewOverlay", { contents, path });
    },

    async clearPreviewOverlay(path?: string) {
      await request("clearPreviewOverlay", path === undefined ? {} : { path });
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

    async packageVersions() {
      return request("packageVersions") as Promise<PackageVersionInfo[]>;
    },

    async setPackageVersions(updates: { name: string; version: string; dev?: boolean }[]) {
      return request("setPackageVersions", { updates }) as Promise<PackageOpResult>;
    },

    /**
     * Build info for the About screen.
     *
     * The channel is the honest difference between the two desktop builds: this one is installed
     * and updated by the system package manager, so it reports no `updateStatus` — an in-app
     * updater it does not have could only ever answer "unknown".
     */
    async getAppInfo() {
      return request("appInfo") as Promise<AppInfo>;
    },

    // ─── Multi-window ───────────────────────────────────────────────────────────
    /* A window is a launcher process here, where on electrobun it is a BrowserWindow inside one.
       Studio cannot tell the difference: it asks which project, then asks for it elsewhere, and
       both launchers answer whether a window was opened or an existing one raised. */

    /**
     * Pick a project WITHOUT binding this window to it — the New Window branch of Open Project.
     * `openProject()` re-roots the asking window as a side effect of picking, which is the one
     * thing this branch must not do.
     */
    async pickProject() {
      return request("pickProject") as Promise<{ root: string; name: string } | null>;
    },

    /** Open a project in another window, focusing the window that already holds it if there is one. */
    async openProjectInNewWindow(root: string) {
      return request("openProjectInNewWindow", { root }) as Promise<{ focused: boolean }>;
    },

    /** Open a fresh welcome window. */
    async newWindow() {
      await request("newWindow");
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
