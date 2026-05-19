import {
  setProjectRoot,
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
} from "../src/handlers";
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
} from "../src/git";
import { addPackage, removePackage, listPackages } from "../src/packages";

const projectRoot = process.argv[2] || process.cwd();
setProjectRoot(projectRoot);

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

const server = Bun.serve({
  port: 0,
  async fetch(req, server) {
    if (server.upgrade(req)) return;
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

console.log(`[test-server] port=${server.port}`);
