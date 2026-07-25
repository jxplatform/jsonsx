// oxlint-disable unicorn/no-process-exit -- standalone launcher CLI; exit codes are its interface
import { isAbsolute, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  openProject,
  setDirectoryDialog,
  setFileDialog,
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
  gitStage,
  gitStatus,
  gitUnstage,
} from "../git";
import {
  addPackage,
  dependenciesNeedInstall,
  installDependencies,
  listPackages,
  outdatedPackages,
  removePackage,
  setPackageVersions,
} from "../packages";
import { openDirectoryDialog, openFileDialog } from "./utils";
import { createProjectServer } from "@jxsuite/server/project-server";
import { listStarters } from "@jxsuite/starters";
import { readRecents, writeRecents } from "../recent-store";
import { readSettings, writeSettings } from "../settings-store";
import type { RecentProjectEntry } from "../rpc-schema";

// ─── Project root ────────────────────────────────────────────────────────────

const projectRoot = process.argv[2] || process.env.JSONSX_PROJECT_ROOT || process.cwd();
setProjectRoot(projectRoot);
setFileDialog(openFileDialog);
setDirectoryDialog(openDirectoryDialog);

// ─── RPC handler dispatch map ────────────────────────────────────────────────

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
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
  outdatedPackages: () => outdatedPackages(),
  setPackageVersions: (params) =>
    setPackageVersions(params as { updates: { name: string; version: string; dev?: boolean }[] }),
  openProject: () => openProject(),
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
    // Single-window launcher: rebind the process-global root in place. Studio re-reads the
    // Project.json itself, so no config is returned and dedup never applies.
    setProjectRoot((params as { root: string }).root);
    return Promise.resolve({ config: null, deduped: false });
  },
  getRecentProjects: () => readRecents(),
  saveRecentProjects: (params) =>
    writeRecents((params as { projects: RecentProjectEntry[] }).projects),
  getSettings: () => readSettings(),
  saveSettings: (params) =>
    writeSettings((params as { settings: Record<string, string> }).settings),
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
  resolveSiteContext: (params) => handleResolveSiteContext(params as { filePath: string }),
  uploadFile: (params) => handleUploadFile(params as { path: string; data: string }),
  writeFile: (params) => handleWriteFile(params as { path: string; content: string }),
};

// ─── Static file serving + WebSocket RPC server ──────────────────────────────

const studioDir = process.env.JX_STUDIO_ASSETS || resolve(import.meta.dir, "../../assets/studio");

// Single-window chromium launcher: one default session whose root tracks the process-global root.
// The factory re-resolves this on every request/message, so setWindowProject takes effect live.
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

const { url: serverUrl, rpcToken } = createProjectServer({
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

console.log(`[chromium] Studio server at ${serverUrl}`);
console.log(`[chromium] WebSocket RPC at ${serverUrl.replace(/^http/, "ws")}`);
console.log(`[chromium] Project root: ${projectRoot}`);

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

const userDataDir = resolve(projectRoot, ".jx/chromium-profile");
seedChromiumPreferences(userDataDir);

const chromiumArgs = [
  `--app=${serverUrl}/__studio__/index.html?token=${rpcToken}`,
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
