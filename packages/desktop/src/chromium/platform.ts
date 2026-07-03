/// <reference lib="dom" />
import type {
  ComponentMeta,
  RecentProjectEntry,
  RenameResult,
  StudioPlatform,
} from "@jxsuite/studio/types";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type {
  CodeServiceResult,
  DirEntry,
  GitBranchesResult,
  GitLogEntry,
  GitStatusResult,
  OutdatedInfo,
  PackageInfo,
  PackageOpResult,
} from "../rpc-schema";

export function createDesktopPlatform(): StudioPlatform {
  // The project server gates the WS upgrade on the token. The launcher passes it in the shell URL
  // (?token=…); read it here before the shell strips it from the address bar after boot.
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const ws = new WebSocket(`ws://${location.host}/?token=${encodeURIComponent(token)}`);
  // The canvas iframe runs the in-iframe runtime, which authenticates its dev-proxy loopback
  // Resolve/server fetches with this same per-process rpcToken (?rpcToken=…). Thread it onto the
  // Canvas URL when present so createProjectServer does not 403 those fetches; keep the bare path
  // Otherwise so a token-less/dev context stays byte-identical. Mirrors electrobun's getCanvasUrl.
  const canvasUrl = token
    ? `/__studio__/canvas.html?rpcToken=${encodeURIComponent(token)}`
    : "/__studio__/canvas.html";
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as {
      id: number;
      error?: string;
      result?: unknown;
    };
    const p = pending.get(msg.id);
    if (!p) {
      return;
    }
    pending.delete(msg.id);
    if (msg.error) {
      p.reject(new Error(msg.error));
    } else {
      p.resolve(msg.result);
    }
  });

  const ready = new Promise<void>((resolve) => {
    ws.addEventListener("open", () => resolve());
  });

  function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return ready.then(
      () =>
        new Promise((resolve, reject) => {
          const id = (nextId += 1);
          pending.set(id, { reject, resolve });
          ws.send(JSON.stringify({ id, method, params }));
        }),
    );
  }

  return {
    id: "desktop" as const,

    projectRoot: "",

    // The chromium project server serves the canvas iframe doc under /__studio__/. Only chromium
    // Sets this; electrobun and the dev server leave it unset and keep their default canvas path.
    // The ?rpcToken (computed above) authenticates the in-iframe runtime's loopback resolve/server
    // Fetches, mirroring electrobun's getCanvasUrl RPC.
    canvasUrl,

    async activate() {
      // No-op: the chromium platform needs no activation step
    },

    async openProject() {
      return request("openProject") as Promise<{
        config: ProjectConfig;
        handle: { root: string; name: string; projectConfig: ProjectConfig };
      } | null>;
    },

    async probeRootProject() {
      try {
        const content = await request("readFile", { path: "project.json" });
        const config = JSON.parse(content as string) as { name?: string };
        // Resolve the absolute backend root so the recent-projects list gets a re-openable key.
        const { root } = (await request("getProjectRoot")) as { root: string | null };
        return {
          info: {
            directories: [] as string[],
            isSiteProject: true as const,
            projectConfig: config as ProjectConfig,
          },
          meta: { name: config.name || "project", root: root || "." },
        };
      } catch {
        // The launcher's root defaults to the launch cwd, which usually holds no project.json.
        // Report "no project" (null) so the studio shows the welcome screen — returning a phantom
        // Non-site project instead sets projectState and suppresses the welcome screen for the
        // Whole session (mirrors the electrobun platform's probeRootProject contract).
        return null;
      }
    },

    async getProjectRoot() {
      return request("getProjectRoot") as Promise<{ root: string | null }>;
    },

    async setWindowProject(root: string) {
      return request("setWindowProject", { root }) as Promise<{
        deduped: boolean;
        config: ProjectConfig | null;
      }>;
    },

    // ─── Recent projects (user-level store, shared across per-project profiles) ──

    async getRecentProjects() {
      return request("getRecentProjects") as Promise<RecentProjectEntry[]>;
    },

    async saveRecentProjects(projects: RecentProjectEntry[]) {
      await request("saveRecentProjects", { projects });
    },

    async resolveSiteContext(filePath: string) {
      return request("resolveSiteContext", { filePath }) as Promise<{
        sitePath: string | null;
        projectConfig?: ProjectConfig;
        fileRelPath?: string;
      }>;
    },

    async listDirectory(dir: string) {
      return request("listDirectory", { dir }) as Promise<DirEntry[]>;
    },

    async readFile(path: string) {
      return request("readFile", { path }) as Promise<string>;
    },

    async writeFile(path: string, content: string) {
      return request("writeFile", { content, path }) as Promise<void>;
    },

    async uploadFile(path: string, data: string | File | Blob | ArrayBuffer) {
      return request("uploadFile", { data, path }) as Promise<unknown>;
    },

    async deleteFile(path: string) {
      return request("deleteFile", { path }) as Promise<void>;
    },

    async renameFile(from: string, to: string) {
      return request("renameFile", { from, to }) as Promise<RenameResult>;
    },

    async createDirectory(path: string) {
      return request("createDirectory", { path }) as Promise<void>;
    },

    async discoverComponents(dir?: string) {
      return request("discoverComponents", { dir }) as Promise<ComponentMeta[]>;
    },

    async codeService(action: string, payload: unknown) {
      return request("codeService", {
        action,
        payload,
      }) as Promise<CodeServiceResult | null>;
    },

    async locateFile(name: string) {
      return request("locateFile", { name }) as Promise<string | null>;
    },

    async fetchPluginSchema(src: string, prototype?: string, base?: string) {
      return request("fetchPluginSchema", {
        base,
        prototype,
        src,
      }) as Promise<unknown>;
    },

    async gitStatus() {
      return request("gitStatus") as Promise<GitStatusResult>;
    },

    async gitBranches() {
      return request("gitBranches") as Promise<GitBranchesResult>;
    },

    async gitLog(limit?: number) {
      return request("gitLog", { limit }) as Promise<GitLogEntry[]>;
    },

    async gitStage(files: string[]) {
      return request("gitStage", { files }) as Promise<void>;
    },

    async gitUnstage(files: string[]) {
      return request("gitUnstage", { files }) as Promise<void>;
    },

    async gitCommit(message: string) {
      return request("gitCommit", { message }) as Promise<void>;
    },

    async gitPush(opts?: { setUpstream?: boolean }) {
      return request("gitPush", opts || {}) as Promise<void>;
    },

    async gitPull() {
      return request("gitPull") as Promise<void>;
    },

    async gitFetch() {
      return request("gitFetch") as Promise<void>;
    },

    async gitCheckout(branch: string) {
      return request("gitCheckout", { branch }) as Promise<void>;
    },

    async gitCreateBranch(name: string) {
      return request("gitCreateBranch", { name }) as Promise<void>;
    },

    async gitDiff(path?: string) {
      return request("gitDiff", { path }) as Promise<string>;
    },

    async gitDiscard(files: string[]) {
      return request("gitDiscard", { files }) as Promise<void>;
    },

    async gitShow(opts: { path: string; ref?: string }) {
      return request("gitShow", opts) as Promise<string>;
    },

    async gitInit() {
      await request("gitInit");
    },

    async gitAddRemote(name: string, url: string) {
      await request("gitAddRemote", { name, url });
    },

    async searchFiles(query: string) {
      return request("searchFiles", { query }) as Promise<DirEntry[]>;
    },

    async listFormats() {
      return request("listFormats", {}) as Promise<Record<string, unknown>[]>;
    },

    /** @param {Record<string, unknown>} payload */
    async formatAction(payload: Record<string, unknown>) {
      return request("formatAction", payload);
    },

    async addPackage(name: string) {
      return request("addPackage", { name }) as Promise<unknown>;
    },

    async removePackage(name: string) {
      return request("removePackage", { name }) as Promise<unknown>;
    },

    async listPackages() {
      return request("listPackages") as Promise<PackageInfo[]>;
    },

    async installDependencies() {
      return request("installDependencies") as Promise<PackageOpResult>;
    },

    async dependenciesNeedInstall() {
      return request("dependenciesNeedInstall") as Promise<boolean>;
    },

    async outdatedPackages() {
      return request("outdatedPackages") as Promise<OutdatedInfo[]>;
    },

    async setPackageVersions(updates: { name: string; version: string; dev?: boolean }[]) {
      return request("setPackageVersions", { updates }) as Promise<PackageOpResult>;
    },

    async createProject(opts: {
      name: string;
      description?: string;
      url?: string;
      adapter?: string;
      directory: string;
    }) {
      return request("createProject", opts) as Promise<{
        root: string;
        config: ProjectConfig;
      }>;
    },

    // AI Assistant (Stack B: OpenAI-compatible SSE proxy on the local chromium server)
    aiChatUrl() {
      return "/__studio__/ai/chat";
    },
  };
}
