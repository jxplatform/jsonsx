export function createDesktopPlatform(): StudioPlatform {
  const ws = new WebSocket(`ws://${location.host}`);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const p = pending.get(msg.id);
    if (!p) return;
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
          const id = nextId++;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        }),
    );
  }

  return {
    id: "desktop" as const,

    projectRoot: "",

    async activate() {},

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
        return {
          meta: { root: ".", name: config.name || "project" },
          info: {
            isSiteProject: true as const,
            projectConfig: config as ProjectConfig,
            directories: [] as string[],
          },
        };
      } catch {
        return {
          meta: { root: ".", name: "project" },
          info: { isSiteProject: false as const, projectConfig: null, directories: [] as string[] },
        };
      }
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
      return request("writeFile", { path, content }) as Promise<void>;
    },

    async uploadFile(path: string, data: string) {
      return request("uploadFile", { path, data }) as Promise<unknown>;
    },

    async deleteFile(path: string) {
      return request("deleteFile", { path }) as Promise<void>;
    },

    async renameFile(from: string, to: string) {
      return request("renameFile", { from, to }) as Promise<void>;
    },

    async createDirectory(path: string) {
      return request("createDirectory", { path }) as Promise<void>;
    },

    async discoverComponents(dir?: string) {
      return request("discoverComponents", { dir }) as Promise<ComponentMeta[]>;
    },

    async codeService(action: string, payload: unknown) {
      return request("codeService", { action, payload }) as Promise<CodeServiceResult | null>;
    },

    async locateFile(name: string) {
      return request("locateFile", { name }) as Promise<string | null>;
    },

    async fetchPluginSchema(src: string, prototype?: string, base?: string) {
      return request("fetchPluginSchema", { src, prototype, base }) as Promise<unknown>;
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

    async gitPush() {
      return request("gitPush") as Promise<void>;
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

    async searchFiles(query: string) {
      return request("searchFiles", { query }) as Promise<DirEntry[]>;
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

    async createProject(opts: {
      name: string;
      description?: string;
      url?: string;
      adapter?: string;
      directory: string;
    }) {
      return request("createProject", opts) as Promise<{ root: string; config: ProjectConfig }>;
    },

    // AI Assistant
    async aiAuthStatus() {
      const res = await fetch("/studio/ai/auth-status");
      return res.json() as Promise<{ authenticated: boolean; error?: string }>;
    },
    async aiCreateSession(opts: { message: string; systemPrompt?: string }) {
      const res = await fetch("/studio/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      return res.json() as Promise<{ id: string }>;
    },
    async aiSendMessage(id: string, message: string) {
      await fetch(`/studio/ai/session/${id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
    },
    aiStreamUrl(id: string) {
      return `/studio/ai/session/${id}/stream`;
    },
    async aiStopSession(id: string) {
      await fetch(`/studio/ai/session/${id}/stop`, { method: "POST" });
    },
    async aiDeleteSession(id: string) {
      await fetch(`/studio/ai/session/${id}`, { method: "DELETE" });
    },
  };
}
