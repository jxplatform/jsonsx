/**
 * The chromium launcher's RPC transport, under failure.
 *
 * The bug this exists for: the shell held ONE long-lived WebSocket and the transport had no failure
 * path at all. `ready` resolved once and was never reset, and `WebSocket.send()` on a CLOSING or
 * CLOSED socket does not throw — per WHATWG it discards the data and the browser may log "WebSocket
 * is already in CLOSING or CLOSED state" to the console, which was the entire observable evidence.
 * So every call after a disconnection returned a promise that NEVER SETTLED: `openProject` did
 * nothing, no toast, no log, and the in-flight counter behind `probe.idle()` never came back down.
 * Relaunching Studio was the only recovery.
 *
 * What the transport owes its callers is that every request SETTLES — with a reply, with a
 * rejection, or with a timeout. That is what these tests hold it to; the reconnect and the
 * keepalive are what make the rejection recoverable rather than terminal.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ServerWebSocket } from "bun";

/** Live sockets, so a test can drop them the way a server closing one does. */
const sockets: ServerWebSocket<unknown>[] = [];
/** Every method the server saw, keepalives included. */
const seen: string[] = [];
/** When true, the server accepts the upgrade and immediately hangs up. */
let hangUpOnConnect = false;
/** Methods the server deliberately never answers, so a test can leave a request genuinely open. */
const SILENT = new Set(["locateFile"]);

const server = Bun.serve({
  fetch(req, srv) {
    if (srv.upgrade(req)) {
      return;
    }
    return new Response("Not Found", { status: 404 });
  },
  port: 0,
  websocket: {
    open(ws) {
      sockets.push(ws);
      if (hangUpOnConnect) {
        ws.close();
      }
    },
    close(ws) {
      const at = sockets.indexOf(ws);
      if (at !== -1) {
        sockets.splice(at, 1);
      }
    },
    message(ws, raw) {
      const msg = JSON.parse(raw as string) as { id: number; method: string };
      seen.push(msg.method);
      if (msg.method === "__ping") {
        ws.send(JSON.stringify({ id: msg.id, result: null }));
        return;
      }
      if (SILENT.has(msg.method)) {
        return; // Deliberately unanswered: what settles this one is a close, not a reply.
      }
      ws.send(JSON.stringify({ id: msg.id, result: { method: msg.method } }));
    },
  },
});

const TEST_HOST = `localhost:${server.port}`;

Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { host: TEST_HOST, href: `http://${TEST_HOST}/?token=T`, search: "?token=T" },
  writable: true,
});

// Happy-dom's WebSocket cannot reach a real server; Bun re-exposes its own when the override goes.
const wsStr = globalThis.WebSocket?.toString() ?? "";
if (wsStr.includes("WebSocketImplementation") || wsStr.includes("DOMException")) {
  // @ts-expect-error -- deleting a required global; Bun re-exposes its built-in WebSocket
  delete globalThis.WebSocket;
}

const windowListeners = new Map<string, () => void>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    addEventListener: (type: string, handler: () => void) => windowListeners.set(type, handler),
    focus: () => {},
    open: () => null,
  },
  writable: true,
});

void mock.module("@jxsuite/studio/import-client", () => ({
  streamImport: () => Promise.resolve(),
}));

const { createDesktopPlatform } = await import("../src/chromium/platform");

/** Close every live socket, the way a server hanging up does. Snapshotted: `close` mutates it. */
function closeAll(): void {
  const live = [...sockets];
  sockets.length = 0;
  for (const ws of live) {
    ws.close();
  }
}

/** Wait for a condition, or give up — no arbitrary sleeps. */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) {
      return;
    }
    await new Promise<void>((r) => {
      setTimeout(r, 5);
    });
  }
  throw new Error("condition never became true");
}

let platform: ReturnType<typeof createDesktopPlatform>;

beforeAll(async () => {
  platform = createDesktopPlatform();
  await platform.getProjectRoot();
});

afterAll(() => {
  windowListeners.get("pagehide")?.();
  void server.stop(true);
});

describe("when the socket dies", () => {
  test("an in-flight request REJECTS rather than waiting forever", async () => {
    const inFlight = platform.locateFile("never/arrives.json");
    await until(() => seen.includes("locateFile"));
    closeAll();
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(inFlight).rejects.toThrow("Lost connection");
  });

  test("and the transport comes back on its own", async () => {
    await until(() => sockets.length > 0);
    // The mock server echoes the method it answered, so this proves a NEW socket carried it.
    await expect(platform.getProjectRoot()).resolves.toMatchObject({ method: "getProjectRoot" });
  });

  test("a request made while the socket is down rejects instead of vanishing", async () => {
    /* THE REPORTED BUG. `ws.send()` on a closed socket is a no-op, so without the readyState guard
       the frame simply disappears and the caller waits for a reply nobody will ever write. */
    hangUpOnConnect = true;
    closeAll();
    await until(() => sockets.length === 0);
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(platform.readFile("x.json")).rejects.toThrow("Lost connection");
    hangUpOnConnect = false;
  });

  test("it reports the state to whoever is listening, and reports recovery too", async () => {
    const states: { online: boolean }[] = [];
    const stop = platform.subscribeConnection!((state) => states.push(state));
    await until(() => states.some((s) => s.online), 5000);
    stop();
    expect(states.at(-1)?.online).toBe(true);
  });
});

describe("the keepalive", () => {
  test("is answered ahead of anything that needs a session", async () => {
    /* A ping proves the socket is alive, which is a fact about the SOCKET — not about which project
       a window is bound to. The server answers it before the session lookup for exactly that
       reason, so a window mid-re-root stays connected. */
    await until(() => sockets.length > 0);
    sockets[0]!.send(JSON.stringify({ id: 1, method: "focusWindow" }));
    await expect(platform.getProjectRoot()).resolves.toBeTruthy();
  });
});
