/**
 * Integration: the real dev server's /__studio/collab endpoint driven by the real collab wire
 * client over actual WebSockets — probe, two-client convergence, explicit-save persistence,
 * room-level dirty, and (registry-level) external-change resets.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createDevServer } from "../src/server.ts";
import { createCollabRegistry } from "../src/collab.ts";
import { createWsCollabConnection } from "@jxsuite/collab/client";
import { COLLAB_SUBPROTOCOL, negotiateCollab } from "@jxsuite/collab/negotiate";
import type { WsCollabConnection } from "@jxsuite/collab/client";
import { sourceText, updateSourceText } from "@jxsuite/collab";

const FIXTURES = resolve(import.meta.dir, "_collab_fixtures");
const PAGE = "pages/index.md";

let server: { port: number; stop: (force?: boolean) => void };
const connections: WsCollabConnection[] = [];

function connect(): WsCollabConnection {
  const connection = createWsCollabConnection({
    openTimeoutMs: 5000,
    reconnectDelayMs: 50,
    url: `ws://localhost:${server.port}/__studio/collab`,
  });
  connections.push(connection);
  return connection;
}

/** Resolve when the socket completes its handshake; reject if it fails. */
function whenOpen(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", () => {
      resolveOpen();
    });
    ws.addEventListener("error", () => {
      rejectOpen(new Error("handshake failed"));
    });
  });
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolveSleep) => {
      setTimeout(resolveSleep, 20);
    });
  }
}

beforeAll(async () => {
  rmSync(FIXTURES, { force: true, recursive: true });
  mkdirSync(join(FIXTURES, "pages"), { recursive: true });
  writeFileSync(join(FIXTURES, "project.json"), JSON.stringify({ name: "collab-demo" }));
  writeFileSync(join(FIXTURES, PAGE), "# Hello\n");
  server = (await createDevServer({
    builds: [],
    port: 0,
    root: FIXTURES,
    studio: true,
    watch: false,
  })) as unknown as { port: number; stop: (force?: boolean) => void };
});

afterAll(() => {
  for (const connection of connections) {
    connection.destroy();
  }
  server.stop(true);
  rmSync(FIXTURES, { force: true, recursive: true });
});

describe("/__studio/collab", () => {
  test("plain GET answers the capability probe, advertising the subprotocol", async () => {
    const res = await fetch(`http://localhost:${server.port}/__studio/collab`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({
      collab: true,
      protocols: [COLLAB_SUBPROTOCOL],
      version: 1,
    });
  });

  test("the probe body is exactly what negotiateCollab reads", async () => {
    const res = await fetch(`http://localhost:${server.port}/__studio/collab`);
    const probe = await res.json();
    expect(negotiateCollab(probe)).toEqual({ offer: [COLLAB_SUBPROTOCOL], refused: null });
  });

  test("an upgrade offering the subprotocol is echoed, and the socket opens", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/__studio/collab`, [COLLAB_SUBPROTOCOL]);
    await whenOpen(ws);
    // A client only reaches `open` if the echo was one of the tokens it offered (RFC 6455 §4.1).
    expect(ws.protocol).toBe(COLLAB_SUBPROTOCOL);
    ws.close();
  });

  test("an upgrade offering nothing still connects, and echoes nothing", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/__studio/collab`);
    await whenOpen(ws);
    expect(ws.protocol).toBe("");
    ws.close();
  });

  test("an upgrade offering only an envelope the server cannot speak is refused", async () => {
    /*
     * Refusing the handshake is the point: a peer whose frames we would mis-parse must not join a
     * room. The refusal is a 400 with a problem body, not a 101 with no echo.
     */
    const res = await fetch(`http://localhost:${server.port}/__studio/collab`, {
      headers: {
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol": "jx.collab.v9",
        "Sec-WebSocket-Version": "13",
        Upgrade: "websocket",
      },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.text()).toContain(COLLAB_SUBPROTOCOL);
  });

  test("a handle syncs the file's content and a local identity", async () => {
    const handle = await connect().openDoc(PAGE);
    expect(handle).not.toBeNull();
    await handle!.whenSynced;
    expect(sourceText(handle!.doc).toString()).toBe("# Hello\n");
    expect(handle!.identity()?.login).toStartWith("local-");
    expect(handle!.identity()?.permission).toBe("write");
    handle!.destroy();
  });

  test("a missing file resolves null", async () => {
    expect(await connect().openDoc("pages/absent.md")).toBeNull();
  });

  test("two clients converge and flush persists to disk", async () => {
    const a = await connect().openDoc(PAGE);
    const b = await connect().openDoc(PAGE);
    await a!.whenSynced;
    await b!.whenSynced;

    updateSourceText(a!.doc, "# Hello\n\nEdited together\n", "test");
    await until(() => sourceText(b!.doc).toString().includes("Edited together"));

    updateSourceText(b!.doc, "# Hello\n\nEdited together, twice\n", "test");
    await until(() => sourceText(a!.doc).toString().includes("twice"));

    await a!.flush();
    expect(readFileSync(join(FIXTURES, PAGE), "utf8")).toBe("# Hello\n\nEdited together, twice\n");
    a!.destroy();
    b!.destroy();
  });

  test("edits do NOT auto-persist; the room goes dirty and an explicit flush writes + clears it", async () => {
    const handle = await connect().openDoc(PAGE);
    await handle!.whenSynced;
    const dirtyStates: boolean[] = [];
    handle!.onDirty((d) => dirtyStates.push(d));
    const before = readFileSync(join(FIXTURES, PAGE), "utf8");
    const marker = `explicit-${Date.now()}`;
    updateSourceText(handle!.doc, `# Hello\n\n${marker}\n`, "test");
    // The room reports dirty over the wire, but nothing reaches disk without an explicit flush.
    await until(() => dirtyStates.at(-1) === true);
    await new Promise((resolveSleep) => {
      setTimeout(resolveSleep, 200);
    });
    expect(readFileSync(join(FIXTURES, PAGE), "utf8")).toBe(before);
    // The explicit flush persists it and clears the room-level dirty for every peer.
    await handle!.flush();
    expect(readFileSync(join(FIXTURES, PAGE), "utf8")).toContain(marker);
    await until(() => dirtyStates.at(-1) === false);
    handle!.destroy();
  });

  test("a redundant flush with no new edits is a no-op", async () => {
    const handle = await connect().openDoc(PAGE);
    await handle!.whenSynced;
    await handle!.flush();
    const before = readFileSync(join(FIXTURES, PAGE), "utf8");
    // Nothing changed since the last flush: the persist path short-circuits, no rewrite.
    await handle!.flush();
    expect(readFileSync(join(FIXTURES, PAGE), "utf8")).toBe(before);
    handle!.destroy();
  });

  test("a binary path is refused by the capability", async () => {
    expect(await connect().openDoc("assets/logo.png")).toBeNull();
  });

  test("a path escaping the server root is refused by the capability", async () => {
    expect(await connect().openDoc("../escape.md")).toBeNull();
  });
});

describe("watcher-driven resets", () => {
  test("an external disk write reaches subscribers as a doc-reset via the file watcher", async () => {
    const dir = resolve(import.meta.dir, "_collab_watch_fixtures");
    rmSync(dir, { force: true, recursive: true });
    mkdirSync(join(dir, "pages"), { recursive: true });
    writeFileSync(join(dir, "pages/live.md"), "# Watched\n");
    const watched = (await createDevServer({
      builds: [],
      port: 0,
      root: dir,
      studio: true,
      watch: true,
    })) as unknown as { port: number; stop: (force?: boolean) => void };
    const connection = createWsCollabConnection({
      openTimeoutMs: 5000,
      url: `ws://localhost:${watched.port}/__studio/collab`,
    });
    try {
      const handle = await connection.openDoc("pages/live.md");
      expect(handle).not.toBeNull();
      await handle!.whenSynced;
      let resets = 0;
      handle!.onReset(() => {
        resets += 1;
      });
      // Give chokidar a beat to finish its initial scan before the external write.
      await new Promise((resolveSleep) => {
        setTimeout(resolveSleep, 300);
      });
      writeFileSync(join(dir, "pages/live.md"), "# Rewritten outside the room\n");
      await until(() => resets === 1, 10_000);
    } finally {
      connection.destroy();
      watched.stop(true);
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("graceful shutdown", () => {
  test("stop() flushes unsaved edits to disk and is idempotent", async () => {
    const dir = resolve(import.meta.dir, "_collab_stop_fixtures");
    rmSync(dir, { force: true, recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "doc.md"), "start\n");
    const registry = createCollabRegistry({ absRoot: dir, activeProjectRoot: () => null });
    const srv = Bun.serve({
      fetch: (req, bunServer) => registry.handleRequest(req, bunServer) ?? new Response("ok"),
      port: 0,
      websocket: registry.websocket,
    });
    const connection = createWsCollabConnection({
      openTimeoutMs: 5000,
      url: `ws://localhost:${srv.port}`,
    });
    try {
      const handle = await connection.openDoc("doc.md");
      await handle!.whenSynced;
      updateSourceText(handle!.doc, "start\n\nunsaved edit\n", "test");
      // Wait for the edit to reach the server room (the dirty broadcast confirms it landed).
      await new Promise<void>((res) => {
        const off = handle!.onDirty((d) => {
          if (d) {
            off();
            res();
          }
        });
      });
      // No explicit flush — the file on disk is still the original.
      expect(readFileSync(join(dir, "doc.md"), "utf8")).toBe("start\n");
      // Graceful shutdown flushes the pending edit as a last-ditch safety.
      await registry.stop();
      expect(readFileSync(join(dir, "doc.md"), "utf8")).toBe("start\n\nunsaved edit\n");
      // A second stop() is idempotent.
      await registry.stop();
    } finally {
      connection.destroy();
      void srv.stop(true);
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("persist failures", () => {
  test("a failed shutdown write-back is swallowed and stop() still completes", async () => {
    const dir = resolve(import.meta.dir, "_collab_persist_fail_fixtures");
    rmSync(dir, { force: true, recursive: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "doc.md");
    writeFileSync(file, "start\n");
    const registry = createCollabRegistry({ absRoot: dir, activeProjectRoot: () => null });
    const srv = Bun.serve({
      fetch: (req, bunServer) => registry.handleRequest(req, bunServer) ?? new Response("ok"),
      port: 0,
      websocket: registry.websocket,
    });
    const connection = createWsCollabConnection({
      openTimeoutMs: 5000,
      url: `ws://localhost:${srv.port}`,
    });
    try {
      const handle = await connection.openDoc("doc.md");
      await handle!.whenSynced;
      updateSourceText(handle!.doc, "start\n\nnever lands\n", "test");
      await new Promise<void>((res) => {
        const off = handle!.onDirty((d) => {
          if (d) {
            off();
            res();
          }
        });
      });
      // Turn the target path into a directory: the shutdown write-back must fail (EISDIR),
      // Be swallowed, and clear its optimistic signature without breaking stop().
      rmSync(file);
      mkdirSync(file);
      await registry.stop();
      // The failed write left the directory in place; nothing was force-written.
      expect(statSync(file).isDirectory()).toBe(true);
      // A second stop() after the failure is still a no-op.
      await registry.stop();
    } finally {
      connection.destroy();
      void srv.stop(true);
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("registry external changes", () => {
  test("a genuinely external write resets the room; write-back echoes do not", async () => {
    const dir = resolve(import.meta.dir, "_collab_registry_fixtures");
    rmSync(dir, { force: true, recursive: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "doc.md");
    writeFileSync(file, "original");
    const registry = createCollabRegistry({ absRoot: dir, activeProjectRoot: () => null });
    const { decodeFrame, encodeFrame } = await import("@jxsuite/collab/envelope");

    // Wire a loopback client through the registry's Bun-shaped handlers, capturing sent frames.
    const received: string[] = [];
    const fakeWs = {
      close: () => {},
      data: { connection: null as unknown },
      send: (data: Uint8Array) => {
        try {
          const frame = decodeFrame(new Uint8Array(data));
          received.push(frame.type === "control" ? `control:${frame.message.type}` : frame.type);
        } catch {
          received.push("malformed");
        }
      },
    };
    void registry.websocket.open?.(fakeWs as never);
    const hostConnection = fakeWs.data.connection as {
      handleMessage: (d: Uint8Array) => void;
      close: () => void;
    };
    expect(hostConnection).toBeTruthy();

    hostConnection.handleMessage(
      encodeFrame({ message: { path: "doc.md", type: "open" }, type: "control" }),
    );
    await until(() => received.includes("control:opened"));

    // A save whose bytes match the live source is our own write-back echo: no reset.
    registry.handleExternalChange(file);
    await new Promise((resolveSleep) => {
      setTimeout(resolveSleep, 150);
    });
    expect(received).not.toContain("control:doc-reset");

    // Different bytes on disk are a genuine external change: subscribers get a doc-reset.
    writeFileSync(file, "changed externally");
    registry.handleExternalChange(file);
    await until(() => received.includes("control:doc-reset"));

    hostConnection.close();
    await registry.stop();
    rmSync(dir, { force: true, recursive: true });
  });

  test("a deleted file resets the room; unknown paths and text frames are ignored", async () => {
    const dir = resolve(import.meta.dir, "_collab_delete_fixtures");
    rmSync(dir, { force: true, recursive: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "doc.md");
    writeFileSync(file, "will vanish");
    const registry = createCollabRegistry({ absRoot: dir, activeProjectRoot: () => null });
    const { decodeFrame, encodeFrame } = await import("@jxsuite/collab/envelope");

    const received: string[] = [];
    const fakeWs = {
      close: () => {},
      data: { connection: null as unknown },
      send: (data: Uint8Array) => {
        try {
          const frame = decodeFrame(new Uint8Array(data));
          received.push(frame.type === "control" ? `control:${frame.message.type}` : frame.type);
        } catch {
          received.push("malformed");
        }
      },
    };
    // A text frame is ignored outright — even before any connection state exists.
    void registry.websocket.message?.(fakeWs as never, "not a binary frame");
    void registry.websocket.open?.(fakeWs as never);
    const hostConnection = fakeWs.data.connection as {
      handleMessage: (d: Uint8Array) => void;
      close: () => void;
    };
    hostConnection.handleMessage(
      encodeFrame({ message: { path: "doc.md", type: "open" }, type: "control" }),
    );
    await until(() => received.includes("control:opened"));

    // A change notification for a path no room has ever loaded is dropped.
    registry.handleExternalChange(join(dir, "ghost.md"));
    await new Promise((resolveSleep) => {
      setTimeout(resolveSleep, 100);
    });
    expect(received).not.toContain("control:doc-reset");

    // Deleting the file behind an open room is a genuine external change: the read fails and the
    // Room resets its subscribers.
    rmSync(file);
    registry.handleExternalChange(file);
    await until(() => received.includes("control:doc-reset"));

    // Leaving the room schedules the empty-room grace timer; stop() clears it.
    hostConnection.close();
    await new Promise((resolveSleep) => {
      setTimeout(resolveSleep, 50);
    });
    await registry.stop();
    rmSync(dir, { force: true, recursive: true });
  });

  test("an empty room is torn down after the grace period elapses", async () => {
    const dir = resolve(import.meta.dir, "_collab_grace_fixtures");
    rmSync(dir, { force: true, recursive: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "doc.md");
    writeFileSync(file, "grace");
    const registry = createCollabRegistry({ absRoot: dir, activeProjectRoot: () => null });
    const { decodeFrame, encodeFrame } = await import("@jxsuite/collab/envelope");

    const received: string[] = [];
    const fakeWs = {
      close: () => {},
      data: { connection: null as unknown },
      send: (data: Uint8Array) => {
        try {
          const frame = decodeFrame(new Uint8Array(data));
          received.push(frame.type === "control" ? `control:${frame.message.type}` : frame.type);
        } catch {
          received.push("malformed");
        }
      },
    };
    void registry.websocket.open?.(fakeWs as never);
    const hostConnection = fakeWs.data.connection as {
      handleMessage: (d: Uint8Array) => void;
      close: () => void;
    };
    hostConnection.handleMessage(
      encodeFrame({ message: { path: "doc.md", type: "open" }, type: "control" }),
    );
    await until(() => received.includes("control:opened"));

    // Capture the 30 s empty-room grace timer instead of waiting it out.
    const realSetTimeout = globalThis.setTimeout;
    let graceCb: (() => void) | null = null;
    globalThis.setTimeout = ((cb: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 30_000) {
        graceCb = cb;
        return realSetTimeout(() => {}, 0);
      }
      return realSetTimeout(cb, ms as number, ...rest);
    }) as unknown as typeof setTimeout;
    try {
      void registry.websocket.close?.(fakeWs as never, 1000, "bye");
      await until(() => graceCb !== null);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // The grace period elapses: the room is destroyed and later change events are dropped.
    graceCb!();
    const frames = received.length;
    registry.handleExternalChange(file);
    await new Promise((resolveSleep) => {
      setTimeout(resolveSleep, 100);
    });
    expect(received.length).toBe(frames);

    // Re-open and leave again, but this time let the (real) grace timer stay pending so that
    // Stop() has a live destroy timer to clear.
    let scheduled = false;
    globalThis.setTimeout = ((cb: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 30_000) {
        scheduled = true;
      }
      return realSetTimeout(cb, ms as number, ...rest);
    }) as unknown as typeof setTimeout;
    try {
      const fakeWs2 = {
        close: () => {},
        data: { connection: null as unknown },
        send: (data: Uint8Array) => {
          try {
            const frame = decodeFrame(new Uint8Array(data));
            const label = frame.type === "control" ? frame.message.type : frame.type;
            received.push(`re:${label}`);
          } catch {
            received.push("re:malformed");
          }
        },
      };
      void registry.websocket.open?.(fakeWs2 as never);
      const secondConnection = fakeWs2.data.connection as {
        handleMessage: (d: Uint8Array) => void;
        close: () => void;
      };
      secondConnection.handleMessage(
        encodeFrame({ message: { path: "doc.md", type: "open" }, type: "control" }),
      );
      await until(() => received.includes("re:opened"));
      void registry.websocket.close?.(fakeWs2 as never, 1000, "bye");
      await until(() => scheduled);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    await registry.stop();
    rmSync(dir, { force: true, recursive: true });
  });
});
