// oxlint-disable unicorn/no-process-exit -- standalone launcher CLI; exit codes are its interface
import { basename, isAbsolute, resolve } from "node:path";
import type { SettingsPatch } from "@jxsuite/protocol";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  codeService,
  createProject,
  dataConnectionTest,
  dataConnections,
  dataDeleteRow,
  dataInsertRow,
  dataPush,
  dataRows,
  dataUpdateRow,
  discoverComponents,
  fetchPluginSchema,
  fetchProjectSchemas,
  findReferences,
  formatAction,
  getProjectRoot,
  handleCreateDirectory,
  handleDeleteFile,
  handleReadFile,
  handleRenameFile,
  handleResolveSiteContext,
  handleUploadFile,
  handleWriteFile,
  jxResolve,
  jxServerFunction,
  listDirectory,
  listExtensions,
  listFormats,
  listSecrets,
  locateFile,
  buildSite,
  clearPreviewOverlay,
  previewSite,
  setPreviewOverlay,
  openExternal,
  openProject,
  searchFiles,
  setDirectoryDialog,
  setFileDialog,
  pickProjectFile,
  setFileEventSink,
  setProjectRoot,
  setSecrets,
} from "../handlers";
import {
  gitAddRemote,
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDiff,
  gitDiscard,
  gitFetch,
  gitInit,
  gitLog,
  gitPull,
  gitPush,
  gitShow,
  gitStage,
  gitStatus,
  gitUnstage,
} from "../git";
import {
  addPackage,
  dependenciesNeedInstall,
  installDependencies,
  listPackages,
  packageVersions,
  removePackage,
  setPackageVersions,
} from "../packages";
import { openDirectoryDialog, openFileDialog } from "./utils";
import { appInfo } from "./app-info";
import { STUDIO_SHELL_PATH } from "./app-id";
import {
  findWindowByRoot,
  listWindows,
  nextWelcomeProfile,
  projectProfile,
  registerWindow,
  requestFocus,
  unregisterWindow,
  updateWindow,
  watchFocusRequests,
} from "./window-registry";
import { createProjectServer } from "@jxsuite/server/project-server";
import { listStarters } from "@jxsuite/starters";
import { readRecents, writeRecents } from "../recent-store";
import { patchSettings, readSettings, watchSettings } from "../settings-store";
import {
  githubSignIn,
  githubSignOut,
  githubTokenStatus,
  setAuthorizationHost,
} from "../github-signin";
import type { RecentProjectEntry } from "../rpc-schema";

// ─── Project root ────────────────────────────────────────────────────────────

/* A welcome window — one this launcher opened for `File → New Window`, with no project yet. The
   positional argument is the project root and there is no flag surface (specs/desktop.md §9.3), so
   "no project" travels as an environment variable the parent sets and a user never types. Without
   it the child would adopt the parent's cwd, and a New Window opened from a project directory would
   silently re-open that project. */
const welcomeWindow = process.env.JX_STUDIO_NO_PROJECT === "1";

/**
 * The working directory, but only when it is a project — otherwise null.
 *
 * A bare `jx-studio` adopting its cwd is what makes "run it inside a project" open that project,
 * and that stays. What it must not do is adopt a directory that is not one. Launched from a desktop
 * entry or a shell sitting in `$HOME`, the unconditional fallback made the home directory the
 * project root, and the session then watched all of it: every unix socket underneath raised a watch
 * error, and `~/.wine/dosdevices/z:` (a link to `/`) took the walk out of the home directory
 * altogether. The window showed the welcome screen throughout — `probeRootProject` had already
 * decided a directory with no project.json is not a project — so the entire scan was work for a
 * project that was never opened.
 *
 * A root named on the command line or in `JSONSX_PROJECT_ROOT` is still taken at its word; only the
 * one nobody typed has to prove itself.
 */
export function implicitProjectRoot(cwd: string): string | null {
  return existsSync(resolve(cwd, "project.json")) ? cwd : null;
}

const projectRoot = welcomeWindow
  ? null
  : process.argv[2] || process.env.JSONSX_PROJECT_ROOT || implicitProjectRoot(process.cwd());

/**
 * Ask an existing window for this project to come forward; report whether there was one.
 *
 * Two windows on one project is not merely redundant — they would edit the same files through two
 * independent watchers and two undo histories. And before the registry existed the second launcher
 * fared worse than that: its Chromium shares the project's profile directory, so the browser
 * singleton handed the new window to the FIRST launcher's browser and the second launcher exited,
 * leaving a window pointing at a server that had just died.
 */
export function raiseExistingWindow(root: string | null): boolean {
  if (!root) {
    return false;
  }
  const openElsewhere = findWindowByRoot(root);
  if (!openElsewhere) {
    return false;
  }
  console.log(`[chromium] ${root} is already open (pid ${openElsewhere.pid}) — raising it`);
  requestFocus(openElsewhere.pid);
  return true;
}

if (raiseExistingWindow(projectRoot)) {
  process.exit(0);
}

setProjectRoot(projectRoot);
setFileDialog(openFileDialog);
setDirectoryDialog(openDirectoryDialog);

// ─── Windows ─────────────────────────────────────────────────────────────────

/* Where THIS window's browser profile lives. Chromium's process singleton is keyed on it, so it is
   also what makes a window a window: the parent picks the child's directory and passes it down,
   because only the parent can see which ones are already taken. */
const profileDir =
  process.env.JX_STUDIO_PROFILE_DIR ||
  (projectRoot ? projectProfile(projectRoot) : nextWelcomeProfile());

/**
 * Open another window: a fresh launcher process, which is what a window is on this build.
 *
 * @param root Project to open, or null for a welcome window.
 */
function spawnWindow(root: string | null): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    JX_STUDIO_PROFILE_DIR: root ? projectProfile(root) : nextWelcomeProfile(),
    /* "No project" has to be explicit, because the child inherits this process's cwd and would
       otherwise adopt whatever project lives there. */
    JX_STUDIO_NO_PROJECT: root ? "" : "1",
  };
  if (root) {
    delete env.JX_STUDIO_NO_PROJECT;
  }
  /* `import.meta.path`, not argv[1]: it names THIS module however the launcher was started —
     `bun run src/chromium/index.ts`, the Nix wrapper's absolute store path, or a bundle. */
  const child = spawn(process.execPath, [import.meta.path, ...(root ? [root] : [])], {
    detached: true,
    env,
    stdio: "inherit",
  });
  /* Unreferenced and detached: closing the window that opened another must not close the other. */
  child.unref();
}

/**
 * Open `root` in another window, or raise the window that already holds it.
 *
 * The answer is asked BEFORE anything is opened, because the caller has to be able to report which
 * of the two happened — "opened in a new window" is a lie when a window merely came forward.
 */
function openProjectInNewWindow(root: string): { focused: boolean } {
  const existing = findWindowByRoot(root);
  if (existing) {
    requestFocus(existing.pid);
    return { focused: true };
  }
  spawnWindow(root);
  return { focused: false };
}

// ─── RPC handler dispatch map ────────────────────────────────────────────────

/* Exported so the schema↔handler parity test can enumerate the registered method names without
   standing up a browser: a request declared in rpc-schema.ts with no entry here reaches Studio as a
   silent empty result (that is exactly how searchFiles shipped unhandled). */
export const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
  addPackage: (params) => addPackage(params as { name: string }),
  codeService: (params) => codeService(params),
  dependenciesNeedInstall: () => dependenciesNeedInstall(),
  createDirectory: (params) => handleCreateDirectory(params as { path: string }),
  deleteFile: (params) => handleDeleteFile(params as { path: string }),
  discoverComponents: (params) => discoverComponents(params as { dir?: string }),
  fetchPluginSchema: (params) =>
    fetchPluginSchema(params as { src: string; prototype?: string; base?: string }),
  formatAction: (params) =>
    formatAction(
      params as {
        format: string;
        action: string;
        source?: string;
        doc?: Record<string, unknown>;
        options?: Record<string, unknown>;
      },
    ),
  gitAddRemote: (params) => gitAddRemote(params as { name: string; url: string }),
  gitBranches: () => gitBranches(),
  // `View: Open in Browser` builds before it opens, so the reader sees what the author sees.
  buildSite: () => buildSite(),
  previewSite: (params) => previewSite(params as { route: string }),
  /* Both publish synchronously into an in-memory overlay — `rpc-schema` declares `response: void`
     and `createProjectSession` throws where it is called, which `preview-site.test.ts` pins. The
     map's contract is a promise, so the adaptation is here rather than in the session. */
  setPreviewOverlay: async (params) =>
    setPreviewOverlay(params as { contents: string; path: string }),
  clearPreviewOverlay: async (params) => clearPreviewOverlay(params as { path?: string }),
  gitCheckout: (params) => gitCheckout(params as { branch: string }),
  gitCommit: (params) => gitCommit(params as { message: string }),
  gitCreateBranch: (params) => gitCreateBranch(params as { name: string }),
  gitDiff: (params) => gitDiff(params as { path?: string }),
  gitDiscard: (params) => gitDiscard(params as { files: string[] }),
  gitFetch: () => gitFetch(),
  gitInit: () => gitInit(),
  gitLog: (params) => gitLog(params as { limit?: number }),
  gitPull: () => gitPull(),
  gitPush: (params) => gitPush(params as { setUpstream?: boolean }),
  gitShow: (params) => gitShow(params as { path: string; ref?: string }),
  gitStage: (params) => gitStage(params as { files: string[] }),
  gitStatus: () => gitStatus(),
  gitUnstage: (params) => gitUnstage(params as { files: string[] }),
  fetchProjectSchemas: () => fetchProjectSchemas(),
  listDirectory: (params) => listDirectory(params as { dir: string }),
  listExtensions: () => listExtensions(),
  listFormats: () => listFormats(),
  installDependencies: () => installDependencies(),
  listPackages: () => listPackages(),
  locateFile: (params) => locateFile(params as { name: string }),
  searchFiles: (params) => searchFiles(params as { query: string; extensions?: string[] }),
  packageVersions: () => packageVersions(),
  setPackageVersions: (params) =>
    setPackageVersions(params as { updates: { name: string; version: string; dev?: boolean }[] }),
  openProject: () => openProject(),
  openExternal: (params) => openExternal(params as { url: string }),
  // About screen. No `updateStatus`: this build is replaced by whatever packaged it, not by itself.
  appInfo: () => Promise.resolve(appInfo()),
  // The picker WITHOUT the binding — `openProject` above re-roots this window as part of picking,
  // Which is the one thing the New Window branch must not do (see StudioPlatform.pickProject).
  pickProject: async () => {
    const picked = await pickProjectFile();
    return picked && { name: picked.name, root: picked.root };
  },
  // Multi-window. A window is a launcher process here; window-registry.ts is the map.
  newWindow: () => {
    spawnWindow(null);
    return Promise.resolve();
  },
  openProjectInNewWindow: (params) =>
    Promise.resolve(openProjectInNewWindow((params as { root: string }).root)),
  listOpenWindows: () =>
    Promise.resolve(listWindows().map((win) => ({ id: win.pid, projectRoot: win.root }))),
  createProject: (params) =>
    createProject(
      params as {
        name: string;
        description?: string;
        url?: string;
        adapter?: string;
        directory: string;
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
      },
    ),
  listStarters: () => Promise.resolve(listStarters()),
  pickDirectory: async () => ({ path: await openDirectoryDialog() }),
  getProjectRoot: () => Promise.resolve({ root: getProjectRoot() }),
  setWindowProject: (params) => {
    const { root } = params as { root: string };
    /* Dedupe first: if ANOTHER window already holds this project, raise it and say so rather than
       binding a second window to the same files. Studio treats `deduped` as "nothing was loaded
       here", so this window keeps whatever it was showing. */
    const existing = findWindowByRoot(root, process.pid);
    if (existing) {
      requestFocus(existing.pid);
      return Promise.resolve({ config: null, deduped: true });
    }
    // Rebind this launcher's root in place, then tell the registry so other windows can dedupe
    // Against it. Studio re-reads the project.json itself, so no config is returned.
    setProjectRoot(root);
    updateWindow(process.pid, { name: basename(root.replace(/[/\\]+$/, "")) || null, root });
    return Promise.resolve({ config: null, deduped: false });
  },
  getRecentProjects: () => readRecents(),
  saveRecentProjects: (params) =>
    writeRecents((params as { projects: RecentProjectEntry[] }).projects),
  getSettings: () => readSettings(),
  patchSettings: (params) => patchSettings((params as { patch: SettingsPatch }).patch),
  githubSignIn: (params) => githubSignIn(params as { force?: boolean }),
  githubSignOut: () => githubSignOut(),
  githubToken: () => githubTokenStatus(),
  jxResolve: (params) => jxResolve(params as { body: string }),
  jxServerFunction: (params) => jxServerFunction(params as { body: string }),
  // Data surface + secrets (desktop twins of /__studio/data/* + /__studio/secrets)
  dataConnections: () => dataConnections(),
  dataConnectionTest: (params) => dataConnectionTest(params as { connection: string }),
  dataPush: (params) => dataPush(params as { connection?: string; dryRun?: boolean }),
  dataRows: (params) => dataRows(params as { table: string }),
  dataInsertRow: (params) =>
    dataInsertRow(params as { table: string; values: Record<string, unknown> }),
  dataUpdateRow: (params) =>
    dataUpdateRow(params as { table: string; pk: string | number; set: Record<string, unknown> }),
  dataDeleteRow: (params) => dataDeleteRow(params as { table: string; pk: string | number }),
  listSecrets: () => listSecrets(),
  setSecrets: (params) => setSecrets(params as { set?: Record<string, string>; remove?: string[] }),
  readFile: (params) => handleReadFile(params as { path: string }),
  removePackage: (params) => removePackage(params as { name: string }),
  renameFile: (params) => handleRenameFile(params as { from: string; to: string }),
  findReferences: (params) => findReferences(params as { path?: string; tagName?: string }),
  resolveSiteContext: (params) => handleResolveSiteContext(params as { filePath: string }),
  uploadFile: (params) => handleUploadFile(params as { path: string; data: string }),
  writeFile: (params) => handleWriteFile(params as { path: string; content: string }),
};

// ─── Static file serving + WebSocket RPC server ──────────────────────────────

const studioDir = process.env.JX_STUDIO_ASSETS || resolve(import.meta.dir, "../../assets/studio");

// One window, one launcher, one session — whose root tracks the process-global root. The factory
// Re-resolves this on every request/message, so setWindowProject takes effect live.
const defaultSession = {
  get projectRoot(): string | null {
    return getProjectRoot();
  },
  handlers,
};

// The launcher's Chromium binary doubles as puppeteer's browser for the import pipeline, so it is
// Discovered before the server starts (NixOS-safe: no google-chrome-stable assumption).
function findChromium(): string | null {
  const candidates = [
    process.env.CHROMIUM_BIN,
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ].filter(Boolean) as string[];

  // Bun.which resolves a binary in PATH on every platform (no dependency on a POSIX `which`, which
  // Is absent from a stock Windows shell and made resolution flaky depending on the host shell).
  for (const bin of candidates) {
    const found = Bun.which(bin);
    if (found) {
      return found;
    }
  }
  return null;
}

const chromiumBin = findChromium();
if (!chromiumBin) {
  console.error("[chromium] No chromium/chrome found. Install chromium or set CHROMIUM_BIN.");
  process.exit(1);
}

const projectServer = createProjectServer({
  importApi: {
    chromePath: chromiumBin,
    resolveDest: (dir) => {
      // The webview resolves the destination under a natively-picked parent before posting.
      if (!isAbsolute(dir)) {
        throw new Error("directory must be an absolute path");
      }
      return dir;
    },
  },
  resolveSession: () => defaultSession,
  studioDir,
});

const { url: serverUrl, rpcToken } = projectServer;

/* The OAuth loopback redirect lands on this server, so sign-in cannot be wired until it exists. */
setAuthorizationHost({
  authorizer: projectServer.authorizer,
  port: projectServer.server.port ?? 0,
});

/* Push filesystem changes to the shell so the sidebar stays live, the way the dev server's SSE
   `fs` event does and electrobun's per-window `onFileEvents` message does. Registering the sink is
   what STARTS the watcher, and re-rooting the session re-arms it, so this one call covers the whole
   life of the window including the projects it is pointed at later. */
setFileEventSink((events) => {
  projectServer.push("onFileEvents", { events });
});

/* Every chromium window is its own process with its own browser profile, so a settings change made
   in one is invisible to the others until something re-reads the file. The store's watch is what
   carries it across. */
const stopSettingsWatch = watchSettings((settings) => {
  projectServer.push("settingsChanged", { settings });
});

/* Another window may ask this one to come forward (see window-registry.ts). Only the page can
   raise an `--app` window, so the request is relayed to it. */
const stopFocusWatch = watchFocusRequests(process.pid, () => {
  projectServer.push("focusWindow");
});

/* Publish this window so other launchers can find, dedupe against, and raise it. Registered after
   the server exists so the entry can name the origin it is serving. */
registerWindow({
  name: projectRoot ? basename(projectRoot.replace(/[/\\]+$/, "")) || null : null,
  pid: process.pid,
  profileDir,
  root: projectRoot,
  url: serverUrl,
});

/** Leave the registry exactly once, however this process is ending. */
let released = false;
export function releaseWindow(): void {
  if (released) {
    return;
  }
  released = true;
  stopFocusWatch();
  stopSettingsWatch();
  unregisterWindow(process.pid);
}
process.on("exit", releaseWindow);

console.log(`[chromium] Studio server at ${serverUrl}`);
console.log(`[chromium] WebSocket RPC at ${serverUrl.replace(/^http/, "ws")}`);
console.log(`[chromium] Project root: ${projectRoot ?? "(none — welcome window)"}`);

// ─── Launch Chromium ─────────────────────────────────────────────────────────

/**
 * Seed the profile's Preferences so Chromium never offers to save credentials: the credentials
 * form's API-key field is a password input, and without these prefs Chromium offers to save it to
 * the OS password manager on every save. Chrome only honors these as profile preferences (there is
 * no flag), so they are merged into `<user-data-dir>/Default/Preferences` before every launch —
 * preserving whatever else Chromium has written there. A missing or corrupt file is replaced with a
 * fresh object holding just these keys.
 */
export function seedChromiumPreferences(userDataDir: string): void {
  const defaultDir = resolve(userDataDir, "Default");
  const prefsFile = resolve(defaultDir, "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(prefsFile, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      prefs = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or corrupt Preferences: start from a fresh object.
  }
  prefs.credentials_enable_service = false;
  const profile =
    prefs.profile && typeof prefs.profile === "object" && !Array.isArray(prefs.profile)
      ? (prefs.profile as Record<string, unknown>)
      : {};
  profile.password_manager_enabled = false;
  profile.password_manager_leak_detection = false;
  prefs.profile = profile;
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(prefsFile, JSON.stringify(prefs), "utf8");
}

console.log(`[chromium] Launching: ${chromiumBin}`);

const userDataDir = profileDir;
seedChromiumPreferences(userDataDir);

const chromiumArgs = [
  /* The shell path is a constant because Chromium bakes it into the window's app_id, which is the
     only string a taskbar can match this window to `jx-studio.desktop` by (see app-id.ts). */
  `--app=${serverUrl}${STUDIO_SHELL_PATH}?token=${rpcToken}`,
  "--class=jx-studio",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1400,900",
  `--user-data-dir=${userDataDir}`,
];

if (process.env.WAYLAND_DISPLAY) {
  chromiumArgs.push("--ozone-platform=wayland", "--enable-features=UseOzonePlatform");
}

const chrome = spawn(chromiumBin, chromiumArgs, {
  detached: false,
  stdio: "inherit",
});

chrome.on("close", (code) => {
  console.log(`[chromium] Browser closed (code ${code})`);
  process.exit(0);
});

process.on("SIGINT", () => {
  chrome.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  chrome.kill();
  process.exit(0);
});
