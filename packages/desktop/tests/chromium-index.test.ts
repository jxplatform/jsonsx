// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// In-process import of src/chromium/index.ts, a launcher with import-time side effects.
// Collaborators are mocked so tests can drive the embedded HTTP + WebSocket RPC server.
// The chromium process lifecycle is exercised deterministically via a fake child process.

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dir, "_fixtures_chromium_index");
const STUDIO_ASSETS = join(FIXTURES, "_studio_assets");

// Convert an absolute filesystem path to the URL pathname a browser would request for it. A bare
// POSIX path is already a valid URL path; a Windows path (C:\Users\x) becomes /C:/Users/x.
function toUrlPath(absPath: string): string {
  const forward = absPath.replaceAll("\\", "/");
  return forward.startsWith("/") ? forward : `/${forward}`;
}

mkdirSync(join(FIXTURES, "public"), { recursive: true });
mkdirSync(STUDIO_ASSETS, { recursive: true });
writeFileSync(join(FIXTURES, "hello.txt"), "Hello Index");
writeFileSync(join(FIXTURES, "public", "pub.css"), "body { margin: 0 }");
writeFileSync(join(STUDIO_ASSETS, "index.html"), "<html>studio-shell</html>");
// The iframe canvas assets the launcher must serve (staged by scripts/stage-studio-assets.ts).
mkdirSync(join(STUDIO_ASSETS, "dist"), { recursive: true });
writeFileSync(join(STUDIO_ASSETS, "canvas.html"), '<html><div id="jx-canvas-root"></div></html>');
writeFileSync(join(STUDIO_ASSETS, "dist", "iframe-entry.js"), "// canvas entry stub");

// A self-contained .class.json so the /__jx_resolve__ HTTP route returns a known value.
writeFileSync(
  join(FIXTURES, "Sum.class.json"),
  JSON.stringify({
    $defs: {
      constructor: { $prototype: "Function", role: "constructor" },
      fields: {
        a: { access: "public", default: 0, identifier: "a", role: "field", scope: "instance" },
        b: { access: "public", default: 0, identifier: "b", role: "field", scope: "instance" },
      },
      methods: {
        resolve: { body: "return this.a + this.b;", identifier: "resolve", role: "method" },
      },
    },
    $prototype: "Class",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Sum",
  }),
);

// ─── Mocked collaborator modules ────────────────────────────────────────────

let projectRootValue = FIXTURES;

const handlerMocks = {
  codeService: mock((params: unknown) => Promise.resolve({ echoed: params })),
  discoverComponents: mock(() => Promise.resolve([{ path: "btn.json", tagName: "my-btn" }])),
  fetchPluginSchema: mock(() => Promise.resolve({ type: "object" })),
  formatAction: mock(() => Promise.resolve({ doc: { ok: true } })),
  getProjectRoot: mock(() => projectRootValue),
  handleCreateDirectory: mock(() => Promise.resolve()),
  handleDeleteFile: mock(() => Promise.resolve()),
  handleReadFile: mock((p: { path: string }) => Promise.resolve(`read:${p.path}`)),
  handleRenameFile: mock(() => Promise.resolve()),
  handleResolveSiteContext: mock(() => Promise.resolve({ sitePath: "." })),
  handleUploadFile: mock(() => Promise.resolve()),
  handleWriteFile: mock(() => Promise.resolve()),
  jxResolve: mock((p: { body: string }) =>
    Promise.resolve({ body: JSON.stringify({ resolved: p.body }), status: 200 }),
  ),
  jxServerFunction: mock((p: { body: string }) =>
    Promise.resolve({ body: JSON.stringify({ server: p.body }), status: 200 }),
  ),
  listDirectory: mock(() => Promise.resolve([{ name: "hello.txt", type: "file" }])),
  listFormats: mock(() => Promise.resolve([{ format: "markdown" }])),
  locateFile: mock(() => Promise.resolve("located/file.json")),
  openProject: mock(() => Promise.resolve({ config: { name: "P" }, handle: { root: "." } })),
  createProject: mock(() => Promise.resolve({ config: { name: "New" }, root: "/new" })),
  setDirectoryDialog: mock(() => {}),
  setFileDialog: mock(() => {}),
  setProjectRoot: mock(() => {}),
};

const gitMocks = {
  gitAddRemote: mock(() => Promise.resolve()),
  gitBranches: mock(() => Promise.resolve({ branches: ["main"], current: "main" })),
  gitCheckout: mock(() => Promise.resolve()),
  gitCommit: mock(() => Promise.resolve()),
  gitCreateBranch: mock(() => Promise.resolve()),
  gitDiff: mock(() => Promise.resolve("diff --git a/x")),
  gitDiscard: mock(() => Promise.resolve()),
  // Rejects with a non-Error value to exercise the String(error) branch
  // oxlint-disable-next-line prefer-promise-reject-errors -- deliberate non-Error rejection
  gitFetch: mock(() => Promise.reject("fetch-blew-up")),
  gitInit: mock(() => Promise.resolve()),
  gitLog: mock(() => Promise.resolve([{ hash: "abc", message: "init" }])),
  // Rejects with an Error to exercise the error.message branch
  gitPull: mock(() => Promise.reject(new Error("pull failed"))),
  gitPush: mock(() => Promise.resolve()),
  gitStage: mock(() => Promise.resolve()),
  gitStatus: mock(() => Promise.resolve({ branch: "main", files: [] })),
  gitUnstage: mock(() => Promise.resolve()),
};

const packageMocks = {
  addPackage: mock(() => Promise.resolve({ added: true })),
  dependenciesNeedInstall: mock(() => Promise.resolve(true)),
  installDependencies: mock(() => Promise.resolve({ ok: true })),
  listPackages: mock(() => Promise.resolve([{ name: "left-pad" }])),
  outdatedPackages: mock(() => Promise.resolve([])),
  removePackage: mock(() => Promise.resolve({ removed: true })),
  setPackageVersions: mock(() => Promise.resolve({ ok: true })),
};

const openFileDialogMock = mock(() => Promise.resolve("/picked/project.json"));

const readRecentsMock = mock(() =>
  Promise.resolve([{ name: "Recent", root: "/abs/recent", timestamp: 1 }]),
);
const writeRecentsMock = mock(() => Promise.resolve());

void mock.module("../src/handlers", () => handlerMocks);
void mock.module("../src/git", () => gitMocks);
void mock.module("../src/packages", () => packageMocks);
const openDirectoryDialogMock = mock(async () => null);
void mock.module("../src/chromium/utils", () => ({
  openDirectoryDialog: openDirectoryDialogMock,
  openFileDialog: openFileDialogMock,
}));
void mock.module("../src/recent-store", () => ({
  readRecents: readRecentsMock,
  writeRecents: writeRecentsMock,
}));

// ─── Fake chromium child process ────────────────────────────────────────────

class FakeChrome {
  kill = mock(() => true);
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}
const fakeChrome = new FakeChrome();
const spawnCalls: { bin: string; args: string[] }[] = [];
const spawnMock = mock((bin: string, args: string[], _opts: unknown) => {
  spawnCalls.push({ args, bin });
  return fakeChrome;
});
void mock.module("node:child_process", () => ({ spawn: spawnMock }));

// ─── Environment + globals for the import-time side effects ────────────────

process.argv[2] = FIXTURES;
process.env.JX_STUDIO_ASSETS = STUDIO_ASSETS;
process.env.CHROMIUM_BIN = "sh";
process.env.WAYLAND_DISPLAY ||= "wayland-test";

const exitCalls: number[] = [];
const realExit = process.exit;
process.exit = ((code?: number) => {
  exitCalls.push(code ?? 0);
}) as unknown as typeof process.exit;

const sigintBefore = new Set(process.listeners("SIGINT"));
const sigtermBefore = new Set(process.listeners("SIGTERM"));

const realServe = Bun.serve.bind(Bun);
let server: ReturnType<typeof Bun.serve> | undefined;
(Bun as unknown as { serve: (opts: unknown) => unknown }).serve = (opts: unknown) => {
  server = realServe(opts as Parameters<typeof Bun.serve>[0]);
  return server;
};

// Resolve CHROMIUM_BIN deterministically: the real Bun.which returns null in a stock Windows shell
// (no `sh` on PATH), which would send the launcher down its "no chromium found" exit path instead.
const realWhich = Bun.which.bind(Bun);
(Bun as unknown as { which: (cmd: string) => string | null }).which = (cmd: string) =>
  cmd === "sh" ? "/usr/bin/sh" : null;

const logs: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  logs.push(args.map(String).join(" "));
};

await import("../src/chromium/index");

console.log = realLog;
(Bun as unknown as { serve: typeof Bun.serve }).serve = realServe;
(Bun as unknown as { which: typeof Bun.which }).which = realWhich;

const sigintHandlers = process
  .listeners("SIGINT")
  .filter((listener) => !sigintBefore.has(listener));
const sigtermHandlers = process
  .listeners("SIGTERM")
  .filter((listener) => !sigtermBefore.has(listener));

// The factory binds 127.0.0.1; localhost is a loopback alias the test client can also use.
const baseUrl = `http://127.0.0.1:${server!.port}`;

// Extract the rpc token the launcher threaded into the --app URL (?token=…). The privileged routes
// And the WS upgrade are gated on it.
const appArg = spawnCalls[0]!.args[0]!;
const rpcToken = new URL(appArg.replace(/^--app=/, "")).searchParams.get("token")!;

afterAll(() => {
  process.exit = realExit;
  for (const listener of sigintHandlers) {
    process.removeListener("SIGINT", listener);
  }
  for (const listener of sigtermHandlers) {
    process.removeListener("SIGTERM", listener);
  }
  void server?.stop(true);
  rmSync(FIXTURES, { force: true, recursive: true });
});

// ─── WebSocket RPC helper ───────────────────────────────────────────────────

let ws: WebSocket;

function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1_000_000);
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.id !== id) {
        return;
      }
      ws.removeEventListener("message", handler);
      if (msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(msg.result);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

beforeAll(async () => {
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/?token=${rpcToken}`);
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", reject);
  });
});

afterAll(() => {
  ws?.close();
});

// ─── Startup behavior ───────────────────────────────────────────────────────

describe("chromium launcher startup", () => {
  test("registers project root and file dialog with the handlers module", () => {
    expect(handlerMocks.setProjectRoot).toHaveBeenCalledWith(FIXTURES);
    expect(handlerMocks.setFileDialog).toHaveBeenCalledWith(openFileDialogMock);
  });

  test("logs the loopback server URL and project root", () => {
    expect(logs.some((line) => line.includes(`Studio server at ${baseUrl}`))).toBe(true);
    expect(logs.some((line) => line.includes("Studio server at http://127.0.0.1:"))).toBe(true);
    expect(logs.some((line) => line.includes(`Project root: ${FIXTURES}`))).toBe(true);
  });

  test("spawns the resolved chromium binary in app mode under /__studio__/ with the token", () => {
    expect(spawnCalls).toHaveLength(1);
    const [{ args, bin }] = spawnCalls;
    expect(bin.endsWith("/sh")).toBe(true);
    expect(args[0]).toBe(`--app=${baseUrl}/__studio__/index.html?token=${rpcToken}`);
    expect(args[0]).toContain("127.0.0.1");
    expect(args).toContain("--no-first-run");
    // The profile dir is built with path.resolve, so the separator is OS-native (\ on Windows).
    expect(args.some((a) => a.includes(join(".jx", "chromium-profile")))).toBe(true);
  });

  test("adds wayland flags when WAYLAND_DISPLAY is set", () => {
    const [{ args }] = spawnCalls;
    expect(args).toContain("--ozone-platform=wayland");
    expect(args).toContain("--enable-features=UseOzonePlatform");
  });
});

// ─── WebSocket RPC dispatch ─────────────────────────────────────────────────

describe("chromium launcher RPC dispatch", () => {
  test("readFile dispatches to handleReadFile with params", async () => {
    const result = await rpc("readFile", { path: "hello.txt" });
    expect(result).toBe("read:hello.txt");
    expect(handlerMocks.handleReadFile).toHaveBeenCalledWith({ path: "hello.txt" });
  });

  test("void handlers resolve with null (?? null normalization)", async () => {
    expect(await rpc("writeFile", { content: "x", path: "a.txt" })).toBeNull();
    expect(await rpc("deleteFile", { path: "a.txt" })).toBeNull();
    expect(await rpc("renameFile", { from: "a", to: "b" })).toBeNull();
    expect(await rpc("createDirectory", { path: "dir" })).toBeNull();
    expect(await rpc("uploadFile", { data: "aGk=", path: "u.bin" })).toBeNull();
    expect(handlerMocks.handleWriteFile).toHaveBeenCalledWith({ content: "x", path: "a.txt" });
    expect(handlerMocks.handleRenameFile).toHaveBeenCalledWith({ from: "a", to: "b" });
  });

  test("file and project queries return handler results", async () => {
    expect(await rpc("listDirectory", { dir: "." })).toEqual([{ name: "hello.txt", type: "file" }]);
    expect(await rpc("discoverComponents", { dir: "." })).toEqual([
      { path: "btn.json", tagName: "my-btn" },
    ]);
    expect(await rpc("locateFile", { name: "file.json" })).toBe("located/file.json");
    expect(await rpc("openProject")).toEqual({ config: { name: "P" }, handle: { root: "." } });
    expect(await rpc("resolveSiteContext", { filePath: "x.json" })).toEqual({ sitePath: "." });
    expect(await rpc("fetchPluginSchema", { src: "./P.ts" })).toEqual({ type: "object" });
    expect(await rpc("codeService", { action: "lint" })).toEqual({
      echoed: { action: "lint" },
    });
    expect(await rpc("listFormats")).toEqual([{ format: "markdown" }]);
    expect(await rpc("formatAction", { action: "parse", format: "markdown" })).toEqual({
      doc: { ok: true },
    });
    expect(handlerMocks.formatAction).toHaveBeenCalledWith({
      action: "parse",
      format: "markdown",
    });
  });

  test("getProjectRoot wraps the handler value in { root }", async () => {
    expect(await rpc("getProjectRoot")).toEqual({ root: projectRootValue });
  });

  test("createProject dispatches to the createProject handler", async () => {
    const result = await rpc("createProject", { directory: "n", name: "New" });
    expect(result).toEqual({ config: { name: "New" }, root: "/new" });
    expect(handlerMocks.createProject).toHaveBeenCalledWith({ directory: "n", name: "New" });
  });

  test("listStarters dispatches to the real starter registry", async () => {
    const result = (await rpc("listStarters")) as { id: string }[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.some((s) => s.id === "restaurant")).toBe(true);
  });

  test("jxResolve / jxServerFunction WS methods dispatch to the handlers", async () => {
    expect(await rpc("jxResolve", { body: '{"a":1}' })).toEqual({
      body: JSON.stringify({ resolved: '{"a":1}' }),
      status: 200,
    });
    expect(handlerMocks.jxResolve).toHaveBeenCalledWith({ body: '{"a":1}' });
    expect(await rpc("jxServerFunction", { body: '{"x":2}' })).toEqual({
      body: JSON.stringify({ server: '{"x":2}' }),
      status: 200,
    });
    expect(handlerMocks.jxServerFunction).toHaveBeenCalledWith({ body: '{"x":2}' });
  });

  test("setWindowProject rebinds the root in place and reports no dedup", async () => {
    expect(await rpc("setWindowProject", { root: "/abs/switch" })).toEqual({
      config: null,
      deduped: false,
    });
    expect(handlerMocks.setProjectRoot).toHaveBeenCalledWith("/abs/switch");
  });

  test("recent-projects handlers read from and write to the store", async () => {
    expect(await rpc("getRecentProjects")).toEqual([
      { name: "Recent", root: "/abs/recent", timestamp: 1 },
    ]);
    const projects = [{ name: "Saved", root: "/abs/saved", timestamp: 2 }];
    await rpc("saveRecentProjects", { projects });
    expect(writeRecentsMock).toHaveBeenCalledWith(projects);
  });

  test("git query methods return results", async () => {
    expect(await rpc("gitStatus")).toEqual({ branch: "main", files: [] });
    expect(await rpc("gitBranches")).toEqual({ branches: ["main"], current: "main" });
    expect(await rpc("gitLog", { limit: 5 })).toEqual([{ hash: "abc", message: "init" }]);
    expect(gitMocks.gitLog).toHaveBeenCalledWith({ limit: 5 });
    expect(await rpc("gitDiff", { path: "x" })).toBe("diff --git a/x");
  });

  test("git mutation methods dispatch with params and resolve null", async () => {
    expect(await rpc("gitStage", { files: ["a"] })).toBeNull();
    expect(await rpc("gitUnstage", { files: ["a"] })).toBeNull();
    expect(await rpc("gitCommit", { message: "msg" })).toBeNull();
    expect(await rpc("gitPush", { setUpstream: true })).toBeNull();
    expect(await rpc("gitCheckout", { branch: "dev" })).toBeNull();
    expect(await rpc("gitCreateBranch", { name: "feat" })).toBeNull();
    expect(await rpc("gitDiscard", { files: ["a"] })).toBeNull();
    expect(await rpc("gitInit")).toBeNull();
    expect(await rpc("gitAddRemote", { name: "origin", url: "git@host:r.git" })).toBeNull();
    expect(gitMocks.gitCommit).toHaveBeenCalledWith({ message: "msg" });
    expect(gitMocks.gitPush).toHaveBeenCalledWith({ setUpstream: true });
    expect(gitMocks.gitAddRemote).toHaveBeenCalledWith({ name: "origin", url: "git@host:r.git" });
  });

  test("package methods dispatch to the packages module", async () => {
    expect(await rpc("addPackage", { name: "left-pad" })).toEqual({ added: true });
    expect(await rpc("removePackage", { name: "left-pad" })).toEqual({ removed: true });
    expect(await rpc("listPackages")).toEqual([{ name: "left-pad" }]);
    expect(packageMocks.addPackage).toHaveBeenCalledWith({ name: "left-pad" });
  });

  test("dependency-management methods dispatch to the packages module", async () => {
    expect(await rpc("installDependencies")).toEqual({ ok: true });
    expect(await rpc("dependenciesNeedInstall")).toBe(true);
    expect(await rpc("outdatedPackages")).toEqual([]);
    const updates = [{ name: "@jxsuite/runtime", version: "^0.30.1" }];
    expect(await rpc("setPackageVersions", { updates })).toEqual({ ok: true });
    expect(packageMocks.setPackageVersions).toHaveBeenCalledWith({ updates });
  });

  test("Error rejections are reported via error.message", async () => {
    await expect(rpc("gitPull")).rejects.toThrow("pull failed");
  });

  test("non-Error rejections are stringified", async () => {
    await expect(rpc("gitFetch")).rejects.toThrow("fetch-blew-up");
  });

  test("unknown methods get an error response", async () => {
    await expect(rpc("definitelyNotAMethod")).rejects.toThrow(
      "Unknown method: definitelyNotAMethod",
    );
  });

  test("invalid JSON gets an error response with id 0", async () => {
    const response = await new Promise<{ id: number; error?: string }>((resolve) => {
      const handler = (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string);
        if (msg.id !== 0) {
          return;
        }
        ws.removeEventListener("message", handler);
        resolve(msg);
      };
      ws.addEventListener("message", handler);
      ws.send("{{{not json");
    });
    expect(response.error).toBe("Invalid JSON");
  });
});

// ─── HTTP static serving ────────────────────────────────────────────────────

describe("chromium launcher HTTP server", () => {
  test("serves studio assets under /__studio__/ with Referrer-Policy same-origin", async () => {
    // Same-origin (not no-referrer): the studio shell's asset fetches must carry a referrer so the
    // Server-side referrer checks pass — see @jxsuite/server commit bdbb33a6.
    const res = await fetch(`${baseUrl}/__studio__/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("studio-shell");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  test("serves the iframe canvas doc + bundle under /__studio__/", async () => {
    // The canvas iframe boots from /__studio__/canvas.html (see chromium/platform.ts canvasUrl);
    // A missing file here is the packaged-app "Not found" iframe regression.
    const doc = await fetch(`${baseUrl}/__studio__/canvas.html`);
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain("jx-canvas-root");
    const entry = await fetch(`${baseUrl}/__studio__/dist/iframe-entry.js`);
    expect(entry.status).toBe(200);
  });

  test("studio-asset over-encoded traversal out of studioDir is 404", async () => {
    // A single fetch/URL parse collapses real "../"; an over-encoded %252e survives one decode as
    // %2e and is rejected by the server's over-encoding guard.
    const res = await fetch(`${baseUrl}/__studio__/%252e%252e/hello.txt`);
    expect(res.status).toBe(404);
  });

  test("POST /__jx_resolve__ with the token dispatches to handleResolve", async () => {
    const res = await fetch(`${baseUrl}/__jx_resolve__?token=${rpcToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ $prototype: "Sum", $src: "./Sum.class.json", a: 2, b: 3 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(5);
  });

  test("POST /__jx_resolve__ without the token is 403", async () => {
    const res = await fetch(`${baseUrl}/__jx_resolve__`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ $src: "./Sum.class.json" }),
    });
    expect(res.status).toBe(403);
  });

  test("serves absolute paths under the project root", async () => {
    const res = await fetch(`${baseUrl}${toUrlPath(FIXTURES)}/hello.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Hello Index");
  });

  test("falls through when an absolute path under the root does not exist", async () => {
    const res = await fetch(`${baseUrl}${toUrlPath(FIXTURES)}/missing-abs.txt`);
    expect(res.status).toBe(404);
  });

  test("serves relative paths from the project root", async () => {
    const res = await fetch(`${baseUrl}/hello.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Hello Index");
  });

  test("serves files from the public/ subdirectory", async () => {
    const res = await fetch(`${baseUrl}/pub.css`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("margin: 0");
  });

  test("over-encoded ../ traversal of a project file is 404", async () => {
    const res = await fetch(`${baseUrl}/%252e%252e/hello.txt`);
    expect(res.status).toBe(404);
  });

  test("an absolute path outside the project root is 404", async () => {
    // The tests directory sits outside FIXTURES (the project root). An absolute request for a file
    // That really exists there must not be served — containment is by root, not by existence.
    const res = await fetch(`${baseUrl}${toUrlPath(import.meta.dir)}/chromium-index.test.ts`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for missing files", async () => {
    const res = await fetch(`${baseUrl}/definitely-missing.xyz`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for everything when no project root is set", async () => {
    projectRootValue = "";
    try {
      const res = await fetch(`${baseUrl}/hello.txt`);
      expect(res.status).toBe(404);
    } finally {
      projectRootValue = FIXTURES;
    }
  });
});

// ─── Process lifecycle ──────────────────────────────────────────────────────

describe("chromium launcher lifecycle", () => {
  test("SIGINT kills chromium and exits", () => {
    expect(sigintHandlers).toHaveLength(1);
    const before = fakeChrome.kill.mock.calls.length;
    (sigintHandlers[0] as () => void)();
    expect(fakeChrome.kill.mock.calls.length).toBe(before + 1);
    expect(exitCalls).toContain(0);
  });

  test("SIGTERM kills chromium and exits", () => {
    expect(sigtermHandlers).toHaveLength(1);
    const before = fakeChrome.kill.mock.calls.length;
    (sigtermHandlers[0] as () => void)();
    expect(fakeChrome.kill.mock.calls.length).toBe(before + 1);
  });

  test("browser close logs the exit code and exits the launcher", () => {
    const exitsBefore = exitCalls.length;
    const captured: string[] = [];
    const saved = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      fakeChrome.emit("close", 7);
    } finally {
      console.log = saved;
    }
    expect(captured.some((line) => line.includes("Browser closed (code 7)"))).toBe(true);
    expect(exitCalls.length).toBe(exitsBefore + 1);
  });
});
