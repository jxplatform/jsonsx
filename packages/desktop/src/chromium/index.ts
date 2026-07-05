// oxlint-disable unicorn/no-process-exit -- standalone launcher CLI; exit codes are its interface
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  codeService,
  createProject,
  discoverComponents,
  fetchPluginSchema,
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
  listFormats,
  locateFile,
  openProject,
  setDirectoryDialog,
  setFileDialog,
  setProjectRoot,
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
  listDirectory: (params) => listDirectory(params as { dir: string }),
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
        starter?: string;
      },
    ),
  listStarters: () => Promise.resolve(listStarters()),
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
  jxResolve: (params) => jxResolve(params as { body: string }),
  jxServerFunction: (params) => jxServerFunction(params as { body: string }),
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

const { url: serverUrl, rpcToken } = createProjectServer({
  resolveSession: () => defaultSession,
  studioDir,
});

console.log(`[chromium] Studio server at ${serverUrl}`);
console.log(`[chromium] WebSocket RPC at ${serverUrl.replace(/^http/, "ws")}`);
console.log(`[chromium] Project root: ${projectRoot}`);

// ─── Launch Chromium ─────────────────────────────────────────────────────────

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

console.log(`[chromium] Launching: ${chromiumBin}`);

const chromiumArgs = [
  `--app=${serverUrl}/__studio__/index.html?token=${rpcToken}`,
  "--class=jx-studio",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1400,900",
  `--user-data-dir=${resolve(projectRoot, ".jx/chromium-profile")}`,
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
