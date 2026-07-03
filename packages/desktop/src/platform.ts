/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { Electroview } from "electrobun/view";
import { html, render as litRender } from "lit-html";
import type { RecentProjectEntry, StudioRPC } from "./rpc-schema";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type { FsEventPayload } from "@jxsuite/server/refactor";

export function createDesktopPlatform() {
  // The studio sidebar's live-sync subscriber, if any. Set via subscribeFileEvents below.
  let fileEventHandler: ((events: FsEventPayload[]) => void) | null = null;
  const rpc = Electroview.defineRPC<StudioRPC>({
    handlers: {
      messages: {
        fileChanged: (payload) => {
          console.log("[desktop] File changed:", payload.path);
        },
        onFileEvents: (payload) => {
          fileEventHandler?.(payload.events);
        },
        updateReady: (payload) => {
          showUpdateToast(payload.version, rpc);
        },
      },
      requests: {},
    },
    maxRequestTime: 300_000,
  });

  const electroview = new Electroview({ rpc });
  void electroview;

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
        return Response.json(
          { error: String(error) },
          {
            headers: { "content-type": "application/json" },
            status: 500,
          },
        );
      }
    }

    return originalFetch(input, init);
  };

  // ─── Global MutationObserver: resolve relative asset URLs everywhere ────────
  // Catches <img src>, <video src>, <source src>, <video poster> in any part of
  // The DOM (canvas, panels, dropdowns, etc.) so we don't need per-component fixes.
  //
  // The shell document lives on views://; a relative PANEL asset src there does not resolve to a
  // Servable URL, so the observer rewrites it to ${loopbackOrigin()}/<path> — an absolute URL on the
  // Per-window loopback server (a cross-origin <img> load, which needs NO CORS). loopbackOrigin() is
  // The canvas origin from platform.canvasUrl (always set once activate() resolves); if it is not yet
  // Resolved at boot, the observer no-ops that one mutation rather than rewriting it.
  function loopbackOrigin(): string | null {
    const { canvasUrl } = platform;
    if (!canvasUrl) {
      return null;
    }
    try {
      const { protocol, origin } = new URL(canvasUrl, location.href);
      return protocol === "http:" || protocol === "https:" ? origin : null;
    } catch {
      return null;
    }
  }

  function resolveElementAssets(el: Element) {
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
        const origin = loopbackOrigin();
        if (!origin) {
          // The canvas origin isn't resolved yet (pre-activate) — leave this mutation untouched.
          continue;
        }
        // Point the panel <img> straight at the loopback server (a cross-origin image load,
        // Allowed without CORS).
        const path = val.replace(/^\.?\//, "");
        el.setAttribute(attr, `${origin}/${path}`);
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
    const [, val] = match;
    if (val.startsWith("data:") || val.startsWith("blob:") || val.startsWith("http")) {
      return;
    }
    const origin = loopbackOrigin();
    if (!origin) {
      // The canvas origin isn't resolved yet (pre-activate) — leave this mutation untouched.
      return;
    }
    // Rewrite the background-image url() to the loopback origin (a cross-origin image load).
    const path = val.replace(/^\.?\//, "");
    htmlEl.style.backgroundImage = `url(${origin}/${path})`;
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

  const platform = {
    id: "desktop" as const,

    projectRoot: "",

    /**
     * The cross-origin loopback canvas URL for this window, fetched in {@link activate} (awaited at
     * studio boot, before the first canvas mount). The iframe-host resolves the iframe `src`
     * against it, and the asset observer rewrites relative panel asset srcs to this origin.
     */
    canvasUrl: undefined as string | undefined,

    async activate() {
      // Request this window's loopback canvas URL over RPC (kills the preload/executeJavascript
      // Race), so it's set before the first canvas mount and the asset observer's first rewrite.
      try {
        const { canvasUrl } = await rpc.request.getCanvasUrl();
        platform.canvasUrl = canvasUrl ?? undefined;
      } catch (error) {
        console.warn("getCanvasUrl RPC failed; canvas falls back to the default URL:", error);
      }
      // Synchronous initial sweep AFTER canvasUrl resolves: imgs mounted before activate() awaited
      // Carry relative srcs (a stray views:// request). Rewrite them to the loopback origin now
      // Instead of waiting for the next mutation, then drain any records the observer already
      // Batched pre-activate so they aren't reprocessed. Wrapped so a sweep failure can't break
      // Activate.
      try {
        if (loopbackOrigin()) {
          resolveAllAssets(document.documentElement);
          observer.takeRecords();
        }
      } catch (error) {
        console.warn("initial asset sweep failed:", error);
      }
    },

    async openProject() {
      const res = await rpc.request.openProject();
      return res;
    },

    // ─── Multi-window ──────────────────────────────────────────────────────────

    async openProjectInNewWindow(root: string) {
      await rpc.request.openProjectInNewWindow({ root });
    },

    async newWindow() {
      await rpc.request.newWindow();
    },

    async setWindowProject(root: string) {
      return rpc.request.setWindowProject({ root });
    },

    async getProjectRoot() {
      return rpc.request.getProjectRoot();
    },

    // ─── Recent projects (process-shared, user-level store) ─────────────────────

    async getRecentProjects() {
      return rpc.request.getRecentProjects();
    },

    async saveRecentProjects(projects: RecentProjectEntry[]) {
      await rpc.request.saveRecentProjects({ projects });
    },

    async probeRootProject() {
      // A fresh welcome window owns a session with no project root. Report "no project" (null) so the
      // Studio shows the welcome screen — returning a phantom non-site project instead would suppress
      // The welcome screen and trigger a spurious "No project open" error from listFormats.
      let root: string | null = null;
      try {
        ({ root } = await rpc.request.getProjectRoot());
      } catch {
        root = null;
      }
      if (!root) {
        return null;
      }
      try {
        const content = await rpc.request.readFile({ path: "project.json" });
        const config = JSON.parse(content as string) as ProjectConfig;
        // `root` (the absolute backend root) is already resolved above and is the re-openable key.
        return {
          info: {
            directories: [] as string[],
            isSiteProject: true as const,
            projectConfig: config,
          },
          meta: { name: config.name || "project", root },
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

    subscribeFileEvents(handler: (events: FsEventPayload[]) => void) {
      fileEventHandler = handler;
      return () => {
        if (fileEventHandler === handler) {
          fileEventHandler = null;
        }
      };
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

    /**
     * Class resolution via the shared dev-proxy pipeline (the same handler the canvas runtime
     * reaches through the fetch patch above), called directly over RPC.
     *
     * @param {Record<string, unknown>} body
     */
    async resolveClass(body: Record<string, unknown>) {
      const { status, body: resBody } = await rpc.request.jxResolve({
        body: JSON.stringify(body),
      });
      if (status >= 400) {
        throw new Error(`Class resolution failed: ${status}`);
      }
      return JSON.parse(resBody) as unknown;
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

    async installDependencies() {
      return rpc.request.installDependencies();
    },

    async dependenciesNeedInstall() {
      return rpc.request.dependenciesNeedInstall();
    },

    async outdatedPackages() {
      return rpc.request.outdatedPackages();
    },

    async setPackageVersions(updates: { name: string; version: string; dev?: boolean }[]) {
      return rpc.request.setPackageVersions({ updates });
    },

    async getAppInfo() {
      const info = await rpc.request.updaterGetLocalInfo();
      let updateStatus: string | undefined;
      try {
        const status = await rpc.request.updaterGetStatus();
        updateStatus = status.error
          ? `Update check failed: ${status.error}`
          : status.updateReady
            ? `Update ready (${status.version ?? "?"})`
            : status.updateAvailable
              ? `Update available (${status.version ?? "?"})`
              : "Up to date";
      } catch {
        // Status is best-effort; omit it if the updater isn't reachable.
      }
      return {
        version: info.version,
        channel: info.channel,
        hash: info.hash,
        ...(updateStatus === undefined ? {} : { updateStatus }),
      };
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

    // AI Assistant (Stack B: absolute SSE proxy URL from the shared local server, via RPC)
    async aiChatUrl() {
      return rpc.request.aiChatUrl() as Promise<string>;
    },
  };

  return platform;
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
