import { describe, expect, mock, test } from "bun:test";

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

mock.module("electrobun/view", () => ({
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

// ─── Asset-resolution fixture (single synchronous mutation batch) ───────────
// The happy-dom MutationObserver delivers exactly one batch per observer, so
// All DOM mutations that should be observed must happen synchronously right
// After createDesktopPlatform() starts observing.

const assetResponses: Record<string, () => string> = {
  "assets/pic.png": () => "data:image/png;base64,SU1H",
  "bg/tile.png": () => "data:image/png;base64,Qkc=",
  "deep/backdrop.png": () => "data:image/png;base64,REVFUEJH",
  "deep/inner.png": () => "data:image/png;base64,TkVTVA==",
  "empty/none.png": () => "",
  "fail/err.png": () => {
    throw new Error("io error");
  },
  "late/style.png": () => "data:image/png;base64,U1RZ",
  "media/poster.jpg": () => "data:image/jpeg;base64,UE9TVEVS",
};

impls.set("readFileAsDataUrl", (params) => {
  const { path } = params as { path: string };
  const responder = assetResponses[path];
  if (!responder) {
    throw new Error(`unexpected asset path: ${path}`);
  }
  return responder();
});

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
const emptyImg = document.createElement("img");
emptyImg.setAttribute("src", "empty/none.png");
const failImg = document.createElement("img");
failImg.setAttribute("src", "fail/err.png");
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
  emptyImg,
  failImg,
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

  test("serves views:// URLs via readFile with json mime", async () => {
    impls.set("readFile", () => '{"hello":"world"}');
    const res = await window.fetch("views://studio/data/foo.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"hello":"world"}');
    expect(lastCall("readFile")!.args[0]).toEqual({ path: "data/foo.json" });
    impls.delete("readFile");
  });

  test("falls back to public/ prefix when direct read fails", async () => {
    impls.set("readFile", (params) => {
      const { path } = params as { path: string };
      if (path.startsWith("public/")) {
        return "public file body";
      }
      throw new Error("not found");
    });
    const res = await window.fetch("views://studio/notes.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("public file body");
    expect(lastCall("readFile")!.args[0]).toEqual({ path: "public/notes.txt" });
    impls.delete("readFile");
  });

  test("returns 404 when both reads fail", async () => {
    impls.set("readFile", () => {
      throw new Error("nope");
    });
    const res = await window.fetch("views://studio/missing.bin");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    impls.delete("readFile");
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
  test("identity and activate", async () => {
    expect(platform.id).toBe("desktop");
    expect(platform.projectRoot).toBe("");
    await platform.activate();
  });

  test("openProject delegates with no arguments", async () => {
    const result = await platform.openProject();
    expect(result).toEqual({ method: "openProject", ok: true });
    expect(lastCall("openProject")!.args).toEqual([]);
  });

  test("probeRootProject reads project.json when present", async () => {
    impls.set("readFile", () => JSON.stringify({ name: "My Site" }));
    const probe = await platform.probeRootProject();
    expect(probe.info.isSiteProject).toBe(true);
    expect(probe.info.projectConfig).toEqual({ name: "My Site" } as never);
    expect(probe.meta).toEqual({ name: "My Site", root: "." });
    expect(lastCall("readFile")!.args[0]).toEqual({ path: "project.json" });
    impls.delete("readFile");
  });

  test("probeRootProject falls back to 'project' name when config has none", async () => {
    impls.set("readFile", () => "{}");
    const probe = await platform.probeRootProject();
    expect(probe.info.isSiteProject).toBe(true);
    expect(probe.meta.name).toBe("project");
    impls.delete("readFile");
  });

  test("probeRootProject reports non-site project on read failure", async () => {
    impls.set("readFile", () => {
      throw new Error("missing");
    });
    const probe = await platform.probeRootProject();
    expect(probe.info.isSiteProject).toBe(false);
    expect(probe.info.projectConfig).toBeNull();
    expect(probe.meta).toEqual({ name: "project", root: "." });
    impls.delete("readFile");
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
    ["aiAuthStatus", [], "aiAuthStatus", undefined],
    ["aiCreateSession", [{ message: "hi" }], "aiCreateSession", { message: "hi" }],
    ["aiStreamUrl", ["sess-1"], "aiStreamUrl", { id: "sess-1" }],
    ["setWindowProject", ["/proj/x"], "setWindowProject", { root: "/proj/x" }],
    ["getProjectRoot", [], "getProjectRoot", undefined],
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
    ["aiSendMessage", ["sess-1", "hello"], "aiSendMessage", { id: "sess-1", message: "hello" }],
    ["aiStopSession", ["sess-1"], "aiStopSession", { id: "sess-1" }],
    ["aiDeleteSession", ["sess-1"], "aiDeleteSession", { id: "sess-1" }],
    ["openProjectInNewWindow", ["/proj/y"], "openProjectInNewWindow", { root: "/proj/y" }],
    ["newWindow", [], "newWindow", undefined],
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

  test("resolveAssetUrl returns the data url on success", async () => {
    impls.set("readFileAsDataUrl", () => "data:image/png;base64,QUJD");
    const url = await platform.resolveAssetUrl("img.png");
    expect(url).toBe("data:image/png;base64,QUJD");
    impls.delete("readFileAsDataUrl");
  });

  test("resolveAssetUrl returns null on failure", async () => {
    impls.set("readFileAsDataUrl", () => {
      throw new Error("nope");
    });
    const url = await platform.resolveAssetUrl("img.png");
    expect(url).toBeNull();
    impls.delete("readFileAsDataUrl");
  });

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
  test("rewrites relative img src to data url", async () => {
    await flush();
    expect(imgRelative.getAttribute("src")).toBe("data:image/png;base64,SU1H");
    expect(
      callsFor("readFileAsDataUrl").some(
        (c) => (c.args[0] as { path: string }).path === "assets/pic.png",
      ),
    ).toBe(true);
  });

  test("leaves absolute, data and views urls untouched", async () => {
    await flush();
    expect(imgHttp.getAttribute("src")).toBe("http://example.com/pic2.png");
    expect(imgData.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(imgViews.getAttribute("src")).toBe("views://studio/pic.png");
    const requestedPaths = callsFor("readFileAsDataUrl").map(
      (c) => (c.args[0] as { path: string }).path,
    );
    expect(requestedPaths.some((p) => p.includes("example.com"))).toBe(false);
    expect(requestedPaths.some((p) => p.includes("pic2"))).toBe(false);
  });

  test("resolves video poster attribute", async () => {
    await flush();
    expect(video.getAttribute("poster")).toBe("data:image/jpeg;base64,UE9TVEVS");
  });

  test("resolves nested children of an added subtree", async () => {
    await flush();
    expect(innerImg.getAttribute("src")).toBe("data:image/png;base64,TkVTVA==");
  });

  test("resolves background images on styled children of an added subtree", async () => {
    await flush();
    expect(styleChild.style.backgroundImage).toContain("data:image/png;base64,REVFUEJH");
  });

  test("rewrites style background-image url", async () => {
    await flush();
    expect(bgDiv.style.backgroundImage).toContain("data:image/png;base64,Qkc=");
    expect(
      callsFor("readFileAsDataUrl").some(
        (c) => (c.args[0] as { path: string }).path === "bg/tile.png",
      ),
    ).toBe(true);
  });

  test("ignores http, none and absent background images", async () => {
    await flush();
    expect(bgHttpDiv.style.backgroundImage).toContain("example.com/bg.png");
    expect(bgNoneDiv.style.backgroundImage).toBe("none");
    expect(plainStyleDiv.style.color).toBe("red");
    const requestedPaths = callsFor("readFileAsDataUrl").map(
      (c) => (c.args[0] as { path: string }).path,
    );
    expect(requestedPaths.some((p) => p.includes("bg.png"))).toBe(false);
  });

  test("reacts to style attribute mutations", async () => {
    await flush();
    expect(styleLateDiv.style.backgroundImage).toContain("data:image/png;base64,U1RZ");
  });

  test("leaves attribute removed when data url resolution returns empty", async () => {
    await flush();
    expect(emptyImg.getAttribute("src")).toBeNull();
  });

  test("swallows data url resolution failures", async () => {
    await flush();
    expect(failImg.getAttribute("src")).toBeNull();
  });
});
