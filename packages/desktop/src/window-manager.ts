/**
 * Multi-window manager. One Bun process owns N windows; each window has its own ProjectSession and
 * its own RPC bound to that session, so windows track independent projects. Dedupe by normalized
 * project root: opening an already-open project focuses the existing window instead of
 * duplicating.
 *
 * @docs studio/desktop
 */

import { BrowserView, BrowserWindow, Screen } from "electrobun/main";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyUpdate,
  checkForUpdate,
  composeAppInfo,
  downloadUpdate,
  getLocalInfo,
  getStatus,
} from "./updater";
import { createGitOps } from "./git";
import { createPackageOps } from "./packages";
import { createProjectServer } from "@jxsuite/server/project-server";
import { listStarters } from "@jxsuite/starters";
import { createProjectSession, pickProjectFile } from "./project-session";
import { readRecents, writeRecents } from "./recent-store";
import { readSettings, writeSettings } from "./settings-store";
import {
  githubSignIn,
  githubSignOut,
  githubTokenStatus,
  setAuthorizationHost,
} from "./github-signin";
import { studioDir } from "./canvas-runtime";
import type { ProjectServerHandle } from "@jxsuite/server/project-server";
import type { ProjectSession } from "./project-session";
import type { SiteConfig, StudioRPC } from "./rpc-schema";

interface WindowEntry {
  win: BrowserWindow;
  rpc: ReturnType<typeof buildWindowRpc>;
  session: ProjectSession;
  projectRoot: string | null;
  /**
   * This window's own loopback createProjectServer (the cross-origin canvas path). Its single
   * session is THIS window's session, so an asset GET is unambiguous (no ?win= needed) and a token
   * from window A cannot drive window B. Torn down in {@link disposeWindow}.
   */
  server?: ProjectServerHandle;
  maximize: {
    maximized: boolean;
    restoreFrame: { x: number; y: number; width: number; height: number };
  };
}

const windows = new Map<number, WindowEntry>();

// The AI SSE server is a single shared HTTP server owned by index.ts; its URL is injected here so
// Per-window RPC handlers can hand the webview a stream URL.
let aiServerUrl = "";

export function setAiServerUrl(url: string) {
  aiServerUrl = url;
}

// The token-gated import-site endpoint on the same shared server (full URL incl. its token).
let importServiceUrl = "";

export function setImportServiceUrl(url: string) {
  importServiceUrl = url;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeRoot(root: string): string {
  let r = resolve(root);
  try {
    r = realpathSync.native(r);
  } catch {
    // Path may not exist yet (e.g. a freshly created project) — fall back to the resolved form.
  }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function titleFor(root: string | null): string {
  if (!root) {
    return "Jx Studio";
  }
  const name =
    root
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || "Jx Studio";
  return `${name} — Jx Studio`;
}

function findWindowByRoot(root: string, except?: WindowEntry): WindowEntry | null {
  const key = normalizeRoot(root);
  for (const entry of windows.values()) {
    if (entry === except) {
      continue;
    }
    if (entry.projectRoot && normalizeRoot(entry.projectRoot) === key) {
      return entry;
    }
  }
  return null;
}

function activate(entry: WindowEntry) {
  try {
    entry.win.activate();
  } catch {
    // Best-effort focus
  }
}

export function listOpenWindows(): { id: number; projectRoot: string | null }[] {
  return [...windows.values()].map((e) => ({ id: e.win.id, projectRoot: e.projectRoot }));
}

/** Send an updateReady message to every open window (updater is process-shared). */
export function broadcastUpdateReady(version: string) {
  for (const entry of windows.values()) {
    try {
      entry.rpc.send.updateReady({ version });
    } catch {
      // Webview may not be ready yet; the updater repeats on its interval
    }
  }
}

/** Parse a `file://…/project.json` open-url into the project directory, or null if not one. */
export function parseProjectDirFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "file:") {
      return null;
    }
    const filePath = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
    if (!filePath.endsWith("project.json")) {
      return null;
    }
    return filePath.slice(0, filePath.lastIndexOf("/"));
  } catch {
    return null;
  }
}

// ─── Window lifecycle ───────────────────────────────────────────────────────────

/**
 * Open a window for a project (dedupe-focus if already open), or a welcome window when projectRoot
 * is null. Returns the (new or focused) window.
 */
export function openProjectWindow(projectRoot: string | null): BrowserWindow {
  if (projectRoot) {
    const existing = findWindowByRoot(projectRoot);
    if (existing) {
      activate(existing);
      return existing.win;
    }
  }

  const session = createProjectSession(projectRoot);
  const entry: WindowEntry = {
    win: undefined as unknown as BrowserWindow,
    rpc: undefined as unknown as ReturnType<typeof buildWindowRpc>,
    session,
    projectRoot,
    maximize: { maximized: false, restoreFrame: { height: 900, width: 1400, x: 0, y: 0 } },
  };

  // The window is constructed after its rpc, so handlers read entry.win lazily via getWin().
  entry.rpc = buildWindowRpc(entry, () => entry.win);
  // Push filesystem changes to the webview so the sidebar stays live (mirrors the dev server's SSE).
  session.setFileEventSink((events) => {
    try {
      entry.rpc.send.onFileEvents({ events });
    } catch {}
  });
  entry.win = new BrowserWindow({
    frame: { height: 900, width: 1400, x: 0, y: 0 },
    navigationRules: "^*,views://*,http://127.0.0.1:*",
    rpc: entry.rpc,
    title: titleFor(projectRoot),
    titleBarStyle: "hidden",
    url: "views://studio/index.html",
  });

  windows.set(entry.win.id, entry);
  // Stand up THIS window's own loopback project server (the cross-origin canvas path). Its single
  // Session tracks this window's session.projectRoot, so an asset GET is unambiguous and no
  // Cross-window token reuse is possible. The studio shell reads its canvasUrl via getCanvasUrl().
  const handlers = buildWsHandlers(entry);
  const windowSession = {
    get projectRoot(): string | null {
      return entry.session.projectRoot;
    },
    handlers,
  };
  entry.server = createProjectServer({
    resolveSession: () => windowSession,
    studioDir: studioDir(),
  });
  /*
   * The OAuth redirect lands on THIS window's loopback server, so the newest window owns the
   * redirect. That is the right answer for a flow the user starts from a window and finishes in a
   * browser seconds later; a sign-in outstanding when another window opens is abandoned, and says
   * so, rather than silently redirecting to a port nobody is listening on.
   */
  if (entry.server) {
    setAuthorizationHost({
      authorizer: entry.server.authorizer,
      port: entry.server.server.port ?? 0,
    });
  }
  entry.win.on("close", () => disposeWindow(entry.win.id));
  return entry.win;
}

/**
 * The canvas-facing WS-RPC handler subset for a window's loopback server: jxResolve /
 * jxServerFunction (the canvas live-render path) plus the read paths. Window controls, git,
 * dialogs, and writes stay ONLY on the Electroview RPC (never exposed on the loopback surface).
 */
function buildWsHandlers(
  entry: WindowEntry,
): Record<string, (params: unknown) => Promise<unknown>> {
  const { session } = entry;
  return {
    jxResolve: (params) => session.jxResolve(params as { body: string }),
    jxServerFunction: (params) => session.jxServerFunction(params as { body: string }),
    readFile: (params) => session.handleReadFile(params as { path: string }),
    resolveSiteContext: (params) =>
      session.handleResolveSiteContext(params as { filePath: string }),
  };
}

function disposeWindow(id: number) {
  const entry = windows.get(id);
  if (!entry) {
    return;
  }
  entry.server?.stop(); // Per-window teardown (tab close does NOT call this)
  entry.session.setProjectRoot(null); // Drops the format-registry cache
  windows.delete(id);
}

// ─── Per-window RPC ─────────────────────────────────────────────────────────────

function buildWindowRpc(entry: WindowEntry, getWin: () => BrowserWindow) {
  const { session } = entry;
  const git = createGitOps(session);
  const pkg = createPackageOps(session);

  return BrowserView.defineRPC<StudioRPC>({
    handlers: {
      messages: {},
      requests: {
        // Packages
        addPackage: (params) => pkg.addPackage(params),
        dependenciesNeedInstall: () => pkg.dependenciesNeedInstall(),
        installDependencies: () => pkg.installDependencies(),
        listPackages: () => pkg.listPackages(),
        outdatedPackages: () => pkg.outdatedPackages(),
        removePackage: (params) => pkg.removePackage(params),
        setPackageVersions: (params) => pkg.setPackageVersions(params),

        // AI (Stack B: hand the webview the absolute SSE proxy URL on the shared local server)
        aiChatUrl: () => `${aiServerUrl}/__studio/ai/chat`,

        // Import (the token-gated NDJSON endpoint on the shared local server) + directory picker
        importSiteUrl: () => importServiceUrl,
        pickDirectory: () => session.pickDirectory(),

        // The picker WITHOUT the binding. `openProject` below re-roots this window's session as
        // Part of picking, which is the one thing the New Window branch must not do — it asks
        // Which project, then hands the answer to `openProjectInNewWindow`.
        pickProject: async () => {
          const picked = await pickProjectFile();
          return picked && { name: picked.name, root: picked.root };
        },

        // Files / project (bound to this window's session)
        codeService: (params) => session.codeService(params),
        createDirectory: (params) => session.handleCreateDirectory(params),
        deleteFile: (params) => session.handleDeleteFile(params),
        discoverComponents: (params) => session.discoverComponents(params),
        fetchPluginSchema: (params) => session.fetchPluginSchema(params),
        formatAction: (params) => session.formatAction(params),
        jxResolve: (params) => session.jxResolve(params),
        jxServerFunction: (params) => session.jxServerFunction(params),
        fetchProjectSchemas: () => session.fetchProjectSchemas(),
        buildSite: () => session.buildSite(),
        listDirectory: (params) => session.listDirectory(params),
        listExtensions: () => session.listExtensions(),
        listFormats: () => session.listFormats(),
        locateFile: (params) => session.locateFile(params),
        openExternal: (params) => session.openExternal(params),
        searchFiles: (params) => session.searchFiles(params),
        openProject: async () => {
          const result = await session.openProject();
          if (result) {
            entry.projectRoot = session.projectRoot;
            try {
              getWin().setTitle(titleFor(session.projectRoot));
            } catch {}
          }
          return result;
        },
        createProject: async (params) => {
          const result = await session.createProject(params);
          entry.projectRoot = session.projectRoot;
          try {
            getWin().setTitle(titleFor(session.projectRoot));
          } catch {}
          return result;
        },
        listStarters: () => Promise.resolve(listStarters()),
        readFile: (params) => session.handleReadFile(params),
        renameFile: (params) => session.handleRenameFile(params),
        findReferences: (params) => session.findReferences(params),
        resolveSiteContext: (params) => session.handleResolveSiteContext(params),
        uploadFile: (params) => session.handleUploadFile(params),
        writeFile: (params) => session.handleWriteFile(params),

        // Data surface + secrets (bound to this window's session)
        dataConnections: () => session.dataConnections(),
        dataConnectionTest: (params) => session.dataConnectionTest(params),
        dataPush: (params) => session.dataPush(params),
        dataRows: (params) => session.dataRows(params),
        dataInsertRow: (params) => session.dataInsertRow(params),
        dataUpdateRow: (params) => session.dataUpdateRow(params),
        dataDeleteRow: (params) => session.dataDeleteRow(params),
        listSecrets: () => session.listSecrets(),
        setSecrets: (params) => session.setSecrets(params),

        // Git (bound to this window's session)
        gitAddRemote: (params) => git.gitAddRemote(params),
        gitBranches: () => git.gitBranches(),
        gitCheckout: (params) => git.gitCheckout(params),
        gitCommit: (params) => git.gitCommit(params),
        gitCreateBranch: (params) => git.gitCreateBranch(params),
        gitDiff: (params) => git.gitDiff(params),
        gitDiscard: (params) => git.gitDiscard(params),
        gitFetch: () => git.gitFetch(),
        gitInit: () => git.gitInit(),
        gitLog: (params) => git.gitLog(params),
        gitPull: () => git.gitPull(),
        gitPush: (params) => git.gitPush(params),
        gitShow: (params) => git.gitShow(params),
        gitStage: (params) => git.gitStage(params),
        gitStatus: () => git.gitStatus(),
        gitUnstage: (params) => git.gitUnstage(params),

        // Recent projects (process-shared, user-level store)
        getRecentProjects: () => readRecents(),
        saveRecentProjects: (params) => writeRecents(params.projects),

        // User settings (process-shared, user-level store)
        getSettings: () => readSettings(),
        saveSettings: (params) => writeSettings(params.settings),

        // GitHub sign-in (RFC 8252 loopback + PKCE, hosted on this window's own server)
        githubSignIn: (params) => githubSignIn(params),
        githubSignOut: () => githubSignOut(),
        githubToken: () => githubTokenStatus(),

        // About screen (composed from the updater, which only this launcher has)
        appInfo: () => composeAppInfo(),

        // Updater (process-shared)
        updaterApplyUpdate: () => applyUpdate(),
        updaterCheckForUpdate: () => checkForUpdate(),
        updaterDownloadUpdate: () => downloadUpdate(),
        updaterGetLocalInfo: () => getLocalInfo(),
        updaterGetStatus: () => getStatus(),

        // Window controls (this window only)
        windowClose: () => {
          getWin().close();
        },
        windowGetFrame: () => getWin().getFrame(),
        windowMaximize: () => {
          const win = getWin();
          if (entry.maximize.maximized) {
            const f = entry.maximize.restoreFrame;
            win.setFrame(f.x, f.y, f.width, f.height);
            entry.maximize.maximized = false;
          } else {
            entry.maximize.restoreFrame = win.getFrame();
            const display = Screen.getPrimaryDisplay();
            const { x, y, width, height } = display.workArea;
            win.setFrame(x, y, width, height);
            entry.maximize.maximized = true;
          }
        },
        windowMinimize: () => {
          getWin().minimize();
        },
        windowSetFrame: (params) => {
          getWin().setFrame(params.x, params.y, params.width, params.height);
        },

        // Multi-window
        newWindow: () => {
          openProjectWindow(null);
        },
        openProjectInNewWindow: (params) => {
          // Asked BEFORE opening, because `openProjectWindow` answers both cases with a window and
          // The caller has to be able to say which one it got.
          const focused = findWindowByRoot(params.root) !== null;
          openProjectWindow(params.root);
          return { focused };
        },
        getProjectRoot: () => ({ root: session.projectRoot }),
        // Hand the studio shell this window's cross-origin loopback canvas URL.
        getCanvasUrl: () => {
          const srv = entry.server;
          if (!srv) {
            return { canvasUrl: null };
          }
          // Append the server rpcToken so the in-iframe runtime can authenticate its dev-proxy
          // Resolve/server fetches (the host adds the separate channel `token` param on top).
          const u = new URL(srv.canvasUrl);
          u.searchParams.set("rpcToken", srv.rpcToken);
          return { canvasUrl: u.href };
        },
        listOpenWindows: () => listOpenWindows(),
        setWindowProject: async (params) => {
          // Dedupe: if another window already owns this project, focus it and tell the caller.
          const existing = findWindowByRoot(params.root, entry);
          if (existing) {
            activate(existing);
            return { config: null, deduped: true };
          }
          session.setProjectRoot(params.root);
          entry.projectRoot = params.root;
          try {
            getWin().setTitle(titleFor(params.root));
          } catch {}
          let config: SiteConfig | null = null;
          try {
            config = JSON.parse(
              await session.handleReadFile({ path: "project.json" }),
            ) as SiteConfig;
          } catch {}
          return { config, deduped: false };
        },
      },
    },
    maxRequestTime: 300_000,
  });
}
