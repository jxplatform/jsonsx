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

    // Phase 7: the views:// readFile shim stays ONLY on the views:// path. On loopback the canvas
    // Doc + assets are served natively over http, so this shim must not shadow them. loopbackOrigin()
    // Is null with the gate off (canvasUrl unset) → the shim stays installed, byte-identical to today.
    if (url.startsWith("views://") && !loopbackOrigin()) {
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
  //
  // Phase 7: the observer is ALWAYS installed; only its REWRITE TARGET switches by the loopback gate.
  // The view-side gate signal is platform.canvasUrl: undefined on the views:// path (gate off /
  // GetCanvasUrl null) → rewrite to a data-URL exactly as today; an absolute loopback origin when the
  // Per-window server is up → rewrite to an absolute loopback URL (fetch-free, no readFileAsDataUrl).
  // With the gate off, canvasUrl is never set, so this is byte-identical to before.
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
        const path = val.replace(/^\.?\//, "");
        const origin = loopbackOrigin();
        if (origin) {
          // Loopback: point the panel <img> straight at the loopback server (a cross-origin image
          // Load, allowed without CORS). No fetch, no readFileAsDataUrl round-trip.
          el.setAttribute(attr, `${origin}/${path}`);
          continue;
        }
        resolving.add(el);
        el.removeAttribute(attr);
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
    const [, val] = match;
    if (val.startsWith("data:") || val.startsWith("blob:") || val.startsWith("http")) {
      return;
    }
    const path = val.replace(/^\.?\//, "");
    const origin = loopbackOrigin();
    if (origin) {
      // Loopback: rewrite the background-image url() to the loopback origin (cross-origin image load).
      htmlEl.style.backgroundImage = `url(${origin}/${path})`;
      return;
    }
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

  const platform = {
    id: "desktop" as const,

    projectRoot: "",

    /**
     * Phase 7: the cross-origin loopback canvas URL for this window, fetched in {@link activate}
     * (awaited at studio boot, before the first canvas mount). Stays undefined on the views:// path
     * (gate off / getCanvasUrl returns null) → iframe-host falls back to DEFAULT_CANVAS_URL, so the
     * shipped behavior is byte-identical until the gate flips.
     */
    canvasUrl: undefined as string | undefined,

    async activate() {
      // Request this window's canvas URL over RPC (kills the preload/executeJavascript race). Null
      // On the views:// path; an absolute loopback URL when the per-window server is up.
      try {
        const { canvasUrl } = await rpc.request.getCanvasUrl();
        platform.canvasUrl = canvasUrl ?? undefined;
      } catch {
        // RPC unavailable (e.g. older host): keep the views:// fallback.
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
