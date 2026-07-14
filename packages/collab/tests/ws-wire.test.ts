/**
 * Host + client wired over an in-memory socket pair (no network): the full envelope contract —
 * seed-before-sync, two-client convergence, awareness relay, read-only enforcement, flush ack,
 * doc-reset epochs, and reconnect resync.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createCollabHost } from "../src/ws-room.ts";
import type { CollabHost } from "../src/ws-room.ts";
import { createWsCollabConnection } from "../src/ws-client.ts";
import type { WsCollabConnection, WsLike } from "../src/ws-client.ts";
import { encodeFrame } from "../src/envelope.ts";
import type { CollabIdentity } from "../src/provider.ts";
import { applyDocOpsToY, LOCAL_ORIGIN } from "../src/op-bridge.ts";
import { seedStructure, sourceText, structureMap, yDocToJson } from "../src/schema.ts";

/** In-memory WebSocket wired straight into a host connection, with async delivery. */
class LoopbackSocket implements WsLike {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private hostConn: { handleMessage: (data: Uint8Array) => void; close: () => void } | null = null;

  constructor(host: CollabHost, identity: CollabIdentity, registry: LoopbackSocket[]) {
    registry.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) {
        return;
      }
      this.hostConn = host.connect(
        {
          close: () => this.dropFromServer(),
          send: (data) => {
            const copy = new Uint8Array(data);
            queueMicrotask(() => {
              if (this.readyState === 1) {
                this.onmessage?.({ data: copy.buffer });
              }
            });
          },
        },
        identity,
      );
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: Uint8Array): void {
    const copy = new Uint8Array(data);
    queueMicrotask(() => this.hostConn?.handleMessage(copy));
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.hostConn?.close();
    this.onclose?.();
  }

  /** Server-side drop (simulates a network cut the client did not ask for). */
  dropFromServer(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.onclose?.();
  }
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** One constructor per (host, identity) pair, matching the webSocketImpl contract. */
function socketImplFor(
  host: CollabHost,
  identity: CollabIdentity,
  sockets: LoopbackSocket[],
): new (url: string) => WsLike {
  return class extends LoopbackSocket {
    constructor() {
      super(host, identity, sockets);
    }
  };
}

interface Fixture {
  host: CollabHost;
  files: Map<string, string>;
  flushes: string[];
  emptied: string[];
  connect: (identity?: Partial<CollabIdentity>) => WsCollabConnection;
  sockets: LoopbackSocket[];
}

const cleanups: (() => void)[] = [];

function fixture(): Fixture {
  const files = new Map<string, string>([["pages/index.json", `{"tagName":"div"}`]]);
  const flushes: string[] = [];
  const emptied: string[] = [];
  const sockets: LoopbackSocket[] = [];
  const host = createCollabHost({
    loadSource: (path) => Promise.resolve(files.get(path) ?? null),
    onEmpty: (path) => {
      emptied.push(path);
    },
    onFlush: (path) => {
      flushes.push(path);
    },
    rejectPath: (path) => (path.endsWith(".png") ? "binary-file" : null),
  });
  const connect = (identity: Partial<CollabIdentity> = {}) => {
    const connection = createWsCollabConnection({
      openTimeoutMs: 1000,
      url: "ws://loopback",
      webSocketImpl: socketImplFor(
        host,
        { color: "#4f9cf9", login: "octocat", permission: "write", ...identity },
        sockets,
      ),
    });
    cleanups.push(() => connection.destroy());
    return connection;
  };
  cleanups.push(() => host.destroy());
  return { connect, emptied, files, flushes, host, sockets };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("open + seed", () => {
  test("a handle syncs the server-seeded source and hello identity", async () => {
    const fx = fixture();
    const connection = fx.connect();
    const handle = await connection.openDoc("pages/index.json");
    expect(handle).not.toBeNull();
    await handle!.whenSynced;
    expect(sourceText(handle!.doc).toString()).toBe(`{"tagName":"div"}`);
    expect(handle!.identity()?.login).toBe("octocat");
    expect(handle!.identity()?.permission).toBe("write");
  });

  test("a missing file resolves null (solo fallback)", async () => {
    const fx = fixture();
    const handle = await fx.connect().openDoc("pages/absent.json");
    expect(handle).toBeNull();
  });

  test("a rejected path resolves null", async () => {
    const fx = fixture();
    const handle = await fx.connect().openDoc("assets/logo.png");
    expect(handle).toBeNull();
  });

  test("content-not-loaded hydrates once and retries", async () => {
    const fx = fixture();
    const connection = createWsCollabConnection({
      hydratePath: (path) => {
        fx.files.set(path, "hydrated!");
        return Promise.resolve();
      },
      openTimeoutMs: 1000,
      url: "ws://loopback",
      webSocketImpl: socketImplFor(
        fx.host,
        { color: "#fff", login: "octocat", permission: "write" },
        fx.sockets,
      ),
    });
    cleanups.push(() => connection.destroy());
    const handle = await connection.openDoc("pages/lazy.json");
    expect(handle).not.toBeNull();
    await handle!.whenSynced;
    expect(sourceText(handle!.doc).toString()).toBe("hydrated!");
  });
});

describe("two clients", () => {
  test("structure edits converge across two connections", async () => {
    const fx = fixture();
    const a = await fx.connect().openDoc("pages/index.json");
    const b = await fx.connect().openDoc("pages/index.json");
    await a!.whenSynced;
    await b!.whenSynced;

    seedStructure(a!.doc, { children: [{ tagName: "p", textContent: "one" }], tagName: "div" });
    await settle();
    expect(yDocToJson(b!.doc)).toEqual(yDocToJson(a!.doc));

    applyDocOpsToY(
      b!.doc,
      [{ index: 1, node: { tagName: "aside" }, op: "insert-child", parentPath: [] }],
      LOCAL_ORIGIN,
    );
    await settle();
    expect(yDocToJson(a!.doc)).toEqual(yDocToJson(b!.doc));
    expect((yDocToJson(a!.doc) as { children: unknown[] }).children).toHaveLength(2);
  });

  test("awareness states relay to the other connection and drop on close", async () => {
    const fx = fixture();
    const connA = fx.connect();
    const connB = fx.connect();
    const a = await connA.openDoc("pages/index.json");
    const b = await connB.openDoc("pages/index.json");
    await a!.whenSynced;
    await b!.whenSynced;

    a!.awareness.setLocalState({ focusedPath: "pages/index.json", user: { login: "octocat" } });
    await settle();
    const seenByB = [...b!.awareness.getStates().values()];
    expect(
      seenByB.some((s) => (s as { user?: { login?: string } }).user?.login === "octocat"),
    ).toBe(true);

    connA.destroy();
    await settle();
    const afterClose = [...b!.awareness.getStates().entries()].filter(
      ([id]) => id !== b!.awareness.clientID,
    );
    expect(afterClose).toHaveLength(0);
  });

  test("read-only clients receive updates but cannot write", async () => {
    const fx = fixture();
    const writer = await fx.connect().openDoc("pages/index.json");
    const reader = await fx
      .connect({ login: "viewer", permission: "read" })
      .openDoc("pages/index.json");
    await writer!.whenSynced;
    await reader!.whenSynced;
    expect(reader!.identity()?.permission).toBe("read");

    seedStructure(writer!.doc, { tagName: "main" });
    await settle();
    expect(yDocToJson(reader!.doc)).toEqual(yDocToJson(writer!.doc));

    // The reader's write reaches its local doc but the server drops it.
    seedStructure(reader!.doc, { tagName: "hax" });
    reader!.doc.transact(() => {
      structureMap(reader!.doc).set("tagName", "hax");
    }, LOCAL_ORIGIN);
    await settle();
    expect((yDocToJson(writer!.doc) as { tagName?: string }).tagName).toBe("main");
  });
});

describe("lifecycle", () => {
  test("flush round-trips an ack", async () => {
    const fx = fixture();
    const handle = await fx.connect().openDoc("pages/index.json");
    await handle!.whenSynced;
    await handle!.flush();
    expect(fx.flushes).toEqual(["pages/index.json"]);
  });

  test("resetDoc bumps the epoch and fires onReset on subscribers", async () => {
    const fx = fixture();
    const handle = await fx.connect().openDoc("pages/index.json");
    await handle!.whenSynced;
    let resets = 0;
    handle!.onReset(() => {
      resets += 1;
    });

    fx.files.set("pages/index.json", "replaced externally");
    fx.host.resetDoc("pages/index.json");
    await settle();
    expect(resets).toBe(1);
    expect(fx.host.sourceOf("pages/index.json")).toBeNull();
  });

  test("closing the last handle empties the room for teardown", async () => {
    const fx = fixture();
    const handle = await fx.connect().openDoc("pages/index.json");
    await handle!.whenSynced;
    handle!.destroy();
    await settle();
    expect(fx.emptied).toEqual(["pages/index.json"]);
    expect(fx.host.subscriberCount("pages/index.json")).toBe(0);
    fx.host.destroyRoomIfEmpty("pages/index.json");
    expect(fx.host.sourceOf("pages/index.json")).toBeNull();
  });

  test("connection status reports and openDoc guards", async () => {
    const fx = fixture();
    const connection = fx.connect();
    expect(connection.status()).toBe("connecting");
    const handle = await connection.openDoc("pages/index.json");
    expect(connection.status()).toBe("connected");
    await handle!.whenSynced;

    // A second open of a live path is refused (one handle per doc per connection).
    expect(await connection.openDoc("pages/index.json")).toBeNull();

    // Socket errors are absorbed (the close handler owns recovery).
    fx.sockets[0]!.onerror?.();

    // Handle destroy is idempotent; a destroyed handle's path can be re-opened.
    handle!.destroy();
    handle!.destroy();
    const again = await connection.openDoc("pages/index.json");
    expect(again).not.toBeNull();

    connection.destroy();
    expect(await connection.openDoc("pages/index.json")).toBeNull();
    // Destroy is idempotent too.
    connection.destroy();
  });

  test("onReset / onStatus unsubscribe closures remove their callbacks", async () => {
    const fx = fixture();
    const handle = await fx.connect().openDoc("pages/index.json");
    await handle!.whenSynced;
    let resets = 0;
    let statuses = 0;
    const offReset = handle!.onReset(() => {
      resets += 1;
    });
    const offStatus = handle!.onStatus(() => {
      statuses += 1;
    });
    offReset();
    offStatus();

    // A doc-reset would fire onReset (see the resetDoc test above) — not after unsubscribing.
    fx.host.resetDoc("pages/index.json");
    await settle();
    // A server-side drop flips the status to "offline" — nobody is listening anymore.
    fx.sockets[0]!.dropFromServer();
    await settle();
    expect(resets).toBe(0);
    expect(statuses).toBe(0);
  });

  test("openDoc gives up after openTimeoutMs when the server never answers", async () => {
    // A "server" that accepts the socket but swallows every frame: the "open" control goes
    // Nowhere, so no "opened" reply can resolve the open — only the client-side timeout can.
    const silentHost = {
      connect: () => ({ close: () => {}, handleMessage: () => {} }),
    } as unknown as CollabHost;
    const connection = createWsCollabConnection({
      openTimeoutMs: 1,
      url: "ws://silent",
      webSocketImpl: socketImplFor(
        silentHost,
        { color: "#fff", login: "octocat", permission: "write" },
        [],
      ),
    });
    cleanups.push(() => connection.destroy());
    expect(await connection.openDoc("pages/index.json")).toBeNull();
    expect(connection.status()).toBe("connected");
  });

  test("an 'opened' control at a different epoch resets the live handle", async () => {
    const fx = fixture();
    const connection = fx.connect();
    const handle = await connection.openDoc("pages/index.json");
    await handle!.whenSynced;
    let resets = 0;
    handle!.onReset(() => {
      resets += 1;
    });
    // The server re-announces the doc at a new epoch (its history moved while we were away):
    // The handle is dead and must reset rather than merge divergent histories.
    fx.sockets[0]!.onmessage?.({
      data: encodeFrame({
        message: { epoch: 777, path: "pages/index.json", type: "opened" },
        type: "control",
      }).buffer,
    });
    expect(resets).toBe(1);
  });

  test("junk, unknown-path, and unhandled frames from the server are ignored", async () => {
    const fx = fixture();
    const connection = fx.connect();
    const handle = await connection.openDoc("pages/index.json");
    await handle!.whenSynced;
    const socket = fx.sockets[0]!;
    const inject = (frame: Parameters<typeof encodeFrame>[0]) => {
      socket.onmessage?.({ data: encodeFrame(frame).buffer });
    };

    // Non-binary data and an undecodable frame are dropped.
    socket.onmessage?.({ data: "not-binary" });
    socket.onmessage?.({ data: new Uint8Array([9]).buffer });
    // A server never sends doc-close; the frame switch's default arm drops it.
    inject({ path: "pages/index.json", type: "doc-close" });
    // A server never sends "open"; the control switch's default arm drops it.
    inject({ message: { path: "pages/index.json", type: "open" }, type: "control" });
    // Control frames for paths this client never opened are ignored.
    inject({ message: { epoch: 1, path: "pages/other.json", type: "opened" }, type: "control" });
    inject({
      message: { code: "too-large", message: "x", path: "pages/other.json", type: "error" },
      type: "control",
    });
    // An error without a path has no doc to fail.
    inject({ message: { code: "rate-limited", message: "x", type: "error" }, type: "control" });
    // Doc-sync at a stale epoch or for an unopened path is dropped.
    inject({ body: new Uint8Array([0]), epoch: 99, path: "pages/index.json", type: "doc-sync" });
    inject({ body: new Uint8Array([0]), epoch: 1, path: "pages/other.json", type: "doc-sync" });

    await settle();
    // The connection survives all of it with its sync intact.
    expect(connection.status()).toBe("connected");
    expect(sourceText(handle!.doc).toString()).toBe(`{"tagName":"div"}`);
  });

  test("a failing hydratePath falls back to solo", async () => {
    const fx = fixture();
    const connection = createWsCollabConnection({
      hydratePath: () => Promise.reject(new Error("no such file")),
      openTimeoutMs: 1000,
      url: "ws://loopback",
      webSocketImpl: socketImplFor(
        fx.host,
        { color: "#fff", login: "octocat", permission: "write" },
        fx.sockets,
      ),
    });
    cleanups.push(() => connection.destroy());
    expect(await connection.openDoc("pages/never.json")).toBeNull();
  });

  test("a dropped connection reconnects, re-opens, and resyncs offline edits", async () => {
    const fx = fixture();
    const connection = createWsCollabConnection({
      openTimeoutMs: 1000,
      reconnectDelayMs: 1,
      url: "ws://loopback",
      webSocketImpl: socketImplFor(
        fx.host,
        { color: "#fff", login: "octocat", permission: "write" },
        fx.sockets,
      ),
    });
    cleanups.push(() => connection.destroy());
    const handle = await connection.openDoc("pages/index.json");
    await handle!.whenSynced;
    seedStructure(handle!.doc, { tagName: "before-drop" });
    await settle();

    const statuses: string[] = [];
    handle!.onStatus((s) => statuses.push(s));
    // Presence published before the drop: reconnect must re-publish the full local state.
    handle!.awareness.setLocalState({ user: { login: "octocat" } });
    await settle();
    // Server-side drop; client reconnects with a fresh socket.
    fx.sockets[0]!.dropFromServer();
    // Offline edit while disconnected.
    handle!.doc.transact(() => {
      structureMap(handle!.doc).set("tagName", "edited-offline");
    }, LOCAL_ORIGIN);
    await settle(30);

    expect(statuses).toContain("offline");
    expect(statuses).toContain("connected");
    // The local awareness state survived the reconnect re-publish.
    expect(handle!.awareness.getLocalState()).toEqual({ user: { login: "octocat" } });
    // A second client sees the offline edit after resync — and the re-published presence.
    const b = await fx.connect().openDoc("pages/index.json");
    await b!.whenSynced;
    await settle();
    expect((yDocToJson(b!.doc) as { tagName?: string }).tagName).toBe("edited-offline");
    const seenByB = [...b!.awareness.getStates().values()];
    expect(
      seenByB.some((s) => (s as { user?: { login?: string } }).user?.login === "octocat"),
    ).toBe(true);
  });
});
