/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { Electroview } from "electrobun/view";
import { html, render as litRender } from "lit-html";
import { streamImport } from "@jxsuite/studio/import-client";
import { toBase64 } from "@jxsuite/studio/base64";
import type { RecentProjectEntry, StudioRPC } from "./rpc-schema";
import type {
  DataRowDelete,
  DataRowInsert,
  DataRowsQuery,
  DataRowUpdate,
  SecretsSetRequest,
} from "@jxsuite/protocol";
import type {
  CreateProjectDestination,
  ImportProgressEvent,
  ImportSiteOptions,
  StudioPlatform,
} from "@jxsuite/studio/types";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type { FsEventPayload } from "@jxsuite/server/refactor";
import { setPreviewNavigateHandler } from "@jxsuite/studio/preview-navigate";

/* Returns an INFERRED type, not `StudioPlatform`, with `satisfies` doing the conformance check. The
   desktop adds `updater` and `windowControls`, which the PAL interface deliberately does not declare
   — the studio reaches them through `globalThis.__jxPlatform` with its own local shapes (see
   resize-edges.ts, toolbar.ts) so it stays launcher-agnostic. Annotating the return as
   `StudioPlatform` erased them from every caller, including this package's own tests. */
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

  /*
   * Preview link clicks go to the user's REAL browser, not this webview.
   *
   * Following a link in Preview exists to see the page behave like the deployed thing — routing,
   * history, devtools. A webview with no address bar is not that, and navigating THIS one would
   * replace the editor. The Bun side hands the URL to the OS (`Utils.openExternal`); on failure the
   * studio's own `window.open` default still applies.
   */
  setPreviewNavigateHandler((url) => {
    const fallback = () => {
      window.open(url, "_blank", "noopener,noreferrer");
    };
    /* `{ ok: false }` is a REFUSAL, not a rejection — the backend answers the request either way,
       and branching only on a thrown error left the click doing nothing at all when the OS had no
       opener for it. */
    void rpc.request
      .openExternal({ url })
      .then((result) => {
        if (!result?.ok) {
          fallback();
        }
      })
      .catch(fallback);
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

    /* New projects go where the user says: the modal's Location field, with Browse… backed by the
       native dialog below. The backend refuses a create without one. */
    createDestination: "path" as const,

    projectRoot: "",

    /**
     * The cross-origin loopback canvas URL for this window, fetched in {@link activate} (awaited at
     * studio boot, before the first canvas mount). The iframe-host resolves the iframe `src`
     * against it, and the asset observer rewrites relative panel asset srcs to this origin.
     */
    canvasUrl: undefined as string | undefined,
    /* This window's loopback port, so the url is not known until activate() has asked for it over
       RPC. Declared so the iframe host waits rather than mounting the bundle-relative fallback —
       which under views:// now RESOLVES, to a canvas.html this app really stages, and would boot
       the canvas inside the shell's app-privileged origin in a CEF instance running
       disable-site-isolation-trials. The cross-origin loopback canvas exists so that cannot
       happen. Chromium sets canvasUrl synchronously and needs none of this. */
    canvasUrlDeferred: true,

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

    async pickProject() {
      return rpc.request.pickProject();
    },

    // ─── Multi-window ──────────────────────────────────────────────────────────

    async openProjectInNewWindow(root: string) {
      return rpc.request.openProjectInNewWindow({ root });
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

    // ─── User settings (process-shared, user-level store) ───────────────────────

    async getSettings() {
      return rpc.request.getSettings();
    },

    async saveSettings(settings: Record<string, string>) {
      await rpc.request.saveSettings({ settings });
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

    // The RPC transport JSON-serializes params, so binary must be base64 before it goes on the wire
    // (a File/Blob would serialize to `{}`); the backend base64-decodes. A string passes through.
    async uploadFile(path: string, data: string | File | Blob | ArrayBuffer) {
      return await rpc.request.uploadFile({ data: await toBase64(data), path });
    },

    async deleteFile(path: string) {
      return rpc.request.deleteFile({ path });
    },

    async renameFile(from: string, to: string) {
      return rpc.request.renameFile({ from, to });
    },

    async findReferences(target: { path?: string; tagName?: string }) {
      return rpc.request.findReferences(target);
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

    async buildSite() {
      return rpc.request.buildSite();
    },

    async gitAddRemote(name: string, url: string) {
      await rpc.request.gitAddRemote({ name, url });
    },

    async searchFiles(query: string, extensions?: string[]) {
      return rpc.request.searchFiles({ query, ...(extensions != null && { extensions }) });
    },

    async listFormats() {
      return rpc.request.listFormats();
    },

    /** The extensions payload behind descriptor-contributed settings sections. */
    async listExtensions() {
      return rpc.request.listExtensions();
    },

    /** Pre-bundled per-project entry schemas for Monaco registration. */
    async fetchProjectSchemas() {
      return rpc.request.fetchProjectSchemas();
    },

    // ─── Data surface + secrets (owner console; names-only secrets) ────────────

    async dataConnections() {
      return rpc.request.dataConnections();
    },

    async dataConnectionTest(connection: string) {
      return rpc.request.dataConnectionTest({ connection });
    },

    async dataPush(opts?: { connection?: string; dryRun?: boolean }) {
      return rpc.request.dataPush(opts ?? {});
    },

    async dataRows(query: DataRowsQuery) {
      return rpc.request.dataRows(query);
    },

    async dataInsertRow(req: DataRowInsert) {
      return rpc.request.dataInsertRow(req);
    },

    async dataUpdateRow(req: DataRowUpdate) {
      return rpc.request.dataUpdateRow(req);
    },

    async dataDeleteRow(req: DataRowDelete) {
      return rpc.request.dataDeleteRow(req);
    },

    async listSecrets() {
      const res = await rpc.request.listSecrets();
      return res.names;
    },

    async setSecrets(req: SecretsSetRequest) {
      return rpc.request.setSecrets(req);
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

    /* One request, composed on the Bun side. It used to be assembled here from two updater calls,
       which made the About screen's contents a property of THIS launcher's webview rather than of
       the build it describes — so the chromium launcher, which has no updater to call, could not
       answer the question at all. */
    async getAppInfo() {
      return rpc.request.appInfo();
    },

    async createProject(opts: {
      name: string;
      description?: string;
      url?: string;
      adapter?: string;
      directory: string;
      /* The full PAL union, not just the `path` variant: the parameter is contravariant, so
         narrowing it here makes the whole platform object unassignable to StudioPlatform. What
         actually keeps Studio from sending a repo destination is `createDestination: "path"`. */
      destination: CreateProjectDestination;
      starter?: string;
      template?: string;
      design?: {
        accent?: string;
        background?: string;
        text?: string;
        bodyFont?: string;
        headingFont?: string;
        media?: Record<string, string>;
        logo?: { name: string; base64: string };
      };
    }) {
      const { destination } = opts;
      if (destination.kind !== "path") {
        throw new Error(
          "The desktop app creates projects on disk; repo destinations are cloud-only",
        );
      }
      return rpc.request.createProject({ ...opts, destination }) as Promise<{
        root: string;
        config: ProjectConfig;
      }>;
    },

    async listStarters() {
      return rpc.request.listStarters();
    },

    async pickDirectory() {
      const result = await rpc.request.pickDirectory();
      return result.path;
    },

    // AI-guided site import: streams NDJSON progress from the token-gated shared local server. The
    // Modal resolves the destination before calling (specs/desktop.md §4.5), so `directory` is
    // Already absolute — a relative one means a caller skipped the Location field.
    async importSite(
      opts: ImportSiteOptions,
      onProgress: (evt: ImportProgressEvent) => void,
      signal?: AbortSignal,
    ) {
      const { directory } = opts;
      if (!/^(?:[a-zA-Z]:[\\/]|\/)/.test(directory)) {
        throw new Error("A destination folder is required.");
      }
      const endpoint = (await rpc.request.importSiteUrl()) as string;
      return streamImport(endpoint, opts, onProgress, signal);
    },

    /*
     * GitHub sign-in, launcher-only like `updater` and `windowControls`: the browser Studio has no
     * loopback server to redirect to and keeps the device flow, so this is not a PAL member.
     */
    githubAuth: {
      signIn: (force = false) => rpc.request.githubSignIn({ force }),
      signOut: () => rpc.request.githubSignOut(),
      status: () => rpc.request.githubToken(),
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

  /* `satisfies` on the identifier, not on the literal above: a fresh object literal gets excess
     property checks, which would reject the two launcher-only extras this function exists to expose.
     A reference is not fresh, so this checks conformance and keeps the inferred type. */
  return platform satisfies StudioPlatform;
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
