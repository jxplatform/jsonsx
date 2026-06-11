import { BrowserView, BrowserWindow, Screen } from "electrobun/bun";
import Electrobun from "electrobun/bun";
import type { StudioRPC } from "./rpc-schema";
import {
  codeService,
  discoverComponents,
  fetchPluginSchema,
  formatAction,
  handleCreateDirectory,
  handleDeleteFile,
  handleReadFile,
  handleReadFileAsDataUrl,
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
  setFileDialog,
  setProjectRoot,
} from "./handlers";
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
} from "./git";
import { addPackage, listPackages, removePackage } from "./packages";
import {
  applyUpdate,
  checkForUpdate,
  downloadUpdate,
  getLocalInfo,
  getStatus,
  setNotifyWebview,
  startBackgroundChecks,
} from "./updater";
import { init as initUtils, openFileDialog } from "./utils";
import { handleAiRoute } from "./ai";
import {
  createSession,
  deleteSession,
  getAuthStatus,
  sendMessage,
  stopSession,
} from "@jxsuite/server/claude-session";

// ─── Determine project root ───────────────────────────────────────────────────

const projectRoot = process.argv[2] || process.env.JSONSX_PROJECT_ROOT || process.cwd();

setProjectRoot(projectRoot);
await initUtils();
setFileDialog(openFileDialog);

// ─── Window maximize state (workaround for frameless window fullscreen bug) ──

let _maximized = false;
let _restoreFrame = { height: 900, width: 1400, x: 0, y: 0 };

let win: InstanceType<typeof BrowserWindow>;

// ─── Register RPC handlers ────────────────────────────────────────────────────

const rpc = BrowserView.defineRPC<StudioRPC>({
  handlers: {
    messages: {},
    requests: {
      addPackage: (params) => addPackage(params),
      aiAuthStatus: () => getAuthStatus(),
      aiCreateSession: (params) =>
        createSession(projectRoot, params.message, {
          ...(params.systemPrompt != null && {
            systemPrompt: params.systemPrompt,
          }),
        }),
      aiDeleteSession: (params) => {
        deleteSession(params.id);
      },
      aiSendMessage: (params) => {
        sendMessage(params.id, params.message);
      },
      aiStopSession: (params) => {
        stopSession(params.id);
      },
      aiStreamUrl: (params) => `${aiServerUrl}/studio/ai/session/${params.id}/stream`,
      codeService: (params) => codeService(params),
      createDirectory: (params) => handleCreateDirectory(params),
      deleteFile: (params) => handleDeleteFile(params),
      discoverComponents: (params) => discoverComponents(params),
      fetchPluginSchema: (params) => fetchPluginSchema(params),
      formatAction: (params) => formatAction(params),
      gitAddRemote: (params) => gitAddRemote(params),
      gitBranches: () => gitBranches(),
      gitCheckout: (params) => gitCheckout(params),
      gitCommit: (params) => gitCommit(params),
      gitCreateBranch: (params) => gitCreateBranch(params),
      gitDiff: (params) => gitDiff(params),
      gitDiscard: (params) => gitDiscard(params),
      gitFetch: () => gitFetch(),
      gitInit: () => gitInit(),
      gitLog: (params) => gitLog(params),
      gitPull: () => gitPull(),
      gitPush: (params) => gitPush(params),
      gitStage: (params) => gitStage(params),
      gitStatus: () => gitStatus(),
      gitUnstage: (params) => gitUnstage(params),
      jxResolve: (params) => jxResolve(params),
      jxServerFunction: (params) => jxServerFunction(params),
      listDirectory: (params) => listDirectory(params),
      listFormats: () => listFormats(),
      listPackages: () => listPackages(),
      locateFile: (params) => locateFile(params),
      openProject: () => openProject(),
      readFile: (params) => handleReadFile(params),
      readFileAsDataUrl: (params) => handleReadFileAsDataUrl(params),
      removePackage: (params) => removePackage(params),
      renameFile: (params) => handleRenameFile(params),
      resolveSiteContext: (params) => handleResolveSiteContext(params),
      updaterApplyUpdate: () => applyUpdate(),
      updaterCheckForUpdate: () => checkForUpdate(),
      updaterDownloadUpdate: () => downloadUpdate(),
      updaterGetLocalInfo: () => getLocalInfo(),
      updaterGetStatus: () => getStatus(),
      uploadFile: (params) => handleUploadFile(params),
      windowClose: () => {
        win.close();
      },
      windowGetFrame: (): {
        x: number;
        y: number;
        width: number;
        height: number;
      } => win.getFrame(),
      windowMaximize: () => {
        if (_maximized) {
          win.setFrame(_restoreFrame.x, _restoreFrame.y, _restoreFrame.width, _restoreFrame.height);
          _maximized = false;
        } else {
          _restoreFrame = win.getFrame();
          const display = Screen.getPrimaryDisplay();
          const { x, y, width, height } = display.workArea;
          win.setFrame(x, y, width, height);
          _maximized = true;
        }
      },
      windowMinimize: () => {
        win.minimize();
      },
      windowSetFrame: (params) => {
        win.setFrame(params.x, params.y, params.width, params.height);
      },
      writeFile: (params) => handleWriteFile(params),
    },
  },
  maxRequestTime: 300_000,
});

// ─── AI HTTP server (SSE streaming requires HTTP) ────────────────────────────

const aiServer = Bun.serve({
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/{2,}/, "/");
    const aiResponse = await handleAiRoute(req, path, projectRoot);
    if (aiResponse) {
      return aiResponse;
    }
    return new Response("Not Found", { status: 404 });
  },
  port: 0,
});

const aiServerUrl = `http://localhost:${aiServer.port}`;

// ─── Open the main window ─────────────────────────────────────────────────────

win = new BrowserWindow({
  frame: { height: 900, width: 1400, x: 0, y: 0 },
  navigationRules: "views://*,^*",
  rpc,
  title: "Jx Studio",
  titleBarStyle: "hidden",
  url: "views://studio/index.html",
});

startBackgroundChecks();
setNotifyWebview((version) => rpc.send.updateReady({ version }));

// ─── Handle file associations (open-url) ─────────────────────────────────────

Electrobun.events.on("open-url", (e: { data: { url: string } }) => {
  const url = new URL(e.data.url);
  if (url.protocol === "file:") {
    const filePath = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
    if (filePath.endsWith("project.json")) {
      const dir = filePath.slice(0, filePath.lastIndexOf("/"));
      setProjectRoot(dir);
    }
  }
});
