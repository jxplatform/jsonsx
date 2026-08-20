import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rpcParity } from "./_rpc-parity";

// ─── Mock electrobun/main ───────────────────────────────────────────────────

/*
 * The window's RPC handler map, typed as the handlers actually are.
 *
 * The parameter is an open bag, not `never`. `p?: never` admits no argument at all, so every
 * parameterised call in this file had to write `as never` — forty-five casts that documented
 * nothing and defeated the check on each one — and a handler that genuinely takes an argument
 * (`githubSignIn({ force })`) still could not be called, because `as never` cannot conjure a
 * parameter the signature does not have.
 *
 * The return stays `unknown` on purpose: this map holds a MIX of sync and async handlers
 * (`getCanvasUrl` returns a value, `pickProject` returns a promise), so promising a `Promise` here
 * would be as wrong in the other direction. Call sites await.
 */
interface RpcConfig {
  handlers: { requests: Record<string, (params?: Record<string, unknown>) => unknown> };
}
const rpcConfigs: RpcConfig[] = [];
const rpcObjects: {
  send: { updateReady: ReturnType<typeof mock>; onFileEvents: ReturnType<typeof mock> };
}[] = [];
const createdWindows: MockWindow[] = [];
let nextWinId = 1;

class MockWindow {
  id: number;
  opts: Record<string, unknown>;
  close = mock(() => {});
  minimize = mock(() => {});
  activate = mock(() => {});
  setTitle = mock((_t: string) => {});
  setFrame = mock((_x: number, _y: number, _w: number, _h: number) => {});
  getFrame = mock(() => ({ height: 10, width: 20, x: 1, y: 2 }));
  _closeHandler: (() => void) | null = null;
  constructor(opts: Record<string, unknown>) {
    this.id = nextWinId;
    nextWinId += 1;
    this.opts = opts;
    createdWindows.push(this);
  }
  on(name: string, handler: () => void) {
    if (name === "close") {
      this._closeHandler = handler;
    }
  }
}

void mock.module("electrobun/main", () => ({
  BrowserView: {
    defineRPC: (config: RpcConfig) => {
      rpcConfigs.push(config);
      const rpc = {
        send: {
          onFileEvents: mock((_p: { events: unknown[] }) => {}),
          updateReady: mock((_p: { version: string }) => {}),
        },
      };
      rpcObjects.push(rpc);
      return rpc;
    },
  },
  BrowserWindow: MockWindow,
  Screen: {
    getPrimaryDisplay: () => ({ workArea: { height: 1080, width: 1920, x: 5, y: 6 } }),
  },
}));

// ─── Mock project-session ────────────────────────────────────────────────────

function makeSession(initialRoot: string | null) {
  let root = initialRoot;
  const s = {
    get projectRoot() {
      return root;
    },
    setProjectRoot: mock((r: string | null) => {
      root = r;
    }),
    setFileEventSink: mock((_sink: unknown) => {}),
    dispose: mock(() => {}),
    handleReadFile: mock(async (_p: { path: string }) => '{"name":"Proj"}'),
    handleWriteFile: mock(async () => {}),
    handleDeleteFile: mock(async () => {}),
    handleRenameFile: mock(async () => {}),
    findReferences: mock(async () => ({
      errors: [],
      files: [],
      filesReferencing: 0,
      path: null,
      refsTotal: 0,
      tagName: null,
    })),
    handleCreateDirectory: mock(async () => {}),
    handleUploadFile: mock(async () => {}),
    handleResolveSiteContext: mock(async () => ({ sitePath: null })),
    listDirectory: mock(async () => []),
    discoverComponents: mock(async () => []),
    codeService: mock(async () => null),
    locateFile: mock(async () => null),
    searchFiles: mock(async () => [{ name: "a.json", path: "pages/a.json", type: "file" }]),
    openExternal: mock(async () => ({ ok: true })),
    fetchPluginSchema: mock(async () => null),
    jxResolve: mock(async () => ({ body: "{}", status: 200 })),
    jxServerFunction: mock(async () => ({ body: "{}", status: 200 })),
    listFormats: mock(async () => []),
    buildSite: mock(async () => ({
      errors: [],
      files: 2,
      routes: 1,
      url: "http://127.0.0.1:4321",
    })),
    formatAction: mock(async () => ({})),
    // Data surface + secrets (desktop twins of /__studio/data/* + /__studio/secrets)
    dataConnections: mock(async () => ({ connections: [] })),
    dataConnectionTest: mock(async () => ({ ok: true })),
    dataPush: mock(async () => ({ applied: false, plan: [] })),
    dataRows: mock(async () => ({ columns: [], rows: [], total: 0 })),
    dataInsertRow: mock(async () => ({ row: { id: "n" } })),
    dataUpdateRow: mock(async () => ({ row: { id: "n" } })),
    dataDeleteRow: mock(async () => ({ ok: true })),
    listSecrets: mock(async () => ({ names: [] })),
    setSecrets: mock(async () => ({ names: [], ok: true })),
    pickDirectory: mock(async () => "/picked"),
    openProject: mock(async () => {
      root = "/proj/opened";
      return {
        config: { name: "Proj" },
        handle: { name: "Proj", projectConfig: {}, root: "." },
      };
    }),
    // Mirrors the real session: the project lands under the destination the caller chose, never
    // Under a folder the backend picked for itself.
    createProject: mock(async (opts: { destination: { parent: string }; directory: string }) => {
      root = `${opts.destination.parent}/${opts.directory}`;
      return { config: { name: "New" }, root };
    }),
  };
  return s;
}
const sessions: ReturnType<typeof makeSession>[] = [];
const createProjectSession = mock((root: string | null) => {
  const s = makeSession(root);
  sessions.push(s);
  return s;
});
/** The session-free picker: answers "which project" and binds nothing. Null models a cancel. */
let pickedProject: { root: string; name: string; config: { name: string } } | null = {
  config: { name: "Picked" },
  name: "Picked",
  root: "/proj/picked",
};
const pickProjectFile = mock(async () => pickedProject);
void mock.module("../src/project-session", () => ({
  createProjectSession,
  pickProjectFile,
  setFileDialog: mock(() => {}),
}));

// ─── Mock git / packages factories ───────────────────────────────────────────

const gitInstances: Record<string, ReturnType<typeof mock>>[] = [];
const createGitOps = mock(() => {
  const g = Object.fromEntries(
    [
      "gitStatus",
      "gitBranches",
      "gitLog",
      "gitStage",
      "gitUnstage",
      "gitCommit",
      "gitPush",
      "gitPull",
      "gitFetch",
      "gitCheckout",
      "gitCreateBranch",
      "gitDiff",
      "gitShow",
      "gitDiscard",
      "gitInit",
      "gitAddRemote",
    ].map((k) => [k, mock(async () => `${k}:ok`)]),
  );
  gitInstances.push(g);
  return g;
});
void mock.module("../src/git", () => ({ createGitOps }));

const pkgInstances: Record<string, ReturnType<typeof mock>>[] = [];
const createPackageOps = mock(() => {
  const p = Object.fromEntries(
    ["addPackage", "removePackage", "listPackages"].map((k) => [k, mock(async () => `${k}:ok`)]),
  );
  pkgInstances.push(p);
  return p;
});
void mock.module("../src/packages", () => ({ createPackageOps }));

// ─── Mock the user-level settings store ──────────────────────────────────────

const readSettingsMock = mock(async () => ({ aiApiKey: "sk-abc" }));
const writeSettingsMock = mock(async (_settings: Record<string, string>) => {});
void mock.module("../src/settings-store", () => ({
  readSettings: readSettingsMock,
  writeSettings: writeSettingsMock,
}));

// ─── Mock updater ────────────────────────────────────────────────────────────

void mock.module("../src/updater", () => ({
  applyUpdate: mock(() => "apply"),
  checkForUpdate: mock(() => "check"),
  downloadUpdate: mock(() => "download"),
  getLocalInfo: mock(() => "local"),
  getStatus: mock(() => "status"),
}));

// ─── Mock the studio-asset dir + project-server factory ──────────────────────

void mock.module("../src/canvas-runtime", () => ({
  studioDir: () => "/fake/studio",
}));

interface FakeServer {
  resolveSession: () => { projectRoot: string | null; handlers: Record<string, unknown> } | null;
  url: string;
  canvasUrl: string;
  rpcToken: string;
  /* The window installs its server as the OAuth redirect host, so the fake needs both members. */
  authorizer: { stop: ReturnType<typeof mock> };
  server: { port: number };
  stop: ReturnType<typeof mock>;
}
const createdServers: FakeServer[] = [];
let nextPort = 50_000;
const createProjectServer = mock((opts: { resolveSession: () => never; studioDir: string }) => {
  const port = nextPort;
  nextPort += 1;
  const url = `http://127.0.0.1:${port}`;
  const handle: FakeServer = {
    authorizer: { stop: mock(() => {}) },
    canvasUrl: `${url}/__studio__/canvas.html`,
    resolveSession: opts.resolveSession,
    rpcToken: `tok-${port}`,
    server: { port },
    stop: mock(() => {}),
    url,
  };
  createdServers.push(handle);
  return handle;
});
void mock.module("@jxsuite/server/project-server", () => ({ createProjectServer }));

/*
 * GitHub sign-in. Mocked at the module boundary because the real one opens a browser and talks to
 * GitHub; what this file tests is that each window wires the requests and claims the redirect.
 */
const setAuthorizationHostMock = mock((_host: unknown) => {});
void mock.module("../src/github-signin", () => ({
  githubSignIn: mock(async (params: { force?: boolean }) => ({
    token: params.force ? "gho_fresh" : "gho_stored",
  })),
  githubSignOut: mock(async () => ({ ok: true })),
  githubTokenStatus: mock(async () => ({ stored: true })),
  setAuthorizationHost: setAuthorizationHostMock,
}));

// ─── Import module under test ────────────────────────────────────────────────

const {
  openProjectWindow,
  listOpenWindows,
  broadcastUpdateReady,
  parseProjectDirFromUrl,
  setAiServerUrl,
  setImportServiceUrl,
} = await import("../src/window-manager");

setAiServerUrl("http://localhost:9000");
setImportServiceUrl("http://x/import?token=t");

const DASH = "—"; // Em dash used in window titles

function lastRequests() {
  return rpcConfigs.at(-1)!.handlers.requests;
}

beforeEach(() => {
  rpcConfigs.length = 0;
  rpcObjects.length = 0;
  sessions.length = 0;
  gitInstances.length = 0;
  pkgInstances.length = 0;
  createdWindows.length = 0;
  createdServers.length = 0;
  createProjectServer.mockClear();
});

afterEach(() => {
  // Closing a window disposes its entry; resets the module-level windows map between tests.
  for (const w of createdWindows) {
    try {
      w._closeHandler?.();
    } catch {}
  }
});

// ─── Window creation ────────────────────────────────────────────────────────

describe("openProjectWindow", () => {
  test("opens a project window with the expected options", () => {
    const win = openProjectWindow("/proj/a");
    const w = createdWindows.at(-1)!;
    expect(win).toBe(w as never);
    expect(w.opts.url).toBe("views://studio/index.html");
    expect(w.opts.title).toBe(`a ${DASH} Jx Studio`);
    expect(w.opts.titleBarStyle).toBe("hidden");
    expect(w.opts.frame).toEqual({ height: 900, width: 1400, x: 0, y: 0 });
    // Block-all first, then allow the two known origins last (last-match-wins).
    expect(w.opts.navigationRules).toBe("^*,views://*,http://127.0.0.1:*");
    expect(w.opts.rpc).toBe(rpcObjects.at(-1) as never);
    expect(createProjectSession).toHaveBeenLastCalledWith("/proj/a" as never);
  });

  test("opens a welcome window (null root) titled 'Jx Studio'", () => {
    openProjectWindow(null);
    expect(createdWindows.at(-1)!.opts.title).toBe("Jx Studio");
  });

  test("dedupes by project root: re-opening focuses the existing window", () => {
    const first = openProjectWindow("/proj/dedupe");
    const createdCount = createdWindows.length;
    const second = openProjectWindow("/proj/dedupe");
    expect(second).toBe(first as never);
    expect(createdWindows.length).toBe(createdCount); // No new window created
    expect((first as unknown as MockWindow).activate).toHaveBeenCalled();
  });

  test("tracks open windows and removes them on close", () => {
    openProjectWindow("/proj/track1");
    openProjectWindow("/proj/track2");
    const roots = listOpenWindows().map((w) => w.projectRoot);
    expect(roots).toContain("/proj/track1");
    expect(roots).toContain("/proj/track2");

    createdWindows.at(-1)!._closeHandler!();
    expect(listOpenWindows().map((w) => w.projectRoot)).not.toContain("/proj/track2");
  });
});

// ─── Per-window RPC delegation ──────────────────────────────────────────────

describe("per-window RPC", () => {
  test("delegates file/git/package requests to this window's session", async () => {
    openProjectWindow("/proj/rpc");
    const reqs = lastRequests();
    const session = sessions.at(-1)!;
    const git = gitInstances.at(-1)!;
    const pkg = pkgInstances.at(-1)!;

    await reqs.readFile({ path: "x" });
    expect(session.handleReadFile).toHaveBeenCalledWith({ path: "x" });
    await reqs.writeFile({ content: "c", path: "p" });
    expect(session.handleWriteFile).toHaveBeenCalledWith({ content: "c", path: "p" });
    await reqs.gitStatus();
    expect(git.gitStatus).toHaveBeenCalledTimes(1);
    await reqs.addPackage({ name: "p" });
    expect(pkg.addPackage).toHaveBeenCalledWith({ name: "p" });
  });

  test("delegates every remaining file/git/package/updater request handler", async () => {
    openProjectWindow("/proj/sweep");
    const reqs = lastRequests();
    const session = sessions.at(-1)!;
    const git = gitInstances.at(-1)!;
    const pkg = pkgInstances.at(-1)!;

    // File / project handlers (each forwards to the window's session).
    await reqs.deleteFile({ path: "a.json" });
    await reqs.renameFile({ from: "a", to: "b" });
    await reqs.findReferences({ path: "components/card.json" });
    await reqs.createDirectory({ path: "d" });
    await reqs.uploadFile({ data: "x", path: "p" });
    await reqs.resolveSiteContext({ filePath: "pages/a.json" });
    await reqs.listDirectory({ dir: "src" });
    await reqs.discoverComponents({});
    await reqs.codeService({ action: "lint", payload: {} });
    await reqs.locateFile({ name: "x.json" });
    await reqs.searchFiles({ extensions: [".md"], query: "abo" });
    await reqs.openExternal({ url: "https://example.com" });
    await reqs.fetchPluginSchema({ src: "m.js" });
    await reqs.formatAction({ action: "parse", format: "md" });
    await reqs.jxResolve({ body: "{}" });
    await reqs.jxServerFunction({ body: "{}" });
    await reqs.listFormats();
    // `View: Open in Browser` builds through this window and opens the origin the reply names.
    expect(await reqs.buildSite()).toEqual({
      errors: [],
      files: 2,
      routes: 1,
      url: "http://127.0.0.1:4321",
    });
    expect(session.handleDeleteFile).toHaveBeenCalledWith({ path: "a.json" });
    expect(session.findReferences).toHaveBeenCalledWith({ path: "components/card.json" });
    expect(session.listDirectory).toHaveBeenCalledWith({ dir: "src" });
    expect(session.listFormats).toHaveBeenCalledTimes(1);
    // The format registry's extensions ride along; dropping them makes ⌘P .json-only.
    expect(session.searchFiles).toHaveBeenCalledWith({ extensions: [".md"], query: "abo" });
    expect(session.openExternal).toHaveBeenCalledWith({ url: "https://example.com" });

    // Data surface + secrets handlers (each forwards to the window's session).
    await reqs.dataConnections();
    await reqs.dataConnectionTest({ connection: "main" });
    await reqs.dataPush({ dryRun: true });
    await reqs.dataRows({ table: "posts" });
    await reqs.dataInsertRow({ table: "posts", values: {} });
    await reqs.dataUpdateRow({ pk: "n", set: {}, table: "posts" });
    await reqs.dataDeleteRow({ pk: "n", table: "posts" });
    await reqs.listSecrets();
    await reqs.setSecrets({ set: { A: "1" } });
    expect(session.dataConnections).toHaveBeenCalledTimes(1);
    expect(session.dataConnectionTest).toHaveBeenCalledWith({ connection: "main" });
    expect(session.dataPush).toHaveBeenCalledWith({ dryRun: true });
    expect(session.dataRows).toHaveBeenCalledWith({ table: "posts" });
    expect(session.dataInsertRow).toHaveBeenCalledWith({ table: "posts", values: {} });
    expect(session.dataUpdateRow).toHaveBeenCalledWith({ pk: "n", set: {}, table: "posts" });
    expect(session.dataDeleteRow).toHaveBeenCalledWith({ pk: "n", table: "posts" });
    expect(session.listSecrets).toHaveBeenCalledTimes(1);
    expect(session.setSecrets).toHaveBeenCalledWith({ set: { A: "1" } });

    // Git handlers.
    await reqs.gitBranches();
    await reqs.gitLog({ limit: 5 });
    await reqs.gitStage({ files: ["a"] });
    await reqs.gitUnstage({ files: ["a"] });
    await reqs.gitCommit({ message: "m" });
    await reqs.gitPush({});
    await reqs.gitPull();
    await reqs.gitFetch();
    await reqs.gitCheckout({ branch: "dev" });
    await reqs.gitCreateBranch({ name: "f" });
    await reqs.gitDiff({});
    await reqs.gitShow({ path: "a.json", ref: "HEAD" });
    await reqs.gitDiscard({ files: ["a"] });
    await reqs.gitInit();
    await reqs.gitAddRemote({ name: "origin", url: "u" });
    expect(git.gitBranches).toHaveBeenCalledTimes(1);
    expect(git.gitCommit).toHaveBeenCalledWith({ message: "m" });
    expect(git.gitShow).toHaveBeenCalledWith({ path: "a.json", ref: "HEAD" });

    // Package handlers.
    await reqs.listPackages();
    await reqs.removePackage({ name: "lodash" });
    expect(pkg.listPackages).toHaveBeenCalledTimes(1);

    // Process-shared handlers.
    expect(reqs.aiChatUrl()).toBe("http://localhost:9000/__studio/ai/chat");
    expect(reqs.updaterApplyUpdate()).toBe("apply");
    expect(reqs.updaterCheckForUpdate()).toBe("check");
    expect(reqs.updaterDownloadUpdate()).toBe("download");
    expect(reqs.updaterGetLocalInfo()).toBe("local");
    expect(reqs.updaterGetStatus()).toBe("status");
    const open = reqs.listOpenWindows() as { id: number; projectRoot: string | null }[];
    expect(open.some((w) => w.projectRoot === "/proj/sweep")).toBe(true);
  });

  test("settings handlers pass through to the user-level settings store", async () => {
    openProjectWindow("/proj/settings");
    const reqs = lastRequests();

    const readsBefore = readSettingsMock.mock.calls.length;
    expect(await reqs.getSettings()).toEqual({ aiApiKey: "sk-abc" });
    expect(readSettingsMock.mock.calls.length).toBe(readsBefore + 1);

    const settings = { aiApiKey: "sk-new", theme: "dark" };
    await reqs.saveSettings({ settings });
    expect(writeSettingsMock).toHaveBeenLastCalledWith(settings);
  });

  test("GitHub sign-in handlers reach the loopback flow", async () => {
    openProjectWindow("/proj/github");
    const reqs = lastRequests();
    expect(await reqs.githubToken()).toEqual({ stored: true });
    expect(await reqs.githubSignIn({ force: true })).toEqual({ token: "gho_fresh" });
    expect(await reqs.githubSignOut()).toEqual({ ok: true });
  });

  test("each window installs its own server as the OAuth redirect host", () => {
    // The redirect lands on a specific port, so the newest window owns it.
    setAuthorizationHostMock.mockClear();
    openProjectWindow("/proj/redirect");
    const host = setAuthorizationHostMock.mock.calls.at(-1)![0] as { port: number };
    expect(host.port).toBe(createdServers.at(-1)!.server.port);
  });

  test("window controls target this window and maximize toggles", () => {
    const win = openProjectWindow("/proj/controls") as unknown as MockWindow;
    const reqs = lastRequests();

    reqs.windowClose();
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(reqs.windowGetFrame()).toEqual({ height: 10, width: 20, x: 1, y: 2 });
    reqs.windowMinimize();
    expect(win.minimize).toHaveBeenCalledTimes(1);
    reqs.windowSetFrame({ height: 6, width: 5, x: 3, y: 4 });
    expect(win.setFrame).toHaveBeenLastCalledWith(3, 4, 5, 6);

    reqs.windowMaximize();
    expect(win.setFrame).toHaveBeenLastCalledWith(5, 6, 1920, 1080);
    reqs.windowMaximize();
    expect(win.setFrame).toHaveBeenLastCalledWith(1, 2, 20, 10); // Restored from getFrame()
  });

  test("aiChatUrl resolves to the shared AI server's proxy endpoint", () => {
    openProjectWindow("/proj/ai");
    const reqs = lastRequests();
    expect(reqs.aiChatUrl()).toBe("http://localhost:9000/__studio/ai/chat");
  });

  test("importSiteUrl resolves to the shared token-gated import endpoint", () => {
    openProjectWindow("/proj/import");
    expect(lastRequests().importSiteUrl()).toBe("http://x/import?token=t");
  });

  test("pickDirectory delegates to this window's session", async () => {
    openProjectWindow("/proj/pick");
    const session = sessions.at(-1)!;
    expect(await lastRequests().pickDirectory()).toBe("/picked");
    expect(session.pickDirectory).toHaveBeenCalledTimes(1);
  });

  test("getProjectRoot reports this window's root", () => {
    openProjectWindow("/proj/which");
    expect(lastRequests().getProjectRoot()).toEqual({ root: "/proj/which" });
  });

  test("newWindow / openProjectInNewWindow open additional windows", () => {
    openProjectWindow(null);
    const reqs = lastRequests();
    const before = listOpenWindows().length;
    reqs.newWindow();
    expect(listOpenWindows().length).toBe(before + 1);
    expect(createdWindows.at(-1)!.opts.title).toBe("Jx Studio");
    const res = reqs.openProjectInNewWindow({ root: "/proj/sibling" });
    expect(createdWindows.at(-1)!.opts.title).toBe(`sibling ${DASH} Jx Studio`);
    expect(res).toEqual({ focused: false });
  });

  test("openProjectInNewWindow reports a FOCUS when the project is already open", () => {
    // Both outcomes hand back a window, so the caller cannot tell them apart by the return value
    // Alone — and "opened in a new window" is the wrong thing to tell someone whose existing
    // Window just came forward. The flag is asked before the open, while the answer is still true.
    const owner = openProjectWindow("/proj/twice") as unknown as MockWindow;
    openProjectWindow(null);
    const reqs = lastRequests();
    const created = createdWindows.length;

    expect(reqs.openProjectInNewWindow({ root: "/proj/twice" })).toEqual({
      focused: true,
    });
    expect(createdWindows.length).toBe(created); // Nothing new was built…
    expect(owner.activate).toHaveBeenCalled(); // …the one that had it was raised.
  });

  test("pickProject answers WHICH project without binding this window to it", async () => {
    // The whole reason this request exists beside `openProject`: the New Window branch has to ask
    // The question without suffering the answer. A session bound here would leave the window that
    // Merely asked serving a project it is not showing.
    const win = openProjectWindow("/proj/asking") as unknown as MockWindow;
    const session = sessions.at(-1)!;
    const reqs = lastRequests();

    expect(await reqs.pickProject()).toEqual({ name: "Picked", root: "/proj/picked" });
    expect(session.setProjectRoot).not.toHaveBeenCalled();
    expect(session.openProject).not.toHaveBeenCalled();
    expect(win.setTitle).not.toHaveBeenCalled();
    expect(listOpenWindows().find((w) => w.id === win.id)?.projectRoot).toBe("/proj/asking");
  });

  test("pickProject passes a cancelled picker straight through as null", async () => {
    const previous = pickedProject;
    pickedProject = null;
    try {
      openProjectWindow(null);
      expect(await lastRequests().pickProject()).toBeNull();
    } finally {
      pickedProject = previous;
    }
  });
});

// ─── Schema ↔ handler parity ────────────────────────────────────────────────

describe("rpc schema parity", () => {
  test("every request declared in rpc-schema.ts has a handler in this window's map", () => {
    openProjectWindow("/proj/parity");
    // No exemptions: the electrobun window IS the full desktop surface.
    const parity = rpcParity(Object.keys(lastRequests()));
    expect(parity.unhandled).toEqual([]);
    expect(parity.undeclared).toEqual([]);
  });
});

// ─── setWindowProject (welcome window loads a project in place) ──────────────

describe("setWindowProject", () => {
  test("binds this window's session and returns the project config", async () => {
    openProjectWindow(null);
    const reqs = lastRequests();
    const session = sessions.at(-1)!;
    const res = await reqs.setWindowProject({ root: "/proj/inplace" });
    expect(session.setProjectRoot).toHaveBeenCalledWith("/proj/inplace");
    expect(res).toEqual({ config: { name: "Proj" }, deduped: false });
  });

  test("dedupes to an existing window instead of loading twice", async () => {
    const owner = openProjectWindow("/proj/shared") as unknown as MockWindow;
    openProjectWindow(null);
    const reqs = lastRequests();
    const res = await reqs.setWindowProject({ root: "/proj/shared" });
    expect(res).toEqual({ config: null, deduped: true });
    expect(owner.activate).toHaveBeenCalled();
  });
});

// ─── Disposal on close ──────────────────────────────────────────────────────

describe("disposeWindow", () => {
  test("clears the session root when a window closes", () => {
    const win = openProjectWindow("/proj/dispose") as unknown as MockWindow;
    const session = sessions.at(-1)!;

    win._closeHandler!();
    expect(session.setProjectRoot).toHaveBeenCalledWith(null);
    expect(listOpenWindows().map((w) => w.projectRoot)).not.toContain("/proj/dispose");
  });
});

// ─── Per-window loopback canvas server (always stood up) ─────────────────────

describe("loopback canvas server", () => {
  test("stands up one per-window server and getCanvasUrl returns its canvas URL", () => {
    openProjectWindow("/proj/canvas");
    expect(createProjectServer).toHaveBeenCalledTimes(1);
    expect(createdServers).toHaveLength(1);
    const server = createdServers[0]!;
    // GetCanvasUrl returns the server canvasUrl with the per-window rpcToken appended as a query
    // Param, so the in-iframe runtime can authenticate its loopback dev-proxy fetches.
    const got = (lastRequests().getCanvasUrl() as { canvasUrl: string }).canvasUrl;
    const gotUrl = new URL(got);
    const expectedUrl = new URL(server.canvasUrl);
    expect(`${gotUrl.origin}${gotUrl.pathname}`).toBe(
      `${expectedUrl.origin}${expectedUrl.pathname}`,
    );
    expect(gotUrl.searchParams.get("rpcToken")).toBe(server.rpcToken);
    expect(server.canvasUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__studio__\/canvas\.html$/);
  });

  test("getCanvasUrl appends the server rpcToken to the canvas URL", () => {
    openProjectWindow("/proj/token");
    // Pin a known canvasUrl + rpcToken on this window's server so the assertion is exact.
    const server = createdServers[0]!;
    server.canvasUrl = "http://127.0.0.1:5555/__studio__/canvas.html";
    server.rpcToken = "TOK123";

    const { canvasUrl } = lastRequests().getCanvasUrl() as { canvasUrl: string };
    const parsed = new URL(canvasUrl);
    expect(parsed.pathname).toBe("/__studio__/canvas.html");
    expect(parsed.host).toBe("127.0.0.1:5555");
    expect(parsed.searchParams.get("rpcToken")).toBe("TOK123");
  });

  test("getCanvasUrl returns { canvasUrl: null } when there is no server", () => {
    // This window's loopback server fails to stand up, so entry.server stays undefined and the
    // Handler must take the null branch instead of constructing a URL from `undefined`.
    createProjectServer.mockImplementationOnce(() => undefined as never);
    openProjectWindow("/proj/noserver");
    expect(createdServers).toHaveLength(0);
    expect(lastRequests().getCanvasUrl()).toEqual({ canvasUrl: null });
  });

  test("the server's session tracks THIS window's projectRoot, no ?win= needed", () => {
    openProjectWindow("/proj/winA");
    openProjectWindow("/proj/winB");
    expect(createdServers).toHaveLength(2);
    const [a, b] = createdServers;
    expect(a!.resolveSession()!.projectRoot).toBe("/proj/winA");
    expect(b!.resolveSession()!.projectRoot).toBe("/proj/winB");
    // Distinct ports → no cross-window token reuse.
    expect(a!.url).not.toBe(b!.url);
  });

  test("the WS handler subset exposes only canvas-facing reads (no writes/git)", async () => {
    openProjectWindow("/proj/handlers");
    const session = sessions.at(-1)!;
    const handlers = createdServers[0]!.resolveSession()!.handlers as Record<
      string,
      (p: unknown) => Promise<unknown>
    >;
    expect(Object.keys(handlers).toSorted()).toEqual([
      "jxResolve",
      "jxServerFunction",
      "readFile",
      "resolveSiteContext",
    ]);
    await handlers.jxResolve!({ body: "{}" });
    expect(session.jxResolve).toHaveBeenCalledWith({ body: "{}" });
    await handlers.readFile!({ path: "p" });
    expect(session.handleReadFile).toHaveBeenCalledWith({ path: "p" });
    // No write/git surface leaks onto the loopback server.
    expect(handlers.writeFile).toBeUndefined();
    expect(handlers.gitStatus).toBeUndefined();
  });

  test("disposeWindow stops THIS window's server", () => {
    openProjectWindow("/proj/teardown");
    const server = createdServers[0]!;
    createdWindows.at(-1)!._closeHandler!();
    expect(server.stop).toHaveBeenCalledTimes(1);
  });
});

// ─── openProject request handler ─────────────────────────────────────────────

describe("openProject request handler", () => {
  test("opens a project, binds the root and updates the window title", async () => {
    const win = openProjectWindow(null) as unknown as MockWindow;
    const reqs = lastRequests();
    const session = sessions.at(-1)!;

    const result = await reqs.openProject();
    expect(session.openProject).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      config: { name: "Proj" },
      handle: { name: "Proj", projectConfig: {}, root: "." },
    });
    expect(listOpenWindows().find((w) => w.id === win.id)?.projectRoot).toBe("/proj/opened");
    expect(win.setTitle).toHaveBeenLastCalledWith(`opened ${DASH} Jx Studio`);
  });
});

describe("createProject request handler", () => {
  test("scaffolds at the chosen destination, binds the root and updates the window title", async () => {
    const win = openProjectWindow(null) as unknown as MockWindow;
    const reqs = lastRequests();
    const session = sessions.at(-1)!;

    const params = {
      destination: { kind: "path", parent: "/home/dev/Sites" },
      directory: "shiny",
      name: "New",
    };
    const result = await reqs.createProject(params);
    expect(session.createProject).toHaveBeenCalledTimes(1);
    // The window layer is a pass-through: the destination the modal chose reaches the session
    // Intact, so the project is written only where the user said.
    expect(session.createProject).toHaveBeenCalledWith(params);
    expect(result).toEqual({ config: { name: "New" }, root: "/home/dev/Sites/shiny" });
    expect(listOpenWindows().find((w) => w.id === win.id)?.projectRoot).toBe(
      "/home/dev/Sites/shiny",
    );
    expect(win.setTitle).toHaveBeenLastCalledWith(`shiny ${DASH} Jx Studio`);
  });
});

describe("listStarters request handler", () => {
  test("returns the starter template registry", async () => {
    openProjectWindow(null);
    const reqs = lastRequests();
    const starters = (await reqs.listStarters()) as { id: string }[];
    expect(Array.isArray(starters)).toBe(true);
    expect(starters.some((s) => s.id === "restaurant")).toBe(true);
  });
});

// ─── Broadcast ──────────────────────────────────────────────────────────────

describe("broadcastUpdateReady", () => {
  test("sends updateReady to every open window", () => {
    openProjectWindow("/proj/b1");
    const rpc1 = rpcObjects.at(-1)!;
    openProjectWindow("/proj/b2");
    const rpc2 = rpcObjects.at(-1)!;
    broadcastUpdateReady("9.9.9");
    expect(rpc1.send.updateReady).toHaveBeenCalledWith({ version: "9.9.9" });
    expect(rpc2.send.updateReady).toHaveBeenCalledWith({ version: "9.9.9" });
  });
});

// ─── File-event sink ────────────────────────────────────────────────────────

describe("file event sink", () => {
  test("pushes session file events to the webview and absorbs send failures", () => {
    openProjectWindow("/proj/events");
    const session = sessions.at(-1)!;
    const rpc = rpcObjects.at(-1)!;
    const sink = session.setFileEventSink.mock.calls[0]![0] as (events: unknown[]) => void;

    const events = [{ kind: "change", path: "pages/index.json" }];
    sink(events);
    expect(rpc.send.onFileEvents).toHaveBeenCalledWith({ events });

    // The webview may not be ready yet; the sink must swallow a failed send.
    rpc.send.onFileEvents.mockImplementationOnce(() => {
      throw new Error("webview gone");
    });
    expect(() => sink(events)).not.toThrow();
  });
});

// ─── parseProjectDirFromUrl ─────────────────────────────────────────────────

describe("parseProjectDirFromUrl", () => {
  test("parses a posix project.json file url", () => {
    expect(parseProjectDirFromUrl("file:///home/me/proj/project.json")).toBe("/home/me/proj");
  });
  test("strips the leading slash from windows drive paths", () => {
    expect(parseProjectDirFromUrl("file:///C:/apps/proj/project.json")).toBe("C:/apps/proj");
  });
  test("returns null for files that are not project.json", () => {
    expect(parseProjectDirFromUrl("file:///home/me/proj/readme.md")).toBeNull();
  });
  test("returns null for non-file protocols", () => {
    expect(parseProjectDirFromUrl("https://example.com/project.json")).toBeNull();
  });
  test("returns null when the url cannot be parsed", () => {
    expect(parseProjectDirFromUrl("::::not a valid url")).toBeNull();
  });
});
