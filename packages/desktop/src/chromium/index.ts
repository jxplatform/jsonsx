import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  setProjectRoot,
  setFileDialog,
  getProjectRoot,
  openProject,
  listDirectory,
  handleReadFile,
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
} from "../handlers";
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
} from "../git";
import { addPackage, removePackage, listPackages } from "../packages";
import { openFileDialog } from "./utils";

// ─── Project root ────────────────────────────────────────────────────────────

const projectRoot = process.argv[2] || process.env.JSONSX_PROJECT_ROOT || process.cwd();
setProjectRoot(projectRoot);
setFileDialog(openFileDialog);

// ─── RPC handler dispatch map ────────────────────────────────────────────────

const handlers: Record<string, (params: any) => Promise<any>> = {
  openProject: () => openProject(),
  listDirectory: (params) => listDirectory(params),
  readFile: (params) => handleReadFile(params),
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
};

// ─── Static file serving + WebSocket RPC server ──────────────────────────────

const studioDir = process.env.JX_STUDIO_ASSETS || resolve(import.meta.dir, "../../assets/studio");

const server = Bun.serve({
  port: 0,
  async fetch(req, server) {
    if (server.upgrade(req)) return;

    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith("/studio/")) {
      const assetPath = resolve(studioDir, "." + path.replace("/studio/", "/"));
      const file = Bun.file(assetPath);
      if (await file.exists()) return new Response(file);
    }

    const root = getProjectRoot();
    if (root) {
      const publicFile = Bun.file(resolve(root, "public", "." + path));
      if (await publicFile.exists()) return new Response(publicFile);
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    async message(ws, raw) {
      let msg: { id: number; method: string; params?: any };
      try {
        msg = JSON.parse(raw as string);
      } catch {
        ws.send(JSON.stringify({ id: 0, error: "Invalid JSON" }));
        return;
      }

      const handler = handlers[msg.method];
      if (!handler) {
        ws.send(JSON.stringify({ id: msg.id, error: `Unknown method: ${msg.method}` }));
        return;
      }

      try {
        const result = await handler(msg.params);
        ws.send(JSON.stringify({ id: msg.id, result: result ?? null }));
      } catch (err: any) {
        ws.send(JSON.stringify({ id: msg.id, error: err.message || String(err) }));
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
      if (result.exitCode === 0) return result.stdout.toString().trim();
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
  stdio: "inherit",
  detached: false,
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
