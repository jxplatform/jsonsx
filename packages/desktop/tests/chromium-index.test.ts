// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { CHROMIUM_RPC_EXEMPT, rpcParity } from "./_rpc-parity";

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
// A directory that is a project, and one that merely is a directory (what `$HOME` looks like).
mkdirSync(join(FIXTURES, "implicit-project"), { recursive: true });
mkdirSync(join(FIXTURES, "implicit-not-a-project"), { recursive: true });
writeFileSync(join(FIXTURES, "implicit-project", "project.json"), '{"name":"implicit"}');
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
  // `Build Site` compiles; `View: Open in Browser` reaches previewSite instead.
  buildSite: mock(() => Promise.resolve({ errors: [], files: 0, routes: 0 })),
  clearPreviewOverlay: mock(() => {}),
  /* The live preview: no build, and `reused` says whether the project's open tab took the route
     rather than a new one being opened for it. */
  previewSite: mock(() =>
    Promise.resolve({
      errors: [],
      files: 0,
      mode: "live",
      reused: false,
      routes: 2,
      url: "http://127.0.0.1:41234",
    }),
  ),
  setPreviewOverlay: mock(() => {}),
  codeService: mock((params: unknown) => Promise.resolve({ echoed: params })),
  // Data surface + secrets (desktop twins of /__studio/data/* + /__studio/secrets)
  dataConnections: mock(() => Promise.resolve({ connections: [] })),
  dataConnectionTest: mock(() => Promise.resolve({ ok: true })),
  dataPush: mock(() => Promise.resolve({ applied: false, plan: [] })),
  dataRows: mock(() => Promise.resolve({ columns: [], rows: [], total: 0 })),
  dataInsertRow: mock(() => Promise.resolve({ row: { id: "new" } })),
  dataUpdateRow: mock(() => Promise.resolve({ row: { id: "new" } })),
  dataDeleteRow: mock(() => Promise.resolve({ ok: true })),
  listSecrets: mock(() => Promise.resolve({ names: ["SEEDED"] })),
  setSecrets: mock(() => Promise.resolve({ names: ["SEEDED"], ok: true })),
  discoverComponents: mock(() => Promise.resolve([{ path: "btn.json", tagName: "my-btn" }])),
  fetchPluginSchema: mock(() => Promise.resolve({ type: "object" })),
  findReferences: mock(() =>
    Promise.resolve({
      errors: [],
      files: [{ count: 2, path: "pages/index.json", refs: [] }],
      filesReferencing: 1,
      path: "components/Card.json",
      refsTotal: 2,
      tagName: "my-card",
    }),
  ),
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
  fetchProjectSchemas: mock(() => Promise.resolve({ project: { type: "object" } })),
  listDirectory: mock(() => Promise.resolve([{ name: "hello.txt", type: "file" }])),
  listExtensionCatalog: mock(() =>
    Promise.resolve([{ name: "@jxsuite/feed", sections: [], source: "first-party" }]),
  ),
  listExtensions: mock(() => Promise.resolve([{ specifier: "@jxsuite/parser" }])),
  listFormats: mock(() => Promise.resolve([{ format: "markdown" }])),
  locateFile: mock(() => Promise.resolve("located/file.json")),
  searchFiles: mock(() =>
    Promise.resolve([{ name: "a.json", path: "pages/a.json", type: "file" }]),
  ),
  openExternal: mock(({ url }: { url: string }) => ({ ok: url.startsWith("http") })),
  openProject: mock(() => Promise.resolve({ config: { name: "P" }, handle: { root: "." } })),
  createProject: mock(() => Promise.resolve({ config: { name: "New" }, root: "/new" })),
  /* The picker WITHOUT the binding — the New Window branch of Open Project. Typed to the real
     signature rather than inferred from this one answer: a cancel resolves null, and a stand-in
     that cannot express it cannot stand in for the case that matters most. */
  pickProjectFile: mock(
    (): Promise<{ config: { name: string }; name: string; root: string } | null> =>
      Promise.resolve({ config: { name: "Picked" }, name: "Picked", root: "/picked/project" }),
  ),
  setDirectoryDialog: mock(() => {}),
  setFileDialog: mock(() => {}),
  /* Registering a sink starts the watcher; the launcher points it at the project server's push
     channel, so the test can drive a filesystem event straight into the wire. */
  setFileEventSink: mock((sink: ((events: unknown[]) => void) | null) => {
    fileEventSink = sink;
  }),
  setProjectRoot: mock(() => {}),
};

let fileEventSink: ((events: unknown[]) => void) | null = null;

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
  gitShow: mock(() => Promise.resolve("{\n  old: true\n}")),
  gitStage: mock(() => Promise.resolve()),
  gitStatus: mock(() => Promise.resolve({ branch: "main", files: [] })),
  gitUnstage: mock(() => Promise.resolve()),
};

const packageMocks = {
  addPackage: mock(() => Promise.resolve({ added: true })),
  dependenciesNeedInstall: mock(() => Promise.resolve(true)),
  installDependencies: mock(() => Promise.resolve({ ok: true })),
  listPackages: mock(() => Promise.resolve([{ name: "left-pad" }])),
  packageVersions: mock(() => Promise.resolve([])),
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

const readSettingsMock = mock(() => Promise.resolve({ aiApiKey: "sk-abc" }));
const patchSettingsMock = mock(() => Promise.resolve({ aiApiKey: "sk-new" }));
const watchSettingsMock = mock((_onChange: (s: Record<string, string>) => void) => () => {});
void mock.module("../src/settings-store", () => ({
  readSettings: readSettingsMock,
  patchSettings: patchSettingsMock,
  /* The launcher starts the store's watch so a change in one window reaches the others. */
  watchSettings: watchSettingsMock,
}));

/*
 * GitHub sign-in. Mocked at the module boundary because the real one opens a browser and talks to
 * GitHub; what this file tests is that the launcher wires the three requests to it at all.
 */
const githubSignInMock = mock(async (params: { force?: boolean }) => ({
  token: params.force ? "gho_fresh" : "gho_stored",
}));
const githubSignOutMock = mock(async () => ({ ok: true }));
const githubTokenMock = mock(async () => ({ stored: true }));
const setAuthorizationHostMock = mock((_host: unknown) => {});
void mock.module("../src/github-signin", () => ({
  githubSignIn: githubSignInMock,
  githubSignOut: githubSignOutMock,
  githubTokenStatus: githubTokenMock,
  setAuthorizationHost: setAuthorizationHostMock,
}));

// The import pipeline itself is exercised in @jxsuite/import; here only the route wiring matters.
const importSiteMock = mock((options: Record<string, unknown>) => {
  const outDir = options.outDir as string;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "project.json"), JSON.stringify({ name: "Imported" }));
  return Promise.resolve({ outDir, pages: [], fileCount: 1, verify: null, warnings: [] });
});
void mock.module("@jxsuite/import/run", () => ({ importSite: importSiteMock }));

// ─── Fake chromium child process ────────────────────────────────────────────

class FakeChrome {
  kill = mock(() => true);
  /* Child launchers (the windows this one opens) are detached and unreferenced so that closing the
     window which opened another does not close the other. */
  unref = mock(() => {});
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
const spawnCalls: { bin: string; args: string[]; opts: SpawnOpts }[] = [];
interface SpawnOpts {
  detached?: boolean;
  env?: Record<string, string>;
  stdio?: string;
}
const spawnMock = mock((bin: string, args: string[], opts: SpawnOpts) => {
  spawnCalls.push({ args, bin, opts });
  return fakeChrome;
});
void mock.module("node:child_process", () => ({ spawn: spawnMock }));

// ─── Environment + globals for the import-time side effects ────────────────

process.argv[2] = FIXTURES;
process.env.JX_STUDIO_ASSETS = STUDIO_ASSETS;
process.env.CHROMIUM_BIN = "sh";
process.env.WAYLAND_DISPLAY ||= "wayland-test";
/* The window registry is a real directory of real files shared by every launcher on the machine.
   Point it at the fixtures so a test run neither reads the developer's open windows (which would
   make the launcher's "already open — raising it" boot path fire against a live editor) nor leaves
   a row behind in them. */
const WINDOWS_DIR = join(FIXTURES, "_windows");
process.env.JX_STUDIO_WINDOWS_DIR = WINDOWS_DIR;
rmSync(WINDOWS_DIR, { force: true, recursive: true });

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

const chromiumIndex = await import("../src/chromium/index");

/* Snapshot the registry row the launcher published at boot. Read HERE, before any test re-roots
   the window, because the row is live state — `setWindowProject` rewrites it by design. */
const bootEntry = JSON.parse(
  readFileSync(join(WINDOWS_DIR, `${process.pid}.json`), "utf8"),
) as Record<string, unknown>;

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

  test("seeds the profile Preferences before spawn so Chromium never offers to save the API key", () => {
    // The credentials form's API-key field is a password input; without these profile prefs
    // Chromium offers to save it to the OS password manager on every save.
    const prefsFile = join(FIXTURES, ".jx", "chromium-profile", "Default", "Preferences");
    const prefs = JSON.parse(readFileSync(prefsFile, "utf8")) as {
      credentials_enable_service: boolean;
      profile: { password_manager_enabled: boolean; password_manager_leak_detection: boolean };
    };
    expect(prefs.credentials_enable_service).toBe(false);
    expect(prefs.profile.password_manager_enabled).toBe(false);
    expect(prefs.profile.password_manager_leak_detection).toBe(false);
  });
});

// ─── Chromium profile Preferences seeding ───────────────────────────────────

describe("seedChromiumPreferences", () => {
  test("merges into an existing Preferences file without clobbering unrelated keys", () => {
    const dir = join(FIXTURES, "_prefs_merge");
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({
        browser: { theme: "dark" },
        credentials_enable_service: true,
        profile: { exit_type: "Normal", password_manager_enabled: true },
      }),
    );
    chromiumIndex.seedChromiumPreferences(dir);
    const prefs = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(prefs.credentials_enable_service).toBe(false);
    expect(prefs.browser).toEqual({ theme: "dark" });
    expect(prefs.profile).toEqual({
      exit_type: "Normal",
      password_manager_enabled: false,
      password_manager_leak_detection: false,
    });
  });

  test("recovers from a corrupt Preferences file with a fresh object", () => {
    const dir = join(FIXTURES, "_prefs_corrupt");
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(join(dir, "Default", "Preferences"), "{not json");
    chromiumIndex.seedChromiumPreferences(dir);
    const prefs = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8"));
    expect(prefs).toEqual({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false, password_manager_leak_detection: false },
    });
  });

  test("replaces a non-object profile value and creates the Default dir when missing", () => {
    const dir = join(FIXTURES, "_prefs_fresh");
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify({ profile: "bogus" }));
    chromiumIndex.seedChromiumPreferences(dir);
    const prefs = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8")) as {
      profile: Record<string, unknown>;
    };
    expect(prefs.profile).toEqual({
      password_manager_enabled: false,
      password_manager_leak_detection: false,
    });

    const bare = join(FIXTURES, "_prefs_bare");
    chromiumIndex.seedChromiumPreferences(bare);
    const seeded = JSON.parse(readFileSync(join(bare, "Default", "Preferences"), "utf8")) as {
      credentials_enable_service: boolean;
    };
    expect(seeded.credentials_enable_service).toBe(false);
  });
});

// ─── Schema ↔ handler parity ────────────────────────────────────────────────

describe("rpc schema parity", () => {
  test("every declared request is handled here or explicitly answered elsewhere", () => {
    const parity = rpcParity(Object.keys(chromiumIndex.handlers), CHROMIUM_RPC_EXEMPT);
    expect(parity.unhandled).toEqual([]);
    expect(parity.undeclared).toEqual([]);
    // The exemptions are claims about this launcher, so they rot in both directions.
    expect(parity.staleExempt).toEqual([]);
    expect(parity.orphanExempt).toEqual([]);
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

  /*
   * The two synchronous entries in a map typed to promises, so the map is where they are adapted.
   * Dispatching them through the socket is what proves the adaptation answers at all — declaring
   * the entry is not calling it, and nothing else here ever did.
   */
  test("the preview overlay methods publish and retract through the socket", async () => {
    const published = await rpc("setPreviewOverlay", {
      contents: '{"tagName":"main"}',
      path: "pages/index.json",
    });
    const retracted = await rpc("clearPreviewOverlay", { path: "pages/index.json" });

    expect(published).toBeNull();
    expect(retracted).toBeNull();
    expect(handlerMocks.setPreviewOverlay).toHaveBeenCalledWith({
      contents: '{"tagName":"main"}',
      path: "pages/index.json",
    });
    expect(handlerMocks.clearPreviewOverlay).toHaveBeenCalledWith({ path: "pages/index.json" });
  });

  test("file and project queries return handler results", async () => {
    expect(await rpc("listDirectory", { dir: "." })).toEqual([{ name: "hello.txt", type: "file" }]);
    expect(await rpc("discoverComponents", { dir: "." })).toEqual([
      { path: "btn.json", tagName: "my-btn" },
    ]);
    expect(await rpc("locateFile", { name: "file.json" })).toBe("located/file.json");
    // Quick Access (⌘P): the format registry's extensions must survive the wire hop.
    expect(await rpc("searchFiles", { extensions: [".md"], query: "abo" })).toEqual([
      { name: "a.json", path: "pages/a.json", type: "file" },
    ]);
    expect(handlerMocks.searchFiles).toHaveBeenCalledWith({ extensions: [".md"], query: "abo" });
    expect(await rpc("openProject")).toEqual({ config: { name: "P" }, handle: { root: "." } });
    // Preview links leave the webview: the Bun side hands the URL to the OS.
    expect(await rpc("openExternal", { url: "https://example.com" })).toEqual({ ok: true });
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

  test("createProject dispatches to the createProject handler with the caller's destination", async () => {
    // The launcher is a pass-through: the destination the modal chose reaches the handler unchanged
    // (the handler, not this route, is what refuses a create without one).
    const params = {
      destination: { kind: "path", parent: "/home/dev/Sites" },
      directory: "n",
      name: "New",
    };
    const result = await rpc("createProject", params);
    expect(result).toEqual({ config: { name: "New" }, root: "/new" });
    expect(handlerMocks.createProject).toHaveBeenCalledWith(params);
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

  test("settings handlers read from and write to the store", async () => {
    expect(await rpc("getSettings")).toEqual({ aiApiKey: "sk-abc" });
    expect(readSettingsMock).toHaveBeenCalled();
    const patch = { remove: ["theme"], set: { aiApiKey: "sk-new" } };
    // A patch answers with the resulting store rather than null.
    expect(await rpc("patchSettings", { patch })).toEqual({ aiApiKey: "sk-new" });
    expect(patchSettingsMock).toHaveBeenCalledWith(patch);
  });

  test("GitHub sign-in handlers reach the loopback flow", async () => {
    expect(await rpc("githubToken")).toEqual({ stored: true });
    expect(await rpc("githubSignIn", { force: true })).toEqual({ token: "gho_fresh" });
    expect(githubSignInMock).toHaveBeenLastCalledWith({ force: true });
    expect(await rpc("githubSignOut")).toEqual({ ok: true });
  });

  test("the loopback server is installed as the OAuth redirect host", () => {
    // Sign-in cannot be wired before the server exists, so this is what proves it was.
    expect(setAuthorizationHostMock).toHaveBeenCalled();
    const host = setAuthorizationHostMock.mock.calls.at(-1)![0] as { port: number };
    expect(typeof host.port).toBe("number");
  });

  test("git query methods return results", async () => {
    expect(await rpc("gitStatus")).toEqual({ branch: "main", files: [] });
    expect(await rpc("gitBranches")).toEqual({ branches: ["main"], current: "main" });
    expect(await rpc("gitLog", { limit: 5 })).toEqual([{ hash: "abc", message: "init" }]);
    expect(gitMocks.gitLog).toHaveBeenCalledWith({ limit: 5 });
    expect(await rpc("gitDiff", { path: "x" })).toBe("diff --git a/x");
    expect(await rpc("gitShow", { path: "x.json", ref: "HEAD" })).toBe("{\n  old: true\n}");
    expect(gitMocks.gitShow).toHaveBeenCalledWith({ path: "x.json", ref: "HEAD" });
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

  test("data surface + secrets methods dispatch with params to their handlers", async () => {
    expect(await rpc("dataConnections")).toEqual({ connections: [] });
    expect(handlerMocks.dataConnections).toHaveBeenCalled();
    expect(await rpc("dataConnectionTest", { connection: "main" })).toEqual({ ok: true });
    expect(handlerMocks.dataConnectionTest).toHaveBeenCalledWith({ connection: "main" });
    expect(await rpc("dataPush", { dryRun: true })).toEqual({ applied: false, plan: [] });
    expect(handlerMocks.dataPush).toHaveBeenCalledWith({ dryRun: true });
    expect(await rpc("dataRows", { table: "posts" })).toEqual({ columns: [], rows: [], total: 0 });
    expect(handlerMocks.dataRows).toHaveBeenCalledWith({ table: "posts" });
    expect(await rpc("dataInsertRow", { table: "posts", values: { title: "hi" } })).toEqual({
      row: { id: "new" },
    });
    expect(handlerMocks.dataInsertRow).toHaveBeenCalledWith({
      table: "posts",
      values: { title: "hi" },
    });
    expect(await rpc("dataUpdateRow", { pk: 1, set: { title: "yo" }, table: "posts" })).toEqual({
      row: { id: "new" },
    });
    expect(handlerMocks.dataUpdateRow).toHaveBeenCalledWith({
      pk: 1,
      set: { title: "yo" },
      table: "posts",
    });
    expect(await rpc("dataDeleteRow", { pk: 1, table: "posts" })).toEqual({ ok: true });
    expect(handlerMocks.dataDeleteRow).toHaveBeenCalledWith({ pk: 1, table: "posts" });
    expect(await rpc("listSecrets")).toEqual({ names: ["SEEDED"] });
    expect(handlerMocks.listSecrets).toHaveBeenCalled();
    expect(await rpc("setSecrets", { remove: ["OLD"], set: { API_KEY: "v" } })).toEqual({
      names: ["SEEDED"],
      ok: true,
    });
    expect(handlerMocks.setSecrets).toHaveBeenCalledWith({
      remove: ["OLD"],
      set: { API_KEY: "v" },
    });
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
    expect(await rpc("packageVersions")).toEqual([]);
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

// ─── AI-guided site import route ─────────────────────────────────────────────

describe("chromium launcher import route", () => {
  test("pickDirectory RPC opens the native directory dialog", async () => {
    const result = await rpc("pickDirectory");
    expect(result).toEqual({ path: null });
    expect(openDirectoryDialogMock).toHaveBeenCalled();
  });

  test("rejects a relative destination directory", async () => {
    const res = await fetch(`${baseUrl}/__studio__/import-site?token=${rpcToken}`, {
      body: JSON.stringify({ directory: "relative/dest", url: "https://clone.example/" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("absolute");
  });

  test("imports into an absolute destination with the launcher's browser binary", async () => {
    const dest = join(FIXTURES, "imported-site");
    const res = await fetch(`${baseUrl}/__studio__/import-site?token=${rpcToken}`, {
      body: JSON.stringify({ directory: dest, url: "https://clone.example/" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.at(-1)?.type).toBe("done");
    expect(lines.at(-1)?.root).toBe(dest);
    // The chromium binary the launcher discovered doubles as puppeteer's browser.
    const opts = importSiteMock.mock.calls.at(-1)?.[0] as { chromePath?: string };
    expect(opts.chromePath).toBe("/usr/bin/sh");
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

// ─── Multi-window ───────────────────────────────────────────────────────────

/*
 * A window on this launcher is a PROCESS, so everything below crosses one: the registry is a real
 * directory, "another window" is a real live pid, and opening one is a real spawn of this same
 * entry point. Mocking the registry would test nothing — its entire purpose is to be readable by a
 * process that shares no memory with this one.
 */

/** A live process to stand in for another window, since only a real pid reads as alive. */
const otherWindow = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], {
  stdio: ["ignore", "ignore", "ignore"],
});

afterAll(() => {
  otherWindow.kill();
});

function registryFile(name: string): string {
  return join(WINDOWS_DIR, name);
}

/** Publish a second live window at `root`, the way another launcher process would. */
function publishOtherWindow(root: string | null) {
  mkdirSync(WINDOWS_DIR, { recursive: true });
  writeFileSync(
    registryFile(`${otherWindow.pid}.json`),
    JSON.stringify({
      name: root ? root.split("/").pop() : null,
      pid: otherWindow.pid,
      profileDir: "/tmp/other-profile",
      root,
      url: "http://127.0.0.1:1",
    }),
  );
}

function clearOtherWindow() {
  rmSync(registryFile(`${otherWindow.pid}.json`), { force: true });
  rmSync(registryFile(`${otherWindow.pid}.focus`), { force: true });
}

/** Resolve with the next server-initiated frame carrying `method`, or reject on timeout. */
function nextPush(method: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`no ${method} push within ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as { method?: string };
      if (msg.method !== method) {
        return;
      }
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(msg as Record<string, unknown>);
    };
    ws.addEventListener("message", handler);
  });
}

describe("window registry", () => {
  test("the launcher publishes itself, so another window can find and dedupe against it", () => {
    expect(bootEntry.pid).toBe(process.pid);
    expect(bootEntry.root).toBe(FIXTURES);
    expect(bootEntry.name).toBe("_fixtures_chromium_index");
    // The row names the origin this window is serving, so the listing is worth reading.
    expect(bootEntry.url).toBe(baseUrl);
    expect(bootEntry.profileDir).toContain(join(".jx", "chromium-profile"));
  });

  test("listOpenWindows enumerates every live window, this one included", async () => {
    publishOtherWindow("/proj/sibling");
    try {
      const windows = (await rpc("listOpenWindows")) as { id: number; projectRoot: string }[];
      expect(windows.map((w) => w.id)).toContain(process.pid);
      expect(windows).toContainEqual({ id: otherWindow.pid, projectRoot: "/proj/sibling" });
    } finally {
      clearOtherWindow();
    }
  });
});

describe("opening projects elsewhere", () => {
  test("pickProject answers WHICH project without re-rooting this window", async () => {
    const before = handlerMocks.setProjectRoot.mock.calls.length;
    await expect(rpc("pickProject")).resolves.toEqual({
      name: "Picked",
      root: "/picked/project",
    });
    // The whole reason this exists beside openProject: picking must not bind.
    expect(handlerMocks.setProjectRoot.mock.calls.length).toBe(before);
  });

  test("a cancelled pick is null, not an error", async () => {
    handlerMocks.pickProjectFile.mockImplementationOnce(() => Promise.resolve(null));
    await expect(rpc("pickProject")).resolves.toBeNull();
  });

  test("openProjectInNewWindow spawns another launcher for the project", async () => {
    const before = spawnCalls.length;
    await expect(rpc("openProjectInNewWindow", { root: "/proj/fresh" })).resolves.toEqual({
      focused: false,
    });
    expect(spawnCalls.length).toBe(before + 1);
    const spawned = spawnCalls.at(-1)!;
    // The child is THIS entry point, given the project as its one positional argument.
    expect(spawned.args[0]).toContain("chromium");
    expect(spawned.args[1]).toBe("/proj/fresh");
    // Its Chromium profile sits beside the project, so that window's layout and open tabs survive
    // A restart — and, because the singleton is keyed on it, so that it gets a browser of its own.
    // Matches projectProfile(), which resolves: on Windows join() leaves the path drive-less.
    expect(spawned.opts.env?.JX_STUDIO_PROFILE_DIR).toBe(
      resolvePath("/proj/fresh", ".jx", "chromium-profile"),
    );
    expect(spawned.opts.env?.JX_STUDIO_NO_PROJECT).toBeUndefined();
    expect(spawned.opts.detached).toBe(true);
    expect(fakeChrome.unref).toHaveBeenCalled();
  });

  test("a project already open elsewhere is RAISED, and says so instead of opening a second one", async () => {
    publishOtherWindow("/proj/already-open");
    try {
      const before = spawnCalls.length;
      await expect(rpc("openProjectInNewWindow", { root: "/proj/already-open" })).resolves.toEqual({
        focused: true,
      });
      expect(spawnCalls.length).toBe(before);
      expect(existsSync(registryFile(`${otherWindow.pid}.focus`))).toBe(true);
    } finally {
      clearOtherWindow();
    }
  });

  test("newWindow spawns a launcher with no project", async () => {
    const before = spawnCalls.length;
    await rpc("newWindow");
    expect(spawnCalls.length).toBe(before + 1);
    const spawned = spawnCalls.at(-1)!;
    // No positional root — and the flag that stops the child adopting this process's cwd.
    expect(spawned.args).toHaveLength(1);
    expect(spawned.opts.env?.JX_STUDIO_NO_PROJECT).toBe("1");
    // A welcome window has no project to key a profile on, so it takes a free numbered slot.
    expect(spawned.opts.env?.JX_STUDIO_PROFILE_DIR).toContain("welcome-");
  });
});

describe("setWindowProject", () => {
  test("re-roots this window and republishes it under the new project", async () => {
    const target = join(FIXTURES, "_rerooted");
    mkdirSync(target, { recursive: true });
    await expect(rpc("setWindowProject", { root: target })).resolves.toEqual({
      config: null,
      deduped: false,
    });
    expect(handlerMocks.setProjectRoot).toHaveBeenLastCalledWith(target);
    const own = JSON.parse(readFileSync(registryFile(`${process.pid}.json`), "utf8")) as {
      root: string;
      name: string;
    };
    expect(own.root).toBe(target);
    expect(own.name).toBe("_rerooted");
  });

  test("refuses to bind a project another window already holds, and raises that one", async () => {
    publishOtherWindow("/proj/taken");
    try {
      const before = handlerMocks.setProjectRoot.mock.calls.length;
      await expect(rpc("setWindowProject", { root: "/proj/taken" })).resolves.toEqual({
        config: null,
        deduped: true,
      });
      expect(handlerMocks.setProjectRoot.mock.calls.length).toBe(before);
      expect(existsSync(registryFile(`${otherWindow.pid}.focus`))).toBe(true);
    } finally {
      clearOtherWindow();
    }
  });
});

// ─── Server-initiated frames ────────────────────────────────────────────────

describe("pushed messages", () => {
  test("filesystem changes reach the shell unasked, which is what keeps the sidebar live", async () => {
    const pushed = nextPush("onFileEvents");
    fileEventSink?.([{ isDir: false, path: "pages/index.json", type: "change" }]);
    await expect(pushed).resolves.toEqual({
      method: "onFileEvents",
      params: { events: [{ isDir: false, path: "pages/index.json", type: "change" }] },
    });
  });

  /**
   * The store's watch is what carries a settings change across processes — every chromium window is
   * its own, with its own browser profile, so nothing in-process can reach the others.
   */
  test("a settings change on disk is pushed to the shell", async () => {
    const [onChange] = watchSettingsMock.mock.calls[0]!;
    const pushed = nextPush("settingsChanged");
    onChange({ "jx.ai.model": "o3" });
    await expect(pushed).resolves.toEqual({
      method: "settingsChanged",
      params: { settings: { "jx.ai.model": "o3" } },
    });
  });

  test("a focus request from another window is relayed to the page, which is what can raise it", async () => {
    const pushed = nextPush("focusWindow");
    mkdirSync(WINDOWS_DIR, { recursive: true });
    writeFileSync(registryFile(`${process.pid}.focus`), "");
    await expect(pushed).resolves.toEqual({ method: "focusWindow" });
    // Consumed, so the window does not keep raising itself forever.
    expect(existsSync(registryFile(`${process.pid}.focus`))).toBe(false);
  });
});

// ─── About screen ───────────────────────────────────────────────────────────

describe("appInfo", () => {
  test("reports the channel and no update status — the packager owns updates here", async () => {
    const info = (await rpc("appInfo")) as { channel: string; updateStatus?: string };
    expect(info.channel).toBe("system");
    expect(info.updateStatus).toBeUndefined();
  });
});

// ─── The working directory as a project root ────────────────────────────────

describe("implicitProjectRoot", () => {
  test("adopts the working directory when it holds a project.json", () => {
    // The workflow the fallback exists for: `jx-studio` typed inside a project opens it.
    expect(chromiumIndex.implicitProjectRoot(join(FIXTURES, "implicit-project"))).toBe(
      join(FIXTURES, "implicit-project"),
    );
  });

  test("refuses a working directory that is not a project", () => {
    // The regression: launched from a desktop entry or a shell sitting in $HOME, the old
    // Unconditional fallback made the home directory the project root and the session watched all
    // Of it — while the window showed the welcome screen, because nothing there was a project.
    expect(chromiumIndex.implicitProjectRoot(join(FIXTURES, "implicit-not-a-project"))).toBeNull();
  });
});

// ─── Second launcher for an already-open project ────────────────────────────

describe("raiseExistingWindow", () => {
  test("raises the window that holds the project instead of opening a second one", () => {
    publishOtherWindow("/proj/held");
    try {
      expect(chromiumIndex.raiseExistingWindow("/proj/held")).toBe(true);
      expect(existsSync(registryFile(`${otherWindow.pid}.focus`))).toBe(true);
    } finally {
      clearOtherWindow();
    }
  });

  test("a project nobody holds opens here", () => {
    expect(chromiumIndex.raiseExistingWindow("/proj/nobody-has-this")).toBe(false);
  });

  test("a welcome window has no project to dedupe on", () => {
    expect(chromiumIndex.raiseExistingWindow(null)).toBe(false);
  });
});

// ─── Leaving the registry ───────────────────────────────────────────────────
// Last in the file on purpose: it removes this window's row, which everything above reads.

describe("releaseWindow", () => {
  test("removes this window's row, once, however the process is ending", () => {
    expect(existsSync(registryFile(`${process.pid}.json`))).toBe(true);
    chromiumIndex.releaseWindow();
    expect(existsSync(registryFile(`${process.pid}.json`))).toBe(false);
    // Idempotent: `exit` fires after a SIGINT handler has already torn things down.
    expect(() => chromiumIndex.releaseWindow()).not.toThrow();
  });
});
