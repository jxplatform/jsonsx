/**
 * Tests for the dev-server StudioPlatform adapter (src/platforms/devserver.ts).
 *
 * The adapter is exercised directly against a fetch stub with a route table that mimics the JSON
 * shapes of the /__studio/* endpoints in packages/server/src/studio-api.ts. No installMockPlatform
 * here — the adapter IS a platform.
 */
import "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDevServerPlatform } from "../src/platforms/devserver";
import type { FsEvent } from "../src/types";

/** Minimal EventSource stub: records the latest instance and lets tests emit named events. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  closed = false;
  url: string;
  private listeners = new Map<string, (ev: MessageEvent) => void>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    this.listeners.set(type, fn);
  }
  emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data } as MessageEvent);
  }
  close(): void {
    this.closed = true;
  }
}

// ─── Fetch stub with route table ─────────────────────────────────────────────

interface RecordedCall {
  body: unknown;
  method: string;
  path: string;
  rawBody: unknown;
  search: URLSearchParams;
  url: string;
}

type RouteHandler = (call: RecordedCall) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;
let routes: { handler: RouteHandler; method: string | undefined; path: string }[] = [];
let calls: RecordedCall[] = [];

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function textRes(text: string, status = 200): Response {
  return new Response(text, { status });
}

/** Register a route by pathname (and optional method). Later registrations win. */
function route(path: string, handler: RouteHandler, method?: string): void {
  routes.unshift({ handler, method, path });
}

/** Find recorded calls to a given pathname. */
function callsTo(path: string): RecordedCall[] {
  return calls.filter((c) => c.path === path);
}

beforeEach(() => {
  routes = [];
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const rawBody = init?.body;
    let body: unknown = rawBody;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const call: RecordedCall = {
      body,
      method: init?.method ?? "GET",
      path: url.pathname,
      rawBody,
      search: url.searchParams,
      url: String(input),
    };
    calls.push(call);
    const match = routes.find(
      (r) => r.path === call.path && (!r.method || r.method === call.method),
    );
    if (!match) {
      return json({ error: `no route: ${call.method} ${call.path}` }, 500);
    }
    return await match.handler(call);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
});

// ─── Fake directory handle for openProject ───────────────────────────────────

function fakeDirHandle(name: string, config: unknown | null) {
  return {
    getFileHandle: async (_file: string) => {
      if (config === null) {
        throw new Error("NotFoundError");
      }
      return {
        getFile: async () => ({ text: async () => JSON.stringify(config) }),
      };
    },
    name,
  };
}

function setPicker(fn: unknown): void {
  (window as unknown as Record<string, unknown>).showDirectoryPicker = fn;
}

// ─── Basic identity, projectRoot, activate ───────────────────────────────────

describe("devserver platform basics", () => {
  test("has id devserver and empty projectRoot by default", () => {
    const p = createDevServerPlatform();
    expect(p.id).toBe("devserver");
    expect(p.projectRoot).toBe("");
  });

  test("setting projectRoot fires activate POST with the root", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    const p = createDevServerPlatform();
    p.projectRoot = "examples/site-demo";
    expect(p.projectRoot).toBe("examples/site-demo");
    const activations = callsTo("/__studio/activate");
    expect(activations.length).toBe(1);
    expect(activations[0]!.method).toBe("POST");
    expect(activations[0]!.body).toEqual({ root: "examples/site-demo" });
  });

  test("setting projectRoot to empty/undefined does not activate", () => {
    const p = createDevServerPlatform();
    p.projectRoot = "";
    expect(p.projectRoot).toBe("");
    p.projectRoot = undefined as unknown as string;
    expect(p.projectRoot).toBe("");
    expect(callsTo("/__studio/activate").length).toBe(0);
  });

  test("activate(root) posts the given root explicitly", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    const p = createDevServerPlatform();
    await p.activate("some/dir");
    expect(callsTo("/__studio/activate")[0]!.body).toEqual({ root: "some/dir" });
  });
});

// ─── Path prefix logic (serverPath / stripRoot) ──────────────────────────────

describe("path prefix logic", () => {
  test("without a projectRoot, paths pass through unprefixed", async () => {
    route("/__studio/files", () => json([{ type: "file", name: "a.json", path: "src/a.json" }]));
    const p = createDevServerPlatform();
    const entries = await p.listDirectory("src");
    expect(callsTo("/__studio/files")[0]!.search.get("dir")).toBe("src");
    expect(entries[0]!.path).toBe("src/a.json");
  });

  test("with a projectRoot, '.' maps to the root and responses are stripped", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    route("/__studio/files", () =>
      json([
        { type: "file", name: "index.json", path: "examples/site/index.json" },
        { type: "directory", name: "outside", path: "elsewhere/outside" },
      ]),
    );
    const p = createDevServerPlatform();
    p.projectRoot = "examples/site";
    const entries = await p.listDirectory(".");
    expect(callsTo("/__studio/files")[0]!.search.get("dir")).toBe("examples/site");
    expect(entries[0]!.path).toBe("index.json");
    // Paths outside the root are left untouched
    expect(entries[1]!.path).toBe("elsewhere/outside");
  });

  test("relative paths are prefixed and backslashes normalized", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    route("/__studio/file", () => json({ content: "{}" }));
    const p = createDevServerPlatform();
    p.projectRoot = "examples/site";
    await p.readFile(String.raw`sub\page.json`);
    expect(callsTo("/__studio/file")[0]!.search.get("path")).toBe("examples/site/sub/page.json");
  });

  test("backslash paths normalize even without a projectRoot", async () => {
    route("/__studio/file", () => json({ content: "x" }));
    const p = createDevServerPlatform();
    await p.readFile(String.raw`dir\file.json`);
    expect(callsTo("/__studio/file")[0]!.search.get("path")).toBe("dir/file.json");
  });
});

// ─── openProject ─────────────────────────────────────────────────────────────

describe("openProject", () => {
  test("throws when showDirectoryPicker is unavailable", async () => {
    const p = createDevServerPlatform();
    expect(p.openProject()).rejects.toThrow(/showDirectoryPicker not available/);
  });

  test("returns null when the user cancels the picker", async () => {
    setPicker(async () => {
      throw Object.assign(new Error("user cancelled"), { name: "AbortError" });
    });
    const p = createDevServerPlatform();
    expect(await p.openProject()).toBeNull();
  });

  test("rethrows non-abort picker errors", async () => {
    setPicker(async () => {
      throw new Error("permission denied");
    });
    const p = createDevServerPlatform();
    expect(p.openProject()).rejects.toThrow("permission denied");
  });

  test("throws when the folder has no project.json", async () => {
    setPicker(async () => fakeDirHandle("no-config", null));
    const p = createDevServerPlatform();
    expect(p.openProject()).rejects.toThrow(/No project.json found/);
  });

  test("throws when the site list fetch fails", async () => {
    setPicker(async () => fakeDirHandle("demo", { name: "Demo" }));
    route("/__studio/sites", () => json({ error: "nope" }, 500));
    const p = createDevServerPlatform();
    expect(p.openProject()).rejects.toThrow(/Failed to fetch site list/);
  });

  test("matches the config against known sites and activates the project", async () => {
    const config = { description: "d", name: "Demo Site" };
    setPicker(async () => fakeDirHandle("site-demo", config));
    route("/__studio/sites", () =>
      json([
        { config: { name: "Other" }, path: "examples/other" },
        { config, path: "examples/site-demo" },
      ]),
    );
    route("/__studio/activate", () => json({ ok: true }));
    const p = createDevServerPlatform();
    const result = await p.openProject();
    expect(result).not.toBeNull();
    expect(result!.config).toEqual(config);
    expect(result!.handle.name).toBe("Demo Site");
    expect(result!.handle.root).toBe("examples/site-demo");
    expect(result!.handle.projectConfig).toEqual(config);
    expect(p.projectRoot).toBe("examples/site-demo");
    expect(callsTo("/__studio/activate")[0]!.body).toEqual({ root: "examples/site-demo" });
  });

  test("falls back to handle name from root when config has no name", async () => {
    const config = { adapter: "static" };
    setPicker(async () => fakeDirHandle("unnamed", config));
    route("/__studio/sites", () => json([{ config, path: "deep/nested/unnamed" }]));
    route("/__studio/activate", () => json({ ok: true }));
    const p = createDevServerPlatform();
    const result = await p.openProject();
    expect(result!.handle.name).toBe("unnamed");
  });

  test("uses find-project when the config matches no known site", async () => {
    const config = { name: "Outside" };
    setPicker(async () => fakeDirHandle("outside-dir", config));
    route("/__studio/sites", () => json([]));
    route("/__studio/find-project", (c) => {
      expect(c.search.get("name")).toBe("outside-dir");
      return json({ path: "../external/outside-dir" });
    });
    route("/__studio/activate", () => json({ ok: true }));
    const p = createDevServerPlatform();
    const result = await p.openProject();
    expect(result!.handle.root).toBe("../external/outside-dir");
    expect(p.projectRoot).toBe("../external/outside-dir");
  });

  test("throws when find-project request fails", async () => {
    setPicker(async () => fakeDirHandle("ghost", { name: "Ghost" }));
    route("/__studio/sites", () => json([]));
    route("/__studio/find-project", () => json({ error: "x" }, 500));
    const p = createDevServerPlatform();
    expect(p.openProject()).rejects.toThrow(/Could not locate project on disk/);
  });

  test("throws when find-project returns no path", async () => {
    setPicker(async () => fakeDirHandle("ghost", { name: "Ghost" }));
    route("/__studio/sites", () => json([]));
    route("/__studio/find-project", () => json({ path: null }));
    const p = createDevServerPlatform();
    expect(p.openProject()).rejects.toThrow('Could not find project directory "ghost"');
  });
});

// ─── probeRootProject ────────────────────────────────────────────────────────

describe("probeRootProject", () => {
  test("returns meta and info when both endpoints respond", async () => {
    route("/__studio/project", () => json({ name: "my-site", root: "/srv/site" }));
    route("/__studio/project-info", (c) => {
      expect(c.search.get("dir")).toBe(".");
      return json({ config: { name: "my-site" }, isSiteProject: true });
    });
    const p = createDevServerPlatform();
    const result = await p.probeRootProject();
    expect(result).toEqual({
      info: { config: { name: "my-site" }, isSiteProject: true },
      meta: { name: "my-site", root: "/srv/site" },
    });
  });

  test("falls back to defaults when endpoints respond non-ok", async () => {
    route("/__studio/project", () => json({}, 500));
    route("/__studio/project-info", () => json({}, 500));
    const p = createDevServerPlatform();
    const result = await p.probeRootProject();
    expect(result).toEqual({
      info: { isSiteProject: false },
      meta: { name: "project", root: "." },
    });
  });

  test("returns null when fetch throws", async () => {
    route("/__studio/project", () => {
      throw new Error("network down");
    });
    route("/__studio/project-info", () => json({ isSiteProject: false }));
    const p = createDevServerPlatform();
    expect(await p.probeRootProject()).toBeNull();
  });
});

// ─── createProject ───────────────────────────────────────────────────────────

describe("createProject", () => {
  test("posts the options and returns the server response", async () => {
    route("/__studio/create-project", (c) => {
      expect(c.body).toEqual({ directory: "examples", name: "fresh" });
      return json({ config: { name: "fresh" }, root: "examples/fresh" });
    });
    const p = createDevServerPlatform();
    const result = await p.createProject({ directory: "examples", name: "fresh" });
    expect(result).toEqual({ config: { name: "fresh" }, root: "examples/fresh" });
  });

  test("throws the server error message on failure", async () => {
    route("/__studio/create-project", () => json({ error: "directory exists" }, 400));
    const p = createDevServerPlatform();
    expect(p.createProject({ directory: "x", name: "y" })).rejects.toThrow("directory exists");
  });

  test("throws a generic message when the error body has no error field", async () => {
    route("/__studio/create-project", () => json({}, 500));
    const p = createDevServerPlatform();
    expect(p.createProject({ directory: "x", name: "y" })).rejects.toThrow(
      "Failed to create project",
    );
  });
});

// ─── File operations ─────────────────────────────────────────────────────────

describe("file operations", () => {
  test("listDirectory throws on failure", async () => {
    route("/__studio/files", () => json({ error: "bad dir" }, 400));
    const p = createDevServerPlatform();
    expect(p.listDirectory("nope")).rejects.toThrow("Failed to list directory: nope");
  });

  test("readFile returns the content field", async () => {
    route("/__studio/file", () => json({ content: '{"tagName":"div"}' }));
    const p = createDevServerPlatform();
    expect(await p.readFile("index.json")).toBe('{"tagName":"div"}');
  });

  test("readFile throws on failure", async () => {
    route("/__studio/file", () => json({ error: "missing" }, 404));
    const p = createDevServerPlatform();
    expect(p.readFile("missing.json")).rejects.toThrow("Failed to read file: missing.json");
  });

  test("writeFile PUTs raw content to the prefixed path", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    route("/__studio/file", () => json({ ok: true }), "PUT");
    const p = createDevServerPlatform();
    p.projectRoot = "site";
    await p.writeFile("page.json", '{"a":1}');
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/__studio/file");
    expect(put.search.get("path")).toBe("site/page.json");
    expect(put.rawBody).toBe('{"a":1}');
  });

  test("writeFile throws on failure", async () => {
    route("/__studio/file", () => json({}, 500), "PUT");
    const p = createDevServerPlatform();
    expect(p.writeFile("p.json", "{}")).rejects.toThrow("Failed to write file: p.json");
  });

  test("uploadFile posts binary data and returns the response", async () => {
    route("/__studio/file/upload", () => json({ path: "media/pic.png" }), "POST");
    const p = createDevServerPlatform();
    const buf = new ArrayBuffer(4);
    const result = await p.uploadFile("media/pic.png", buf);
    expect(result).toEqual({ path: "media/pic.png" });
    const call = callsTo("/__studio/file/upload")[0]!;
    expect(call.search.get("path")).toBe("media/pic.png");
    expect(call.rawBody).toBe(buf);
  });

  test("uploadFile throws on failure", async () => {
    route("/__studio/file/upload", () => json({}, 500), "POST");
    const p = createDevServerPlatform();
    expect(p.uploadFile("media/x.png", "data")).rejects.toThrow("Upload failed: media/x.png");
  });

  test("deleteFile succeeds on ok and tolerates 404", async () => {
    route("/__studio/file", () => json({ ok: true }), "DELETE");
    const p = createDevServerPlatform();
    await p.deleteFile("a.json");
    route("/__studio/file", () => json({ error: "gone" }, 404), "DELETE");
    await p.deleteFile("already-gone.json");
    expect(calls.filter((c) => c.method === "DELETE").length).toBe(2);
  });

  test("deleteFile throws on non-404 failure", async () => {
    route("/__studio/file", () => json({}, 500), "DELETE");
    const p = createDevServerPlatform();
    expect(p.deleteFile("locked.json")).rejects.toThrow("Failed to delete file: locked.json");
  });

  test("renameFile posts prefixed from/to paths", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    route("/__studio/file/rename", (c) => {
      expect(c.body).toEqual({ from: "site/a.json", to: "site/b.json" });
      return json({ ok: true });
    });
    const p = createDevServerPlatform();
    p.projectRoot = "site";
    await p.renameFile("a.json", "b.json");
    expect(callsTo("/__studio/file/rename").length).toBe(1);
  });

  test("renameFile throws on failure", async () => {
    route("/__studio/file/rename", () => json({}, 500));
    const p = createDevServerPlatform();
    expect(p.renameFile("a.json", "b.json")).rejects.toThrow("Failed to rename: a.json → b.json");
  });

  test("renameFile maps the refactor report back to project-relative paths", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    route("/__studio/file/rename", () =>
      json({
        errors: [{ error: "x", path: "site/bad.json" }],
        from: "site/a.json",
        ok: true,
        references: {
          files: [{ count: 2, path: "site/pages/index.json" }],
          filesChanged: 1,
          refsUpdated: 2,
        },
        to: "site/b.json",
      }),
    );
    const p = createDevServerPlatform();
    p.projectRoot = "site";
    const report = await p.renameFile("a.json", "b.json");
    expect(report).toMatchObject({
      errors: [{ path: "bad.json" }],
      from: "a.json",
      references: { files: [{ count: 2, path: "pages/index.json" }] },
      to: "b.json",
    });
  });

  test("subscribeFileEvents strips and filters fs events from the SSE stream", () => {
    const original = (globalThis as { EventSource?: unknown }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    try {
      route("/__studio/activate", () => json({ ok: true }));
      const p = createDevServerPlatform();
      p.projectRoot = "site";
      const received: FsEvent[] = [];
      const stop = p.subscribeFileEvents?.((events) => received.push(...events)) ?? (() => {});
      const es = FakeEventSource.last;
      es?.emit(
        "fs",
        JSON.stringify({
          events: [
            { isDir: false, path: "site/pages/a.json", type: "add" },
            { isDir: false, path: "other/x.json", type: "add" },
          ],
        }),
      );
      expect(received).toEqual([{ isDir: false, path: "pages/a.json", type: "add" }]);
      stop();
      expect(es?.closed).toBe(true);
    } finally {
      (globalThis as { EventSource?: unknown }).EventSource = original;
    }
  });

  test("createDirectory is a no-op that resolves without fetching", async () => {
    const p = createDevServerPlatform();
    await p.createDirectory("anything");
    expect(calls.length).toBe(0);
  });
});

// ─── Component discovery, packages, code services ────────────────────────────

describe("discoverComponents", () => {
  test("returns [] without fetching when no dir and no projectRoot", async () => {
    const p = createDevServerPlatform();
    expect(await p.discoverComponents()).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("falls back to the projectRoot when no dir is given", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    route("/__studio/components", (c) => {
      expect(c.search.get("dir")).toBe("examples/site");
      return json([{ name: "Card", path: "components/card.class.json" }]);
    });
    const p = createDevServerPlatform();
    p.projectRoot = "examples/site";
    const comps = await p.discoverComponents();
    expect(comps).toEqual([{ name: "Card", path: "components/card.class.json" }]);
  });

  test("uses the explicit dir argument as-is and returns [] on failure", async () => {
    route("/__studio/components", (c) => {
      expect(c.search.get("dir")).toBe("other/dir");
      return json({ error: "x" }, 500);
    });
    const p = createDevServerPlatform();
    expect(await p.discoverComponents("other/dir")).toEqual([]);
  });
});

describe("packages", () => {
  test("addPackage posts the name and returns the result", async () => {
    route("/__studio/packages/add", (c) => {
      expect(c.body).toEqual({ name: "@scope/pkg" });
      return json({ added: "@scope/pkg" });
    });
    const p = createDevServerPlatform();
    expect(await p.addPackage("@scope/pkg")).toEqual({ added: "@scope/pkg" });
  });

  test("addPackage throws the response text on failure", async () => {
    route("/__studio/packages/add", () => textRes("registry unreachable", 502));
    const p = createDevServerPlatform();
    expect(p.addPackage("bad")).rejects.toThrow("registry unreachable");
  });

  test("removePackage posts the name and returns the result", async () => {
    route("/__studio/packages/remove", (c) => {
      expect(c.body).toEqual({ name: "old-pkg" });
      return json({ removed: true });
    });
    const p = createDevServerPlatform();
    expect(await p.removePackage("old-pkg")).toEqual({ removed: true });
  });

  test("removePackage throws the response text on failure", async () => {
    route("/__studio/packages/remove", () => textRes("not installed", 400));
    const p = createDevServerPlatform();
    expect(p.removePackage("ghost")).rejects.toThrow("not installed");
  });

  test("listPackages returns the list, or [] on failure", async () => {
    route("/__studio/packages", () => json([{ name: "a", version: "1.0.0" }]));
    const p = createDevServerPlatform();
    expect(await p.listPackages()).toEqual([{ name: "a", version: "1.0.0" }]);
    route("/__studio/packages", () => json({}, 500));
    expect(await p.listPackages()).toEqual([]);
  });

  test("installDependencies posts install, returning the result or a failure log", async () => {
    route("/__studio/packages/install", () => json({ ok: true }), "POST");
    const p = createDevServerPlatform();
    expect(await p.installDependencies!()).toEqual({ ok: true });
    route("/__studio/packages/install", () => textRes("install boom", 500), "POST");
    expect(await p.installDependencies!()).toEqual({ log: "install boom", ok: false });
  });

  test("dependenciesNeedInstall reflects the needsInstall flag", async () => {
    route("/__studio/packages/needs-install", () => json({ needsInstall: true }));
    const p = createDevServerPlatform();
    expect(await p.dependenciesNeedInstall!()).toBe(true);
    route("/__studio/packages/needs-install", () => json({}, 500));
    expect(await p.dependenciesNeedInstall!()).toBe(false);
  });

  test("outdatedPackages returns the list, or [] on failure", async () => {
    route("/__studio/packages/outdated", () =>
      json([{ current: "^1.0.0", latest: "2.0.0", name: "a" }]),
    );
    const p = createDevServerPlatform();
    expect(await p.outdatedPackages!()).toEqual([
      { current: "^1.0.0", latest: "2.0.0", name: "a" },
    ]);
    route("/__studio/packages/outdated", () => json({}, 500));
    expect(await p.outdatedPackages!()).toEqual([]);
  });

  test("setPackageVersions posts the updates, returning the result or a failure log", async () => {
    const updates = [{ dev: false, name: "a", version: "^2.0.0" }];
    route(
      "/__studio/packages/set-versions",
      (c) => {
        expect(c.body).toEqual({ updates });
        return json({ ok: true });
      },
      "POST",
    );
    const p = createDevServerPlatform();
    expect(await p.setPackageVersions!(updates)).toEqual({ ok: true });
    route("/__studio/packages/set-versions", () => textRes("conflict", 500), "POST");
    expect(await p.setPackageVersions!(updates)).toEqual({ log: "conflict", ok: false });
  });
});

describe("codeService", () => {
  test("posts the payload to the action endpoint and returns the result", async () => {
    route("/__studio/code/lint", (c) => {
      expect(c.body).toEqual({ source: "x" });
      return json({ diagnostics: [] });
    });
    const p = createDevServerPlatform();
    expect(await p.codeService("lint", { source: "x" })).toEqual({ diagnostics: [] });
  });

  test("returns null on non-ok responses and on network errors", async () => {
    route("/__studio/code/format", () => json({}, 500));
    const p = createDevServerPlatform();
    expect(await p.codeService("format", {})).toBeNull();
    route("/__studio/code/boom", () => {
      throw new Error("offline");
    });
    expect(await p.codeService("boom", {})).toBeNull();
  });
});

// ─── Site context, locate, search, formats, plugin schema ────────────────────

describe("resolveSiteContext", () => {
  test("returns the server payload on success", async () => {
    route("/__studio/resolve-site", (c) => {
      expect(c.search.get("path")).toBe("/abs/site/pages/p.json");
      return json({ projectConfig: { name: "S" }, sitePath: "/abs/site" });
    });
    const p = createDevServerPlatform();
    expect(await p.resolveSiteContext("/abs/site/pages/p.json")).toEqual({
      projectConfig: { name: "S" },
      sitePath: "/abs/site",
    });
  });

  test("returns { sitePath: null } on failure", async () => {
    route("/__studio/resolve-site", () => json({}, 500));
    const p = createDevServerPlatform();
    expect(await p.resolveSiteContext("/nowhere")).toEqual({ sitePath: null });
  });
});

describe("locateFile", () => {
  test("returns the located path", async () => {
    route("/__studio/locate", (c) => {
      expect(c.body).toEqual({ name: "header.json" });
      return json({ path: "components/header.json" });
    });
    const p = createDevServerPlatform();
    expect(await p.locateFile("header.json")).toBe("components/header.json");
  });

  test("returns null when the body has no path, on non-ok, and on throw", async () => {
    route("/__studio/locate", () => json({}));
    const p = createDevServerPlatform();
    expect(await p.locateFile("a")).toBeNull();
    route("/__studio/locate", () => json({}, 404));
    expect(await p.locateFile("b")).toBeNull();
    route("/__studio/locate", () => {
      throw new Error("offline");
    });
    expect(await p.locateFile("c")).toBeNull();
  });
});

describe("searchFiles", () => {
  test("builds a glob from the query plus normalized extensions", async () => {
    route("/__studio/files", () => json([{ type: "file", name: "foo.md", path: "docs/foo.md" }]));
    const p = createDevServerPlatform();
    const results = await p.searchFiles("foo", [".md", "csv"]);
    const call = callsTo("/__studio/files")[0]!;
    expect(call.search.get("glob")).toBe("**/*foo*.{json,md,csv}");
    expect(call.search.get("dir")).toBe(".");
    expect(results).toEqual([{ type: "file", name: "foo.md", path: "docs/foo.md" }]);
  });

  test("strips the project root from result paths", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    route("/__studio/files", () =>
      json([{ type: "file", name: "page.json", path: "site/pages/page.json" }]),
    );
    const p = createDevServerPlatform();
    p.projectRoot = "site";
    const results = await p.searchFiles("page");
    expect(callsTo("/__studio/files")[0]!.search.get("dir")).toBe("site");
    expect(results[0]!.path).toBe("pages/page.json");
  });

  test("returns [] on failure", async () => {
    route("/__studio/files", () => json({}, 500));
    const p = createDevServerPlatform();
    expect(await p.searchFiles("anything")).toEqual([]);
  });
});

describe("formats", () => {
  test("listFormats returns body.formats and defaults to []", async () => {
    route("/__studio/formats", (c) => {
      expect(c.search.get("dir")).toBe(".");
      return json({ formats: [{ extensions: [".md"], name: "markdown" }] });
    });
    const p = createDevServerPlatform();
    expect(await p.listFormats()).toEqual([{ extensions: [".md"], name: "markdown" }]);
    route("/__studio/formats", () => json({}));
    expect(await p.listFormats()).toEqual([]);
    route("/__studio/formats", () => json({}, 500));
    expect(await p.listFormats()).toEqual([]);
  });

  test("listExtensions returns body.extensions and defaults to []", async () => {
    const payload = [
      {
        contributions: [
          {
            className: "Content",
            entrySchema: { type: "object" },
            project: { key: "content" },
            studio: { settings: { layout: "map" } },
          },
        ],
        name: "@jxsuite/parser",
        specifier: "@jxsuite/parser",
        title: "Content & Markdown",
      },
    ];
    route("/__studio/formats", (c) => {
      expect(c.search.get("dir")).toBe(".");
      return json({ extensions: payload, formats: [] });
    });
    const p = createDevServerPlatform();
    expect(await p.listExtensions()).toEqual(payload);
    route("/__studio/formats", () => json({ formats: [] }));
    expect(await p.listExtensions()).toEqual([]);
    route("/__studio/formats", () => json({}, 500));
    expect(await p.listExtensions()).toEqual([]);
  });

  test("fetchProjectSchemas returns the bundled pair and degrades to {}", async () => {
    route("/__studio/project-schemas", (c) => {
      expect(c.search.get("dir")).toBe(".");
      return json({ document: { $ref: "https://jxsuite.com/schema/v1" }, project: { allOf: [] } });
    });
    const p = createDevServerPlatform();
    expect(await p.fetchProjectSchemas()).toEqual({
      document: { $ref: "https://jxsuite.com/schema/v1" },
      project: { allOf: [] },
    });
    route("/__studio/project-schemas", () => json({ error: "boom" }, 500));
    expect(await p.fetchProjectSchemas()).toEqual({});
  });

  test("formatAction posts the payload plus dir and returns result", async () => {
    route("/__studio/format", (c) => {
      expect(c.body).toEqual({ action: "parse", dir: ".", format: "markdown", source: "# hi" });
      return json({ result: { tagName: "h1" } });
    });
    const p = createDevServerPlatform();
    const result = await p.formatAction({ action: "parse", format: "markdown", source: "# hi" });
    expect(result).toEqual({ tagName: "h1" });
  });

  test("formatAction throws the server error or a generic fallback", async () => {
    route("/__studio/format", () => json({ error: "unknown format" }, 400));
    const p = createDevServerPlatform();
    expect(p.formatAction({ format: "nope" })).rejects.toThrow("unknown format");
    route("/__studio/format", () => json({}, 500));
    expect(p.formatAction({ format: "nope" })).rejects.toThrow("Format action failed");
  });
});

describe("fetchPluginSchema", () => {
  test("passes src/prototype/base params and unwraps schema", async () => {
    route("/__studio/plugin-schema", (c) => {
      expect(c.search.get("src")).toBe("./plugin.js");
      expect(c.search.get("prototype")).toBe("Request");
      expect(c.search.get("base")).toBe("site");
      return json({ schema: { type: "object" } });
    });
    const p = createDevServerPlatform();
    expect(await p.fetchPluginSchema("./plugin.js", "Request", "site")).toEqual({
      type: "object",
    });
  });

  test("omits optional params and returns null on failure", async () => {
    route("/__studio/plugin-schema", (c) => {
      expect(c.search.has("prototype")).toBe(false);
      expect(c.search.has("base")).toBe(false);
      return json({}, 404);
    });
    const p = createDevServerPlatform();
    expect(await p.fetchPluginSchema("./missing.js")).toBeNull();
  });
});

// ─── Class resolution (dev-proxy) ────────────────────────────────────────────

describe("resolveClass", () => {
  test("POSTs the config to /__jx_resolve__ and returns the parsed result", async () => {
    route(
      "/__jx_resolve__",
      (c) => {
        expect(c.body).toEqual({
          $prototype: "ContentCollection",
          $src: "@jxsuite/parser/ContentCollection.class.json",
          contentType: "product",
        });
        return json([{ data: { sku: "a" }, id: "A" }]);
      },
      "POST",
    );
    const p = createDevServerPlatform();
    expect(
      await p.resolveClass!({
        $prototype: "ContentCollection",
        $src: "@jxsuite/parser/ContentCollection.class.json",
        contentType: "product",
      }),
    ).toEqual([{ data: { sku: "a" }, id: "A" }]);
  });

  test("throws on a non-OK response", async () => {
    route("/__jx_resolve__", () => textRes("boom", 500), "POST");
    const p = createDevServerPlatform();
    expect(p.resolveClass!({ $src: "x" })).rejects.toThrow("Class resolution failed: 500");
  });
});

// ─── Git operations ──────────────────────────────────────────────────────────

describe("git read operations", () => {
  test("gitStatus returns the parsed status and throws text on failure", async () => {
    const status = { ahead: 0, behind: 0, branch: "main", files: [] };
    route("/__studio/git/status", () => json(status));
    const p = createDevServerPlatform();
    expect(await p.gitStatus()).toEqual(status);
    route("/__studio/git/status", () => textRes("not a git repo", 500));
    expect(p.gitStatus()).rejects.toThrow("not a git repo");
  });

  test("gitBranches returns branches and throws text on failure", async () => {
    route("/__studio/git/branches", () => json({ branches: ["main", "dev"], current: "main" }));
    const p = createDevServerPlatform();
    expect(await p.gitBranches()).toEqual({ branches: ["main", "dev"], current: "main" });
    route("/__studio/git/branches", () => textRes("boom", 500));
    expect(p.gitBranches()).rejects.toThrow("boom");
  });

  test("gitLog forwards the limit query and throws text on failure", async () => {
    route("/__studio/git/log", (c) => {
      expect(c.search.get("limit")).toBe("5");
      return json([{ hash: "abc", message: "init" }]);
    });
    const p = createDevServerPlatform();
    expect(await p.gitLog(5)).toEqual([{ hash: "abc", message: "init" }]);
    route("/__studio/git/log", (c) => {
      expect(c.search.has("limit")).toBe(false);
      return textRes("git error", 500);
    });
    expect(p.gitLog()).rejects.toThrow("git error");
  });

  test("gitDiff passes the path (or empty) and throws text on failure", async () => {
    route("/__studio/git/diff", (c) => {
      expect(c.search.get("path")).toBe("a.json");
      return json({ diff: "+x" });
    });
    const p = createDevServerPlatform();
    expect(await p.gitDiff("a.json")).toEqual({ diff: "+x" });
    route("/__studio/git/diff", (c) => {
      expect(c.search.get("path")).toBe("");
      return textRes("fail", 500);
    });
    expect(p.gitDiff()).rejects.toThrow("fail");
  });

  test("gitShow unwraps content, supports ref, throws text on failure", async () => {
    route("/__studio/git/show", (c) => {
      expect(c.search.get("path")).toBe("a.json");
      expect(c.search.get("ref")).toBe("HEAD~1");
      return json({ content: "old content" });
    });
    const p = createDevServerPlatform();
    expect(await p.gitShow({ path: "a.json", ref: "HEAD~1" })).toBe("old content");
    route("/__studio/git/show", (c) => {
      expect(c.search.has("ref")).toBe(false);
      return textRes("unknown ref", 400);
    });
    expect(p.gitShow({ path: "a.json" })).rejects.toThrow("unknown ref");
  });
});

describe("git write operations", () => {
  const postCases: [
    string,
    string,
    (p: ReturnType<typeof createDevServerPlatform>) => Promise<unknown>,
    unknown,
  ][] = [
    ["gitStage", "/__studio/git/stage", (p) => p.gitStage(["a.json"]), { files: ["a.json"] }],
    ["gitUnstage", "/__studio/git/unstage", (p) => p.gitUnstage(["b.json"]), { files: ["b.json"] }],
    ["gitCommit", "/__studio/git/commit", (p) => p.gitCommit("msg"), { message: "msg" }],
    [
      "gitPush",
      "/__studio/git/push",
      (p) => p.gitPush({ setUpstream: true }),
      { setUpstream: true },
    ],
    ["gitCheckout", "/__studio/git/checkout", (p) => p.gitCheckout("dev"), { branch: "dev" }],
    [
      "gitCreateBranch",
      "/__studio/git/create-branch",
      (p) => p.gitCreateBranch("feat"),
      { name: "feat" },
    ],
    ["gitDiscard", "/__studio/git/discard", (p) => p.gitDiscard(["c.json"]), { files: ["c.json"] }],
    [
      "gitClone",
      "/__studio/git/clone",
      (p) => p.gitClone("https://example.com/r.git"),
      { url: "https://example.com/r.git" },
    ],
  ];

  for (const [name, path, invoke, expectedBody] of postCases) {
    test(`${name} posts the expected body and returns json`, async () => {
      route(path, (c) => {
        expect(c.method).toBe("POST");
        expect(c.body).toEqual(expectedBody);
        return json({ ok: true });
      });
      const p = createDevServerPlatform();
      expect(await invoke(p)).toEqual({ ok: true });
    });

    test(`${name} throws body.error on failure`, async () => {
      route(path, () => json({ error: `${name} failed` }, 500));
      const p = createDevServerPlatform();
      expect(invoke(p)).rejects.toThrow(`${name} failed`);
    });
  }

  test("gitPush defaults to an empty options body", async () => {
    route("/__studio/git/push", (c) => {
      expect(c.body).toEqual({});
      return json({ ok: true });
    });
    const p = createDevServerPlatform();
    expect(await p.gitPush()).toEqual({ ok: true });
  });

  test("gitPull and gitFetch post and surface errors", async () => {
    route("/__studio/git/pull", () => json({ pulled: true }), "POST");
    route("/__studio/git/fetch", () => json({ fetched: true }), "POST");
    const p = createDevServerPlatform();
    expect(await p.gitPull()).toEqual({ pulled: true });
    expect(await p.gitFetch()).toEqual({ fetched: true });
    route("/__studio/git/pull", () => json({ error: "merge conflict" }, 409), "POST");
    route("/__studio/git/fetch", () => json({ error: "no remote" }, 400), "POST");
    expect(p.gitPull()).rejects.toThrow("merge conflict");
    expect(p.gitFetch()).rejects.toThrow("no remote");
  });

  test("gitInit posts and surfaces errors", async () => {
    route("/__studio/git/init", () => json({ ok: true }), "POST");
    const p = createDevServerPlatform();
    expect(await p.gitInit()).toBeUndefined();
    route("/__studio/git/init", () => json({ error: "already a repo" }, 400), "POST");
    expect(p.gitInit()).rejects.toThrow("already a repo");
  });

  test("gitAddRemote posts name and url, surfaces errors", async () => {
    route("/__studio/git/add-remote", (c) => {
      expect(c.body).toEqual({ name: "origin", url: "git@example.com:r.git" });
      return json({ ok: true });
    });
    const p = createDevServerPlatform();
    expect(await p.gitAddRemote("origin", "git@example.com:r.git")).toBeUndefined();
    route("/__studio/git/add-remote", () => json({ error: "remote exists" }, 400));
    expect(p.gitAddRemote("origin", "x")).rejects.toThrow("remote exists");
  });
});

// ─── AI assistant ────────────────────────────────────────────────────────────

describe("AI assistant", () => {
  test("aiChatUrl points at the proxy chat endpoint synchronously", () => {
    const p = createDevServerPlatform();
    expect(p.aiChatUrl()).toBe("/__studio/ai/chat");
    expect(calls.length).toBe(0);
  });
});

describe("listProjects", () => {
  test("maps /__studio/sites entries to catalogue entries", async () => {
    route("/__studio/sites", () =>
      json([
        { config: { name: "Named Site" }, path: "sites/named" },
        { config: {}, path: "sites/anon" },
      ]),
    );
    const p = createDevServerPlatform();
    expect(await p.listProjects?.()).toEqual([
      { name: "Named Site", root: "sites/named", description: "sites/named" },
      { name: "anon", root: "sites/anon", description: "sites/anon" },
    ]);
  });

  test("returns [] when the sites endpoint fails", async () => {
    route("/__studio/sites", () => json({ error: "nope" }, 500));
    const p = createDevServerPlatform();
    expect(await p.listProjects?.()).toEqual([]);
  });
});

describe("cloudflare publish surface", () => {
  test("cfApi forwards through the proxy with the stored token and unwraps result", async () => {
    localStorage.setItem("jx.cf.token", "cf_tok");
    route("/__studio/cf/proxy", () =>
      json({ success: true, result: [{ id: "acct", name: "Acme" }] }, 200),
    );
    const p = createDevServerPlatform();
    const accounts = await p.cfApi?.("/accounts");
    expect(accounts).toEqual([{ id: "acct", name: "Acme" }]);
    const call = callsTo("/__studio/cf/proxy")[0]!;
    expect((call.body as { path: string }).path).toBe("/accounts");
    localStorage.removeItem("jx.cf.token");
  });

  test("cfApi throws without a token and surfaces Cloudflare errors", async () => {
    localStorage.removeItem("jx.cf.token");
    const p = createDevServerPlatform();
    expect(p.cfApi?.("/accounts")).rejects.toThrow(/No Cloudflare API token/);

    localStorage.setItem("jx.cf.token", "cf_tok");
    route("/__studio/cf/proxy", () =>
      json({ success: false, errors: [{ message: "denied" }] }, 403),
    );
    expect(p.cfApi?.("/accounts")).rejects.toThrow(/denied/);
    localStorage.removeItem("jx.cf.token");
  });

  test("cfConnection is null without a token, verified with one", async () => {
    localStorage.removeItem("jx.cf.token");
    localStorage.removeItem("jx.cf.accountId");
    const p = createDevServerPlatform();
    expect(await p.cfConnection?.()).toBeNull();

    localStorage.setItem("jx.cf.token", "cf_tok");
    route("/__studio/cf/proxy", () =>
      json({ success: true, result: [{ id: "acct1", name: "Acme" }] }, 200),
    );
    expect(await p.cfConnection?.()).toEqual({
      connected: true,
      accountId: "acct1",
      accountName: "Acme",
    });
    expect(localStorage.getItem("jx.cf.accountId")).toBe("acct1");

    route("/__studio/cf/proxy", () => json({ success: false, errors: [] }, 401));
    expect(await p.cfConnection?.()).toEqual({ connected: false });
    localStorage.removeItem("jx.cf.token");
    localStorage.removeItem("jx.cf.accountId");
  });
});

describe("collab capability", () => {
  test("a server without the endpoint degrades to solo, probing once", async () => {
    const platform = createDevServerPlatform();
    expect(await platform.collab?.("pages/index.md")).toBeNull();
    expect(await platform.collab?.("pages/index.md")).toBeNull();
    expect(callsTo("/__studio/collab")).toHaveLength(1);
  });

  test("a capable server opens the multiplexed socket at /__studio/collab", async () => {
    route("/__studio/collab", () => json({ collab: true, version: 1 }));
    const seen: string[] = [];
    class RecordingWebSocket {
      binaryType = "";
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      sent = 0;
      constructor(url: string) {
        seen.push(url);
      }
      send(): void {
        this.sent += 1;
      }
      close(): void {
        this.sent = -1;
      }
    }
    const realWs = (globalThis as Record<string, unknown>)["WebSocket"];
    (globalThis as Record<string, unknown>)["WebSocket"] = RecordingWebSocket;
    try {
      const platform = createDevServerPlatform();
      // The open never resolves (the socket never answers); only the URL contract is under test.
      void platform.collab?.("pages/index.md");
      const deadline = Date.now() + 3000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      expect(seen).toEqual([`ws://${location.host}/__studio/collab`]);
    } finally {
      (globalThis as Record<string, unknown>)["WebSocket"] = realWs;
    }
  });
});

// ─── Data surface + secrets ──────────────────────────────────────────────────

describe("data surface + secrets", () => {
  test("dataConnections GETs the connections route scoped to the project dir", async () => {
    route("/__studio/data/connections", () => json({ connections: [] }));
    const p = createDevServerPlatform();
    p.projectRoot = "examples/site-demo";
    route("/__studio/activate", () => json({ ok: true }));
    expect(await p.dataConnections()).toEqual({ connections: [] });
    const [call] = callsTo("/__studio/data/connections");
    expect(call!.search.get("dir")).toBe("examples/site-demo");
  });

  test("dataConnections surfaces backend errors", async () => {
    route("/__studio/data/connections", () => json({ error: "boom" }, 500));
    const p = createDevServerPlatform();
    expect(p.dataConnections()).rejects.toThrow("boom");
  });

  test("dataConnectionTest POSTs the connection name", async () => {
    route("/__studio/data/connections/test", () => json({ ok: true }));
    const p = createDevServerPlatform();
    expect(await p.dataConnectionTest("main")).toEqual({ ok: true });
    const [call] = callsTo("/__studio/data/connections/test");
    expect(call!.method).toBe("POST");
    expect(call!.body).toEqual({ connection: "main" });
  });

  test("dataPush passes connection/dryRun and throws on failure", async () => {
    route("/__studio/data/push", () => json({ applied: false, plan: [] }));
    const p = createDevServerPlatform();
    expect(await p.dataPush({ connection: "main", dryRun: true })).toEqual({
      applied: false,
      plan: [],
    });
    expect(callsTo("/__studio/data/push")[0]!.body).toEqual({ connection: "main", dryRun: true });

    route("/__studio/data/push", () => json({ error: "no such connection" }, 404));
    expect(p.dataPush()).rejects.toThrow("no such connection");
  });

  test("dataRows maps the query into params", async () => {
    route("/__studio/data/rows", () => json({ columns: [], rows: [], total: 0 }), "GET");
    const p = createDevServerPlatform();
    await p.dataRows({
      connection: "main",
      dir: "desc",
      limit: 50,
      offset: 100,
      orderBy: "title",
      table: "posts",
    });
    const [call] = callsTo("/__studio/data/rows");
    expect(call!.search.get("table")).toBe("posts");
    expect(call!.search.get("connection")).toBe("main");
    expect(call!.search.get("limit")).toBe("50");
    expect(call!.search.get("offset")).toBe("100");
    expect(call!.search.get("orderBy")).toBe("title");
    expect(call!.search.get("dir")).toBe("desc");
  });

  test("dataRows throws the backend error", async () => {
    route("/__studio/data/rows", () => json({ error: "Unknown table" }, 404), "GET");
    const p = createDevServerPlatform();
    expect(p.dataRows({ table: "ghost" })).rejects.toThrow("Unknown table");
  });

  test("row mutations use POST/PUT/DELETE on the shared path", async () => {
    route("/__studio/data/rows", () => json({ row: { id: "n" } }, 201), "POST");
    route("/__studio/data/rows", () => json({ row: { id: "n", title: "t" } }), "PUT");
    route("/__studio/data/rows", () => json({ ok: true }), "DELETE");
    const p = createDevServerPlatform();

    const inserted = await p.dataInsertRow({ table: "posts", values: { title: "t" } });
    expect(inserted.row.id).toBe("n");
    const updated = await p.dataUpdateRow({ pk: "n", set: { title: "t" }, table: "posts" });
    expect(updated.row.title).toBe("t");
    const deleted = await p.dataDeleteRow({ connection: "main", pk: "n", table: "posts" });
    expect(deleted).toEqual({ ok: true });

    const del = calls.find((c) => c.method === "DELETE" && c.path === "/__studio/data/rows");
    expect(del!.search.get("pk")).toBe("n");
    expect(del!.search.get("table")).toBe("posts");
    expect(del!.search.get("connection")).toBe("main");
  });

  test("row mutation errors surface", async () => {
    route("/__studio/data/rows", () => json({ error: "Validation failed" }, 400), "POST");
    route("/__studio/data/rows", () => json({ error: "Not found" }, 404), "PUT");
    route("/__studio/data/rows", () => json({ error: "Not found" }, 404), "DELETE");
    const p = createDevServerPlatform();
    expect(p.dataInsertRow({ table: "posts", values: {} })).rejects.toThrow("Validation failed");
    expect(p.dataUpdateRow({ pk: 1, set: {}, table: "posts" })).rejects.toThrow("Not found");
    expect(p.dataDeleteRow({ pk: 1, table: "posts" })).rejects.toThrow("Not found");
  });

  test("listSecrets returns names only and setSecrets PUTs the request", async () => {
    route("/__studio/secrets", () => json({ names: ["MAIN_URL"] }), "GET");
    route("/__studio/secrets", () => json({ names: ["MAIN_URL"], ok: true }), "PUT");
    const p = createDevServerPlatform();
    expect(await p.listSecrets()).toEqual(["MAIN_URL"]);
    expect(await p.setSecrets({ remove: ["OLD"], set: { MAIN_URL: "v" } })).toEqual({
      names: ["MAIN_URL"],
      ok: true,
    });
    const put = calls.find((c) => c.method === "PUT" && c.path === "/__studio/secrets");
    expect(put!.body).toEqual({ remove: ["OLD"], set: { MAIN_URL: "v" } });
  });

  test("secrets errors surface", async () => {
    route("/__studio/secrets", () => json({ error: "denied" }, 400), "GET");
    route("/__studio/secrets", () => json({ error: "bad name" }, 400), "PUT");
    const p = createDevServerPlatform();
    expect(p.listSecrets()).rejects.toThrow("denied");
    expect(p.setSecrets({ set: { X: "1" } })).rejects.toThrow("bad name");
  });
});
