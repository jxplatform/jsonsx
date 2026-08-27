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

import { resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { handleJxMounts } from "./jx-mounts.ts";
import { handleResolve, handleServerFunction, projectAssetMounts } from "./resolve.ts";
import { handleAiApi } from "./ai-api.ts";
import { handleImportApi } from "./import-api.ts";
import { resolveNpmPath } from "./server.ts";
import type { ImportApiOptions } from "./import-api.ts";
import {
  decodeAndNormalizePath,
  loopbackGate,
  originHostGate,
  serveContained,
  serveProjectFile,
} from "./net-guard.ts";
import { problem } from "./problem.ts";
import { createLoopbackAuthorizer, OAUTH_CALLBACK_PATH } from "./oauth-loopback.ts";
import type { LoopbackAuthorizer } from "./oauth-loopback.ts";

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
  /**
   * Enable the AI-guided site-import endpoint (POST `/__studio__/import-site`). Absent disables the
   * route. It writes to the filesystem, so it is gated with the rpcToken like `/__jx_resolve__`.
   */
  importApi?: ImportApiOptions;
}

export interface ProjectServerHandle {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  wsUrl: string;
  rpcToken: string;
  canvasUrl: string;
  /**
   * Push an UNSOLICITED message to the connected shells — the server-to-client half of the RPC.
   *
   * Every other frame on this socket answers an `id` the client chose; these carry a `method` and
   * no `id`, which is how the client's dispatcher tells the two apart. It exists because some
   * things the shell must know are not answers to anything it asked: a file changed on disk, or
   * another window wants this one raised.
   *
   * @param winId Deliver only to sockets stashed with this window id; omit for every socket.
   * @returns How many sockets the message reached — 0 means nothing is listening yet.
   */
  push: (method: string, params?: unknown, winId?: string | null) => number;
  /**
   * The RFC 8252 loopback authorization host. The desktop launcher drives it: `begin()` for the URL
   * to open in the user's browser, then `await pending.code` and {@link exchangeCode}.
   */
  authorizer: LoopbackAuthorizer;
  stop: () => void;
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

  /* Outstanding OAuth authorizations (RFC 8252). Per server, so a stopped server abandons them. */
  const authorizer: LoopbackAuthorizer = createLoopbackAuthorizer();

  /* Live shell sockets, so the server can speak first (see ProjectServerHandle.push). Membership is
     the socket's whole lifetime — added on open, dropped on close — so a push after a window is
     gone reaches nobody rather than throwing. */
  const sockets = new Set<ServerWebSocket<{ winId: string | null }>>();

  const server = Bun.serve<{ winId: string | null }>({
    hostname,
    port,
    // Keep SSE/AI streams alive (mirrors the dev server's generous idle timeout).
    idleTimeout: 120,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // Decode the pathname ONCE, then run ALL containment on the decoded path. Reject a path that
      // Still contains an encoded dot/slash after one decode (over-encoding bypass attempt).
      const decoded = decodeAndNormalizePath(url);
      if ("reject" in decoded) {
        return decoded.reject;
      }
      const { normPath } = decoded;

      const winId = url.searchParams.get("win");

      /*
       * 0. The OAuth loopback redirect (RFC 8252 §7.3).
       *
       *    **Exempt from the token, and only from the token.** The provider redirects the user's
       *    own browser here; that navigation carries whatever the provider's `redirect_uri` said,
       *    and a page cannot append a secret to a URL it does not compose. Gating it on the token
       *    would make the flow impossible rather than safe.
       *
       *    What replaces the token is the `state` parameter, which is unguessable, single-use and
       *    compared in constant time — plus the Host and Fetch Metadata checks, which still apply.
       *    An IdP redirect is exactly the one cross-site shape the strict policy admits: a
       *    top-level GET document navigation, a person following a link.
       */
      if (normPath === OAUTH_CALLBACK_PATH) {
        const gate = originHostGate(req, "strict");
        if (gate) {
          return gate;
        }
        const callback = authorizer.handleCallback(url);
        if (callback) {
          return callback;
        }
      }

      // 1. WebSocket upgrade — token + loopback Origin/Host are the hard gate.
      const upgrade = req.headers.get("upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        const gate = loopbackGate(req, url, rpcToken);
        if (gate) {
          return gate;
        }
        if (srv.upgrade(req, { data: { winId } })) {
          return;
        }
        return problem("invalidRequest", "Upgrade failed");
      }

      /*
       * 2. AI proxy. Gated with the token, like every other surface that spends something: this
       *    route forwards to a provider on the user's key, so an ungated one is an open relay for
       *    any local process — and it was dispatched ahead of every gate. The token is what the
       *    desktop shell appends to this URL; a request without one is refused.
       */
      if (normPath.startsWith("/__studio__/ai/")) {
        const gate = loopbackGate(req, url, rpcToken);
        if (gate) {
          return gate;
        }
        const aiUrl = new URL(req.url);
        aiUrl.pathname = normPath.replace("/__studio__/ai/", "/__studio/ai/");
        const aiResponse = await handleAiApi(req, aiUrl);
        if (aiResponse) {
          return aiResponse;
        }
      }

      // 2b. AI-guided site import — writes to the filesystem and drives a browser, so token +
      //     Loopback Origin/Host are the hard gate (same as the RCE-capable routes below).
      if (normPath === "/__studio__/import-site" && req.method === "POST") {
        const { importApi } = options;
        if (!importApi) {
          return problem("notFound", "Not found");
        }
        const gate = loopbackGate(req, url, rpcToken);
        if (gate) {
          return gate;
        }
        const importUrl = new URL(req.url);
        importUrl.pathname = "/__studio/import-site";
        const importRes = await handleImportApi(req, importUrl, importApi);
        if (importRes) {
          return importRes;
        }
      }

      // 3. Studio assets under the non-colliding /__studio__/ namespace.
      if (normPath.startsWith("/__studio__/")) {
        const assetRel = normPath.slice("/__studio__/".length);
        const assetPath = resolve(studioDir, `.${sep}${assetRel}`);
        const res = await serveContained(assetPath, studioDir);
        if (res) {
          // Never leak the tokened URL cross-origin via Referer, while keeping same-origin requests
          // Normal. MUST be `same-origin`, not `no-referrer`: under `no-referrer` Chromium serializes
          // The Origin header of the canvas iframe's own same-origin POSTs as `null` (Fetch spec
          // Origin-serialization respects referrer policy), which fails originIsLoopbackOrAbsent and
          // Self-403s /__jx_resolve__ + /__jx_server__ from the very document this server serves.
          const headers = new Headers(res.headers);
          headers.set("Referrer-Policy", "same-origin");
          return new Response(res.body, { headers, status: res.status });
        }
        return problem("notFound", "Not found");
      }

      // 4. Resolve the session (fail-closed).
      const session = resolveSession(winId);
      if (!session) {
        return problem("notFound", "Unknown window");
      }
      const root = session.projectRoot;
      if (!root) {
        return problem("notFound", "No project");
      }

      /*
       * 4b. Extension server mounts (/_jx/data etc.) — registry-driven, same wire contract as the
       *     generated site worker and the dev server (specs/extensions.md §11).
       *
       *     Gated on **Origin/Host and Fetch Metadata, not the token**, and the distinction is the
       *     point: these are fetched by the canvas iframe's own page, whose requests carry no
       *     `?token=` — a page cannot rewrite the URLs its own content asks for. So the token is
       *     the wrong instrument here and the origin check is the right one. The policy is
       *     `embeddable` because that iframe is cross-origin by construction.
       */
      if (normPath.startsWith("/_jx/")) {
        const gate = originHostGate(req, "embeddable");
        if (gate) {
          return gate;
        }
        const mountRes = await handleJxMounts(req, url, root);
        if (mountRes) {
          return mountRes;
        }
      }

      // 5. Privileged HTTP routes (RCE-capable: dynamic import()). Gate with token + loopback
      //    Origin/Host BEFORE dispatch.
      if (
        (normPath === "/__jx_resolve__" || normPath === "/__jx_server__") &&
        req.method === "POST"
      ) {
        const gate = loopbackGate(req, url, rpcToken);
        if (gate) {
          return gate;
        }
        if (normPath === "/__jx_resolve__") {
          return handleResolve(req, root, root);
        }
        return handleServerFunction(req, root);
      }

      /*
       * 6. Project files at natural URLs, including extension asset mounts (§8.5) — that is what
       *    lets a canvas preview show an image a content entry references relative to itself.
       *
       *    `embeddable`, for the same reason as the mounts: these ARE the canvas iframe's
       *    subresources, and a cross-origin iframe's images arrive `cross-site`.
       */
      const staticGate = originHostGate(req, "embeddable");
      if (staticGate) {
        return staticGate;
      }
      const fileRes = await serveProjectFile(normPath, root, await projectAssetMounts(root));
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

      /* 8. The project's BUILT SITE is not served here — see the same note in `server.ts`. This
         server's paths mean the project's SOURCES, and a built page means its own output by the
         very same paths; `site-preview.ts` gives that output its own origin, which is what
         `View: Open in Browser` opens. */
      return problem("notFound", "Not found");
    },

    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw) {
        let msg: { id: number; method: string; params?: unknown };
        try {
          msg = JSON.parse(raw as string) as { id: number; method: string; params?: unknown };
        } catch {
          ws.send(JSON.stringify({ error: "Invalid JSON", id: 0 }));
          return;
        }

        /*
         * The keepalive, answered AHEAD of the session lookup.
         *
         * A ping's whole job is to prove the socket is alive, and that is a fact about the socket,
         * not about which project a window is bound to. Behind the lookup it would be refused —
         * and close the socket — in exactly the states where staying connected matters most: a
         * window mid-re-root, or one whose session was torn down and rebuilt. The shell sends one
         * every 30s because this server's idle timeout is 120s and a studio can be quiet for far
         * longer than that (a site import runs for minutes over a separate HTTP stream and touches
         * this socket not at all).
         */
        if (msg.method === "__ping") {
          ws.send(JSON.stringify({ id: msg.id, result: null }));
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
    authorizer,
    push: (method, params, winId) => {
      const frame = JSON.stringify(params === undefined ? { method } : { method, params });
      let delivered = 0;
      for (const ws of sockets) {
        if (winId !== undefined && winId !== null && ws.data.winId !== winId) {
          continue;
        }
        try {
          ws.send(frame);
          delivered += 1;
        } catch {
          // A socket that closed between the iteration and the send is simply not a recipient.
        }
      }
      return delivered;
    },
    stop: () => {
      // Abandon outstanding sign-ins first: their callbacks can no longer arrive.
      authorizer.stop();
      void server.stop(true);
    },
  };
}
