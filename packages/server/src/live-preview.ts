/**
 * The project's working tree, browsable as a site, on an origin of its own.
 *
 * `site-preview.ts` serves the compiler's OUTPUT and argues at length for why that needs its own
 * origin. This is its sibling and the argument inverts: a live preview's paths mean the project's
 * SOURCES, which is what the editing server already serves — so the reason for a second origin here
 * is not that the paths would collide, it is everything else.
 *
 * **Lifetime.** One tab per project needs one origin per project, and the editing server is per
 * WINDOW: a tab pointed at it dies when that window closes, and two windows on one project would
 * produce two tabs. The map below is keyed by project root and lives for the process, exactly as
 * `site-preview.ts`'s does and for the same reason — no single window's teardown may close it.
 *
 * **Isolation.** A previewed page runs the project's own JavaScript, which routinely includes
 * third-party script. On the chromium build the studio shell is served BY the editing server, so a
 * preview mounted there would share `localStorage`, IndexedDB and service-worker scope with the
 * editor. A different port is a different origin, and on loopback that costs nothing.
 *
 * **Rules.** `serveProjectFile` serves the whole project root as an explicitly-temporary lane that
 * warns about itself. On the editor's origin that is Studio addressing files it already holds paths
 * for; on an origin running project script it is a way to read `.dev.vars`. This origin uses
 * `@jxsuite/site`'s allowlist instead, which defaults closed.
 *
 * What is served here that a published site would not have is confined to one namespace,
 * `/__jx_live__/`, dispatched ahead of everything: the runtime bundle, the reload client, the site
 * stylesheet, and the reload stream. Not `/_jx/` — that is the extension-mount namespace, which a
 * previewed page still needs — and not `/__studio__/`, because a preview origin must not look like
 * the editor's.
 *
 * **The overlay is why this shows the canvas rather than the disk.** Studio publishes the bytes a
 * save WOULD write, per dirty document, and every read here prefers them. They are held in memory
 * and never written anywhere: there is no file to go stale, so a crash leaves a preview showing the
 * saved state, which is the right answer rather than a stale one.
 *
 * @docs framework/build/dev-server
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { serveSite, siteContext, siteHeaders } from "@jxsuite/site/serve";
import { SERVABLE_ROOTS } from "@jxsuite/site/paths";
import { buildSiteStyleCSS } from "@jxsuite/site/site-style";
import type { AssetIO, SiteContext } from "@jxsuite/site/serve";
import type { DocumentParser, SiteIO } from "@jxsuite/site/compose";
import { buildProjectFormatRegistry } from "@jxsuite/compiler/format-host";
import type { JxDocument } from "@jxsuite/schema/types";
import { createSseHub } from "./sse.ts";
import type { SseHub } from "./sse.ts";
import { LIVE_NAMESPACE, PREVIEW_CLIENT_JS } from "./preview-client.ts";
import { handleResolve, handleServerFunction } from "./resolve.ts";
import { handleJxMounts } from "./jx-mounts.ts";
import { loopbackGate, originHostGate } from "./net-guard.ts";
import { problem } from "./problem.ts";

/** A running live preview for one project. */
export interface LivePreview {
  /** Origin to prefix a route with, e.g. `http://127.0.0.1:41234`. */
  origin: string;
  port: number;
  /** How many routes the tree currently answers — what a caller reports as `routes`. */
  routes: number;
  /** Problems the origin already knows about, named rather than thrown. */
  errors: string[];
}

/**
 * Coalescing window for a reload broadcast.
 *
 * Trailing, because a burst of keystrokes is one change as far as a reader is concerned. The max
 * wait is not belt-and-braces: a git checkout emits hundreds of events closer together than the
 * debounce, and a pure trailing timer would starve until the checkout finished.
 */
const RELOAD_DEBOUNCE_MS = 150;
const RELOAD_MAX_WAIT_MS = 1000;

/**
 * How long a retarget waits for a tab to say it heard.
 *
 * A closed tab's stream usually cancels promptly on loopback, but a frozen or back/forward-cached
 * one looks open and will not act. So the answer is acknowledged rather than assumed, and when the
 * wait loses the race the reader gets a second tab — the visible failure, chosen deliberately over
 * the invisible one.
 */
const ACK_TIMEOUT_MS = 250;

/** Total bytes of unsaved documents one project may hold before the oldest are dropped. */
const OVERLAY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * What Studio is looking at but has not written, per project.
 *
 * Deliberately NOT part of the running server. Studio may publish before anyone presses the button
 * — and the flush that runs on the way to opening a tab does exactly that — so an overlay tied to
 * an origin's lifetime would drop the newest edit precisely on the first render, which is the one
 * the author is watching for.
 */
interface Overlay {
  files: Map<string, string>;
  /** Paths the budget had to drop, so a caller can say so rather than showing stale content. */
  dropped: string[];
}

const overlays = new Map<string, Overlay>();

/** This project's overlay, created on demand. */
function overlayFor(projectRoot: string): Overlay {
  let overlay = overlays.get(projectRoot);
  if (!overlay) {
    overlay = { dropped: [], files: new Map() };
    overlays.set(projectRoot, overlay);
  }
  return overlay;
}

interface Running extends LivePreview {
  server: { stop: (closeActiveConnections?: boolean) => void };
  hub: SseHub;
  /** This origin's own resolver credential, distinct from any editing server's. */
  token: string;
  /** Bumped per retarget, so a late ack cannot answer for the current one. */
  generation: number;
  pendingAck: { gen: number; settle: (acked: boolean) => void } | null;
  reloadTimer: ReturnType<typeof setTimeout> | null;
  /** When the current burst started, so the max wait can fire through a storm of events. */
  burstStartedAt: number | null;
  /** Recomputed when the tree moves under it. */
  cache: { paths: string[]; context: SiteContext } | null;
}

/** One origin per project root — a second Open in Browser reuses the first one's port. */
const running = new Map<string, Running>();

/** The runtime bundle is the same bytes for every project, so it is read once per process. */
let runtimeBundle: string | null = null;

/**
 * The `@jxsuite/runtime` browser bundle.
 *
 * Preferred from the package's own `dist`, which is what it publishes and what a packaged app
 * ships. A checkout that has not run `bun run build:runtime` has none, and building it here on
 * first request is better than an origin that renders nothing until someone runs a script.
 *
 * That fallback is the one branch in this file no test reaches, and deliberately so: reaching it
 * means `@jxsuite/runtime/dist/runtime.js` neither resolving nor existing, which in this repository
 * it always does, and `mock.module` cannot override a `node:fs` builtin to pretend otherwise. It is
 * exercised for real by any fresh clone that previews before it builds.
 */
async function loadRuntimeBundle(): Promise<string> {
  if (runtimeBundle !== null) {
    return runtimeBundle;
  }
  const require_ = createRequire(import.meta.url);
  try {
    const built = require_.resolve("@jxsuite/runtime/dist/runtime.js");
    if (existsSync(built)) {
      runtimeBundle = await readFile(built, "utf8");
      return runtimeBundle;
    }
  } catch {
    // No published dist on this install; fall through and build one.
  }
  const result = await Bun.build({
    entrypoints: [require_.resolve("@jxsuite/runtime")],
    target: "browser",
  });
  runtimeBundle = await result.outputs[0]!.text();
  return runtimeBundle;
}

/** Every path under a servable root, plus anything the overlay is holding. */
async function treePaths(projectRoot: string, overlay: Map<string, string>): Promise<string[]> {
  const found = new Set<string>(overlay.keys());
  for (const root of SERVABLE_ROOTS) {
    const dir = resolve(projectRoot, root);
    if (!existsSync(dir)) {
      continue;
    }
    for await (const match of new Bun.Glob("**/*").scan({ cwd: dir, dot: false })) {
      found.add(`${root}${match.replaceAll("\\", "/")}`);
    }
  }
  return [...found];
}

/**
 * Parse a non-JSON page through the project's own format registry.
 *
 * This is the capability a Worker does not have and a desktop backend does, and it is the whole
 * difference between a markdown page rendering and reporting that its parser does not run here.
 */
function documentParser(projectRoot: string): DocumentParser {
  return async (path, text) => {
    try {
      const registry = await buildProjectFormatRegistry(projectRoot);
      const entry = registry.byExtension(extname(path), "parse");
      if (!entry) {
        return null;
      }
      return (await entry.call("parse", text, { path })) as JxDocument;
    } catch {
      /* A format that throws is a broken project, not a broken preview: returning null lets the
         composer report the page by name rather than taking the whole origin down. */
      return null;
    }
  };
}

/** Reading the tree, overlay first — which is what makes this the canvas rather than the disk. */
function makeIO(projectRoot: string, paths: string[]): { io: SiteIO; assets: AssetIO } {
  const io: SiteIO = {
    parse: documentParser(projectRoot),
    paths: () => paths,
    read: async (path) => {
      const overlaid = overlayFor(projectRoot).files.get(path);
      if (overlaid !== undefined) {
        return overlaid;
      }
      try {
        return await readFile(join(projectRoot, path), "utf8");
      } catch {
        return null;
      }
    },
  };
  const assets: AssetIO = {
    bytes: async (path) => {
      const overlaid = overlayFor(projectRoot).files.get(path);
      if (overlaid !== undefined) {
        return new TextEncoder().encode(overlaid);
      }
      try {
        return new Uint8Array(await readFile(join(projectRoot, path)));
      } catch {
        return null;
      }
    },
  };
  return { assets, io };
}

/** The route table and project config, recomputed only when something moved under them. */
async function ensureCache(entry: Running, projectRoot: string) {
  if (entry.cache) {
    return entry.cache;
  }
  const paths = await treePaths(projectRoot, overlayFor(projectRoot).files);
  const { io } = makeIO(projectRoot, paths);
  const context = await siteContext(io);
  entry.cache = { context, paths };
  entry.routes = context.routes.length;
  return entry.cache;
}

/** Drop the derived view of the tree; the next request rebuilds it. */
function invalidate(entry: Running) {
  entry.cache = null;
}

/** `project.json`'s `style` as a stylesheet, or empty when the project declares none. */
function siteStyleCss(context: SiteContext): string {
  const { style } = context.config as { style?: Record<string, unknown> };
  if (!style || typeof style !== "object") {
    return "";
  }
  const media = (context.config as { $media?: Record<string, string> }).$media ?? {};
  /* Identity transposition: a browser tab IS the viewport, so `100vh` already means what it says.
     The canvas passes a real transposer because its viewport is an iframe it sizes to content. */
  return buildSiteStyleCSS(style, media, (value) => value);
}

/** Serve one request on a preview origin. */
async function handle(entry: Running, projectRoot: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return problem("invalidRequest", "Bad request");
  }

  /*
   * The host's own namespace, ahead of everything. A project that happens to hold
   * `pages/__jx_live__/x.json` loses that one route, which is the documented cost of having a
   * namespace at all — and it is not in SERVABLE_ROOTS, so no project file is addressable here.
   */
  if (pathname.startsWith(`${LIVE_NAMESPACE}/`)) {
    const surface = pathname.slice(LIVE_NAMESPACE.length + 1);

    if (surface === "reload") {
      return entry.hub.handleSSE(req);
    }

    /* What a client asks when EventSource has failed enough times that "restarting" and "gone" need
       telling apart. A live origin always answers; a dead one refuses the connection. */
    if (surface === "ping") {
      return new Response("ok", { headers: siteHeaders("text/plain; charset=utf-8") });
    }

    if (surface === "ack" && req.method === "POST") {
      let body: { gen?: number };
      try {
        body = (await req.json()) as { gen?: number };
      } catch {
        return problem("invalidRequest", "Invalid JSON body");
      }
      if (entry.pendingAck && body.gen === entry.pendingAck.gen) {
        entry.pendingAck.settle(true);
      }
      return new Response(null, { status: 204 });
    }

    if (surface === "runtime.js") {
      return new Response(await loadRuntimeBundle(), {
        headers: {
          /* Immutable: the bundle is this build's, and a preview reload must not re-fetch 120 KB
             of runtime every time a keystroke lands. */
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Type": "text/javascript; charset=utf-8",
        },
      });
    }

    if (surface === "client.js") {
      return new Response(PREVIEW_CLIENT_JS, {
        headers: {
          "Cache-Control": "no-cache",
          "Content-Type": "text/javascript; charset=utf-8",
        },
      });
    }

    if (surface === "site.css") {
      const { context } = await ensureCache(entry, projectRoot);
      return new Response(siteStyleCss(context), {
        headers: siteHeaders("text/css; charset=utf-8"),
      });
    }

    return problem("notFound", "Not found");
  }

  /*
   * The resolver, on this origin's OWN credential.
   *
   * Both routes do a dynamic `import()` of project code, so they are gated exactly as the editing
   * server gates them — token, Origin, Host, Fetch Metadata — but against a token minted for this
   * origin, so compromising one does not hand over the other. The page's own POST is same-origin,
   * which the strict policy admits.
   *
   * Without them a content collection renders as an empty list: `ContentEntry` always needs a
   * server. That is the difference between previewing a site and previewing its chrome.
   */
  if ((pathname === "/__jx_resolve__" || pathname === "/__jx_server__") && req.method === "POST") {
    const gate = loopbackGate(req, url, entry.token);
    if (gate) {
      return gate;
    }
    return pathname === "/__jx_resolve__"
      ? handleResolve(req, projectRoot, projectRoot)
      : handleServerFunction(req, projectRoot);
  }

  /* Extension server mounts — a previewed page's content and data endpoints. Origin-gated rather
     than token-gated for the reason the editing server gives: a page cannot rewrite the URLs its
     own content asks for, so a token is the wrong instrument. */
  if (pathname.startsWith("/_jx/")) {
    const gate = originHostGate(req, "embeddable");
    if (gate) {
      return gate;
    }
    const mounted = await handleJxMounts(req, url, projectRoot);
    if (mounted) {
      return mounted;
    }
  }

  const { context, paths } = await ensureCache(entry, projectRoot);
  const { assets, io } = makeIO(projectRoot, paths);
  return serveSite(pathname, io, assets, context, {
    shell: {
      base: "/",
      clientScriptUrl: `${LIVE_NAMESPACE}/client.js`,
      resolveToken: entry.token,
      runtimeUrl: `${LIVE_NAMESPACE}/runtime.js`,
      styleUrl: `${LIVE_NAMESPACE}/site.css`,
    },
  });
}

/**
 * Start (or reuse) the live preview origin for `projectRoot`.
 *
 * Always answers: unlike `startSitePreview`, there is nothing to have built first. A project with
 * no pages yet gets an origin that 404s honestly rather than no origin at all.
 */
export async function startLivePreview(projectRoot: string): Promise<LivePreview> {
  const existing = running.get(projectRoot);
  if (existing) {
    await ensureCache(existing, projectRoot);
    return report(existing, projectRoot);
  }

  const entry: Running = {
    burstStartedAt: null,
    cache: null,
    errors: [],
    generation: 0,
    hub: createSseHub(),
    origin: "",
    pendingAck: null,
    port: 0,
    reloadTimer: null,
    routes: 0,
    server: { stop: () => {} },
    token: crypto.randomUUID(),
  };

  const server = Bun.serve({
    fetch: (req) => handle(entry, projectRoot, req),
    hostname: "127.0.0.1",
    /* The composed page is assembled per request and the stream is long-lived; the dev server's
       generous idle timeout applies here for the same reason. */
    idleTimeout: 120,
    port: 0,
  });
  entry.server = server;
  // `server.url` rather than `server.port`: the origin is the thing being handed to a browser, and
  // Reading it from the server that is actually listening cannot disagree with it.
  entry.origin = server.url.origin;
  entry.port = Number(server.url.port);
  running.set(projectRoot, entry);
  /* Counted before answering, because the caller reports it to the author and "0 pages" from a site
     with pages is worse than the moment it costs to walk the tree. */
  await ensureCache(entry, projectRoot);
  return report(entry, projectRoot);
}

/** What a caller hands back to Studio. */
function report(entry: Running, projectRoot: string): LivePreview {
  return {
    errors: overlayErrors(projectRoot),
    origin: entry.origin,
    port: entry.port,
    routes: entry.routes,
  };
}

/** The origin already serving `projectRoot`, without starting one. */
export function livePreviewOrigin(projectRoot: string): string | null {
  return running.get(projectRoot)?.origin ?? null;
}

/** How many tabs are holding this project's reload stream. */
export function livePreviewClients(projectRoot: string): number {
  return running.get(projectRoot)?.hub.clientCount() ?? 0;
}

/**
 * Publish the bytes a save WOULD write for one document.
 *
 * Byte-identical to a save by construction — Studio serializes through the same function
 * `writeFile` uses — so what the reader sees and what saving would produce cannot drift.
 */
export function setLivePreviewOverlay(projectRoot: string, path: string, contents: string): void {
  const overlay = overlayFor(projectRoot);
  if (overlay.files.get(path) === contents) {
    /* Identical bytes are not a change. Studio hashes before publishing too, but a backend that
       reloads a tab because a keystroke was undone would be wrong on its own account. */
    return;
  }
  overlay.files.set(path, contents);
  enforceOverlayBudget(overlay);
  touched(projectRoot);
}

/** Drop one document's overlay, or every one of them. */
export function clearLivePreviewOverlay(projectRoot: string, path?: string): void {
  const overlay = overlays.get(projectRoot);
  if (!overlay) {
    return;
  }
  if (path === undefined) {
    if (overlay.files.size === 0 && overlay.dropped.length === 0) {
      return;
    }
    overlay.files.clear();
    overlay.dropped = [];
  } else if (!overlay.files.delete(path)) {
    return;
  }
  touched(projectRoot);
}

/**
 * Keep the overlay bounded, and SAY what was given up.
 *
 * An overlay that silently forgets a document is worse than one that admits it: the reader would be
 * shown the saved bytes for a file the author is actively editing, with nothing anywhere to explain
 * the difference. Insertion order is edit order, so the oldest entry is the least recently
 * written.
 */
function enforceOverlayBudget(overlay: Overlay): void {
  let total = 0;
  for (const value of overlay.files.values()) {
    total += value.length;
  }
  while (total > OVERLAY_MAX_BYTES && overlay.files.size > 1) {
    const oldest = overlay.files.keys().next().value as string;
    total -= overlay.files.get(oldest)?.length ?? 0;
    overlay.files.delete(oldest);
    if (!overlay.dropped.includes(oldest)) {
      overlay.dropped.push(oldest);
    }
  }
}

/** What a caller reports beside the routes: the unsaved documents this origin gave up on. */
function overlayErrors(projectRoot: string): string[] {
  return (overlays.get(projectRoot)?.dropped ?? []).map(
    (path) => `${path} is too large to preview unsaved; it is shown as last saved.`,
  );
}

/** The tree changed, from whichever side. Invalidate the derived view and coalesce a reload. */
function touched(projectRoot: string): void {
  const entry = running.get(projectRoot);
  if (!entry) {
    return;
  }
  invalidate(entry);
  scheduleReload(entry);
}

/** Something moved on disk — a save, a git checkout, another editor. */
export function notifyLivePreviewChange(projectRoot: string): void {
  touched(projectRoot);
}

/**
 * Coalesce a burst into one reload.
 *
 * A save fires twice — the overlay clears and the watcher reports the write — and both compose to
 * identical bytes, so folding them here is what makes one save one reload.
 */
function scheduleReload(entry: Running): void {
  const now = Date.now();
  entry.burstStartedAt ??= now;
  if (entry.reloadTimer) {
    clearTimeout(entry.reloadTimer);
  }
  const sinceBurstStart = now - entry.burstStartedAt;
  const delay = Math.max(0, Math.min(RELOAD_DEBOUNCE_MS, RELOAD_MAX_WAIT_MS - sinceBurstStart));
  entry.reloadTimer = setTimeout(() => {
    entry.reloadTimer = null;
    entry.burstStartedAt = null;
    entry.hub.broadcast();
  }, delay);
}

/**
 * Point the project's open tab at `route`, and report whether one actually took it.
 *
 * `false` means the caller should open a tab itself: either nothing is connected, or what is
 * connected did not answer inside {@link ACK_TIMEOUT_MS}. The acknowledgement is what keeps a
 * frozen or back/forward-cached tab — which looks connected and will not act — from swallowing the
 * request silently.
 */
export async function navigateLivePreview(projectRoot: string, route: string): Promise<boolean> {
  const entry = running.get(projectRoot);
  if (!entry || entry.hub.clientCount() === 0) {
    return false;
  }
  entry.generation += 1;
  const gen = entry.generation;
  const acked = new Promise<boolean>((settle) => {
    entry.pendingAck = { gen, settle };
    setTimeout(() => {
      if (entry.pendingAck?.gen === gen) {
        entry.pendingAck = null;
        settle(false);
      }
    }, ACK_TIMEOUT_MS);
  });
  entry.hub.broadcastEvent("navigate", { gen, route });
  const result = await acked;
  if (entry.pendingAck?.gen === gen) {
    entry.pendingAck = null;
  }
  return result;
}

/** Stop every preview origin (process teardown, and what the tests close their ports with). */
export function stopLivePreviews(): void {
  for (const entry of running.values()) {
    if (entry.reloadTimer) {
      clearTimeout(entry.reloadTimer);
    }
    entry.server.stop(true);
  }
  running.clear();
}
