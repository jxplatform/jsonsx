import "./with-dom.js";
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { registerPlatform } from "../src/platform";
import type { StudioPlatform } from "../src/types";

import {
  codeService,
  locateDocument,
  fetchPluginSchema,
  pluginSchemaCache,
  setLintMarkers,
  getFunctionArgs,
} from "../src/services/code-services";
import * as monaco from "monaco-editor/editor";

// Mock monaco-editor
void mock.module("monaco-editor/editor", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (url: any) => ({ toString: () => url }) },
  editor: {
    setModelMarkers: mock(() => {}),
  },
}));

// ─── codeService ────────────────────────────────────────────────────────────

// `setLintMarkers` reads the loaded Monaco namespace synchronously — in production it is only
// Reachable with an editor already mounted, so prime the lazy loader here (the module is mocked
// Above, so this resolves immediately).
beforeAll(async () => {
  const { loadMonaco } = await import("../src/services/monaco-lazy");
  await loadMonaco();
});

describe("codeService", () => {
  test("returns null when platform has no codeService", async () => {
    registerPlatform({} as unknown as StudioPlatform);
    const result = await codeService("lint", { code: "x" });
    expect(result).toBeNull();
  });

  test("delegates to platform.codeService", async () => {
    const mockFn = mock(() => ({ diagnostics: [] }));
    registerPlatform({ codeService: mockFn } as unknown as StudioPlatform);
    const result = await codeService("lint", { code: "x" });
    expect(result).toEqual({ diagnostics: [] });
    expect(mockFn).toHaveBeenCalledWith("lint", { code: "x" });
  });
});

// ─── locateDocument ─────────────────────────────────────────────────────────

describe("locateDocument", () => {
  test("returns null when platform has no locateFile", async () => {
    registerPlatform({} as unknown as StudioPlatform);
    const result = await locateDocument("page.json");
    expect(result).toBeNull();
  });

  test("delegates to platform.locateFile", async () => {
    const mockFn = mock(() => ({ path: "pages/page.json" }));
    registerPlatform({ locateFile: mockFn } as unknown as StudioPlatform);
    const result = await locateDocument("page.json");
    expect(result as unknown).toEqual({ path: "pages/page.json" });
    expect(mockFn).toHaveBeenCalledWith("page.json");
  });
});

// ─── fetchPluginSchema ──────────────────────────────────────────────────────

describe("fetchPluginSchema", () => {
  beforeEach(() => {
    pluginSchemaCache.clear();
  });

  test("returns null when def has no $src", async () => {
    registerPlatform({} as unknown as StudioPlatform);
    const result = await fetchPluginSchema({ $prototype: "Foo" }, {});
    expect(result).toBeNull();
  });

  test("returns null when def has no $prototype", async () => {
    registerPlatform({} as unknown as StudioPlatform);
    const result = await fetchPluginSchema({ $src: "./foo.js" }, {});
    expect(result).toBeNull();
  });

  test("returns null when platform has no fetchPluginSchema", async () => {
    registerPlatform({} as unknown as StudioPlatform);
    const result = await fetchPluginSchema({ $prototype: "Foo", $src: "./foo.js" }, {});
    expect(result).toBeNull();
    expect(pluginSchemaCache.get("./foo.js::Foo")).toBeNull();
  });

  test("fetches and caches schema from platform", async () => {
    const schema = { properties: { url: { type: "string" } } };
    const mockFn = mock(() => schema);
    registerPlatform({
      fetchPluginSchema: mockFn,
    } as unknown as StudioPlatform);
    const result = await fetchPluginSchema(
      { $prototype: "DataSource", $src: "./DataSource.class.json" },
      { documentPath: "pages/index.json" },
    );
    expect(result).toEqual(schema);
    expect(pluginSchemaCache.get("./DataSource.class.json::DataSource")).toEqual(schema);
  });

  test("returns cached schema on second call", async () => {
    const schema = { properties: {} };
    const mockFn = mock(() => schema);
    registerPlatform({
      fetchPluginSchema: mockFn,
    } as unknown as StudioPlatform);
    const def = { $prototype: "Cached", $src: "./cached.js" };
    await fetchPluginSchema(def, {});
    await fetchPluginSchema(def, {});
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test("caches null on error", async () => {
    const mockFn = mock(() => {
      throw new Error("network");
    });
    registerPlatform({
      fetchPluginSchema: mockFn,
    } as unknown as StudioPlatform);
    const def = { $prototype: "Err", $src: "./err.js" };
    const result = await fetchPluginSchema(def, {});
    expect(result).toBeNull();
    expect(pluginSchemaCache.get("./err.js::Err")).toBeNull();
  });
});

// ─── setLintMarkers ─────────────────────────────────────────────────────────

describe("setLintMarkers", () => {
  test("does nothing when editor has no model", () => {
    const editor = { getModel: () => null } as any;
    setLintMarkers(editor, []);
    // Should not throw
  });

  test("sets markers from diagnostics", () => {
    const model = {};
    const editor = { getModel: () => model } as any;
    const diagnostics = [
      {
        code: "no-unused-vars",
        help: "Remove it",
        labels: [{ span: { column: 3, length: 4, line: 5 } }],
        message: "Unused variable",
        severity: "error",
        url: null,
      },
    ] as any;
    setLintMarkers(editor, diagnostics);
    expect(monaco.editor.setModelMarkers).toHaveBeenCalled();
    const [call] = (monaco.editor.setModelMarkers as any).mock.calls;
    expect(call[0]).toBe(model);
    expect(call[1]).toBe("oxlint");
    expect(call[2][0].message).toContain("Unused variable");
    expect(call[2][0].message).toContain("Remove it");
    expect(call[2][0].startLineNumber).toBe(5);
    expect(call[2][0].startColumn).toBe(3);
    expect(call[2][0].endColumn).toBe(7);
    expect(call[2][0].severity).toBe(8); // Error
  });

  test("handles warning severity", () => {
    const editor = { getModel: () => ({}) } as any;
    const diagnostics = [
      {
        code: "prefer-const",
        labels: [{ span: { column: 1, length: 3, line: 1 } }],
        message: "Prefer const",
        severity: "warning",
        url: "https://docs.example.com",
      },
    ];
    setLintMarkers(editor, diagnostics);
    const call = (monaco.editor.setModelMarkers as any).mock.calls.at(-1);
    expect(call[2][0].severity).toBe(4); // Warning
    expect(call[2][0].code.value).toBe("prefer-const");
    expect(call[2][0].code.target.toString()).toBe("https://docs.example.com");
  });

  test("filters diagnostics without labels", () => {
    const editor = { getModel: () => ({}) } as any;
    const diagnostics = [
      { labels: [], message: "No labels", severity: "error" },
      { labels: null, message: "Null labels", severity: "error" },
      {
        code: "x",
        labels: [{ span: { column: 1, length: 1, line: 1 } }],
        message: "With label",
        severity: "error",
      },
    ] as any;
    setLintMarkers(editor, diagnostics);
    const call = (monaco.editor.setModelMarkers as any).mock.calls.at(-1);
    expect(call[2].length).toBe(1);
    expect(call[2][0].message).toBe("With label");
  });
});

// ─── getFunctionArgs ────────────────────────────────────────────────────────

describe("getFunctionArgs", () => {
  test("returns parameters from state def", () => {
    const editing = { defName: "onClick", type: "def" };
    const document = {
      state: { onClick: { parameters: ["state", "event", "el"] } },
    };
    expect(getFunctionArgs(editing, document)).toEqual(["state", "event", "el"]);
  });

  test("returns default when state def has no parameters", () => {
    const editing = { defName: "handler", type: "def" };
    const document = { state: { handler: {} } };
    expect(getFunctionArgs(editing, document)).toEqual(["state", "event"]);
  });

  test("returns default when state def not found", () => {
    const editing = { defName: "missing", type: "def" };
    const document = { state: {} };
    expect(getFunctionArgs(editing, document)).toEqual(["state", "event"]);
  });

  test("returns parameters from event node", () => {
    const editing = {
      eventKey: "onclick",
      path: ["children", 0],
      type: "event",
    };
    const document = { children: [{ onclick: { parameters: ["state"] } }] };
    expect(getFunctionArgs(editing, document)).toEqual(["state"]);
  });

  test("returns default for unknown editing type", () => {
    const editing = { type: "unknown" };
    const document = {};
    expect(getFunctionArgs(editing, document)).toEqual(["state", "event"]);
  });
});
