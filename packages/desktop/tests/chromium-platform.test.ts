import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ─── Embedded mock RPC server ──────────────────────────────────────────────

const responses: Record<string, unknown> = {
  addPackage: null,
  codeService: null,
  createDirectory: null,
  deleteFile: null,
  discoverComponents: [{ path: "btn.json", props: [], tagName: "my-btn" }],
  fetchPluginSchema: { properties: {}, type: "object" },
  gitBranches: { branches: ["main", "dev"], current: "main" },
  gitCheckout: null,
  gitCommit: null,
  gitCreateBranch: null,
  gitDiff: "diff --git a/file",
  gitDiscard: null,
  gitFetch: null,
  gitLog: [{ author: "Test", date: "2025-01-01", hash: "abc123", message: "init" }],
  gitPull: null,
  gitPush: null,
  gitShow: "file at ref",
  gitStage: null,
  gitStatus: { ahead: 0, behind: 0, branch: "main", files: [] },
  gitUnstage: null,
  listDirectory: [
    {
      modified: "2025-01-01",
      name: "file.json",
      path: "file.json",
      size: 42,
      type: "file",
    },
  ],
  listPackages: [{ name: "lodash", version: "^4.0.0" }],
  locateFile: "found/file.json",
  openProject: {
    config: { name: "Test" },
    handle: { name: "Test", projectConfig: { name: "Test" }, root: "." },
  },
  removePackage: null,
  renameFile: null,
  resolveSiteContext: { sitePath: "." },
  searchFiles: [{ name: "match.json", path: "match.json", type: "file" }],
  uploadFile: null,
  writeFile: null,
};

// Track forced errors for specific methods
const forcedErrors = new Map<string, string>();

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

      const forcedError = forcedErrors.get(msg.method);
      if (forcedError) {
        forcedErrors.delete(msg.method);
        ws.send(JSON.stringify({ error: forcedError, id: msg.id }));
        return;
      }

      // Dynamic response for readFile based on path
      if (msg.method === "readFile") {
        const params = msg.params as { path?: string } | undefined;
        if (params?.path === "project.json") {
          ws.send(
            JSON.stringify({
              id: msg.id,
              result: JSON.stringify({ name: "TestProject" }),
            }),
          );
        } else {
          ws.send(JSON.stringify({ id: msg.id, result: "file content here" }));
        }
        return;
      }

      if (msg.method in responses) {
        ws.send(JSON.stringify({ id: msg.id, result: responses[msg.method] }));
      } else {
        ws.send(
          JSON.stringify({
            error: `Unknown method: ${msg.method}`,
            id: msg.id,
          }),
        );
      }
    },
  },
});

const TEST_HOST = `localhost:${server.port}`;

// Override location.host for the platform to connect to our mock server.
// Use Object.defineProperty to survive happy-dom's GlobalRegistrator.
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { host: TEST_HOST, href: `http://${TEST_HOST}/` },
  writable: true,
});

// Happy-dom (loaded by studio test preload) replaces globalThis.WebSocket with
// A version that cannot connect to real servers. Detect and fix this by falling
// Back to a thin wrapper around Bun's native TCP WebSocket upgrade.
const wsStr = globalThis.WebSocket?.toString() ?? "";
if (wsStr.includes("WebSocketImplementation") || wsStr.includes("DOMException")) {
  const saved = globalThis.WebSocket;
  // Bun supports native WebSocket via its internal implementation.
  // We can get a working one by deleting happy-dom's override — Bun re-exposes the built-in.
  // @ts-expect-error -- deleting a required global; Bun re-exposes its built-in WebSocket
  delete globalThis.WebSocket;
  if (!globalThis.WebSocket) {
    // Fallback: re-assign — shouldn't happen in Bun but just in case
    globalThis.WebSocket = saved;
  }
}

// ─── Import after globals are set ──────────────────────────────────────────

const { createDesktopPlatform } = await import("../src/chromium/platform");

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("chromium desktop platform", () => {
  let platform: ReturnType<typeof createDesktopPlatform>;

  beforeAll(() => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { host: TEST_HOST, href: `http://${TEST_HOST}/` },
      writable: true,
    });
    platform = createDesktopPlatform();
  });

  afterAll(() => {
    server.stop();
  });

  test("has correct id", () => {
    expect(platform.id).toBe("desktop");
  });

  test("activate is a no-op", async () => {
    await expect(platform.activate()).resolves.toBeUndefined();
  });

  // ─── Project operations ────────────────────────────────────────────────

  test("openProject returns config and handle", async () => {
    const result = await platform.openProject();
    expect(result).not.toBeNull();
    expect(result!.config.name).toBe("Test");
    expect(result!.handle.root).toBe(".");
  });

  test("probeRootProject reads project.json", async () => {
    const result = await platform.probeRootProject();
    expect(result!.info.isSiteProject).toBe(true);
  });

  test("probeRootProject returns fallback when readFile fails", async () => {
    forcedErrors.set("readFile", "File not found");
    const result = await platform.probeRootProject();
    expect(result!.info.isSiteProject).toBe(false);
    expect(result!.info.projectConfig).toBeNull();
    expect(result!.meta.name).toBe("project");
  });

  test("resolveSiteContext returns site path", async () => {
    const result = await platform.resolveSiteContext("pages/index.json");
    expect(result.sitePath).toBe(".");
  });

  // ─── File operations ───────────────────────────────────────────────────

  test("listDirectory returns entries", async () => {
    const entries = await platform.listDirectory(".");
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("file.json");
  });

  test("readFile returns content", async () => {
    const content = await platform.readFile("test.txt");
    expect(content).toBe("file content here");
  });

  test("rejects with error when server returns an error response", async () => {
    forcedErrors.set("readFile", "Permission denied");
    await expect(platform.readFile("secret.txt")).rejects.toThrow("Permission denied");
  });

  test("writeFile resolves without error", async () => {
    await platform.writeFile("out.txt", "data");
  });

  test("uploadFile resolves without error", async () => {
    await platform.uploadFile("img.png", "base64data");
  });

  test("deleteFile resolves without error", async () => {
    await platform.deleteFile("old.txt");
  });

  test("renameFile resolves without error", async () => {
    await platform.renameFile("a.txt", "b.txt");
  });

  test("createDirectory resolves without error", async () => {
    await platform.createDirectory("newdir");
  });

  // ─── Component discovery ───────────────────────────────────────────────

  test("discoverComponents returns component list", async () => {
    const components = await platform.discoverComponents(".");
    expect(components).toHaveLength(1);
    expect(components[0].tagName).toBe("my-btn");
  });

  test("codeService returns null", async () => {
    const result = await platform.codeService("lint", {});
    expect(result).toBeNull();
  });

  test("locateFile returns path", async () => {
    const result = await platform.locateFile("file.json");
    expect(result).toBe("found/file.json");
  });

  test("fetchPluginSchema returns schema", async () => {
    const schema = await platform.fetchPluginSchema("./Plugin.ts", "Plugin");
    expect(schema).toEqual({ properties: {}, type: "object" });
  });

  // ─── Git operations ────────────────────────────────────────────────────

  test("gitStatus returns branch and files", async () => {
    const status = await platform.gitStatus();
    expect(status.branch).toBe("main");
    expect(status.files).toHaveLength(0);
  });

  test("gitBranches returns current and list", async () => {
    const result = await platform.gitBranches();
    expect(result.current).toBe("main");
    expect(result.branches).toContain("dev");
  });

  test("gitLog returns entries", async () => {
    const log = await platform.gitLog(10);
    expect(log).toHaveLength(1);
    expect(log[0].message).toBe("init");
  });

  test("gitStage resolves", async () => {
    await platform.gitStage(["file.txt"]);
  });

  test("gitUnstage resolves", async () => {
    await platform.gitUnstage(["file.txt"]);
  });

  test("gitCommit resolves", async () => {
    await platform.gitCommit("msg");
  });

  test("gitPush resolves", async () => {
    await platform.gitPush();
  });

  test("gitPull resolves", async () => {
    await platform.gitPull();
  });

  test("gitFetch resolves", async () => {
    await platform.gitFetch();
  });

  test("gitCheckout resolves", async () => {
    await platform.gitCheckout("dev");
  });

  test("gitCreateBranch resolves", async () => {
    await platform.gitCreateBranch("feature");
  });

  test("gitDiff returns diff string", async () => {
    const diff = await platform.gitDiff("file.txt");
    expect(diff).toContain("diff");
  });

  test("gitDiscard resolves", async () => {
    await platform.gitDiscard(["file.txt"]);
  });

  test("gitShow returns content at ref", async () => {
    const content = await platform.gitShow({ path: "file.txt", ref: "HEAD" });
    expect(content).toBe("file at ref");
  });

  // ─── Search & Packages ─────────────────────────────────────────────────

  test("searchFiles returns matching entries", async () => {
    const results = await platform.searchFiles("match");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("match.json");
  });

  test("addPackage resolves", async () => {
    await platform.addPackage("lodash");
  });

  test("removePackage resolves", async () => {
    await platform.removePackage("lodash");
  });

  test("listPackages returns package list", async () => {
    const packages = await platform.listPackages();
    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe("lodash");
  });
});
