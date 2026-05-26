export function createDesktopPlatform() {
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
      return request("openProject");
    },

    async probeRootProject() {
      try {
        const content = await request("readFile", { path: "project.json" });
        const config = JSON.parse(content as string);
        return {
          meta: { root: ".", name: config.name || "project" },
          info: { isSiteProject: true, projectConfig: config, directories: [] },
        };
      } catch {
        return {
          meta: { root: ".", name: "project" },
          info: { isSiteProject: false, projectConfig: null, directories: [] },
        };
      }
    },

    async resolveSiteContext(filePath: string) {
      return request("resolveSiteContext", { filePath });
    },

    async listDirectory(dir: string) {
      return request("listDirectory", { dir });
    },

    async readFile(path: string) {
      return request("readFile", { path });
    },

    async writeFile(path: string, content: string) {
      return request("writeFile", { path, content });
    },

    async uploadFile(path: string, data: string) {
      return request("uploadFile", { path, data });
    },

    async deleteFile(path: string) {
      return request("deleteFile", { path });
    },

    async renameFile(from: string, to: string) {
      return request("renameFile", { from, to });
    },

    async createDirectory(path: string) {
      return request("createDirectory", { path });
    },

    async discoverComponents(dir?: string) {
      return request("discoverComponents", { dir });
    },

    async codeService(action: string, payload: unknown) {
      return request("codeService", { action, payload });
    },

    async locateFile(name: string) {
      return request("locateFile", { name });
    },

    async fetchPluginSchema(src: string, prototype?: string, base?: string) {
      return request("fetchPluginSchema", { src, prototype, base });
    },

    async gitStatus() {
      return request("gitStatus");
    },

    async gitBranches() {
      return request("gitBranches");
    },

    async gitLog(limit?: number) {
      return request("gitLog", { limit });
    },

    async gitStage(files: string[]) {
      return request("gitStage", { files });
    },

    async gitUnstage(files: string[]) {
      return request("gitUnstage", { files });
    },

    async gitCommit(message: string) {
      return request("gitCommit", { message });
    },

    async gitPush() {
      return request("gitPush");
    },

    async gitPull() {
      return request("gitPull");
    },

    async gitFetch() {
      return request("gitFetch");
    },

    async gitCheckout(branch: string) {
      return request("gitCheckout", { branch });
    },

    async gitCreateBranch(name: string) {
      return request("gitCreateBranch", { name });
    },

    async gitDiff(path?: string) {
      return request("gitDiff", { path });
    },

    async gitDiscard(files: string[]) {
      return request("gitDiscard", { files });
    },

    async addPackage(name: string) {
      return request("addPackage", { name });
    },

    async removePackage(name: string) {
      return request("removePackage", { name });
    },

    async listPackages() {
      return request("listPackages");
    },
  };
}
