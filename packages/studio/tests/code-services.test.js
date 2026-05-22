import { describe, test, expect, mock, beforeEach } from "bun:test";
import { registerPlatform } from "../src/platform.js";

// Mock monaco-editor
mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (/** @type {any} */ url) => ({ toString: () => url }) },
  editor: {
    setModelMarkers: mock(() => {}),
  },
}));

import {
  codeService,
  locateDocument,
  fetchPluginSchema,
  pluginSchemaCache,
  setLintMarkers,
  getFunctionArgs,
} from "../src/services/code-services.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

// ─── codeService ────────────────────────────────────────────────────────────

describe("codeService", () => {
  test("returns null when platform has no codeService", async () => {
    registerPlatform({});
    const result = await codeService("lint", { code: "x" });
    expect(result).toBeNull();
  });

  test("delegates to platform.codeService", async () => {
    const mockFn = mock(() => ({ diagnostics: [] }));
    registerPlatform({ codeService: mockFn });
    const result = await codeService("lint", { code: "x" });
    expect(result).toEqual({ diagnostics: [] });
    expect(mockFn).toHaveBeenCalledWith("lint", { code: "x" });
  });
});

// ─── locateDocument ─────────────────────────────────────────────────────────

describe("locateDocument", () => {
  test("returns null when platform has no locateFile", async () => {
    registerPlatform({});
    const result = await locateDocument("page.json");
    expect(result).toBeNull();
  });

  test("delegates to platform.locateFile", async () => {
    const mockFn = mock(() => ({ path: "pages/page.json" }));
    registerPlatform({ locateFile: mockFn });
    const result = await locateDocument("page.json");
    expect(result).toEqual({ path: "pages/page.json" });
    expect(mockFn).toHaveBeenCalledWith("page.json");
  });
});

// ─── fetchPluginSchema ──────────────────────────────────────────────────────

describe("fetchPluginSchema", () => {
  beforeEach(() => {
    pluginSchemaCache.clear();
  });

  test("returns null when def has no $src", async () => {
    registerPlatform({});
    const result = await fetchPluginSchema({ $prototype: "Foo" }, {});
    expect(result).toBeNull();
  });

  test("returns null when def has no $prototype", async () => {
    registerPlatform({});
    const result = await fetchPluginSchema({ $src: "./foo.js" }, {});
    expect(result).toBeNull();
  });

  test("returns null when platform has no fetchPluginSchema", async () => {
    registerPlatform({});
    const result = await fetchPluginSchema({ $src: "./foo.js", $prototype: "Foo" }, {});
    expect(result).toBeNull();
    expect(pluginSchemaCache.get("./foo.js::Foo")).toBeNull();
  });

  test("fetches and caches schema from platform", async () => {
    const schema = { properties: { url: { type: "string" } } };
    const mockFn = mock(() => schema);
    registerPlatform({ fetchPluginSchema: mockFn });
    const result = await fetchPluginSchema(
      { $src: "./DataSource.class.json", $prototype: "DataSource" },
      { documentPath: "pages/index.json" },
    );
    expect(result).toEqual(schema);
    expect(pluginSchemaCache.get("./DataSource.class.json::DataSource")).toEqual(schema);
  });

  test("returns cached schema on second call", async () => {
    const schema = { properties: {} };
    const mockFn = mock(() => schema);
    registerPlatform({ fetchPluginSchema: mockFn });
    const def = { $src: "./cached.js", $prototype: "Cached" };
    await fetchPluginSchema(def, {});
    await fetchPluginSchema(def, {});
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test("caches null on error", async () => {
    const mockFn = mock(() => {
      throw new Error("network");
    });
    registerPlatform({ fetchPluginSchema: mockFn });
    const def = { $src: "./err.js", $prototype: "Err" };
    const result = await fetchPluginSchema(def, {});
    expect(result).toBeNull();
    expect(pluginSchemaCache.get("./err.js::Err")).toBeNull();
  });
});

// ─── setLintMarkers ─────────────────────────────────────────────────────────

describe("setLintMarkers", () => {
  test("does nothing when editor has no model", () => {
    const editor = { getModel: () => null };
    setLintMarkers(editor, []);
    // Should not throw
  });

  test("sets markers from diagnostics", () => {
    const model = {};
    const editor = { getModel: () => model };
    const diagnostics = [
      {
        severity: "error",
        message: "Unused variable",
        help: "Remove it",
        labels: [{ span: { line: 5, column: 3, length: 4 } }],
        code: "no-unused-vars",
        url: null,
      },
    ];
    setLintMarkers(editor, diagnostics);
    expect(monaco.editor.setModelMarkers).toHaveBeenCalled();
    const call = /** @type {any} */ (monaco.editor.setModelMarkers).mock.calls[0];
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
    const editor = { getModel: () => ({}) };
    const diagnostics = [
      {
        severity: "warning",
        message: "Prefer const",
        labels: [{ span: { line: 1, column: 1, length: 3 } }],
        code: "prefer-const",
        url: "https://docs.example.com",
      },
    ];
    setLintMarkers(editor, diagnostics);
    const call = /** @type {any} */ (monaco.editor.setModelMarkers).mock.calls.at(-1);
    expect(call[2][0].severity).toBe(4); // Warning
    expect(call[2][0].code.value).toBe("prefer-const");
    expect(call[2][0].code.target.toString()).toBe("https://docs.example.com");
  });

  test("filters diagnostics without labels", () => {
    const editor = { getModel: () => ({}) };
    const diagnostics = [
      { severity: "error", message: "No labels", labels: [] },
      { severity: "error", message: "Null labels", labels: null },
      {
        severity: "error",
        message: "With label",
        labels: [{ span: { line: 1, column: 1, length: 1 } }],
        code: "x",
      },
    ];
    setLintMarkers(editor, diagnostics);
    const call = /** @type {any} */ (monaco.editor.setModelMarkers).mock.calls.at(-1);
    expect(call[2].length).toBe(1);
    expect(call[2][0].message).toBe("With label");
  });
});

// ─── getFunctionArgs ────────────────────────────────────────────────────────

describe("getFunctionArgs", () => {
  test("returns parameters from state def", () => {
    const editing = { type: "def", defName: "onClick" };
    const document = { state: { onClick: { parameters: ["state", "event", "el"] } } };
    expect(getFunctionArgs(editing, document)).toEqual(["state", "event", "el"]);
  });

  test("returns default when state def has no parameters", () => {
    const editing = { type: "def", defName: "handler" };
    const document = { state: { handler: {} } };
    expect(getFunctionArgs(editing, document)).toEqual(["state", "event"]);
  });

  test("returns default when state def not found", () => {
    const editing = { type: "def", defName: "missing" };
    const document = { state: {} };
    expect(getFunctionArgs(editing, document)).toEqual(["state", "event"]);
  });

  test("returns parameters from event node", () => {
    const editing = { type: "event", path: ["children", 0], eventKey: "onclick" };
    const document = { children: [{ onclick: { parameters: ["state"] } }] };
    expect(getFunctionArgs(editing, document)).toEqual(["state"]);
  });

  test("returns default for unknown editing type", () => {
    const editing = { type: "unknown" };
    const document = {};
    expect(getFunctionArgs(editing, document)).toEqual(["state", "event"]);
  });
});
