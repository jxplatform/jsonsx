import { Electroview } from "electrobun/view";
import { html, render as litRender } from "lit-html";
import type { StudioRPC } from "./rpc-schema";

export function createDesktopPlatform() {
  const rpc = Electroview.defineRPC<StudioRPC>({
    maxRequestTime: 300000,
    handlers: {
      requests: {},
      messages: {
        fileChanged: (payload) => {
          console.log("[desktop] File changed:", payload.path);
        },
        updateReady: (payload) => {
          showUpdateToast(payload.version, rpc);
        },
      },
    },
  });

  new Electroview({ rpc });

  const originalFetch = window.fetch.bind(window);
  (window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.startsWith("views://")) {
      const path = url.replace(/^views:\/\/[^/]+\//, "");
      try {
        const content = await rpc.request.readFile({ path });
        const ext = path.split(".").pop() || "";
        const mime = ext === "json" ? "application/json" : "text/plain";
        return new Response(content as string, {
          status: 200,
          headers: { "content-type": mime },
        });
      } catch {
        try {
          const content = await rpc.request.readFile({ path: `public/${path}` });
          const ext = path.split(".").pop() || "";
          const mime = ext === "json" ? "application/json" : "text/plain";
          return new Response(content as string, {
            status: 200,
            headers: { "content-type": mime },
          });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      }
    }
    return originalFetch(input, init);
  };

  return {
    id: "desktop" as const,

    projectRoot: "",

    async activate() {
      /* no-op */
    },

    async openProject() {
      return rpc.request.openProject();
    },

    async probeRootProject() {
      try {
        const content = await rpc.request.readFile({ path: "project.json" });
        const config = JSON.parse(content as string);
        return {
          meta: { root: ".", name: config.name || "project" },
          info: {
            isSiteProject: true,
            projectConfig: config,
            directories: [],
          },
        };
      } catch {
        return {
          meta: { root: ".", name: "project" },
          info: { isSiteProject: false, projectConfig: null, directories: [] },
        };
      }
    },

    async resolveSiteContext(filePath: string) {
      return rpc.request.resolveSiteContext({ filePath });
    },

    async listDirectory(dir: string) {
      return rpc.request.listDirectory({ dir });
    },

    async readFile(path: string) {
      return rpc.request.readFile({ path });
    },

    async resolveAssetUrl(path: string): Promise<string | null> {
      try {
        return await rpc.request.readFileAsDataUrl({ path });
      } catch {
        return null;
      }
    },

    async writeFile(path: string, content: string) {
      return rpc.request.writeFile({ path, content });
    },

    async uploadFile(path: string, data: string) {
      return rpc.request.uploadFile({ path, data });
    },

    async deleteFile(path: string) {
      return rpc.request.deleteFile({ path });
    },

    async renameFile(from: string, to: string) {
      return rpc.request.renameFile({ from, to });
    },

    async createDirectory(path: string) {
      return rpc.request.createDirectory({ path });
    },

    async discoverComponents(dir?: string) {
      return rpc.request.discoverComponents({ dir });
    },

    async codeService(action: string, payload: unknown) {
      return rpc.request.codeService({ action, payload });
    },

    async locateFile(name: string) {
      return rpc.request.locateFile({ name });
    },

    async fetchPluginSchema(src: string, prototype?: string, base?: string) {
      return rpc.request.fetchPluginSchema({ src, prototype, base });
    },

    async gitStatus() {
      return rpc.request.gitStatus();
    },

    async gitBranches() {
      return rpc.request.gitBranches();
    },

    async gitLog(limit?: number) {
      return rpc.request.gitLog({ limit });
    },

    async gitStage(files: string[]) {
      return rpc.request.gitStage({ files });
    },

    async gitUnstage(files: string[]) {
      return rpc.request.gitUnstage({ files });
    },

    async gitCommit(message: string) {
      return rpc.request.gitCommit({ message });
    },

    async gitPush() {
      return rpc.request.gitPush();
    },

    async gitPull() {
      return rpc.request.gitPull();
    },

    async gitFetch() {
      return rpc.request.gitFetch();
    },

    async gitCheckout(branch: string) {
      return rpc.request.gitCheckout({ branch });
    },

    async gitCreateBranch(name: string) {
      return rpc.request.gitCreateBranch({ name });
    },

    async gitDiff(path?: string) {
      return rpc.request.gitDiff({ path });
    },

    async gitDiscard(files: string[]) {
      return rpc.request.gitDiscard({ files });
    },

    async addPackage(name: string) {
      return rpc.request.addPackage({ name });
    },

    async removePackage(name: string) {
      return rpc.request.removePackage({ name });
    },

    async listPackages() {
      return rpc.request.listPackages();
    },

    windowControls: {
      minimize: () => rpc.request.windowMinimize(),
      maximize: () => rpc.request.windowMaximize(),
      close: () => rpc.request.windowClose(),
    },
  };
}

function showUpdateToast(version: string, rpc: any) {
  const container = document.createElement("div");
  container.className = "update-toast-container";
  litRender(
    html`
      <sp-toast open variant="info">
        Version ${version} is ready
        <sp-button
          slot="action"
          variant="overBackground"
          @click=${() => rpc.request.updaterApplyUpdate()}
        >
          Restart to update
        </sp-button>
      </sp-toast>
    `,
    container,
  );
  document.body.appendChild(container);
}
