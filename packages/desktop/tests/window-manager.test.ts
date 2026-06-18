import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Mock electrobun/bun ────────────────────────────────────────────────────

const rpcConfigs: { handlers: { requests: Record<string, (p?: never) => unknown> } }[] = [];
const rpcObjects: { send: { updateReady: ReturnType<typeof mock> } }[] = [];
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

void mock.module("electrobun/bun", () => ({
  BrowserView: {
    defineRPC: (config: { handlers: { requests: Record<string, (p?: never) => unknown> } }) => {
      rpcConfigs.push(config);
      const rpc = { send: { updateReady: mock((_p: { version: string }) => {}) } };
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
    handleReadFile: mock(async (_p: { path: string }) => '{"name":"Proj"}'),
    handleReadFileAsDataUrl: mock(async () => "data:"),
    handleWriteFile: mock(async () => {}),
    handleDeleteFile: mock(async () => {}),
    handleRenameFile: mock(async () => {}),
    handleCreateDirectory: mock(async () => {}),
    handleUploadFile: mock(async () => {}),
    handleResolveSiteContext: mock(async () => ({ sitePath: null })),
    listDirectory: mock(async () => []),
    discoverComponents: mock(async () => []),
    codeService: mock(async () => null),
    locateFile: mock(async () => null),
    fetchPluginSchema: mock(async () => null),
    jxResolve: mock(async () => ({ body: "{}", status: 200 })),
    jxServerFunction: mock(async () => ({ body: "{}", status: 200 })),
    listFormats: mock(async () => []),
    formatAction: mock(async () => ({})),
    openProject: mock(async () => {
      root = "/proj/opened";
      return {
        config: { name: "Proj" },
        handle: { name: "Proj", projectConfig: {}, root: "." },
      };
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
void mock.module("../src/project-session", () => ({
  createProjectSession,
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

// ─── Mock updater + claude-session ───────────────────────────────────────────

void mock.module("../src/updater", () => ({
  applyUpdate: mock(() => "apply"),
  checkForUpdate: mock(() => "check"),
  downloadUpdate: mock(() => "download"),
  getLocalInfo: mock(() => "local"),
  getStatus: mock(() => "status"),
}));

const createSession = mock((_root: string, _msg: string, _opts: unknown) => ({ id: "sess-1" }));
const deleteSession = mock((_id: string) => {});
const sendMessage = mock((_id: string, _msg: string) => {});
const stopSession = mock((_id: string) => {});
void mock.module("@jxsuite/server/claude-session", () => ({
  createSession,
  deleteSession,
  getAuthStatus: mock(async () => ({ authenticated: true })),
  sendMessage,
  stopSession,
}));

// ─── Import module under test ────────────────────────────────────────────────

const {
  openProjectWindow,
  listOpenWindows,
  broadcastUpdateReady,
  parseProjectDirFromUrl,
  setAiServerUrl,
} = await import("../src/window-manager");

setAiServerUrl("http://localhost:9000");

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

    await reqs.readFile({ path: "x" } as never);
    expect(session.handleReadFile).toHaveBeenCalledWith({ path: "x" });
    await reqs.writeFile({ content: "c", path: "p" } as never);
    expect(session.handleWriteFile).toHaveBeenCalledWith({ content: "c", path: "p" });
    await reqs.gitStatus();
    expect(git.gitStatus).toHaveBeenCalledTimes(1);
    await reqs.addPackage({ name: "p" } as never);
    expect(pkg.addPackage).toHaveBeenCalledWith({ name: "p" });
  });

  test("delegates every remaining file/git/package/updater request handler", async () => {
    openProjectWindow("/proj/sweep");
    const reqs = lastRequests();
    const session = sessions.at(-1)!;
    const git = gitInstances.at(-1)!;
    const pkg = pkgInstances.at(-1)!;

    // File / project handlers (each forwards to the window's session).
    await reqs.readFileAsDataUrl({ path: "a.png" } as never);
    await reqs.deleteFile({ path: "a.json" } as never);
    await reqs.renameFile({ from: "a", to: "b" } as never);
    await reqs.createDirectory({ path: "d" } as never);
    await reqs.uploadFile({ data: "x", path: "p" } as never);
    await reqs.resolveSiteContext({ filePath: "pages/a.json" } as never);
    await reqs.listDirectory({ dir: "src" } as never);
    await reqs.discoverComponents({} as never);
    await reqs.codeService({ action: "lint", payload: {} } as never);
    await reqs.locateFile({ name: "x.json" } as never);
    await reqs.fetchPluginSchema({ src: "m.js" } as never);
    await reqs.formatAction({ action: "parse", format: "md" } as never);
    await reqs.jxResolve({ body: "{}" } as never);
    await reqs.jxServerFunction({ body: "{}" } as never);
    await reqs.listFormats();
    expect(session.handleDeleteFile).toHaveBeenCalledWith({ path: "a.json" });
    expect(session.listDirectory).toHaveBeenCalledWith({ dir: "src" });
    expect(session.listFormats).toHaveBeenCalledTimes(1);

    // Git handlers.
    await reqs.gitBranches();
    await reqs.gitLog({ limit: 5 } as never);
    await reqs.gitStage({ files: ["a"] } as never);
    await reqs.gitUnstage({ files: ["a"] } as never);
    await reqs.gitCommit({ message: "m" } as never);
    await reqs.gitPush({} as never);
    await reqs.gitPull();
    await reqs.gitFetch();
    await reqs.gitCheckout({ branch: "dev" } as never);
    await reqs.gitCreateBranch({ name: "f" } as never);
    await reqs.gitDiff({} as never);
    await reqs.gitDiscard({ files: ["a"] } as never);
    await reqs.gitInit();
    await reqs.gitAddRemote({ name: "origin", url: "u" } as never);
    expect(git.gitBranches).toHaveBeenCalledTimes(1);
    expect(git.gitCommit).toHaveBeenCalledWith({ message: "m" });

    // Package handlers.
    await reqs.listPackages();
    await reqs.removePackage({ name: "lodash" } as never);
    expect(pkg.listPackages).toHaveBeenCalledTimes(1);

    // Process-shared handlers.
    expect(await reqs.aiAuthStatus()).toEqual({ authenticated: true } as never);
    expect(reqs.updaterApplyUpdate()).toBe("apply");
    expect(reqs.updaterCheckForUpdate()).toBe("check");
    expect(reqs.updaterDownloadUpdate()).toBe("download");
    expect(reqs.updaterGetLocalInfo()).toBe("local");
    expect(reqs.updaterGetStatus()).toBe("status");
    const open = reqs.listOpenWindows() as { id: number; projectRoot: string | null }[];
    expect(open.some((w) => w.projectRoot === "/proj/sweep")).toBe(true);
  });

  test("window controls target this window and maximize toggles", () => {
    const win = openProjectWindow("/proj/controls") as unknown as MockWindow;
    const reqs = lastRequests();

    reqs.windowClose();
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(reqs.windowGetFrame()).toEqual({ height: 10, width: 20, x: 1, y: 2 });
    reqs.windowMinimize();
    expect(win.minimize).toHaveBeenCalledTimes(1);
    reqs.windowSetFrame({ height: 6, width: 5, x: 3, y: 4 } as never);
    expect(win.setFrame).toHaveBeenLastCalledWith(3, 4, 5, 6);

    reqs.windowMaximize();
    expect(win.setFrame).toHaveBeenLastCalledWith(5, 6, 1920, 1080);
    reqs.windowMaximize();
    expect(win.setFrame).toHaveBeenLastCalledWith(1, 2, 20, 10); // Restored from getFrame()
  });

  test("aiCreateSession binds the window's root and aiStreamUrl uses the shared server", () => {
    openProjectWindow("/proj/ai");
    const reqs = lastRequests();
    const result = reqs.aiCreateSession({ message: "hi" } as never);
    expect(createSession).toHaveBeenLastCalledWith("/proj/ai", "hi", {});
    expect(result).toEqual({ id: "sess-1" } as never);
    expect(reqs.aiStreamUrl({ id: "abc" } as never)).toBe(
      "http://localhost:9000/studio/ai/session/abc/stream",
    );
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
    reqs.openProjectInNewWindow({ root: "/proj/sibling" } as never);
    expect(createdWindows.at(-1)!.opts.title).toBe(`sibling ${DASH} Jx Studio`);
  });
});

// ─── setWindowProject (welcome window loads a project in place) ──────────────

describe("setWindowProject", () => {
  test("binds this window's session and returns the project config", async () => {
    openProjectWindow(null);
    const reqs = lastRequests();
    const session = sessions.at(-1)!;
    const res = await reqs.setWindowProject({ root: "/proj/inplace" } as never);
    expect(session.setProjectRoot).toHaveBeenCalledWith("/proj/inplace");
    expect(res).toEqual({ config: { name: "Proj" }, deduped: false } as never);
  });

  test("dedupes to an existing window instead of loading twice", async () => {
    const owner = openProjectWindow("/proj/shared") as unknown as MockWindow;
    openProjectWindow(null);
    const reqs = lastRequests();
    const res = await reqs.setWindowProject({ root: "/proj/shared" } as never);
    expect(res).toEqual({ config: null, deduped: true } as never);
    expect(owner.activate).toHaveBeenCalled();
  });
});

// ─── Disposal on close ──────────────────────────────────────────────────────

describe("disposeWindow", () => {
  test("clears the session root and AI sessions when a window closes", () => {
    const win = openProjectWindow("/proj/dispose") as unknown as MockWindow;
    const reqs = lastRequests();
    const session = sessions.at(-1)!;
    reqs.aiCreateSession({ message: "hi" } as never); // Records sess-1

    win._closeHandler!();
    expect(session.setProjectRoot).toHaveBeenCalledWith(null);
    expect(deleteSession).toHaveBeenCalledWith("sess-1");
    expect(listOpenWindows().map((w) => w.projectRoot)).not.toContain("/proj/dispose");
  });
});

// ─── AI session request handlers ────────────────────────────────────────────

describe("AI session request handlers", () => {
  test("aiCreateSession throws when the window has no project open", () => {
    openProjectWindow(null);
    const reqs = lastRequests();
    expect(() => reqs.aiCreateSession({ message: "hi" } as never)).toThrow("No project open");
  });

  test("aiSendMessage / aiStopSession / aiDeleteSession delegate to claude-session", () => {
    openProjectWindow("/proj/ai-ops");
    const reqs = lastRequests();
    reqs.aiCreateSession({ message: "hi" } as never); // Records sess-1

    reqs.aiSendMessage({ id: "sess-1", message: "yo" } as never);
    expect(sendMessage).toHaveBeenCalledWith("sess-1", "yo");

    reqs.aiStopSession({ id: "sess-1" } as never);
    expect(stopSession).toHaveBeenCalledWith("sess-1");

    reqs.aiDeleteSession({ id: "sess-1" } as never);
    expect(deleteSession).toHaveBeenCalledWith("sess-1");
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
    } as never);
    expect(listOpenWindows().find((w) => w.id === win.id)?.projectRoot).toBe("/proj/opened");
    expect(win.setTitle).toHaveBeenLastCalledWith(`opened ${DASH} Jx Studio`);
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
