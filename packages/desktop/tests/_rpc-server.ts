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

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
  openProject: () => openProject(),
  listDirectory: (params) => listDirectory(params as { dir: string }),
  readFile: (params) => handleReadFile(params as { path: string }),
  writeFile: (params) => handleWriteFile(params as { path: string; content: string }),
  deleteFile: (params) => handleDeleteFile(params as { path: string }),
  renameFile: (params) => handleRenameFile(params as { from: string; to: string }),
  createDirectory: (params) => handleCreateDirectory(params as { path: string }),
  uploadFile: (params) => handleUploadFile(params as { path: string; data: string }),
  resolveSiteContext: (params) => handleResolveSiteContext(params as { filePath: string }),
  discoverComponents: (params) => discoverComponents(params as { dir?: string }),
  codeService: (params) => codeService(params),
  locateFile: (params) => locateFile(params as { name: string }),
  fetchPluginSchema: (params) =>
    fetchPluginSchema(params as { src: string; prototype?: string; base?: string }),
  gitStatus: () => gitStatus(),
  gitBranches: () => gitBranches(),
  gitLog: (params) => gitLog(params as { limit?: number }),
  gitStage: (params) => gitStage(params as { files: string[] }),
  gitUnstage: (params) => gitUnstage(params as { files: string[] }),
  gitCommit: (params) => gitCommit(params as { message: string }),
  gitPush: () => gitPush(),
  gitPull: () => gitPull(),
  gitFetch: () => gitFetch(),
  gitCheckout: (params) => gitCheckout(params as { branch: string }),
  gitCreateBranch: (params) => gitCreateBranch(params as { name: string }),
  gitDiff: (params) => gitDiff(params as { path?: string }),
  gitDiscard: (params) => gitDiscard(params as { files: string[] }),
  addPackage: (params) => addPackage(params as { name: string }),
  removePackage: (params) => removePackage(params as { name: string }),
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
      let msg: { id: number; method: string; params?: unknown };
      try {
        msg = JSON.parse(raw as string);
      } catch {
        ws.send(JSON.stringify({ id: 0, error: "Invalid JSON" }));
        return;
      }

      const handler = handlers[msg.method];
      if (!handler) {
        await Bun.sleep(0);
        ws.send(JSON.stringify({ id: msg.id, error: `Unknown method: ${msg.method}` }));
        return;
      }

      try {
        const result = await handler(msg.params);
        ws.send(JSON.stringify({ id: msg.id, result: result ?? null }));
      } catch (err: unknown) {
        await Bun.sleep(0);
        ws.send(
          JSON.stringify({ id: msg.id, error: err instanceof Error ? err.message : String(err) }),
        );
      }
    },
  },
});

console.log(`[test-server] port=${server.port}`);
