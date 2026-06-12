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
    route("/__studio/files", () => json([{ kind: "file", name: "a.json", path: "src/a.json" }]));
    const p = createDevServerPlatform();
    const entries = await p.listDirectory("src");
    expect(callsTo("/__studio/files")[0]!.search.get("dir")).toBe("src");
    expect(entries[0].path).toBe("src/a.json");
  });

  test("with a projectRoot, '.' maps to the root and responses are stripped", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    route("/__studio/files", () =>
      json([
        { kind: "file", name: "index.json", path: "examples/site/index.json" },
        { kind: "directory", name: "outside", path: "elsewhere/outside" },
      ]),
    );
    const p = createDevServerPlatform();
    p.projectRoot = "examples/site";
    const entries = await p.listDirectory(".");
    expect(callsTo("/__studio/files")[0]!.search.get("dir")).toBe("examples/site");
    expect(entries[0].path).toBe("index.json");
    // Paths outside the root are left untouched
    expect(entries[1].path).toBe("elsewhere/outside");
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
    route("/__studio/files", () => json([{ kind: "file", name: "foo.md", path: "docs/foo.md" }]));
    const p = createDevServerPlatform();
    const results = await p.searchFiles("foo", [".md", "csv"]);
    const call = callsTo("/__studio/files")[0]!;
    expect(call.search.get("glob")).toBe("**/*foo*.{json,md,csv}");
    expect(call.search.get("dir")).toBe(".");
    expect(results).toEqual([{ kind: "file", name: "foo.md", path: "docs/foo.md" }]);
  });

  test("strips the project root from result paths", async () => {
    route("/__studio/activate", () => json({ ok: true }));
    route("/__studio/files", () =>
      json([{ kind: "file", name: "page.json", path: "site/pages/page.json" }]),
    );
    const p = createDevServerPlatform();
    p.projectRoot = "site";
    const results = await p.searchFiles("page");
    expect(callsTo("/__studio/files")[0]!.search.get("dir")).toBe("site");
    expect(results[0].path).toBe("pages/page.json");
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
  test("aiAuthStatus returns the parsed body", async () => {
    route("/__studio/ai/auth-status", () => json({ authenticated: true }));
    const p = createDevServerPlatform();
    expect(await p.aiAuthStatus()).toEqual({ authenticated: true });
  });

  test("aiCreateSession posts options and surfaces errors", async () => {
    route("/__studio/ai/session", (c) => {
      expect(c.body).toEqual({ message: "hi", systemPrompt: "be nice" });
      return json({ id: "s1" });
    });
    const p = createDevServerPlatform();
    expect(await p.aiCreateSession({ message: "hi", systemPrompt: "be nice" })).toEqual({
      id: "s1",
    });
    route("/__studio/ai/session", () => json({ error: "not authenticated" }, 401));
    expect(p.aiCreateSession({ message: "hi" })).rejects.toThrow("not authenticated");
  });

  test("aiSendMessage posts to the session endpoint and surfaces errors", async () => {
    route("/__studio/ai/session/s1/message", (c) => {
      expect(c.body).toEqual({ message: "next" });
      return json({ accepted: true });
    });
    const p = createDevServerPlatform();
    expect(await p.aiSendMessage("s1", "next")).toEqual({ accepted: true });
    route("/__studio/ai/session/s1/message", () => json({ error: "session gone" }, 404));
    expect(p.aiSendMessage("s1", "again")).rejects.toThrow("session gone");
  });

  test("aiStreamUrl builds the stream URL synchronously", () => {
    const p = createDevServerPlatform();
    expect(p.aiStreamUrl("abc")).toBe("/__studio/ai/session/abc/stream");
    expect(calls.length).toBe(0);
  });

  test("aiStopSession and aiDeleteSession hit their endpoints", async () => {
    route("/__studio/ai/session/s2/stop", () => json({}), "POST");
    route("/__studio/ai/session/s2", () => json({}), "DELETE");
    const p = createDevServerPlatform();
    await p.aiStopSession("s2");
    await p.aiDeleteSession("s2");
    expect(callsTo("/__studio/ai/session/s2/stop")[0]!.method).toBe("POST");
    expect(callsTo("/__studio/ai/session/s2")[0]!.method).toBe("DELETE");
  });
});
