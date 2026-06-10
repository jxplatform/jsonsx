import { BrowserView, BrowserWindow, Screen } from "electrobun/bun";
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
  jxResolve,
  jxServerFunction,
  listFormats,
  formatAction,
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
  gitInit,
  gitAddRemote,
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
import { handleAiRoute } from "./ai";
import {
  createSession,
  sendMessage,
  stopSession,
  deleteSession,
  getAuthStatus,
} from "@jxsuite/server/claude-session";

// ─── Determine project root ───────────────────────────────────────────────────

const projectRoot = process.argv[2] || process.env.JSONSX_PROJECT_ROOT || process.cwd();

setProjectRoot(projectRoot);
await initUtils();
setFileDialog(openFileDialog);

// ─── Window maximize state (workaround for frameless window fullscreen bug) ──

let _maximized = false;
let _restoreFrame = { x: 0, y: 0, width: 1400, height: 900 };

let win: InstanceType<typeof BrowserWindow>;

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
      jxResolve: (params) => jxResolve(params),
      jxServerFunction: (params) => jxServerFunction(params),
      listFormats: () => listFormats(),
      formatAction: (params) => formatAction(params),
      gitStatus: () => gitStatus(),
      gitBranches: () => gitBranches(),
      gitLog: (params) => gitLog(params),
      gitStage: (params) => gitStage(params),
      gitUnstage: (params) => gitUnstage(params),
      gitCommit: (params) => gitCommit(params),
      gitPush: (params) => gitPush(params),
      gitPull: () => gitPull(),
      gitFetch: () => gitFetch(),
      gitCheckout: (params) => gitCheckout(params),
      gitCreateBranch: (params) => gitCreateBranch(params),
      gitDiff: (params) => gitDiff(params),
      gitDiscard: (params) => gitDiscard(params),
      gitInit: () => gitInit(),
      gitAddRemote: (params) => gitAddRemote(params),
      addPackage: (params) => addPackage(params),
      removePackage: (params) => removePackage(params),
      listPackages: () => listPackages(),
      updaterGetLocalInfo: () => getLocalInfo(),
      updaterCheckForUpdate: () => checkForUpdate(),
      updaterDownloadUpdate: () => downloadUpdate(),
      updaterApplyUpdate: () => applyUpdate(),
      updaterGetStatus: () => getStatus(),
      windowMinimize: () => {
        win.minimize();
      },
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
      windowClose: () => {
        win.close();
      },
      windowGetFrame: (): {
        x: number;
        y: number;
        width: number;
        height: number;
      } => {
        return win.getFrame();
      },
      windowSetFrame: (params) => {
        win.setFrame(params.x, params.y, params.width, params.height);
      },
      aiAuthStatus: () => getAuthStatus(),
      aiCreateSession: (params) =>
        createSession(projectRoot, params.message, {
          ...(params.systemPrompt != null && {
            systemPrompt: params.systemPrompt,
          }),
        }),
      aiSendMessage: (params) => {
        sendMessage(params.id, params.message);
      },
      aiStreamUrl: (params) => `${aiServerUrl}/studio/ai/session/${params.id}/stream`,
      aiStopSession: (params) => {
        stopSession(params.id);
      },
      aiDeleteSession: (params) => {
        deleteSession(params.id);
      },
    },
    messages: {},
  },
});

// ─── AI HTTP server (SSE streaming requires HTTP) ────────────────────────────

const aiServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/{2,}/, "/");
    const aiResponse = await handleAiRoute(req, path, projectRoot);
    if (aiResponse) return aiResponse;
    return new Response("Not Found", { status: 404 });
  },
});

const aiServerUrl = `http://localhost:${aiServer.port}`;

// ─── Open the main window ─────────────────────────────────────────────────────

win = new BrowserWindow({
  title: "Jx Studio",
  url: "views://studio/index.html",
  frame: { x: 0, y: 0, width: 1400, height: 900 },
  titleBarStyle: "hidden",
  navigationRules: "views://*,^*",
  rpc,
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
