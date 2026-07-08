/**
 * Integration: the real dev server's /__studio/collab endpoint driven by the real collab wire
 * client over actual WebSockets — probe, two-client convergence, disk write-back, flush, and
 * (registry-level) external-change resets.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createDevServer } from "../src/server.ts";
import { createCollabRegistry } from "../src/collab.ts";
import { createWsCollabConnection } from "@jxsuite/collab/client";
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
  test("plain GET answers the capability probe", async () => {
    const res = await fetch(`http://localhost:${server.port}/__studio/collab`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ collab: true, version: 1 });
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

  test("the debounced write-back lands without an explicit flush", async () => {
    const handle = await connect().openDoc(PAGE);
    await handle!.whenSynced;
    const marker = `auto-${Date.now()}`;
    updateSourceText(handle!.doc, `# Hello\n\n${marker}\n`, "test");
    await until(() => {
      try {
        return readFileSync(join(FIXTURES, PAGE), "utf8").includes(marker);
      } catch {
        return false;
      }
    });
    handle!.destroy();
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
});
