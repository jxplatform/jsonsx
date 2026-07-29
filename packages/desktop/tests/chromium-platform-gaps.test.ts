// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { afterAll, describe, expect, test } from "bun:test";

// Covers the parts of src/chromium/platform.ts not exercised by
// Chromium-platform.test.ts: gitShow/gitInit/gitAddRemote, search, formats,
// Package management, createProject, the AI assistant fetch helpers, and the
// Unsolicited-message guard in the WebSocket dispatcher.

// ─── Embedded mock RPC server ──────────────────────────────────────────────

const responses: Record<string, unknown> = {
  addPackage: { added: "left-pad" },
  createProject: {
    config: { name: "Fresh" },
    root: "/tmp/fresh",
  },
  formatAction: { doc: { title: "Hello" }, ok: true },
  gitAddRemote: null,
  gitInit: null,
  gitShow: "old file content",
  listFormats: [{ extensions: [".md"], format: "markdown" }],
  listPackages: [{ name: "left-pad", version: "^1.0.0" }],
  listStarters: [{ id: "restaurant", name: "Bistro & Café", tagline: "A menu-driven site." }],
  removePackage: { removed: "left-pad" },
  searchFiles: [{ name: "found.json", path: "a/found.json", type: "file" }],
};

interface ReceivedMessage {
  method: string;
  params?: Record<string, unknown>;
}

const received: ReceivedMessage[] = [];

const server = Bun.serve({
  fetch(req, srv) {
    if (srv.upgrade(req)) {
      return;
    }
    return new Response("Not Found", { status: 404 });
  },
  port: 0,
  websocket: {
    message(ws, raw) {
      const msg = JSON.parse(raw as string) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      received.push({ method: msg.method, ...(msg.params ? { params: msg.params } : {}) });

      // Exercise the dispatcher's unknown-id guard: send an unsolicited
      // Message before the real response.
      if (msg.method === "gitInit") {
        ws.send(JSON.stringify({ id: 999_999, result: "nobody is waiting for this" }));
      }

      if (msg.method in responses) {
        ws.send(JSON.stringify({ id: msg.id, result: responses[msg.method] }));
      } else {
        ws.send(JSON.stringify({ error: `Unknown method: ${msg.method}`, id: msg.id }));
      }
    },
  },
});

const TEST_HOST = `localhost:${server.port}`;

Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { host: TEST_HOST, href: `http://${TEST_HOST}/` },
  writable: true,
});

// If a DOM shim replaced WebSocket, restore Bun's native implementation.
const wsStr = globalThis.WebSocket?.toString() ?? "";
if (wsStr.includes("WebSocketImplementation") || wsStr.includes("DOMException")) {
  // @ts-expect-error -- deleting a required global; Bun re-exposes its built-in WebSocket
  delete globalThis.WebSocket;
}

// ─── Fetch stub for the AI assistant endpoints ─────────────────────────────

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const fetchCalls: FetchCall[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = ((url: string, init?: RequestInit) => {
  fetchCalls.push({ url, ...(init ? { init } : {}) });
  if (url === "/studio/ai/auth-status") {
    return Promise.resolve(Response.json({ authenticated: true }));
  }
  if (url === "/studio/ai/session") {
    return Promise.resolve(Response.json({ id: "sess-1" }));
  }
  return Promise.resolve(new Response(null, { status: 204 }));
}) as typeof fetch;

// ─── Import after globals are set ──────────────────────────────────────────

const { createDesktopPlatform } = await import("../src/chromium/platform");
const platform = createDesktopPlatform();

afterAll(() => {
  globalThis.fetch = realFetch;
  void server.stop();
});

function lastRequest(): ReceivedMessage | undefined {
  return received.at(-1);
}

// ─── Git extras ─────────────────────────────────────────────────────────────

describe("chromium platform: remaining git operations", () => {
  test("gitShow sends path and ref, returns file content at ref", async () => {
    const content = await platform.gitShow({ path: "a.txt", ref: "HEAD~1" });
    expect(content).toBe("old file content");
    expect(lastRequest()).toEqual({
      method: "gitShow",
      params: { path: "a.txt", ref: "HEAD~1" },
    });
  });

  test("gitInit resolves even when an unsolicited message arrives first", async () => {
    await expect(platform.gitInit()).resolves.toBeUndefined();
    expect(received.some((r) => r.method === "gitInit")).toBe(true);
  });

  test("gitAddRemote sends name and url", async () => {
    await expect(platform.gitAddRemote("origin", "git@host:me/repo.git")).resolves.toBeUndefined();
    expect(lastRequest()).toEqual({
      method: "gitAddRemote",
      params: { name: "origin", url: "git@host:me/repo.git" },
    });
  });
});

// ─── Search, formats, packages, project creation ────────────────────────────

describe("chromium platform: search, formats and packages", () => {
  test("searchFiles sends query and returns entries", async () => {
    const results = await platform.searchFiles("found");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("found.json");
    expect(lastRequest()).toEqual({ method: "searchFiles", params: { query: "found" } });
  });

  test("listFormats returns registered formats", async () => {
    const formats = await platform.listFormats();
    expect(formats).toEqual([{ extensions: [".md"], format: "markdown" }]);
    expect(lastRequest()).toEqual({ method: "listFormats", params: {} });
  });

  test("formatAction forwards the whole payload as params", async () => {
    const result = await platform.formatAction({
      action: "parse",
      format: "markdown",
      source: "# Hello",
    });
    expect(result).toEqual({ doc: { title: "Hello" }, ok: true });
    expect(lastRequest()).toEqual({
      method: "formatAction",
      params: { action: "parse", format: "markdown", source: "# Hello" },
    });
  });

  test("addPackage sends package name", async () => {
    const result = await platform.addPackage("left-pad");
    expect(result).toEqual({ added: "left-pad" });
    expect(lastRequest()).toEqual({ method: "addPackage", params: { name: "left-pad" } });
  });

  test("removePackage sends package name", async () => {
    const result = await platform.removePackage("left-pad");
    expect(result).toEqual({ removed: "left-pad" });
    expect(lastRequest()).toEqual({ method: "removePackage", params: { name: "left-pad" } });
  });

  test("listPackages returns installed packages", async () => {
    const packages = await platform.listPackages();
    expect(packages).toEqual([{ name: "left-pad", version: "^1.0.0" }]);
  });

  test("createDestination advertises the on-disk Location field", () => {
    // The chromium backend scaffolds onto disk, so the New Project modal renders a Location field
    // (with Browse… backed by pickDirectory) rather than the cloud's owner/repository picker.
    expect(platform.createDestination).toBe("path");
  });

  test("createProject forwards the caller's destination verbatim and returns root and config", async () => {
    const result = await platform.createProject({
      adapter: "static",
      description: "demo",
      destination: { kind: "path", parent: "/tmp" },
      directory: "fresh",
      name: "Fresh",
      url: "https://fresh.example",
    });
    expect(result.root).toBe("/tmp/fresh");
    expect(result.config.name).toBe("Fresh");
    expect(lastRequest()).toEqual({
      method: "createProject",
      params: {
        adapter: "static",
        description: "demo",
        destination: { kind: "path", parent: "/tmp" },
        directory: "fresh",
        name: "Fresh",
        url: "https://fresh.example",
      },
    });
  });

  test("listStarters returns the starter template list", async () => {
    const starters = await platform.listStarters!();
    expect(starters).toEqual(responses.listStarters as never);
    expect(lastRequest()!.method).toBe("listStarters");
  });

  test("rejects when the server reports an unknown method", async () => {
    await expect(platform.gitStatus()).rejects.toThrow("Unknown method: gitStatus");
  });
});

// ─── AI assistant helpers (HTTP, not WebSocket) ─────────────────────────────

describe("chromium platform: AI assistant endpoints", () => {
  test("aiChatUrl points at the chromium AI chat route", () => {
    expect(platform.aiChatUrl()).toBe("/__studio__/ai/chat");
  });
});
