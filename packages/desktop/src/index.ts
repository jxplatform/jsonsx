import { BrowserView, BrowserWindow } from "electrobun/bun";
import Electrobun from "electrobun/bun";
import type { StudioRPC } from "./rpc-schema";
import {
  setProjectRoot,
  setFileDialog,
  openProject,
  listDirectory,
  handleReadFile,
  handleReadFileAsDataUrl,
  handleWriteFile,
  handleDeleteFile,
  handleRenameFile,
  handleCreateDirectory,
  handleUploadFile,
  handleResolveSiteContext,
  discoverComponents,
  codeService,
  locateFile,
  fetchPluginSchema,
} from "./handlers";
import {
  gitStatus,
  gitBranches,
  gitLog,
  gitStage,
  gitUnstage,
  gitCommit,
  gitPush,
  gitPull,
  gitFetch,
  gitCheckout,
  gitCreateBranch,
  gitDiff,
  gitDiscard,
} from "./git";
import { addPackage, removePackage, listPackages } from "./packages";
import {
  getLocalInfo,
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  getStatus,
  startBackgroundChecks,
  setNotifyWebview,
} from "./updater";
import { init as initUtils, openFileDialog } from "./utils";

// ─── Determine project root ───────────────────────────────────────────────────

const projectRoot = process.argv[2] || process.env.JSONSX_PROJECT_ROOT || process.cwd();

setProjectRoot(projectRoot);
await initUtils();
setFileDialog(openFileDialog);

// ─── Register RPC handlers ────────────────────────────────────────────────────

const rpc = BrowserView.defineRPC<StudioRPC>({
  maxRequestTime: 300000,
  handlers: {
    requests: {
      openProject: () => openProject(),
      listDirectory: (params) => listDirectory(params),
      readFile: (params) => handleReadFile(params),
      readFileAsDataUrl: (params) => handleReadFileAsDataUrl(params),
      writeFile: (params) => handleWriteFile(params),
      deleteFile: (params) => handleDeleteFile(params),
      renameFile: (params) => handleRenameFile(params),
      createDirectory: (params) => handleCreateDirectory(params),
      uploadFile: (params) => handleUploadFile(params),
      resolveSiteContext: (params) => handleResolveSiteContext(params),
      discoverComponents: (params) => discoverComponents(params),
      codeService: (params) => codeService(params),
      locateFile: (params) => locateFile(params),
      fetchPluginSchema: (params) => fetchPluginSchema(params),
      gitStatus: () => gitStatus(),
      gitBranches: () => gitBranches(),
      gitLog: (params) => gitLog(params),
      gitStage: (params) => gitStage(params),
      gitUnstage: (params) => gitUnstage(params),
      gitCommit: (params) => gitCommit(params),
      gitPush: () => gitPush(),
      gitPull: () => gitPull(),
      gitFetch: () => gitFetch(),
      gitCheckout: (params) => gitCheckout(params),
      gitCreateBranch: (params) => gitCreateBranch(params),
      gitDiff: (params) => gitDiff(params),
      gitDiscard: (params) => gitDiscard(params),
      addPackage: (params) => addPackage(params),
      removePackage: (params) => removePackage(params),
      listPackages: () => listPackages(),
      updaterGetLocalInfo: () => getLocalInfo(),
      updaterCheckForUpdate: () => checkForUpdate(),
      updaterDownloadUpdate: () => downloadUpdate(),
      updaterApplyUpdate: () => applyUpdate(),
      updaterGetStatus: () => getStatus(),
    },
    messages: {},
  },
});

// ─── Open the main window ─────────────────────────────────────────────────────

new BrowserWindow({
  title: "Jx Studio",
  url: "views://studio/index.html",
  frame: { x: 0, y: 0, width: 1400, height: 900 },
  navigationRules: "views://*,^*",
  rpc,
});

startBackgroundChecks();
setNotifyWebview((version) => rpc.send.updateReady({ version }));

// ─── Handle file associations (open-url) ─────────────────────────────────────

Electrobun.events.on("open-url", (e: any) => {
  const url = new URL(e.data.url);
  if (url.protocol === "file:") {
    const filePath = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
    if (filePath.endsWith("project.json")) {
      const dir = filePath.slice(0, filePath.lastIndexOf("/"));
      setProjectRoot(dir);
    }
  }
});
