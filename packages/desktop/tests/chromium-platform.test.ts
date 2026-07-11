// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

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
  getProjectRoot: { root: "/abs/proj" },
  setWindowProject: { config: { name: "Test" }, deduped: false },
  getRecentProjects: [{ name: "Recent", root: "/abs/recent", timestamp: 7 }],
  getSettings: { aiApiKey: "sk-abc" },
  pickDirectory: { path: "/picked/parent" },
  saveRecentProjects: null,
  saveSettings: null,
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
  dependenciesNeedInstall: true,
  installDependencies: { ok: true },
  outdatedPackages: [{ current: "^4.0.0", latest: "4.17.21", name: "lodash" }],
  setPackageVersions: { ok: true },
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
  // Data surface + secrets (desktop twins of /__studio/data/* + /__studio/secrets)
  dataConnections: { connections: [{ isDefault: true, name: "main" }] },
  dataConnectionTest: { ok: true },
  dataPush: { applied: false, plan: [{ kind: "createTable", summary: "Create" }] },
  dataRows: { columns: [{ name: "id", pk: true, type: "text" }], rows: [], total: 0 },
  dataInsertRow: { row: { id: "n" } },
  dataUpdateRow: { row: { id: "n", title: "t" } },
  dataDeleteRow: { ok: true },
  listSecrets: { names: ["MAIN_URL"] },
  setSecrets: { names: ["MAIN_URL"], ok: true },
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

// The NDJSON stream client is exercised by studio's import-client tests; here only the plumbing
// (endpoint token, directory resolution, callback threading) matters.
const streamImportCalls: unknown[][] = [];
const streamImport = mock((...args: unknown[]) => {
  streamImportCalls.push(args);
  return Promise.resolve({ config: { name: "Imported" }, root: "/imported" });
});
void mock.module("@jxsuite/studio/import-client", () => ({ streamImport }));

const { createDesktopPlatform } = await import("../src/chromium/platform");

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("chromium desktop platform", () => {
  let platform: ReturnType<typeof createDesktopPlatform>;

  beforeAll(() => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        host: TEST_HOST,
        href: `http://${TEST_HOST}/?token=CHROMIUM_TOK`,
        search: "?token=CHROMIUM_TOK",
      },
      writable: true,
    });
    platform = createDesktopPlatform();
  });

  afterAll(() => {
    void server.stop();
  });

  test("has correct id", () => {
    expect(platform.id).toBe("desktop");
  });

  test("canvasUrl carries the per-process rpcToken read from the shell URL", () => {
    // The launcher passes the rpcToken as ?token= on the shell URL; the platform threads it onto
    // The canvas iframe URL as ?rpcToken= so the in-iframe runtime's loopback fetches authenticate.
    const url = new URL(platform.canvasUrl!, "http://x");
    expect(url.pathname).toBe("/__studio__/canvas.html");
    expect(url.searchParams.get("rpcToken")).toBe("CHROMIUM_TOK");
  });

  test("canvasUrl stays the bare path when no token is present (dev/token-less parity)", () => {
    // Construct a platform under a token-less location; canvasUrl must be byte-identical to the
    // Default so the dev server / token-less contexts are unaffected.
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { host: TEST_HOST, href: `http://${TEST_HOST}/`, search: "" },
      writable: true,
    });
    const tokenless = createDesktopPlatform();
    expect(tokenless.canvasUrl).toBe("/__studio__/canvas.html");
  });

  test("activate is a no-op", async () => {
    await expect(platform.activate()).resolves.toBeUndefined();
  });

  // ─── AI-guided site import ─────────────────────────────────────────────

  test("pickDirectory returns the natively picked path", async () => {
    await expect(platform.pickDirectory!()).resolves.toBe("/picked/parent");
  });

  test("importSite resolves a relative directory under a picked parent and streams via the tokened endpoint", async () => {
    streamImportCalls.length = 0;
    const onProgress = () => {};
    const result = await platform.importSite!(
      {
        aiComponents: false,
        depth: 1,
        directory: "my-slug",
        maxPages: 5,
        name: "X",
        url: "https://x.example",
      },
      onProgress,
    );
    expect(result).toEqual({ config: { name: "Imported" }, root: "/imported" } as never);
    const [endpoint, opts, cb] = streamImportCalls[0]!;
    expect(endpoint).toBe("/__studio__/import-site?token=CHROMIUM_TOK");
    expect((opts as { directory: string }).directory).toBe("/picked/parent/my-slug");
    expect(cb).toBe(onProgress);
  });

  test("importSite passes an absolute directory through without a dialog", async () => {
    streamImportCalls.length = 0;
    await platform.importSite!(
      {
        aiComponents: false,
        depth: 0,
        directory: "/abs/dest",
        maxPages: 1,
        name: "X",
        url: "https://x.example",
      },
      () => {},
    );
    expect((streamImportCalls[0]![1] as { directory: string }).directory).toBe("/abs/dest");
  });

  test("importSite rejects when the directory picker is cancelled", async () => {
    responses.pickDirectory = { path: null };
    try {
      await expect(
        platform.importSite!(
          {
            aiComponents: false,
            depth: 0,
            directory: "slug",
            maxPages: 1,
            name: "X",
            url: "https://x.example",
          },
          () => {},
        ),
      ).rejects.toThrow("No destination folder was selected.");
    } finally {
      responses.pickDirectory = { path: "/picked/parent" };
    }
  });

  // ─── Class resolution ──────────────────────────────────────────────────

  test("resolveClass POSTs to /__jx_resolve__ with the shell token", async () => {
    // The project server 403s a token-less /__jx_resolve__; the platform must thread the token.
    const originalFetch = globalThis.fetch;
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ init, url: String(input) });
      return Response.json([{ data: { sku: "a" }, id: "A" }]);
    }) as typeof fetch;
    try {
      const result = await platform.resolveClass!({ $src: "x" });
      expect(result).toEqual([{ data: { sku: "a" }, id: "A" }]);
      expect(seen[0]!.url).toBe("/__jx_resolve__?token=CHROMIUM_TOK");
      expect(seen[0]!.init?.method).toBe("POST");
      expect(seen[0]!.init?.body).toBe('{"$src":"x"}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolveClass throws on a non-OK response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("no", { status: 403 })) as typeof fetch;
    try {
      expect(platform.resolveClass!({ $src: "x" })).rejects.toThrow("Class resolution failed: 403");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    // Absolute backend root is surfaced as the re-openable key.
    expect(result!.meta.root).toBe("/abs/proj");
  });

  test("getProjectRoot returns the backend root", async () => {
    const { root } = await platform.getProjectRoot!();
    expect(root).toBe("/abs/proj");
  });

  test("setWindowProject rebinds in place and reports no dedup", async () => {
    const res = await platform.setWindowProject!("/abs/proj");
    expect(res.deduped).toBe(false);
    expect(res.config).toEqual({ name: "Test" });
  });

  test("recent projects round-trip through the backend store", async () => {
    const list = await platform.getRecentProjects!();
    expect(list.map((p) => p.root)).toEqual(["/abs/recent"]);
    await expect(platform.saveRecentProjects!(list)).resolves.toBeUndefined();
  });

  test("settings round-trip through the backend store", async () => {
    const settings = await platform.getSettings!();
    expect(settings).toEqual({ aiApiKey: "sk-abc" });
    await expect(platform.saveSettings!(settings)).resolves.toBeUndefined();
  });

  test("probeRootProject returns null when readFile fails (no project → welcome screen)", async () => {
    // The launcher's root defaults to the launch cwd; a missing project.json means "no project".
    // A phantom non-site result here would set projectState and suppress the welcome screen for
    // The whole session (the chromium never-shows-welcome regression).
    forcedErrors.set("readFile", "File not found");
    const result = await platform.probeRootProject();
    expect(result).toBeNull();
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

  // ─── Data surface + secrets ────────────────────────────────────────────

  test("data surface members round-trip over the RPC socket", async () => {
    const connections = await platform.dataConnections!();
    expect(connections.connections[0]!.name).toBe("main");
    expect(await platform.dataConnectionTest!("main")).toEqual({ ok: true });
    const push = await platform.dataPush!({ dryRun: true });
    expect(push.plan).toHaveLength(1);
    const rows = await platform.dataRows!({ limit: 50, table: "posts" });
    expect(rows.columns[0]!.pk).toBe(true);
    const inserted = await platform.dataInsertRow!({ table: "posts", values: { title: "t" } });
    expect(inserted.row.id).toBe("n");
    const updated = await platform.dataUpdateRow!({
      pk: "n",
      set: { title: "t" },
      table: "posts",
    });
    expect(updated.row.title).toBe("t");
    expect(await platform.dataDeleteRow!({ pk: "n", table: "posts" })).toEqual({ ok: true });
  });

  test("secrets members are names-only on the way out", async () => {
    expect(await platform.listSecrets!()).toEqual(["MAIN_URL"]);
    expect(await platform.setSecrets!({ set: { MAIN_URL: "v" } })).toEqual({
      names: ["MAIN_URL"],
      ok: true,
    });
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

  test("installDependencies / dependenciesNeedInstall resolve", async () => {
    expect(await platform.installDependencies!()).toEqual({ ok: true });
    expect(await platform.dependenciesNeedInstall!()).toBe(true);
  });

  test("outdatedPackages returns the outdated list", async () => {
    const out = await platform.outdatedPackages!();
    expect(out).toEqual([{ current: "^4.0.0", latest: "4.17.21", name: "lodash" }]);
  });

  test("setPackageVersions resolves", async () => {
    expect(await platform.setPackageVersions!([{ name: "lodash", version: "^4.17.21" }])).toEqual({
      ok: true,
    });
  });
});
