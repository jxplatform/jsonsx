// oxlint-disable unicorn/no-process-exit -- standalone launcher CLI; exit codes are its interface
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  codeService,
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
  listDirectory,
  listFormats,
  locateFile,
  openProject,
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
import { addPackage, listPackages, removePackage } from "../packages";
import { openFileDialog } from "./utils";
import { handleAiRoute } from "../ai";

// ─── Project root ────────────────────────────────────────────────────────────

const projectRoot = process.argv[2] || process.env.JSONSX_PROJECT_ROOT || process.cwd();
setProjectRoot(projectRoot);
setFileDialog(openFileDialog);

// ─── RPC handler dispatch map ────────────────────────────────────────────────

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
  addPackage: (params) => addPackage(params as { name: string }),
  codeService: (params) => codeService(params),
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
  listPackages: () => listPackages(),
  locateFile: (params) => locateFile(params as { name: string }),
  openProject: () => openProject(),
  readFile: (params) => handleReadFile(params as { path: string }),
  removePackage: (params) => removePackage(params as { name: string }),
  renameFile: (params) => handleRenameFile(params as { from: string; to: string }),
  resolveSiteContext: (params) => handleResolveSiteContext(params as { filePath: string }),
  uploadFile: (params) => handleUploadFile(params as { path: string; data: string }),
  writeFile: (params) => handleWriteFile(params as { path: string; content: string }),
};

// ─── Static file serving + WebSocket RPC server ──────────────────────────────

const studioDir = process.env.JX_STUDIO_ASSETS || resolve(import.meta.dir, "../../assets/studio");

const server = Bun.serve({
  async fetch(req, srv) {
    if (srv.upgrade(req)) {
      return;
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/{2,}/, "/");

    // AI routes (SSE streaming + REST)
    if (path.startsWith("/studio/ai/")) {
      const aiResponse = await handleAiRoute(req, path, projectRoot);
      if (aiResponse) {
        return aiResponse;
      }
    }

    if (path.startsWith("/studio/")) {
      const assetPath = resolve(studioDir, `.${path.replace("/studio/", "/")}`);
      const file = Bun.file(assetPath);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    const root = getProjectRoot();
    if (root) {
      // Serve absolute paths that fall under the project root
      if (path.startsWith(root)) {
        const file = Bun.file(path);
        if (await file.exists()) {
          return new Response(file);
        }
      }

      // Serve relative paths from project root
      const projectFile = Bun.file(resolve(root, `.${path}`));
      if (await projectFile.exists()) {
        return new Response(projectFile);
      }

      // Serve from public/ subdirectory
      const publicFile = Bun.file(resolve(root, "public", `.${path}`));
      if (await publicFile.exists()) {
        return new Response(publicFile);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
  port: 0,
  websocket: {
    async message(ws, raw) {
      let msg: { id: number; method: string; params?: unknown };
      try {
        msg = JSON.parse(raw as string);
      } catch {
        ws.send(JSON.stringify({ error: "Invalid JSON", id: 0 }));
        return;
      }

      const handler = handlers[msg.method];
      if (!handler) {
        ws.send(
          JSON.stringify({
            error: `Unknown method: ${msg.method}`,
            id: msg.id,
          }),
        );
        return;
      }

      try {
        const result = await handler(msg.params);
        ws.send(JSON.stringify({ id: msg.id, result: result ?? null }));
      } catch (error: unknown) {
        ws.send(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            id: msg.id,
          }),
        );
      }
    },
  },
});

const serverUrl = `http://localhost:${server.port}`;
console.log(`[chromium] Studio server at ${serverUrl}`);
console.log(`[chromium] WebSocket RPC at ws://localhost:${server.port}`);
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

  for (const bin of candidates) {
    try {
      const result = Bun.spawnSync(["which", bin]);
      if (result.exitCode === 0) {
        return result.stdout.toString().trim();
      }
    } catch {}
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
  `--app=${serverUrl}/studio/index.html`,
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
