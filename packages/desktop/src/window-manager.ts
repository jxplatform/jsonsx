/**
 * Multi-window manager. One Bun process owns N windows; each window has its own ProjectSession and
 * its own RPC bound to that session, so windows track independent projects. Dedupe by normalized
 * project root: opening an already-open project focuses the existing window instead of
 * duplicating.
 */

import { BrowserView, BrowserWindow, Screen } from "electrobun/bun";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  createSession,
  deleteSession,
  getAuthStatus,
  sendMessage,
  stopSession,
} from "@jxsuite/server/claude-session";
import { applyUpdate, checkForUpdate, downloadUpdate, getLocalInfo, getStatus } from "./updater";
import { createGitOps } from "./git";
import { createPackageOps } from "./packages";
import { createProjectSession } from "./project-session";
import type { ProjectSession } from "./project-session";
import type { SiteConfig, StudioRPC } from "./rpc-schema";

interface WindowEntry {
  win: BrowserWindow;
  rpc: ReturnType<typeof buildWindowRpc>;
  session: ProjectSession;
  projectRoot: string | null;
  maximize: {
    maximized: boolean;
    restoreFrame: { x: number; y: number; width: number; height: number };
  };
  aiSessionIds: Set<string>;
}

const windows = new Map<number, WindowEntry>();

// The AI SSE server is a single shared HTTP server owned by index.ts; its URL is injected here so
// Per-window RPC handlers can hand the webview a stream URL.
let aiServerUrl = "";

export function setAiServerUrl(url: string) {
  aiServerUrl = url;
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
    aiSessionIds: new Set<string>(),
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
    navigationRules: "views://*,^*",
    rpc: entry.rpc,
    title: titleFor(projectRoot),
    titleBarStyle: "hidden",
    url: "views://studio/index.html",
  });

  windows.set(entry.win.id, entry);
  entry.win.on("close", () => disposeWindow(entry.win.id));
  return entry.win;
}

function disposeWindow(id: number) {
  const entry = windows.get(id);
  if (!entry) {
    return;
  }
  entry.session.setProjectRoot(null); // Drops the format-registry cache
  for (const sid of entry.aiSessionIds) {
    try {
      deleteSession(sid); // Aborts the in-flight query via stopSession
    } catch {}
  }
  entry.aiSessionIds.clear();
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
        listPackages: () => pkg.listPackages(),
        removePackage: (params) => pkg.removePackage(params),

        // AI (sessions are id-keyed and process-global; record ids for cleanup on close)
        aiAuthStatus: () => getAuthStatus(),
        aiCreateSession: (params) => {
          const root = session.projectRoot;
          if (!root) {
            throw new Error("No project open");
          }
          const result = createSession(root, params.message, {
            ...(params.systemPrompt != null && { systemPrompt: params.systemPrompt }),
          });
          entry.aiSessionIds.add(result.id);
          return result;
        },
        aiDeleteSession: (params) => {
          entry.aiSessionIds.delete(params.id);
          deleteSession(params.id);
        },
        aiSendMessage: (params) => {
          sendMessage(params.id, params.message);
        },
        aiStopSession: (params) => {
          stopSession(params.id);
        },
        aiStreamUrl: (params) => `${aiServerUrl}/studio/ai/session/${params.id}/stream`,

        // Files / project (bound to this window's session)
        codeService: (params) => session.codeService(params),
        createDirectory: (params) => session.handleCreateDirectory(params),
        deleteFile: (params) => session.handleDeleteFile(params),
        discoverComponents: (params) => session.discoverComponents(params),
        fetchPluginSchema: (params) => session.fetchPluginSchema(params),
        formatAction: (params) => session.formatAction(params),
        jxResolve: (params) => session.jxResolve(params),
        jxServerFunction: (params) => session.jxServerFunction(params),
        listDirectory: (params) => session.listDirectory(params),
        listFormats: () => session.listFormats(),
        locateFile: (params) => session.locateFile(params),
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
        readFile: (params) => session.handleReadFile(params),
        readFileAsDataUrl: (params) => session.handleReadFileAsDataUrl(params),
        renameFile: (params) => session.handleRenameFile(params),
        resolveSiteContext: (params) => session.handleResolveSiteContext(params),
        uploadFile: (params) => session.handleUploadFile(params),
        writeFile: (params) => session.handleWriteFile(params),

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
        gitStage: (params) => git.gitStage(params),
        gitStatus: () => git.gitStatus(),
        gitUnstage: (params) => git.gitUnstage(params),

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
          openProjectWindow(params.root);
        },
        getProjectRoot: () => ({ root: session.projectRoot }),
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
