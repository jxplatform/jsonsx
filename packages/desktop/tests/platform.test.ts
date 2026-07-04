import { afterEach, describe, expect, mock, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

// ─── Mock electrobun/view ───────────────────────────────────────────────────

interface Call {
  method: string;
  args: unknown[];
}

const calls: Call[] = [];
const impls = new Map<string, (...args: unknown[]) => unknown>();

const requestProxy = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
  get(_target, prop: string) {
    return (...args: unknown[]) => {
      calls.push({ args, method: prop });
      const impl = impls.get(prop);
      if (impl) {
        return (async () => impl(...args))();
      }
      return Promise.resolve({ method: prop, ok: true });
    };
  },
});

const rpcObject = { request: requestProxy };

let capturedRpcConfig: {
  handlers: {
    messages: Record<string, (payload: never) => void>;
    requests: Record<string, unknown>;
  };
  maxRequestTime: number;
} | null = null;
let electroviewCtorArgs: unknown = null;

void mock.module("electrobun/view", () => ({
  Electroview: class {
    static defineRPC(config: never) {
      capturedRpcConfig = config;
      return rpcObject;
    }
    constructor(opts: unknown) {
      electroviewCtorArgs = opts;
    }
  },
}));

function callsFor(method: string): Call[] {
  return calls.filter((c) => c.method === method);
}

function lastCall(method: string): Call | undefined {
  return callsFor(method).at(-1);
}

async function flush(ms = 25): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ─── Import module under test (after mocks + DOM) ──────────────────────────

const { createDesktopPlatform } = await import("../src/platform");

// Stub the original fetch BEFORE the platform wraps it, so passthrough is observable.
const passthroughFetch = mock(async () => new Response("passthrough-body", { status: 299 }));
(window as unknown as Record<string, unknown>).fetch = passthroughFetch;

const platform = createDesktopPlatform();
// The asset observer rewrites relative panel srcs to the loopback origin; set it BEFORE the
// Synchronous mutation batch below so the observer sees the canvas origin as active.
const LOOPBACK = "http://127.0.0.1:51999";
platform.canvasUrl = `${LOOPBACK}/__studio__/canvas.html`;

// ─── Asset-resolution fixture (single synchronous mutation batch) ───────────
// The happy-dom MutationObserver delivers exactly one batch per observer, so
// All DOM mutations that should be observed must happen synchronously right
// After createDesktopPlatform() starts observing.

const imgRelative = document.createElement("img");
imgRelative.setAttribute("src", "./assets/pic.png");
const imgHttp = document.createElement("img");
imgHttp.setAttribute("src", "http://example.com/pic.png");
const imgData = document.createElement("img");
imgData.setAttribute("src", "data:image/png;base64,AA==");
const imgViews = document.createElement("img");
imgViews.setAttribute("src", "views://studio/pic.png");
const video = document.createElement("video");
video.setAttribute("poster", "media/poster.jpg");
const wrap = document.createElement("div");
const innerImg = document.createElement("img");
innerImg.setAttribute("src", "deep/inner.png");
wrap.append(innerImg);
// A styled child nested in an added subtree exercises the querySelectorAll("[style]") branch.
const styleWrap = document.createElement("div");
const styleChild = document.createElement("div");
styleChild.setAttribute("style", "background-image: url('deep/backdrop.png')");
styleWrap.append(styleChild);
const bgDiv = document.createElement("div");
bgDiv.setAttribute("style", "background-image: url('./bg/tile.png')");
const bgHttpDiv = document.createElement("div");
bgHttpDiv.setAttribute("style", "background-image: url('http://example.com/bg.png')");
const styleLateDiv = document.createElement("div");
const bgNoneDiv = document.createElement("div");
bgNoneDiv.setAttribute("style", "background-image: none");
const plainStyleDiv = document.createElement("div");
plainStyleDiv.setAttribute("style", "color: red");

document.body.append(
  bgNoneDiv,
  plainStyleDiv,
  imgRelative,
  imgHttp,
  imgData,
  imgViews,
  video,
  wrap,
  styleWrap,
  bgDiv,
  bgHttpDiv,
  styleLateDiv,
  "plain text node",
);

// Attribute mutations in the same batch exercise the "attributes" observer branch.
styleLateDiv.setAttribute("style", "background-image: url(late/style.png)");
imgHttp.setAttribute("src", "http://example.com/pic2.png");
imgRelative.setAttribute("alt", "ignored attribute");

// ─── RPC wiring ─────────────────────────────────────────────────────────────

describe("RPC setup", () => {
  test("defines RPC with message handlers and constructs Electroview", () => {
    expect(capturedRpcConfig).not.toBeNull();
    expect(capturedRpcConfig!.maxRequestTime).toBe(300_000);
    expect(typeof capturedRpcConfig!.handlers.messages.fileChanged).toBe("function");
    expect(typeof capturedRpcConfig!.handlers.messages.updateReady).toBe("function");
    expect(capturedRpcConfig!.handlers.requests).toEqual({});
    expect(electroviewCtorArgs).toEqual({ rpc: rpcObject });
  });

  test("fileChanged message handler runs without error", () => {
    const handler = capturedRpcConfig!.handlers.messages.fileChanged as (p: {
      path: string;
    }) => void;
    expect(() => handler({ path: "some/file.json" })).not.toThrow();
  });

  test("updateReady message shows toast and restart button triggers applyUpdate", () => {
    const handler = capturedRpcConfig!.handlers.messages.updateReady as (p: {
      version: string;
    }) => void;
    handler({ version: "9.9.9" });

    const container = document.body.querySelector(".update-toast-container");
    expect(container).not.toBeNull();
    expect(container!.textContent).toContain("9.9.9");

    const before = callsFor("updaterApplyUpdate").length;
    const button = container!.querySelector("sp-button");
    expect(button).not.toBeNull();
    button!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(callsFor("updaterApplyUpdate").length).toBe(before + 1);
    container!.remove();
  });
});

// ─── Fetch interception ─────────────────────────────────────────────────────

describe("fetch interception", () => {
  test("routes /__jx_resolve__ through rpc.request.jxResolve", async () => {
    impls.set("jxResolve", () => ({
      body: JSON.stringify({ resolved: true }),
      status: 201,
    }));
    const res = await window.fetch("/__jx_resolve__", {
      body: JSON.stringify({ a: 1 }),
      method: "POST",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ resolved: true });
    expect(lastCall("jxResolve")!.args[0]).toEqual({ body: '{"a":1}' });
    impls.delete("jxResolve");
  });

  test("routes /__jx_server__ through rpc.request.jxServerFunction", async () => {
    impls.set("jxServerFunction", () => ({
      body: JSON.stringify({ value: 42 }),
      status: 200,
    }));
    const res = await window.fetch(new URL("http://localhost/__jx_server__"), {
      body: JSON.stringify({ fn: "x" }),
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 42 });
    expect(lastCall("jxServerFunction")!.args[0]).toEqual({ body: '{"fn":"x"}' });
    impls.delete("jxServerFunction");
  });

  test("defaults body to {} when no init body and accepts Request input", async () => {
    impls.set("jxResolve", () => ({ body: "null", status: 200 }));
    const req = new Request("http://localhost/__jx_resolve__", { method: "POST" });
    const res = await window.fetch(req);
    expect(res.status).toBe(200);
    expect(lastCall("jxResolve")!.args[0]).toEqual({ body: "{}" });
    impls.delete("jxResolve");
  });

  test("returns 500 JSON error when the RPC handler throws", async () => {
    impls.set("jxServerFunction", () => {
      throw new Error("boom");
    });
    const res = await window.fetch("/__jx_server__", { body: "{}", method: "POST" });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("boom");
    impls.delete("jxServerFunction");
  });
});

// ─── Class resolution (resolveClass PAL method) ─────────────────────────────

describe("resolveClass", () => {
  test("calls rpc.request.jxResolve directly and parses the JSON body", async () => {
    impls.set("jxResolve", () => ({
      body: JSON.stringify([{ data: { sku: "a" }, id: "A" }]),
      status: 200,
    }));
    const result = await platform.resolveClass!({ $src: "x", contentType: "product" });
    expect(result).toEqual([{ data: { sku: "a" }, id: "A" }]);
    expect(lastCall("jxResolve")!.args[0]).toEqual({
      body: '{"$src":"x","contentType":"product"}',
    });
    impls.delete("jxResolve");
  });

  test("throws on an error status", async () => {
    impls.set("jxResolve", () => ({ body: "nope", status: 500 }));
    expect(platform.resolveClass!({ $src: "x" })).rejects.toThrow("Class resolution failed: 500");
    impls.delete("jxResolve");
  });

  test("does NOT intercept views:// URLs — they pass through to the original fetch", async () => {
    // Loopback-only: the canvas doc + assets are served natively over http by the per-window loopback
    // Server, so there is no views:// read-shim. A views:// URL falls through to the original fetch.
    const res = await window.fetch("views://studio/data/foo.json");
    expect(res.status).toBe(299);
    expect(await res.text()).toBe("passthrough-body");
    expect(callsFor("readFile")).toHaveLength(0);
  });

  test("passes other URLs to the original fetch", async () => {
    const res = await window.fetch("http://example.com/page");
    expect(res.status).toBe(299);
    expect(await res.text()).toBe("passthrough-body");
    expect(passthroughFetch).toHaveBeenCalled();
  });
});

// ─── Platform method delegation ─────────────────────────────────────────────

describe("platform methods", () => {
  // The asset-observer fixture (module scope) set platform.canvasUrl to LOOPBACK; restore it after
  // Tests that mutate it so the later asset-resolution describe's observer still sees the origin.
  afterEach(() => {
    platform.canvasUrl = `${LOOPBACK}/__studio__/canvas.html`;
  });

  test("identity and activate", async () => {
    expect(platform.id).toBe("desktop");
    expect(platform.projectRoot).toBe("");
    await platform.activate();
  });

  test("activate stores the loopback canvasUrl returned by getCanvasUrl", async () => {
    impls.set("getCanvasUrl", () => ({
      canvasUrl: "http://127.0.0.1:51234/__studio__/canvas.html",
    }));
    await platform.activate();
    expect(platform.canvasUrl).toBe("http://127.0.0.1:51234/__studio__/canvas.html");
    // A null canvasUrl clears it back to undefined.
    impls.set("getCanvasUrl", () => ({ canvasUrl: null }));
    await platform.activate();
    expect(platform.canvasUrl).toBeUndefined();
    impls.delete("getCanvasUrl");
  });

  test("activate leaves canvasUrl unset when the getCanvasUrl RPC throws", async () => {
    impls.set("getCanvasUrl", () => {
      throw new Error("rpc down");
    });
    platform.canvasUrl = undefined;
    await platform.activate();
    expect(platform.canvasUrl).toBeUndefined();
    impls.delete("getCanvasUrl");
  });

  test("openProject delegates with no arguments", async () => {
    const result = await platform.openProject();
    expect(result).toEqual({ method: "openProject", ok: true });
    expect(lastCall("openProject")!.args).toEqual([]);
  });

  test("probeRootProject reads project.json when present", async () => {
    impls.set("getProjectRoot", () => ({ root: "/proj" }));
    impls.set("readFile", () => JSON.stringify({ name: "My Site" }));
    const probe = await platform.probeRootProject();
    expect(probe).not.toBeNull();
    expect(probe!.info.isSiteProject).toBe(true);
    expect(probe!.info.projectConfig).toEqual({ name: "My Site" } as never);
    expect(probe!.meta).toEqual({ name: "My Site", root: "/proj" });
    expect(lastCall("readFile")!.args[0]).toEqual({ path: "project.json" });
    impls.delete("readFile");
    impls.delete("getProjectRoot");
  });

  test("probeRootProject falls back to 'project' name when config has none", async () => {
    impls.set("getProjectRoot", () => ({ root: "/proj" }));
    impls.set("readFile", () => "{}");
    const probe = await platform.probeRootProject();
    expect(probe).not.toBeNull();
    expect(probe!.info.isSiteProject).toBe(true);
    expect(probe!.meta.name).toBe("project");
    impls.delete("readFile");
    impls.delete("getProjectRoot");
  });

  test("probeRootProject reports non-site project on read failure", async () => {
    impls.set("getProjectRoot", () => ({ root: "/proj" }));
    impls.set("readFile", () => {
      throw new Error("missing");
    });
    const probe = await platform.probeRootProject();
    expect(probe).not.toBeNull();
    expect(probe!.info.isSiteProject).toBe(false);
    expect(probe!.info.projectConfig).toBeNull();
    expect(probe!.meta).toEqual({ name: "project", root: "." });
    impls.delete("readFile");
    impls.delete("getProjectRoot");
  });

  test("probeRootProject returns null when the window has no project (welcome window)", async () => {
    impls.set("getProjectRoot", () => ({ root: null }));
    const readsBefore = callsFor("readFile").length;
    const probe = await platform.probeRootProject();
    // Null tells the studio to show the welcome screen; project.json is never read.
    expect(probe).toBeNull();
    expect(callsFor("readFile").length).toBe(readsBefore);
    impls.delete("getProjectRoot");
  });

  test("probeRootProject returns null when getProjectRoot fails", async () => {
    impls.set("getProjectRoot", () => {
      throw new Error("rpc down");
    });
    const probe = await platform.probeRootProject();
    expect(probe).toBeNull();
    impls.delete("getProjectRoot");
  });

  const delegations: [string, unknown[], string, unknown][] = [
    ["resolveSiteContext", ["pages/a.json"], "resolveSiteContext", { filePath: "pages/a.json" }],
    ["listDirectory", ["src"], "listDirectory", { dir: "src" }],
    ["readFile", ["a.json"], "readFile", { path: "a.json" }],
    ["writeFile", ["a.json", "body"], "writeFile", { content: "body", path: "a.json" }],
    ["uploadFile", ["img.png", "ZGF0YQ=="], "uploadFile", { data: "ZGF0YQ==", path: "img.png" }],
    ["deleteFile", ["a.json"], "deleteFile", { path: "a.json" }],
    ["renameFile", ["old.json", "new.json"], "renameFile", { from: "old.json", to: "new.json" }],
    ["createDirectory", ["newdir"], "createDirectory", { path: "newdir" }],
    [
      "codeService",
      ["lint", { code: "x" }],
      "codeService",
      {
        action: "lint",
        payload: { code: "x" },
      },
    ],
    ["locateFile", ["button.json"], "locateFile", { name: "button.json" }],
    ["searchFiles", ["query"], "searchFiles", { query: "query" }],
    ["listFormats", [], "listFormats", undefined],
    [
      "formatAction",
      [{ action: "parse", format: "md" }],
      "formatAction",
      {
        action: "parse",
        format: "md",
      },
    ],
    ["addPackage", ["lodash"], "addPackage", { name: "lodash" }],
    ["removePackage", ["lodash"], "removePackage", { name: "lodash" }],
    ["listPackages", [], "listPackages", undefined],
    ["installDependencies", [], "installDependencies", undefined],
    ["dependenciesNeedInstall", [], "dependenciesNeedInstall", undefined],
    ["outdatedPackages", [], "outdatedPackages", undefined],
    [
      "setPackageVersions",
      [[{ name: "x", version: "^1" }]],
      "setPackageVersions",
      { updates: [{ name: "x", version: "^1" }] },
    ],
    ["gitStatus", [], "gitStatus", undefined],
    ["gitBranches", [], "gitBranches", undefined],
    ["gitStage", [["a.json"]], "gitStage", { files: ["a.json"] }],
    ["gitUnstage", [["a.json"]], "gitUnstage", { files: ["a.json"] }],
    ["gitCommit", ["feat: x"], "gitCommit", { message: "feat: x" }],
    ["gitPull", [], "gitPull", undefined],
    ["gitFetch", [], "gitFetch", undefined],
    ["gitCheckout", ["dev"], "gitCheckout", { branch: "dev" }],
    ["gitCreateBranch", ["feature"], "gitCreateBranch", { name: "feature" }],
    ["gitDiscard", [["a.json"]], "gitDiscard", { files: ["a.json"] }],
    [
      "gitShow",
      [{ path: "a.json", ref: "HEAD~1" }],
      "gitShow",
      {
        path: "a.json",
        ref: "HEAD~1",
      },
    ],
    [
      "createProject",
      [{ directory: "/tmp/p", name: "p" }],
      "createProject",
      {
        directory: "/tmp/p",
        name: "p",
      },
    ],
    ["listStarters", [], "listStarters", undefined],
    ["aiChatUrl", [], "aiChatUrl", undefined],
    ["setWindowProject", ["/proj/x"], "setWindowProject", { root: "/proj/x" }],
    ["getProjectRoot", [], "getProjectRoot", undefined],
    ["getRecentProjects", [], "getRecentProjects", undefined],
  ];

  for (const [method, args, rpcMethod, expectedPayload] of delegations) {
    test(`${method} delegates to rpc.request.${rpcMethod}`, async () => {
      const fn = (platform as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        method
      ];
      const result = await fn.apply(platform, args);
      const call = lastCall(rpcMethod);
      expect(call).toBeDefined();
      if (expectedPayload === undefined) {
        expect(call!.args).toEqual([]);
      } else {
        expect(call!.args[0]).toEqual(expectedPayload);
      }
      expect(result).toEqual({ method: rpcMethod, ok: true });
    });
  }

  const voidDelegations: [string, unknown[], string, unknown][] = [
    ["gitInit", [], "gitInit", undefined],
    [
      "gitAddRemote",
      ["origin", "git@host:repo.git"],
      "gitAddRemote",
      {
        name: "origin",
        url: "git@host:repo.git",
      },
    ],
    ["openProjectInNewWindow", ["/proj/y"], "openProjectInNewWindow", { root: "/proj/y" }],
    ["newWindow", [], "newWindow", undefined],
    [
      "saveRecentProjects",
      [[{ name: "x", root: "/x", timestamp: 1 }]],
      "saveRecentProjects",
      { projects: [{ name: "x", root: "/x", timestamp: 1 }] },
    ],
  ];

  for (const [method, args, rpcMethod, expectedPayload] of voidDelegations) {
    test(`${method} awaits rpc.request.${rpcMethod} and returns undefined`, async () => {
      const fn = (platform as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        method
      ];
      const result = await fn.apply(platform, args);
      const call = lastCall(rpcMethod);
      expect(call).toBeDefined();
      if (expectedPayload === undefined) {
        expect(call!.args).toEqual([]);
      } else {
        expect(call!.args[0]).toEqual(expectedPayload);
      }
      expect(result).toBeUndefined();
    });
  }

  test("discoverComponents includes dir only when provided", async () => {
    await platform.discoverComponents("components");
    expect(lastCall("discoverComponents")!.args[0]).toEqual({ dir: "components" });
    await platform.discoverComponents();
    expect(lastCall("discoverComponents")!.args[0]).toEqual({});
  });

  test("fetchPluginSchema conditionally spreads prototype and base", async () => {
    await platform.fetchPluginSchema("pkg/mod.js", "Widget", "/base");
    expect(lastCall("fetchPluginSchema")!.args[0]).toEqual({
      base: "/base",
      prototype: "Widget",
      src: "pkg/mod.js",
    });
    await platform.fetchPluginSchema("pkg/mod.js");
    expect(lastCall("fetchPluginSchema")!.args[0]).toEqual({ src: "pkg/mod.js" });
  });

  test("gitLog includes limit only when provided", async () => {
    await platform.gitLog(7);
    expect(lastCall("gitLog")!.args[0]).toEqual({ limit: 7 });
    await platform.gitLog();
    expect(lastCall("gitLog")!.args[0]).toEqual({});
  });

  test("gitPush defaults opts to empty object", async () => {
    await platform.gitPush({ setUpstream: true });
    expect(lastCall("gitPush")!.args[0]).toEqual({ setUpstream: true });
    await platform.gitPush();
    expect(lastCall("gitPush")!.args[0]).toEqual({});
  });

  test("gitDiff includes path only when provided", async () => {
    await platform.gitDiff("a.json");
    expect(lastCall("gitDiff")!.args[0]).toEqual({ path: "a.json" });
    await platform.gitDiff();
    expect(lastCall("gitDiff")!.args[0]).toEqual({});
  });

  test("updater methods delegate", async () => {
    const mapping: [keyof typeof platform.updater, string][] = [
      ["applyUpdate", "updaterApplyUpdate"],
      ["checkForUpdate", "updaterCheckForUpdate"],
      ["downloadUpdate", "updaterDownloadUpdate"],
      ["getLocalInfo", "updaterGetLocalInfo"],
      ["getStatus", "updaterGetStatus"],
    ];
    for (const [method, rpcMethod] of mapping) {
      const before = callsFor(rpcMethod).length;
      await (platform.updater[method] as () => Promise<unknown>)();
      expect(callsFor(rpcMethod).length).toBe(before + 1);
    }
  });

  test("windowControls delegate and setFrame maps positional args", async () => {
    await platform.windowControls.close();
    expect(lastCall("windowClose")).toBeDefined();
    await platform.windowControls.getFrame();
    expect(lastCall("windowGetFrame")).toBeDefined();
    await platform.windowControls.maximize();
    expect(lastCall("windowMaximize")).toBeDefined();
    await platform.windowControls.minimize();
    expect(lastCall("windowMinimize")).toBeDefined();
    await platform.windowControls.setFrame(10, 20, 300, 400);
    expect(lastCall("windowSetFrame")!.args[0]).toEqual({
      height: 400,
      width: 300,
      x: 10,
      y: 20,
    });
  });
});

// ─── MutationObserver asset resolution ──────────────────────────────────────
// All mutations happened in the single module-scope batch above; tests only
// Assert on the settled DOM state.

describe("asset resolution via MutationObserver", () => {
  test("rewrites a relative img src to the loopback origin (no data: fetch)", async () => {
    await flush();
    expect(imgRelative.getAttribute("src")).toBe(`${LOOPBACK}/assets/pic.png`);
  });

  test("leaves absolute, data and views urls untouched", async () => {
    await flush();
    expect(imgHttp.getAttribute("src")).toBe("http://example.com/pic2.png");
    expect(imgData.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(imgViews.getAttribute("src")).toBe("views://studio/pic.png");
  });

  test("resolves video poster attribute", async () => {
    await flush();
    expect(video.getAttribute("poster")).toBe(`${LOOPBACK}/media/poster.jpg`);
  });

  test("resolves nested children of an added subtree", async () => {
    await flush();
    expect(innerImg.getAttribute("src")).toBe(`${LOOPBACK}/deep/inner.png`);
  });

  test("resolves background images on styled children of an added subtree", async () => {
    await flush();
    expect(styleChild.style.backgroundImage).toContain(`${LOOPBACK}/deep/backdrop.png`);
  });

  test("rewrites style background-image url to the loopback origin", async () => {
    await flush();
    expect(bgDiv.style.backgroundImage).toContain(`${LOOPBACK}/bg/tile.png`);
  });

  test("ignores http, none and absent background images", async () => {
    await flush();
    expect(bgHttpDiv.style.backgroundImage).toContain("example.com/bg.png");
    expect(bgNoneDiv.style.backgroundImage).toBe("none");
    expect(plainStyleDiv.style.color).toBe("red");
  });

  test("reacts to style attribute mutations", async () => {
    await flush();
    expect(styleLateDiv.style.backgroundImage).toContain(`${LOOPBACK}/late/style.png`);
  });
});

// ─── activate() initial sweep ────────────────────────────────────────────────
// Imgs mounted before activate() resolves carry relative srcs; activate() runs a
// Synchronous sweep AFTER canvasUrl is set (then drains the observer's queue) so
// They are rewritten promptly rather than waiting for the next mutation.

describe("activate() initial asset sweep", () => {
  // Restore the module-scope loopback for any later assertions that depend on it.
  afterEach(() => {
    platform.canvasUrl = `${LOOPBACK}/__studio__/canvas.html`;
    impls.delete("getCanvasUrl");
  });

  test("rewrites a pre-mounted relative img to the loopback origin during activate()", async () => {
    // Clear the origin BEFORE mounting so the observer (if it fires on append) no-ops the img —
    // Proving the rewrite below is the work of activate()'s synchronous sweep, not the observer.
    platform.canvasUrl = undefined;
    const preImg = document.createElement("img");
    preImg.setAttribute("src", "/images/pre.png");
    document.body.append(preImg);

    impls.set("getCanvasUrl", () => ({ canvasUrl: `${LOOPBACK}/__studio__/canvas.html` }));
    await platform.activate();
    // No further flush(): the sweep ran synchronously inside activate() after canvasUrl resolved.
    expect(preImg.getAttribute("src")).toBe(`${LOOPBACK}/images/pre.png`);
    preImg.remove();
  });

  test("does not throw and leaves relative imgs untouched when canvasUrl is null", async () => {
    platform.canvasUrl = undefined;
    const preImg = document.createElement("img");
    preImg.setAttribute("src", "/images/none.png");
    document.body.append(preImg);

    impls.set("getCanvasUrl", () => ({ canvasUrl: null }));
    const result = await platform.activate();
    expect(result).toBeUndefined();
    // LoopbackOrigin() is null => the sweep is skipped and the relative src stays put.
    expect(preImg.getAttribute("src")).toBe("/images/none.png");
    preImg.remove();
  });

  test("a sweep failure is caught and does not break activate()", async () => {
    platform.canvasUrl = undefined;
    impls.set("getCanvasUrl", () => ({ canvasUrl: `${LOOPBACK}/__studio__/canvas.html` }));
    // Force resolveAllAssets to throw by making the tree walk blow up; the catch must swallow it.
    const original = document.documentElement.querySelectorAll.bind(document.documentElement);
    document.documentElement.querySelectorAll = (() => {
      throw new Error("sweep boom");
    }) as typeof document.documentElement.querySelectorAll;
    try {
      const result = await platform.activate();
      expect(result).toBeUndefined();
    } finally {
      document.documentElement.querySelectorAll = original;
    }
  });
});

describe("getAppInfo", () => {
  test("reports 'Up to date' when no update is pending", async () => {
    impls.set("updaterGetLocalInfo", () => ({ channel: "stable", hash: "abc", version: "1.2.3" }));
    impls.set("updaterGetStatus", () => ({
      error: null,
      updateAvailable: false,
      updateReady: false,
      version: null,
    }));
    const info = await platform.getAppInfo!();
    expect(info).toEqual({
      channel: "stable",
      hash: "abc",
      updateStatus: "Up to date",
      version: "1.2.3",
    });
  });

  test("reports available then ready updates", async () => {
    impls.set("updaterGetLocalInfo", () => ({ channel: "canary", hash: "d", version: "1.0.0" }));
    impls.set("updaterGetStatus", () => ({
      error: null,
      updateAvailable: true,
      updateReady: false,
      version: "1.1.0",
    }));
    const available = await platform.getAppInfo!();
    expect(available.updateStatus).toBe("Update available (1.1.0)");
    impls.set("updaterGetStatus", () => ({
      error: null,
      updateAvailable: true,
      updateReady: true,
      version: "1.1.0",
    }));
    const ready = await platform.getAppInfo!();
    expect(ready.updateStatus).toBe("Update ready (1.1.0)");
  });

  test("reports a failed update check", async () => {
    impls.set("updaterGetLocalInfo", () => ({ channel: "stable", hash: "d", version: "1.0.0" }));
    impls.set("updaterGetStatus", () => ({
      error: "boom",
      updateAvailable: false,
      updateReady: false,
      version: null,
    }));
    const failed = await platform.getAppInfo!();
    expect(failed.updateStatus).toBe("Update check failed: boom");
  });

  test("omits updateStatus when the status call throws", async () => {
    impls.set("updaterGetLocalInfo", () => ({ channel: "stable", hash: "d", version: "1.0.0" }));
    impls.set("updaterGetStatus", () => {
      throw new Error("rpc down");
    });
    const info = await platform.getAppInfo!();
    expect(info.updateStatus).toBeUndefined();
    expect(info.version).toBe("1.0.0");
  });
});
