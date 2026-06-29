/**
 * Shared project server factory. Generalizes the chromium variant's ad-hoc in-process Bun.serve
 * into one createProjectServer() used by the chromium desktop launcher (and, in Phase 7,
 * electrobun).
 *
 * It serves three surfaces from a single loopback-bound Bun.serve:
 *
 * - The studio shell + canvas iframe doc + iframe bundle, under a non-colliding studio namespace (so
 *   a project's own asset tree never collides);
 * - Project files at their natural URLs (absolute-under-root, root-relative, and public/), each
 *   contained against path traversal and symlink escape;
 * - The canonical resolve routes (the jx-resolve and jx-server POST endpoints) plus the WS-RPC
 *   dispatch, both gated by a per-server token.
 *
 * SECURITY MODEL (see the spec's SECURITY block):
 *
 * - Loopback bind (127.0.0.1) is the PRIMARY control: other local processes / LAN pages cannot read a
 *   loopback page's location, so they cannot steal the URL token.
 * - The token is the HARD gate on every privileged surface — the WS upgrade and the two HTTP resolve
 *   routes (which both do dynamic import() and are therefore RCE-capable).
 * - Origin/Host is BEST-EFFORT defense-in-depth: a loopback Origin host {127.0.0.1, localhost, ::1}
 *   or an absent Origin is accepted; the privileged HTTP routes additionally reject a Host header
 *   that is not loopback (anti-DNS-rebinding).
 * - File reads and the project write-path are contained with a lexical relative() check plus a
 *   realpath re-check (symlink containment).
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { handleResolve, handleServerFunction } from "./resolve.ts";
import { handleAiApi } from "./ai-api.ts";
import { resolveNpmPath } from "./server.ts";

/** A resolved per-window session: its project root plus its RPC handler map. */
export interface ProjectServerSession {
  projectRoot: string | null;
  handlers: Record<string, (params: unknown) => Promise<unknown>>;
}

export interface CreateProjectServerOptions {
  /**
   * Resolve the session for a given window id (the `win` query param / stashed socket data).
   * chromium passes `() => defaultSession`; electrobun (Phase 7) swaps it for a per-window lookup.
   * A missing/unknown window returns `null`, which the routes treat as a 404 fail-closed.
   */
  resolveSession: (winId: string | null) => ProjectServerSession | null;
  /** Absolute dir holding the studio shell + canvas.html + dist/. */
  studioDir: string;
  /** Per-server RPC token. Defaults to a fresh random UUID. */
  rpcToken?: string;
  /** Bind hostname. Defaults to loopback 127.0.0.1. */
  hostname?: string;
  /** Bind port. Defaults to 0 (ephemeral). */
  port?: number;
}

export interface ProjectServerHandle {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  wsUrl: string;
  rpcToken: string;
  canvasUrl: string;
  stop: () => void;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when a hostname (no port) is a loopback host. Used for best-effort Origin/Host checks. */
function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) {
    return false;
  }
  // Strip a trailing :port (but keep bracketed IPv6 intact for the literal set).
  let h = host;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end === -1 ? h : h.slice(0, end + 1);
  } else {
    const colon = h.indexOf(":");
    if (colon !== -1) {
      h = h.slice(0, colon);
    }
  }
  return LOOPBACK_HOSTS.has(h.toLowerCase());
}

/**
 * Best-effort loopback Origin/Host check (defense-in-depth, not the hard gate).
 *
 * Accept when the Origin's host is loopback OR Origin is absent (Bun-native / test clients send no
 * Origin). Do NOT hardcode-match one literal origin — localhost and 127.0.0.1 are distinct origins,
 * and a too-strict check would 403 legitimate clients.
 */
function originIsLoopbackOrAbsent(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    return true;
  }
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Reject a Host header that is present and NOT loopback (defeats DNS-rebinding, where Host is the
 * attacker domain). An absent Host (Bun-native clients) is accepted.
 */
function hostIsLoopbackOrAbsent(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) {
    return true;
  }
  return isLoopbackHost(host);
}

/** Normalize a path for cross-platform containment comparison (separators + case on Windows). */
function normalizeForCompare(p: string): string {
  const slashed = p.replaceAll("\\", "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * Contain `absPath` within `root`: a lexical relative() check followed by a realpath re-check so a
 * symlink inside the tree cannot point outside it. Returns the (possibly realpath'd) absolute path
 * when contained, or null otherwise. The caller must already have decoded the URL pathname.
 */
function containedPath(absPath: string, root: string): string | null {
  // (1) Lexical containment.
  const rel = relative(root, absPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  // (2) realpath BOTH and re-check the realpath is still under realRoot (symlink containment).
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    // Root itself is unresolvable: fall back to lexical-only containment.
    return absPath;
  }
  try {
    realPath = realpathSync(absPath);
  } catch {
    // Target does not exist yet — lexical containment already passed; let the caller's existence
    // Check decide. (Reads will 404; the write-path resolves its own parent separately.)
    return absPath;
  }
  const nRoot = normalizeForCompare(realRoot);
  const nPath = normalizeForCompare(realPath);
  if (nPath === nRoot || nPath.startsWith(nRoot.endsWith("/") ? nRoot : `${nRoot}/`)) {
    return realPath;
  }
  return null;
}

/**
 * Serve a file under studioDir (or any root) if it both exists and is contained. Returns the
 * Response, or null when missing/traversed (caller decides the fallthrough status).
 */
async function serveContained(absPath: string, root: string): Promise<Response | null> {
  const safe = containedPath(absPath, root);
  if (!safe) {
    return null;
  }
  const file = Bun.file(safe);
  if (await file.exists()) {
    return new Response(file);
  }
  return null;
}

/**
 * Try to serve a project file at its natural URL: absolute-under-root, then root-relative, then
 * public/. Each candidate goes through containedPath (realpath). `decodedPath` is the once-decoded
 * URL pathname (leading slash, forward slashes).
 */
async function serveProjectFile(decodedPath: string, root: string): Promise<Response | null> {
  // Map the URL pathname back to a filesystem path. On Windows the browser requests an absolute
  // Path as /C:/Users/… (leading slash + forward slashes); drop the slash before the drive letter.
  // A POSIX absolute path arrives as //abs/path.
  const fsPath = decodedPath.startsWith("//")
    ? decodedPath.slice(1)
    : decodedPath.replace(/^\/([A-Za-z]:)/, "$1");

  // 1. Absolute path that falls under the project root.
  if (normalizeForCompare(fsPath).startsWith(normalizeForCompare(root))) {
    const res = await serveContained(fsPath, root);
    if (res) {
      return res;
    }
  }

  // 2. Root-relative.
  const relRes = await serveContained(resolve(root, `.${decodedPath}`), root);
  if (relRes) {
    return relRes;
  }

  // 3. public/ subdirectory.
  const pubRes = await serveContained(resolve(root, "public", `.${decodedPath}`), root);
  if (pubRes) {
    return pubRes;
  }

  return null;
}

/**
 * Create and start a shared project server bound to loopback.
 *
 * @param options See {@link CreateProjectServerOptions}.
 * @returns A handle with the bound url/wsUrl, the rpcToken, the canvas iframe URL, and stop().
 */
export function createProjectServer(options: CreateProjectServerOptions): ProjectServerHandle {
  const {
    resolveSession,
    studioDir,
    rpcToken = crypto.randomUUID(),
    hostname = "127.0.0.1",
    port = 0,
  } = options;

  // Bundle cache for npm bare specifiers (mirrors server.ts).
  const bundleCache = new Map<string, string>();

  const server = Bun.serve<{ winId: string | null }>({
    hostname,
    port,
    // Keep SSE/AI streams alive (mirrors the dev server's generous idle timeout).
    idleTimeout: 120,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // Decode the pathname ONCE, then run ALL containment on the decoded path. Reject a path that
      // Still contains an encoded dot/slash after one decode (over-encoding bypass attempt).
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      if (/%2e|%2f/i.test(path)) {
        return new Response("Not found", { status: 404 });
      }
      // Collapse runs of leading slashes to a single one. The natural-URL branch re-expands a POSIX
      // //abs prefix explicitly, so a single leading slash here is the right normal form.
      const normPath = path.replace(/^\/{2,}/, "/");

      const winId = url.searchParams.get("win");

      // 1. WebSocket upgrade — token + loopback Origin/Host are the hard gate.
      const upgrade = req.headers.get("upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        const token = url.searchParams.get("token");
        if (token !== rpcToken || !originIsLoopbackOrAbsent(req) || !hostIsLoopbackOrAbsent(req)) {
          return new Response("Forbidden", { status: 403 });
        }
        if (srv.upgrade(req, { data: { winId } })) {
          return;
        }
        return new Response("Upgrade failed", { status: 400 });
      }

      // 2. AI SSE — keep the existing handleAiApi behavior (rewrite the studio-ai prefix).
      if (normPath.startsWith("/__studio__/ai/")) {
        const aiUrl = new URL(req.url);
        aiUrl.pathname = normPath.replace("/__studio__/ai/", "/__studio/ai/");
        const aiResponse = await handleAiApi(req, aiUrl);
        if (aiResponse) {
          return aiResponse;
        }
      }

      // 3. Studio assets under the non-colliding /__studio__/ namespace.
      if (normPath.startsWith("/__studio__/")) {
        const assetRel = normPath.slice("/__studio__/".length);
        const assetPath = resolve(studioDir, `.${sep}${assetRel}`);
        const res = await serveContained(assetPath, studioDir);
        if (res) {
          // Strip ?token from the shell after boot + never leak it via Referer.
          const headers = new Headers(res.headers);
          headers.set("Referrer-Policy", "no-referrer");
          return new Response(res.body, { headers, status: res.status });
        }
        return new Response("Not found", { status: 404 });
      }

      // 4. Resolve the session (fail-closed).
      const session = resolveSession(winId);
      if (!session) {
        return new Response("Unknown window", { status: 404 });
      }
      const root = session.projectRoot;
      if (!root) {
        return new Response("No project", { status: 404 });
      }

      // 5. Privileged HTTP routes (RCE-capable: dynamic import()). Gate with token + loopback
      //    Origin/Host BEFORE dispatch.
      if (
        (normPath === "/__jx_resolve__" || normPath === "/__jx_server__") &&
        req.method === "POST"
      ) {
        const token = url.searchParams.get("token");
        if (token !== rpcToken || !originIsLoopbackOrAbsent(req) || !hostIsLoopbackOrAbsent(req)) {
          return new Response("Forbidden", { status: 403 });
        }
        if (normPath === "/__jx_resolve__") {
          return handleResolve(req, root, root);
        }
        return handleServerFunction(req, root);
      }

      // 6. Project files at natural URLs.
      const fileRes = await serveProjectFile(normPath, root);
      if (fileRes) {
        return fileRes;
      }

      // 7. npm bare specifiers via node_modules (on-demand bundle, mirrors server.ts).
      const resolved = resolveNpmPath(root, normPath);
      if (resolved) {
        if (!bundleCache.has(resolved)) {
          try {
            const result = await Bun.build({
              entrypoints: [resolved],
              format: "esm",
              minify: false,
            });
            if (result.success && result.outputs.length > 0) {
              bundleCache.set(resolved, await result.outputs[0]!.text());
            }
          } catch (error) {
            console.error("Bundle failed for", resolved, error);
          }
        }
        const bundled = bundleCache.get(resolved);
        if (bundled) {
          return new Response(bundled, {
            headers: { "Content-Type": "application/javascript; charset=utf-8" },
          });
        }
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      async message(ws, raw) {
        let msg: { id: number; method: string; params?: unknown };
        try {
          msg = JSON.parse(raw as string) as { id: number; method: string; params?: unknown };
        } catch {
          ws.send(JSON.stringify({ error: "Invalid JSON", id: 0 }));
          return;
        }

        // Re-resolve the session FRESH each message (fail-closed for Phase 7 multi-window).
        const session = resolveSession(ws.data.winId);
        if (!session) {
          ws.send(JSON.stringify({ error: "Unknown window", id: msg.id }));
          ws.close();
          return;
        }

        const handler = session.handlers[msg.method];
        if (!handler) {
          ws.send(JSON.stringify({ error: `Unknown method: ${msg.method}`, id: msg.id }));
          return;
        }

        try {
          const result = await handler(msg.params);
          ws.send(JSON.stringify({ id: msg.id, result: result ?? null }));
        } catch (error: unknown) {
          ws.send(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              id: msg.id,
            }),
          );
        }
      },
    },
  });

  const boundHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  const url = `http://${boundHost}:${server.port}`;
  const wsUrl = `ws://${boundHost}:${server.port}`;
  const canvasUrl = `${url}/__studio__/canvas.html`;

  return {
    server,
    url,
    wsUrl,
    rpcToken,
    canvasUrl,
    stop: () => {
      void server.stop(true);
    },
  };
}
