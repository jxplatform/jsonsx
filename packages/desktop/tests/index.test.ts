import { describe, expect, mock, test } from "bun:test";

// ─── Mock electrobun/bun ────────────────────────────────────────────────────

let windowOpts: Record<string, unknown> | null = null;
let rpcConfig: {
  handlers: { messages: Record<string, unknown>; requests: Record<string, unknown> };
  maxRequestTime: number;
} | null = null;

const winClose = mock(() => {});
const winMinimize = mock(() => {});
const winSetFrame = mock((_x: number, _y: number, _w: number, _h: number) => {});
const winGetFrame = mock(() => ({ height: 10, width: 20, x: 1, y: 2 }));
const sendUpdateReady = mock((_payload: { version: string }) => {});
const eventHandlers = new Map<string, (e: { data: { url: string } }) => void>();
const rpcObject = { send: { updateReady: sendUpdateReady } };

mock.module("electrobun/bun", () => ({
  BrowserView: {
    defineRPC: (config: never) => {
      rpcConfig = config;
      return rpcObject;
    },
  },
  BrowserWindow: class {
    close = winClose;
    getFrame = winGetFrame;
    minimize = winMinimize;
    setFrame = winSetFrame;
    constructor(opts: Record<string, unknown>) {
      windowOpts = opts;
    }
  },
  default: {
    events: {
      on: (name: string, handler: (e: { data: { url: string } }) => void) => {
        eventHandlers.set(name, handler);
      },
    },
  },
  Screen: {
    getPrimaryDisplay: () => ({ workArea: { height: 1080, width: 1920, x: 5, y: 6 } }),
  },
}));

// ─── Mock local modules ─────────────────────────────────────────────────────

function tagged(name: string) {
  return mock((..._args: unknown[]) => `${name}:result` as unknown);
}

const handlerMocks = {
  codeService: tagged("codeService"),
  discoverComponents: tagged("discoverComponents"),
  fetchPluginSchema: tagged("fetchPluginSchema"),
  formatAction: tagged("formatAction"),
  handleCreateDirectory: tagged("handleCreateDirectory"),
  handleDeleteFile: tagged("handleDeleteFile"),
  handleReadFile: tagged("handleReadFile"),
  handleReadFileAsDataUrl: tagged("handleReadFileAsDataUrl"),
  handleRenameFile: tagged("handleRenameFile"),
  handleResolveSiteContext: tagged("handleResolveSiteContext"),
  handleUploadFile: tagged("handleUploadFile"),
  handleWriteFile: tagged("handleWriteFile"),
  jxResolve: tagged("jxResolve"),
  jxServerFunction: tagged("jxServerFunction"),
  listDirectory: tagged("listDirectory"),
  listFormats: tagged("listFormats"),
  locateFile: tagged("locateFile"),
  openProject: tagged("openProject"),
  setFileDialog: mock((_fn: unknown) => {}),
  setProjectRoot: mock((_root: string | null) => {}),
};
mock.module("../src/handlers", () => handlerMocks);

const gitMocks = {
  gitAddRemote: tagged("gitAddRemote"),
  gitBranches: tagged("gitBranches"),
  gitCheckout: tagged("gitCheckout"),
  gitCommit: tagged("gitCommit"),
  gitCreateBranch: tagged("gitCreateBranch"),
  gitDiff: tagged("gitDiff"),
  gitDiscard: tagged("gitDiscard"),
  gitFetch: tagged("gitFetch"),
  gitInit: tagged("gitInit"),
  gitLog: tagged("gitLog"),
  gitPull: tagged("gitPull"),
  gitPush: tagged("gitPush"),
  gitStage: tagged("gitStage"),
  gitStatus: tagged("gitStatus"),
  gitUnstage: tagged("gitUnstage"),
};
mock.module("../src/git", () => gitMocks);

const packageMocks = {
  addPackage: tagged("addPackage"),
  listPackages: tagged("listPackages"),
  removePackage: tagged("removePackage"),
};
mock.module("../src/packages", () => packageMocks);

let notifyWebview: ((version: string) => void) | null = null;
const updaterMocks = {
  applyUpdate: tagged("applyUpdate"),
  checkForUpdate: tagged("checkForUpdate"),
  downloadUpdate: tagged("downloadUpdate"),
  getLocalInfo: tagged("getLocalInfo"),
  getStatus: tagged("getStatus"),
  setNotifyWebview: mock((fn: (version: string) => void) => {
    notifyWebview = fn;
  }),
  startBackgroundChecks: mock(() => {}),
};
mock.module("../src/updater", () => updaterMocks);

const openFileDialogSentinel = mock(async () => []);
const initUtils = mock(async () => {});
mock.module("../src/utils", () => ({
  init: initUtils,
  openFileDialog: openFileDialogSentinel,
}));

const handleAiRoute = mock(async (_req: Request, path: string, _root: string) => {
  if (path === "/studio/ai/hit") {
    return new Response("ai-ok", { status: 200 });
  }
  return null;
});
mock.module("../src/ai", () => ({ handleAiRoute }));

const sessionMocks = {
  createSession: tagged("createSession"),
  deleteSession: tagged("deleteSession"),
  getAuthStatus: tagged("getAuthStatus"),
  sendMessage: tagged("sendMessage"),
  stopSession: tagged("stopSession"),
};
mock.module("@jxsuite/server/claude-session", () => sessionMocks);

// ─── Stub Bun.serve, then import the module under test ─────────────────────

const realServe = Bun.serve;
let serveOpts: { fetch: (req: Request) => Promise<Response>; port: number } | null = null;
// @ts-expect-error replacing Bun.serve with a capture stub for import-time boot
Bun.serve = (opts: { fetch: (req: Request) => Promise<Response>; port: number }) => {
  serveOpts = opts;
  return { port: 43_210, stop: () => {} };
};

await import("../src/index");

// @ts-expect-error restore the real Bun.serve
Bun.serve = realServe;

const requests = rpcConfig!.handlers.requests as Record<string, (params?: never) => unknown>;

function call(name: string, params?: unknown): unknown {
  return requests[name](params as never);
}

const bootProjectRoot = handlerMocks.setProjectRoot.mock.calls[0]?.[0];

// ─── Boot sequence ──────────────────────────────────────────────────────────

describe("boot sequence", () => {
  test("sets the project root to a non-empty string", () => {
    expect(typeof bootProjectRoot).toBe("string");
    expect((bootProjectRoot as string).length).toBeGreaterThan(0);
  });

  test("initializes utils and wires the file dialog", () => {
    expect(initUtils).toHaveBeenCalledTimes(1);
    expect(handlerMocks.setFileDialog).toHaveBeenCalledWith(openFileDialogSentinel);
  });

  test("registers RPC with all request handlers and max request time", () => {
    expect(rpcConfig).not.toBeNull();
    expect(rpcConfig!.maxRequestTime).toBe(300_000);
    expect(rpcConfig!.handlers.messages).toEqual({});
    for (const name of [
      "addPackage",
      "aiAuthStatus",
      "gitStatus",
      "jxResolve",
      "openProject",
      "windowMaximize",
      "writeFile",
    ]) {
      expect(typeof requests[name]).toBe("function");
    }
  });

  test("starts the AI server on an ephemeral port", () => {
    expect(serveOpts).not.toBeNull();
    expect(serveOpts!.port).toBe(0);
    expect(typeof serveOpts!.fetch).toBe("function");
  });

  test("opens the studio window with the RPC object", () => {
    expect(windowOpts).not.toBeNull();
    expect(windowOpts!.title).toBe("Jx Studio");
    expect(windowOpts!.url).toBe("views://studio/index.html");
    expect(windowOpts!.titleBarStyle).toBe("hidden");
    expect(windowOpts!.rpc).toBe(rpcObject as never);
    expect(windowOpts!.frame).toEqual({ height: 900, width: 1400, x: 0, y: 0 });
  });

  test("starts background update checks and wires webview notification", () => {
    expect(updaterMocks.startBackgroundChecks).toHaveBeenCalledTimes(1);
    expect(notifyWebview).not.toBeNull();
    notifyWebview!("3.1.4");
    expect(sendUpdateReady).toHaveBeenCalledWith({ version: "3.1.4" });
  });
});

// ─── Request handler delegation ─────────────────────────────────────────────

describe("request handler delegation", () => {
  const delegations: [string, unknown, ReturnType<typeof mock>, unknown[]][] = [
    ["addPackage", { name: "p" }, packageMocks.addPackage, [{ name: "p" }]],
    ["aiAuthStatus", undefined, sessionMocks.getAuthStatus, []],
    ["codeService", { action: "a" }, handlerMocks.codeService, [{ action: "a" }]],
    ["createDirectory", { path: "d" }, handlerMocks.handleCreateDirectory, [{ path: "d" }]],
    ["deleteFile", { path: "f" }, handlerMocks.handleDeleteFile, [{ path: "f" }]],
    ["discoverComponents", { dir: "c" }, handlerMocks.discoverComponents, [{ dir: "c" }]],
    ["fetchPluginSchema", { src: "s" }, handlerMocks.fetchPluginSchema, [{ src: "s" }]],
    [
      "formatAction",
      { action: "x", format: "md" },
      handlerMocks.formatAction,
      [{ action: "x", format: "md" }],
    ],
    ["gitAddRemote", { name: "o", url: "u" }, gitMocks.gitAddRemote, [{ name: "o", url: "u" }]],
    ["gitBranches", undefined, gitMocks.gitBranches, []],
    ["gitCheckout", { branch: "b" }, gitMocks.gitCheckout, [{ branch: "b" }]],
    ["gitCommit", { message: "m" }, gitMocks.gitCommit, [{ message: "m" }]],
    ["gitCreateBranch", { name: "n" }, gitMocks.gitCreateBranch, [{ name: "n" }]],
    ["gitDiff", { path: "p" }, gitMocks.gitDiff, [{ path: "p" }]],
    ["gitDiscard", { files: ["f"] }, gitMocks.gitDiscard, [{ files: ["f"] }]],
    ["gitFetch", undefined, gitMocks.gitFetch, []],
    ["gitInit", undefined, gitMocks.gitInit, []],
    ["gitLog", { limit: 3 }, gitMocks.gitLog, [{ limit: 3 }]],
    ["gitPull", undefined, gitMocks.gitPull, []],
    ["gitPush", { setUpstream: true }, gitMocks.gitPush, [{ setUpstream: true }]],
    ["gitStage", { files: ["f"] }, gitMocks.gitStage, [{ files: ["f"] }]],
    ["gitStatus", undefined, gitMocks.gitStatus, []],
    ["gitUnstage", { files: ["f"] }, gitMocks.gitUnstage, [{ files: ["f"] }]],
    ["jxResolve", { body: "{}" }, handlerMocks.jxResolve, [{ body: "{}" }]],
    ["jxServerFunction", { body: "{}" }, handlerMocks.jxServerFunction, [{ body: "{}" }]],
    ["listDirectory", { dir: "d" }, handlerMocks.listDirectory, [{ dir: "d" }]],
    ["listFormats", undefined, handlerMocks.listFormats, []],
    ["listPackages", undefined, packageMocks.listPackages, []],
    ["locateFile", { name: "n" }, handlerMocks.locateFile, [{ name: "n" }]],
    ["openProject", undefined, handlerMocks.openProject, []],
    ["readFile", { path: "p" }, handlerMocks.handleReadFile, [{ path: "p" }]],
    ["readFileAsDataUrl", { path: "p" }, handlerMocks.handleReadFileAsDataUrl, [{ path: "p" }]],
    ["removePackage", { name: "p" }, packageMocks.removePackage, [{ name: "p" }]],
    ["renameFile", { from: "a", to: "b" }, handlerMocks.handleRenameFile, [{ from: "a", to: "b" }]],
    [
      "resolveSiteContext",
      { filePath: "f" },
      handlerMocks.handleResolveSiteContext,
      [{ filePath: "f" }],
    ],
    ["updaterApplyUpdate", undefined, updaterMocks.applyUpdate, []],
    ["updaterCheckForUpdate", undefined, updaterMocks.checkForUpdate, []],
    ["updaterDownloadUpdate", undefined, updaterMocks.downloadUpdate, []],
    ["updaterGetLocalInfo", undefined, updaterMocks.getLocalInfo, []],
    ["updaterGetStatus", undefined, updaterMocks.getStatus, []],
    [
      "uploadFile",
      { data: "d", path: "p" },
      handlerMocks.handleUploadFile,
      [{ data: "d", path: "p" }],
    ],
    [
      "writeFile",
      { content: "c", path: "p" },
      handlerMocks.handleWriteFile,
      [{ content: "c", path: "p" }],
    ],
  ];

  for (const [name, params, target, expectedArgs] of delegations) {
    test(`${name} delegates with the right arguments`, () => {
      const before = target.mock.calls.length;
      const result = call(name, params);
      expect(target.mock.calls.length).toBe(before + 1);
      expect(target.mock.calls.at(-1)).toEqual(expectedArgs as never);
      expect(result).toBe(target.mock.results.at(-1)!.value as never);
    });
  }

  test("aiCreateSession passes project root and omits absent systemPrompt", () => {
    call("aiCreateSession", { message: "hi" });
    expect(sessionMocks.createSession.mock.calls.at(-1)).toEqual([
      bootProjectRoot,
      "hi",
      {},
    ] as never);
  });

  test("aiCreateSession forwards systemPrompt when provided", () => {
    call("aiCreateSession", { message: "hi", systemPrompt: "be nice" });
    expect(sessionMocks.createSession.mock.calls.at(-1)).toEqual([
      bootProjectRoot,
      "hi",
      { systemPrompt: "be nice" },
    ] as never);
  });

  test("aiSendMessage / aiStopSession / aiDeleteSession return void", () => {
    expect(call("aiSendMessage", { id: "s1", message: "m" })).toBeUndefined();
    expect(sessionMocks.sendMessage.mock.calls.at(-1)).toEqual(["s1", "m"] as never);
    expect(call("aiStopSession", { id: "s1" })).toBeUndefined();
    expect(sessionMocks.stopSession.mock.calls.at(-1)).toEqual(["s1"] as never);
    expect(call("aiDeleteSession", { id: "s1" })).toBeUndefined();
    expect(sessionMocks.deleteSession.mock.calls.at(-1)).toEqual(["s1"] as never);
  });

  test("aiStreamUrl points at the AI server stream endpoint", () => {
    expect(call("aiStreamUrl", { id: "abc" })).toBe(
      "http://localhost:43210/studio/ai/session/abc/stream",
    );
  });
});

// ─── Window controls ────────────────────────────────────────────────────────

describe("window controls", () => {
  test("windowClose closes the window", () => {
    call("windowClose");
    expect(winClose).toHaveBeenCalledTimes(1);
  });

  test("windowGetFrame returns the window frame", () => {
    expect(call("windowGetFrame")).toEqual({ height: 10, width: 20, x: 1, y: 2 });
  });

  test("windowMinimize minimizes the window", () => {
    call("windowMinimize");
    expect(winMinimize).toHaveBeenCalledTimes(1);
  });

  test("windowSetFrame maps the params to positional args", () => {
    call("windowSetFrame", { height: 40, width: 30, x: 11, y: 22 });
    expect(winSetFrame.mock.calls.at(-1)).toEqual([11, 22, 30, 40]);
  });

  test("windowMaximize toggles between work area and restore frame", () => {
    const before = winSetFrame.mock.calls.length;
    call("windowMaximize");
    expect(winSetFrame.mock.calls.at(-1)).toEqual([5, 6, 1920, 1080]);
    call("windowMaximize");
    expect(winSetFrame.mock.calls.at(-1)).toEqual([1, 2, 20, 10]);
    expect(winSetFrame.mock.calls.length).toBe(before + 2);
  });
});

// ─── AI HTTP server fetch handler ───────────────────────────────────────────

describe("AI server fetch handler", () => {
  test("delegates matching routes to handleAiRoute", async () => {
    const res = await serveOpts!.fetch(new Request("http://localhost/studio/ai/hit"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ai-ok");
    const [, path, root] = handleAiRoute.mock.calls.at(-1)!;
    expect(path).toBe("/studio/ai/hit");
    expect(root).toBe(bootProjectRoot);
  });

  test("normalizes duplicate leading slashes", async () => {
    const res = await serveOpts!.fetch(new Request("http://localhost//studio/ai/hit"));
    expect(res.status).toBe(200);
    expect(handleAiRoute.mock.calls.at(-1)![1]).toBe("/studio/ai/hit");
  });

  test("returns 404 for unhandled routes", async () => {
    const res = await serveOpts!.fetch(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});

// ─── open-url file association ──────────────────────────────────────────────

describe("open-url event", () => {
  const handler = () => eventHandlers.get("open-url")!;

  test("registers an open-url listener", () => {
    expect(eventHandlers.has("open-url")).toBe(true);
  });

  test("sets the project root when a project.json file url opens", () => {
    handler()({ data: { url: "file:///home/me/proj/project.json" } });
    expect(handlerMocks.setProjectRoot.mock.calls.at(-1)).toEqual(["/home/me/proj"]);
  });

  test("strips the leading slash from windows drive paths", () => {
    handler()({ data: { url: "file:///C:/apps/proj/project.json" } });
    expect(handlerMocks.setProjectRoot.mock.calls.at(-1)).toEqual(["C:/apps/proj"]);
  });

  test("ignores file urls that are not project.json", () => {
    const before = handlerMocks.setProjectRoot.mock.calls.length;
    handler()({ data: { url: "file:///home/me/proj/readme.md" } });
    expect(handlerMocks.setProjectRoot.mock.calls.length).toBe(before);
  });

  test("ignores non-file protocols", () => {
    const before = handlerMocks.setProjectRoot.mock.calls.length;
    handler()({ data: { url: "https://example.com/project.json" } });
    expect(handlerMocks.setProjectRoot.mock.calls.length).toBe(before);
  });
});
