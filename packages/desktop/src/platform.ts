/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { Electroview } from "electrobun/view";
import { html, render as litRender } from "lit-html";
import type { StudioRPC } from "./rpc-schema";
import type { ProjectConfig } from "@jxsuite/schema/types";

export function createDesktopPlatform() {
  const rpc = Electroview.defineRPC<StudioRPC>({
    handlers: {
      messages: {
        fileChanged: (payload) => {
          console.log("[desktop] File changed:", payload.path);
        },
        updateReady: (payload) => {
          showUpdateToast(payload.version, rpc);
        },
      },
      requests: {},
    },
    maxRequestTime: 300_000,
  });

  new Electroview({ rpc });

  const originalFetch = window.fetch.bind(window);
  (window as unknown as Record<string, unknown>).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    // Route the runtime's dev-proxy endpoints through RPC. The runtime POSTs to relative
    // "/__jx_resolve__" (class resolution) and "/__jx_server__" (server functions); under the
    // views:// protocol these would otherwise resolve to a missing view resource.
    let pathname = url;
    try {
      ({ pathname } = new URL(url, location.href));
    } catch {}
    if (pathname === "/__jx_resolve__" || pathname === "/__jx_server__") {
      const body = init?.body != null ? String(init.body) : "{}";
      const handler =
        pathname === "/__jx_server__" ? rpc.request.jxServerFunction : rpc.request.jxResolve;
      try {
        const { status, body: resBody } = await handler({ body });
        return new Response(resBody, {
          headers: { "content-type": "application/json" },
          status,
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), {
          headers: { "content-type": "application/json" },
          status: 500,
        });
      }
    }

    if (url.startsWith("views://")) {
      const path = url.replace(/^views:\/\/[^/]+\//, "");
      try {
        const content = await rpc.request.readFile({ path });
        const ext = path.split(".").pop() || "";
        const mime = ext === "json" ? "application/json" : "text/plain";
        return new Response(content as string, {
          headers: { "content-type": mime },
          status: 200,
        });
      } catch {
        try {
          const content = await rpc.request.readFile({
            path: `public/${path}`,
          });
          const ext = path.split(".").pop() || "";
          const mime = ext === "json" ? "application/json" : "text/plain";
          return new Response(content as string, {
            headers: { "content-type": mime },
            status: 200,
          });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      }
    }
    return originalFetch(input, init);
  };

  // ─── Global MutationObserver: resolve relative asset URLs everywhere ────────
  // Catches <img src>, <video src>, <source src>, <video poster> in any part of
  // The DOM (canvas, panels, dropdowns, etc.) so we don't need per-component fixes.
  const resolving = new WeakSet<Element>();

  function resolveElementAssets(el: Element) {
    if (resolving.has(el)) {
      return;
    }
    const tag = el.tagName;
    if (tag !== "IMG" && tag !== "VIDEO" && tag !== "SOURCE") {
      return;
    }

    for (const attr of ["src", "poster"]) {
      const val = el.getAttribute(attr);
      if (
        val &&
        !val.startsWith("data:") &&
        !val.startsWith("blob:") &&
        !val.startsWith("http") &&
        !val.startsWith("views://")
      ) {
        resolving.add(el);
        el.removeAttribute(attr);
        const path = val.replace(/^\.?\//, "");
        rpc.request
          .readFileAsDataUrl({ path })
          .then((dataUrl: string) => {
            if (dataUrl) {
              el.setAttribute(attr, dataUrl);
            }
          })
          .catch(() => {})
          .finally(() => resolving.delete(el));
      }
    }
  }

  function resolveBackgroundImage(el: Element) {
    const htmlEl = el as HTMLElement;
    if (!htmlEl.style) {
      return;
    }
    const bg = htmlEl.style.backgroundImage;
    if (!bg) {
      return;
    }
    const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (!match) {
      return;
    }
    const val = match[1];
    if (val.startsWith("data:") || val.startsWith("blob:") || val.startsWith("http")) {
      return;
    }
    const path = val.replace(/^\.?\//, "");
    rpc.request
      .readFileAsDataUrl({ path })
      .then((dataUrl: string) => {
        if (dataUrl) {
          htmlEl.style.backgroundImage = `url(${dataUrl})`;
        }
      })
      .catch(() => {});
  }

  function resolveAllAssets(el: Element) {
    resolveElementAssets(el);
    resolveBackgroundImage(el);
    for (const child of el.querySelectorAll("img[src], video[src], source[src], video[poster]")) {
      resolveElementAssets(child);
    }
    for (const child of el.querySelectorAll("[style]")) {
      resolveBackgroundImage(child);
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) {
            continue;
          }
          resolveAllAssets(node as Element);
        }
      } else if (mutation.type === "attributes") {
        const el = mutation.target as Element;
        if (mutation.attributeName === "style") {
          resolveBackgroundImage(el);
        } else {
          resolveElementAssets(el);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    attributeFilter: ["src", "poster", "style"],
    attributes: true,
    childList: true,
    subtree: true,
  });

  return {
    id: "desktop" as const,

    projectRoot: "",

    async activate() {
      /* No-op */
    },

    async openProject() {
      const res = await rpc.request.openProject();
      return res;
    },

    async probeRootProject() {
      try {
        const content = await rpc.request.readFile({ path: "project.json" });
        const config = JSON.parse(content as string) as ProjectConfig;
        return {
          info: {
            directories: [] as string[],
            isSiteProject: true as const,
            projectConfig: config,
          },
          meta: { name: config.name || "project", root: "." },
        };
      } catch {
        return {
          info: {
            directories: [] as string[],
            isSiteProject: false as const,
            projectConfig: null,
          },
          meta: { name: "project", root: "." },
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
      return rpc.request.writeFile({ content, path });
    },

    async uploadFile(path: string, data: string) {
      return rpc.request.uploadFile({ data, path });
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
      return rpc.request.discoverComponents({ ...(dir != null && { dir }) });
    },

    async codeService(action: string, payload: unknown) {
      return rpc.request.codeService({ action, payload });
    },

    async locateFile(name: string) {
      return rpc.request.locateFile({ name });
    },

    async fetchPluginSchema(src: string, prototype?: string, base?: string) {
      return rpc.request.fetchPluginSchema({
        src,
        ...(prototype != null && { prototype }),
        ...(base != null && { base }),
      });
    },

    async gitStatus() {
      return rpc.request.gitStatus();
    },

    async gitBranches() {
      return rpc.request.gitBranches();
    },

    async gitLog(limit?: number) {
      return rpc.request.gitLog({ ...(limit != null && { limit }) });
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

    async gitPush(opts?: { setUpstream?: boolean }) {
      return rpc.request.gitPush(opts || {});
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
      return rpc.request.gitDiff({ ...(path != null && { path }) });
    },

    async gitDiscard(files: string[]) {
      return rpc.request.gitDiscard({ files });
    },

    async gitShow(opts: { path: string; ref?: string }) {
      return rpc.request.gitShow(opts);
    },

    async gitInit() {
      await rpc.request.gitInit();
    },

    async gitAddRemote(name: string, url: string) {
      await rpc.request.gitAddRemote({ name, url });
    },

    async searchFiles(query: string) {
      return rpc.request.searchFiles({ query });
    },

    async listFormats() {
      return rpc.request.listFormats();
    },

    /** @param {Record<string, unknown>} payload */
    async formatAction(payload: Record<string, unknown>) {
      return rpc.request.formatAction(
        payload as { format: string; action: string; source?: string },
      );
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

    async createProject(opts: {
      name: string;
      description?: string;
      url?: string;
      adapter?: string;
      directory: string;
    }) {
      return rpc.request.createProject(opts) as Promise<{
        root: string;
        config: ProjectConfig;
      }>;
    },

    updater: {
      applyUpdate: () => rpc.request.updaterApplyUpdate(),
      checkForUpdate: () => rpc.request.updaterCheckForUpdate(),
      downloadUpdate: () => rpc.request.updaterDownloadUpdate(),
      getLocalInfo: () => rpc.request.updaterGetLocalInfo(),
      getStatus: () => rpc.request.updaterGetStatus(),
    },

    windowControls: {
      close: () => rpc.request.windowClose(),
      getFrame: () => rpc.request.windowGetFrame(),
      maximize: () => rpc.request.windowMaximize(),
      minimize: () => rpc.request.windowMinimize(),
      setFrame: (x: number, y: number, w: number, h: number) =>
        rpc.request.windowSetFrame({ height: h, width: w, x, y }),
    },

    // AI Assistant
    async aiAuthStatus() {
      return rpc.request.aiAuthStatus() as Promise<{
        authenticated: boolean;
        error?: string;
      }>;
    },
    async aiCreateSession(opts: { message: string; systemPrompt?: string }) {
      return rpc.request.aiCreateSession(opts) as Promise<{ id: string }>;
    },
    async aiSendMessage(id: string, message: string) {
      await rpc.request.aiSendMessage({ id, message });
    },
    aiStreamUrl(id: string) {
      return rpc.request.aiStreamUrl({ id }) as Promise<string>;
    },
    async aiStopSession(id: string) {
      await rpc.request.aiStopSession({ id });
    },
    async aiDeleteSession(id: string) {
      await rpc.request.aiDeleteSession({ id });
    },
  };
}

function showUpdateToast(version: string, rpc: { request: { updaterApplyUpdate: () => unknown } }) {
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
  document.body.append(container);
}
