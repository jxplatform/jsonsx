// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentMeta, DirEntry } from "../src/rpc-schema";
import type { StudioSchema } from "../src/handlers";

const mockOpenExternal = mock((url: string) => url.startsWith("https://"));

void mock.module("electrobun/bun", () => ({
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
  Utils: { openExternal: mockOpenExternal, openFileDialog: async () => [] },
}));

const {
  setProjectRoot,
  getProjectRoot,
  setFileDialog,
  setDirectoryDialog,
  listDirectory,
  handleReadFile,
  handleWriteFile,
  handleDeleteFile,
  handleRenameFile,
  handleCreateDirectory,
  handleUploadFile,
  handleResolveSiteContext,
  discoverComponents,
  codeService,
  locateFile,
  fetchPluginSchema,
  openProject,
  createProject,
  openExternal,
} = await import("../src/handlers");

// The folder picker lives on the session object (the legacy handlers shim does not re-export
// PickDirectory), so the picker tests below drive it through a session of their own.
const { createProjectSession } = await import("../src/project-session");

const FIXTURES = join(import.meta.dir, "_fixtures_handlers");

type CreateProjectOpts = Parameters<typeof createProject>[0];
const noDialog = () => setDirectoryDialog(null as unknown as () => Promise<string | null>);

function setup() {
  mkdirSync(FIXTURES, { recursive: true });
  setProjectRoot(FIXTURES);
}

function cleanup() {
  rmSync(FIXTURES, { force: true, recursive: true });
  setProjectRoot(null);
}

// ─── State ──────────────────────────────────────────────────────────────────

describe("project root state", () => {
  test("setProjectRoot / getProjectRoot", () => {
    setProjectRoot("/tmp/test");
    expect(getProjectRoot()).toBe("/tmp/test");
    setProjectRoot(null);
    expect(getProjectRoot()).toBe(null);
  });
});

// ─── Guards ─────────────────────────────────────────────────────────────────

describe("guards", () => {
  test("throws when no project root is set", async () => {
    setProjectRoot(null);
    await expect(listDirectory({ dir: "." })).rejects.toThrow("No project open");
    await expect(handleReadFile({ path: "test.txt" })).rejects.toThrow("No project open");
  });

  test("throws for path traversal outside project root", async () => {
    setup();
    try {
      await expect(handleReadFile({ path: "../../etc/passwd" })).rejects.toThrow(
        "Path outside project root",
      );
    } finally {
      cleanup();
    }
  });

  test.skipIf(process.platform === "win32")(
    "write-path realpath check blocks a symlinked dir that escapes the root",
    async () => {
      setup();
      const { mkdirSync: mkdir, symlinkSync, rmSync: rmTree } = await import("node:fs");
      const outside = join(import.meta.dir, "_fixtures_handlers_outside");
      rmTree(outside, { force: true, recursive: true });
      mkdir(outside, { recursive: true });
      try {
        // A symlink INSIDE the project that points to a directory OUTSIDE it. The lexical guard
        // Alone ("evil/x.txt" has no "..") would pass; the realpath re-check must catch it.
        symlinkSync(outside, join(FIXTURES, "evil"));
        await expect(handleWriteFile({ content: "x", path: "evil/x.txt" })).rejects.toThrow(
          "Path outside project root",
        );
        await expect(handleDeleteFile({ path: "evil/x.txt" })).rejects.toThrow(
          "Path outside project root",
        );
      } finally {
        rmTree(outside, { force: true, recursive: true });
        cleanup();
      }
    },
  );
});

// ─── listDirectory ──────────────────────────────────────────────────────────

describe("listDirectory", () => {
  test("lists files in directory", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "test.json"), '{"hello": true}');
      mkdirSync(join(FIXTURES, "subdir"), { recursive: true });

      const entries = await listDirectory({ dir: "." });
      const names = entries.map((e: DirEntry) => e.name);
      expect(names).toContain("test.json");
      expect(names).toContain("subdir");

      const file = entries.find((e: DirEntry) => e.name === "test.json")!;
      expect(file.type).toBe("file");

      const dir = entries.find((e: DirEntry) => e.name === "subdir")!;
      expect(dir.type).toBe("directory");
    } finally {
      cleanup();
    }
  });

  test("skips hidden files", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, ".hidden"), "secret");
      writeFileSync(join(FIXTURES, "visible.txt"), "hello");

      const entries = await listDirectory({ dir: "." });
      const names = entries.map((e: DirEntry) => e.name);
      expect(names).not.toContain(".hidden");
      expect(names).toContain("visible.txt");
    } finally {
      cleanup();
    }
  });

  test("includes file metadata", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "data.json"), '{"x": 1}');

      const entries = await listDirectory({ dir: "." });
      const file = entries.find((e: DirEntry) => e.name === "data.json")!;
      expect(file.size).toBeGreaterThan(0);
      expect(file.modified).toBeDefined();
      expect(file.path).toBe("data.json");
    } finally {
      cleanup();
    }
  });

  test("rejects directory outside project root", async () => {
    setup();
    try {
      await expect(listDirectory({ dir: "../../" })).rejects.toThrow("Path outside project root");
    } finally {
      cleanup();
    }
  });

  test("returns forward-slash relative paths for nested entries", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "content", "products"), { recursive: true });
      writeFileSync(join(FIXTURES, "content", "products", "widget.md"), "---\n---\n");

      const entries = await listDirectory({ dir: "content/products" });
      const file = entries.find((e: DirEntry) => e.name === "widget.md")!;
      // On Windows Node's relative() yields backslash paths.
      // Studio code such as findContentTypeSchema expects forward slashes, so the handler normalizes.
      expect(file.path).toBe("content/products/widget.md");
      expect(file.path).not.toContain("\\");
    } finally {
      cleanup();
    }
  });
});

// ─── handleReadFile ─────────────────────────────────────────────────────────

describe("handleReadFile", () => {
  test("reads file content", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "hello.txt"), "Hello World");
      const content = await handleReadFile({ path: "hello.txt" });
      expect(content).toBe("Hello World");
    } finally {
      cleanup();
    }
  });

  test("reads JSON files", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "data.json"), '{"count": 42}');
      const content = await handleReadFile({ path: "data.json" });
      expect(JSON.parse(content)).toEqual({ count: 42 });
    } finally {
      cleanup();
    }
  });
});

// ─── handleWriteFile ────────────────────────────────────────────────────────

describe("handleWriteFile", () => {
  test("writes file content", async () => {
    setup();
    try {
      await handleWriteFile({ content: "test content", path: "output.txt" });
      const content = await handleReadFile({ path: "output.txt" });
      expect(content).toBe("test content");
    } finally {
      cleanup();
    }
  });

  test("creates parent directories", async () => {
    setup();
    try {
      await handleWriteFile({ content: "deep", path: "a/b/c/deep.txt" });
      const content = await handleReadFile({ path: "a/b/c/deep.txt" });
      expect(content).toBe("deep");
    } finally {
      cleanup();
    }
  });
});

// ─── handleDeleteFile ───────────────────────────────────────────────────────

describe("handleDeleteFile", () => {
  test("deletes a file", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "temp.txt"), "temporary");
      await handleDeleteFile({ path: "temp.txt" });
      await expect(handleReadFile({ path: "temp.txt" })).rejects.toThrow();
    } finally {
      cleanup();
    }
  });
});

// ─── handleRenameFile ───────────────────────────────────────────────────────

describe("handleRenameFile", () => {
  test("renames a file", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "old.txt"), "content");
      await handleRenameFile({ from: "old.txt", to: "new.txt" });
      const content = await handleReadFile({ path: "new.txt" });
      expect(content).toBe("content");
      await expect(handleReadFile({ path: "old.txt" })).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  test("creates target directory if needed", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "src.txt"), "data");
      await handleRenameFile({ from: "src.txt", to: "newdir/dest.txt" });
      const content = await handleReadFile({ path: "newdir/dest.txt" });
      expect(content).toBe("data");
    } finally {
      cleanup();
    }
  });

  test("rewrites project references and reports them (refactor)", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "pages"), { recursive: true });
      mkdirSync(join(FIXTURES, "components"), { recursive: true });
      writeFileSync(
        join(FIXTURES, "pages/index.json"),
        JSON.stringify({ children: [{ $ref: "../components/counter.json" }] }),
      );
      writeFileSync(
        join(FIXTURES, "components/counter.json"),
        JSON.stringify({ children: [], tagName: "my-counter" }),
      );

      const report = await handleRenameFile({
        from: "components/counter.json",
        to: "components/my-button.json",
      });

      const index = JSON.parse(await handleReadFile({ path: "pages/index.json" })) as {
        children: { $ref: string }[];
      };
      expect(index.children[0]?.$ref).toBe("../components/my-button.json");
      expect(report.references.refsUpdated).toBe(1);
      expect(report.tag).toMatchObject({ from: "my-counter", to: "my-button" });
    } finally {
      cleanup();
    }
  });
});

// ─── handleCreateDirectory ──────────────────────────────────────────────────

describe("handleCreateDirectory", () => {
  test("creates a directory", async () => {
    setup();
    try {
      await handleCreateDirectory({ path: "new-dir" });
      const entries = await listDirectory({ dir: "." });
      const names = entries.map((e: DirEntry) => e.name);
      expect(names).toContain("new-dir");
    } finally {
      cleanup();
    }
  });

  test("creates nested directories", async () => {
    setup();
    try {
      await handleCreateDirectory({ path: "a/b/c" });
      const entries = await listDirectory({ dir: "a/b" });
      const names = entries.map((e: DirEntry) => e.name);
      expect(names).toContain("c");
    } finally {
      cleanup();
    }
  });
});

// ─── discoverComponents ────────────────────────────────────────────────────

describe("discoverComponents", () => {
  test("discovers custom element JSON files", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "components"), { recursive: true });
      writeFileSync(
        join(FIXTURES, "components", "my-button.json"),
        JSON.stringify({
          $id: "btn-001",
          children: [],
          state: {
            count: { default: 0, type: "number" },
            label: { default: "Click", type: "string" },
            onClick: { $prototype: "Function", body: "state.count++" },
          },
          tagName: "my-button",
        }),
      );

      const components = await discoverComponents({ dir: "." });
      expect(components.length).toBeGreaterThanOrEqual(1);
      const btn = components.find((c: ComponentMeta) => c.tagName === "my-button")!;
      expect(btn).toBeDefined();
      expect(btn.$id).toBe("btn-001");
      expect(btn.path).toContain("my-button.json");
      expect(btn.props!.find((p) => p.name === "label")).toBeDefined();
      expect(btn.props!.find((p) => p.name === "onClick")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("returns forward-slash paths for nested components", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "components", "widgets"), { recursive: true });
      writeFileSync(
        join(FIXTURES, "components", "widgets", "my-button.json"),
        JSON.stringify({ children: [], tagName: "my-button" }),
      );

      const components = await discoverComponents({ dir: "." });
      const btn = components.find((c: ComponentMeta) => c.tagName === "my-button")!;
      // Bun.Glob emits backslashes on Windows; the handler must normalize before returning.
      expect(btn.path).toBe("components/widgets/my-button.json");
      expect(btn.path).not.toContain("\\");
    } finally {
      cleanup();
    }
  });

  test("extracts slot definitions with fallback children", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "components"), { recursive: true });
      writeFileSync(
        join(FIXTURES, "components", "my-panel.json"),
        JSON.stringify({
          children: [
            {
              attributes: { name: "header" },
              children: [{ tagName: "h2", textContent: "Default title" }],
              tagName: "slot",
            },
            { children: ["Default body"], tagName: "slot" },
          ],
          tagName: "my-panel",
        }),
      );
      // A slotless component, to confirm the key is omitted
      writeFileSync(
        join(FIXTURES, "components", "my-plain.json"),
        JSON.stringify({ children: [{ tagName: "div" }], tagName: "my-plain" }),
      );

      const components = await discoverComponents({ dir: "." });
      const panel = components.find((c: ComponentMeta) => c.tagName === "my-panel")!;
      expect(panel.slots).toEqual([
        { fallback: [{ tagName: "h2", textContent: "Default title" }], name: "header" },
        { fallback: ["Default body"], name: "" },
      ]);
      const plain = components.find((c: ComponentMeta) => c.tagName === "my-plain")!;
      expect(plain.slots).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("skips non-component JSON files", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "config.json"), JSON.stringify({ name: "My Project" }));
      writeFileSync(join(FIXTURES, "page.json"), JSON.stringify({ children: [], tagName: "div" }));

      const components = await discoverComponents({ dir: "." });
      expect(components.find((c: ComponentMeta) => c.tagName === "div")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("skips node_modules and dist directories", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "node_modules", "pkg"), { recursive: true });
      writeFileSync(
        join(FIXTURES, "node_modules", "pkg", "my-ext.json"),
        JSON.stringify({ children: [], tagName: "my-ext" }),
      );

      const components = await discoverComponents({ dir: "." });
      expect(components.find((c: ComponentMeta) => c.tagName === "my-ext")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("reports hasElements correctly", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "with-elements.json"),
        JSON.stringify({
          $elements: [{ $ref: "./icon.json" }],
          children: [],
          tagName: "my-card",
        }),
      );
      writeFileSync(
        join(FIXTURES, "no-elements.json"),
        JSON.stringify({ children: [], tagName: "my-box" }),
      );

      const components = await discoverComponents({ dir: "." });
      const card = components.find((c: ComponentMeta) => c.tagName === "my-card");
      const box = components.find((c: ComponentMeta) => c.tagName === "my-box");
      expect(card?.hasElements).toBe(true);
      expect(box?.hasElements).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("handles primitive state values", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "primitive-state.json"),
        JSON.stringify({
          children: [],
          state: {
            count: 5,
            label: "hello",
          },
          tagName: "my-counter",
        }),
      );

      const components = await discoverComponents({ dir: "." });
      const counter = components.find((c: ComponentMeta) => c.tagName === "my-counter")!;
      expect(counter).toBeDefined();
      const countProp = counter.props!.find((p) => p.name === "count")!;
      expect(countProp.type).toBe("number");
      expect(countProp.default).toBe(5);
      const labelProp = counter.props!.find((p) => p.name === "label")!;
      expect(labelProp.type).toBe("string");
      expect(labelProp.default).toBe("hello");
    } finally {
      cleanup();
    }
  });
});

// ─── codeService ───────────────────────────────────────────────────────────

describe("codeService", () => {
  test("returns null (not yet implemented)", async () => {
    const result = await codeService({});
    expect(result).toBeNull();
  });
});

// ─── locateFile ────────────────────────────────────────────────────────────

describe("locateFile", () => {
  test("locates a file by name", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "deep", "nested"), { recursive: true });
      writeFileSync(join(FIXTURES, "deep", "nested", "target.json"), "{}");

      const result = await locateFile({ name: "target.json" });
      expect(result).toContain("target.json");
      expect(result).toContain("deep/nested");
    } finally {
      cleanup();
    }
  });

  test("returns null when file not found", async () => {
    setup();
    try {
      const result = await locateFile({ name: "nonexistent-xyz.json" });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ─── fetchPluginSchema ─────────────────────────────────────────────────────

describe("fetchPluginSchema", () => {
  test("reads .class.json and extracts schema", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "Counter.class.json"),
        JSON.stringify({
          $defs: {
            constructor: {
              parameters: [{ $ref: "#/$defs/parameters/initial" }],
            },
            fields: {
              _internal: {
                access: "private",
                identifier: "_internal",
                role: "field",
                type: { type: "string" },
              },
              count: {
                default: 0,
                identifier: "count",
                role: "field",
                type: { type: "number" },
              },
            },
            parameters: {
              initial: {
                description: "Initial count value",
                identifier: "initial",
                type: { type: "number" },
              },
            },
          },
          description: "A counter component",
          title: "Counter",
        }),
      );

      const schema = (await fetchPluginSchema({
        src: "./Counter.class.json",
      })) as StudioSchema;
      expect(schema).not.toBeNull();
      expect(schema.description).toBe("A counter component");
      expect(schema.properties.initial).toBeDefined();
      expect(schema.properties.initial.type).toBe("number");
      expect(schema.properties.count).toBeDefined();
      expect(schema.properties.count.default).toBe(0);
      expect(schema.properties._internal).toBeUndefined();
      expect(schema.required).toContain("initial");
    } finally {
      cleanup();
    }
  });

  test("returns null for non-existent file", async () => {
    setup();
    try {
      const result = await fetchPluginSchema({ src: "./Missing.class.json" });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("resolves class.json with base path", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "components"), { recursive: true });
      writeFileSync(
        join(FIXTURES, "components", "Widget.class.json"),
        JSON.stringify({
          $defs: {
            fields: {
              size: {
                default: "md",
                identifier: "size",
                role: "field",
                type: { type: "string" },
              },
            },
            parameters: {},
          },
          title: "Widget",
        }),
      );

      const schema = (await fetchPluginSchema({
        base: "file:///components/page.json",
        src: "./Widget.class.json",
      })) as StudioSchema;
      expect(schema).not.toBeNull();
      expect(schema.properties.size.default).toBe("md");
    } finally {
      cleanup();
    }
  });

  test("resolves parent class via extends.$ref", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "Base.class.json"),
        JSON.stringify({
          $defs: {
            fields: {
              baseField: {
                identifier: "baseField",
                role: "field",
                type: { type: "string" },
              },
            },
            parameters: {},
          },
          title: "Base",
        }),
      );
      writeFileSync(
        join(FIXTURES, "Child.class.json"),
        JSON.stringify({
          $defs: {
            fields: {
              childField: {
                identifier: "childField",
                role: "field",
                type: { type: "number" },
              },
            },
            parameters: {},
          },
          extends: { $ref: "./Base.class.json" },
          title: "Child",
        }),
      );

      const schema = (await fetchPluginSchema({
        src: "./Child.class.json",
      })) as StudioSchema;
      expect(schema).not.toBeNull();
      expect(schema.properties.baseField).toBeDefined();
      expect(schema.properties.childField).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("resolves via prototype name to .class.json", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "Timer.class.json"),
        JSON.stringify({
          $defs: {
            fields: {
              interval: {
                default: 1000,
                identifier: "interval",
                role: "field",
                type: { type: "number" },
              },
            },
            parameters: {},
          },
          title: "Timer",
        }),
      );

      const schema = (await fetchPluginSchema({
        prototype: "Timer",
        src: "./something.ts",
      })) as StudioSchema;
      expect(schema).not.toBeNull();
      expect(schema.properties.interval.default).toBe(1000);
    } finally {
      cleanup();
    }
  });

  test("returns null for invalid base URL", async () => {
    setup();
    try {
      const result = await fetchPluginSchema({
        base: "not-a-url",
        src: "./Foo.class.json",
      });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns null when prototype .class.json is malformed", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "Broken.class.json"), "not valid json {{{");
      const schema = await fetchPluginSchema({
        prototype: "Broken",
        src: "./something.ts",
      });
      expect(schema).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns null when module import fails", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "bad-module.ts"), "export syntax error %%%");
      const schema = await fetchPluginSchema({
        prototype: "BadModule",
        src: "./bad-module.ts",
      });
      expect(schema).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("resolves JS module with static schema property", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "MyPlugin.ts"),
        `export class MyPlugin { static schema = { type: "object", properties: { x: { type: "number" } } }; }`,
      );

      const schema = (await fetchPluginSchema({
        prototype: "MyPlugin",
        src: "./MyPlugin.ts",
      })) as StudioSchema;
      expect(schema).not.toBeNull();
      expect(schema.type).toBe("object");
    } finally {
      cleanup();
    }
  });

  test("returns null for module without schema", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "plain.ts"), `export function plain() { return 1; }`);
      const result = await fetchPluginSchema({
        prototype: "plain",
        src: "./plain.ts",
      });
      // Plain is a function without .schema, so returns null
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ─── handleUploadFile ──────────────────────────────────────────────────────

describe("handleUploadFile", () => {
  test("writes base64 data as binary", async () => {
    setup();
    try {
      const data = Buffer.from("hello binary").toString("base64");
      await handleUploadFile({ data, path: "upload.bin" });
      const content = await handleReadFile({ path: "upload.bin" });
      expect(content).toBe("hello binary");
    } finally {
      cleanup();
    }
  });

  test("creates parent directories", async () => {
    setup();
    try {
      const data = Buffer.from("deep upload").toString("base64");
      await handleUploadFile({ data, path: "a/b/upload.bin" });
      const content = await handleReadFile({ path: "a/b/upload.bin" });
      expect(content).toBe("deep upload");
    } finally {
      cleanup();
    }
  });

  test("rejects path traversal", async () => {
    setup();
    try {
      const data = Buffer.from("hack").toString("base64");
      await expect(handleUploadFile({ data, path: "../../evil.bin" })).rejects.toThrow(
        "Path outside project root",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── handleResolveSiteContext ──────────────────────────────────────────────

describe("handleResolveSiteContext", () => {
  test("finds project.json in root", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "project.json"), '{"name": "test"}');
      const result = await handleResolveSiteContext({ filePath: "page.json" });
      expect(result.sitePath).toBe(".");
    } finally {
      cleanup();
    }
  });

  test("finds project.json in parent directory", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "site"), { recursive: true });
      writeFileSync(join(FIXTURES, "site", "project.json"), '{"name": "site"}');
      mkdirSync(join(FIXTURES, "site", "pages"), { recursive: true });
      const result = await handleResolveSiteContext({
        filePath: "site/pages/index.json",
      });
      expect(result.sitePath).toBe("site");
    } finally {
      cleanup();
    }
  });

  test("returns a forward-slash sitePath for a deeply nested site", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "sites", "blog", "pages"), { recursive: true });
      writeFileSync(join(FIXTURES, "sites", "blog", "project.json"), '{"name": "blog"}');
      const result = await handleResolveSiteContext({
        filePath: "sites/blog/pages/index.json",
      });
      // Node's relative() yields a backslash path on Windows; the handler must normalize.
      expect(result.sitePath).toBe("sites/blog");
      expect(result.sitePath).not.toContain("\\");
    } finally {
      cleanup();
    }
  });

  test("returns null when no project.json found", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "orphan"), { recursive: true });
      const result = await handleResolveSiteContext({
        filePath: "orphan/file.json",
      });
      expect(result.sitePath).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ─── openProject ──────────────────────────────────────────────────────────

describe("openProject", () => {
  test("throws when no file dialog configured", async () => {
    setup();
    try {
      await expect(openProject()).rejects.toThrow("No file dialog configured");
    } finally {
      cleanup();
    }
  });

  test("returns null when dialog is cancelled", async () => {
    setup();
    try {
      setFileDialog(async () => null);
      const result = await openProject();
      expect(result).toBeNull();
    } finally {
      setFileDialog(null as unknown as () => Promise<string | null>);
      cleanup();
    }
  });

  test("throws when selected file is not project.json", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "other.json"), "{}");
      setFileDialog(async () => join(FIXTURES, "other.json"));
      await expect(openProject()).rejects.toThrow("not a project.json");
    } finally {
      setFileDialog(null as unknown as () => Promise<string | null>);
      cleanup();
    }
  });

  test("opens project.json and sets root", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "project.json"),
        JSON.stringify({ name: "My Project", url: "http://localhost:3000" }),
      );
      setFileDialog(async () => join(FIXTURES, "project.json"));
      const result = await openProject();
      expect(result).not.toBeNull();
      expect(result!.config.name).toBe("My Project");
      expect(result!.handle.name).toBe("My Project");
      // The handle now carries the absolute project root (the re-openable recent-projects key).
      expect(result!.handle.root).toBe(FIXTURES);
      expect(getProjectRoot()).toBe(FIXTURES);
    } finally {
      setFileDialog(null as unknown as () => Promise<string | null>);
      cleanup();
    }
  });

  test("uses directory basename when config has no name", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "project.json"), JSON.stringify({}));
      setFileDialog(async () => join(FIXTURES, "project.json"));
      const result = await openProject();
      expect(result).not.toBeNull();
      expect(result!.handle.name).toBe("_fixtures_handlers");
    } finally {
      setFileDialog(null as unknown as () => Promise<string | null>);
      cleanup();
    }
  });
});

// ─── pickDirectory ─────────────────────────────────────────────────────────
// The native folder picker is now the New Project modal's tool (the Browse… button next to the
// Location field) rather than something the backend triggers on its own, but the RPC is unchanged.

describe("pickDirectory", () => {
  const session = createProjectSession(null);

  test("throws when no directory dialog is configured", async () => {
    noDialog();
    await expect(session.pickDirectory()).rejects.toThrow("No directory dialog configured");
  });

  test("returns the folder the native dialog picked", async () => {
    setDirectoryDialog(async () => "/picked/parent");
    try {
      expect(await session.pickDirectory()).toEqual({ path: "/picked/parent" });
    } finally {
      noDialog();
    }
  });

  test("reports a cancelled picker as a null path", async () => {
    setDirectoryDialog(async () => null);
    try {
      expect(await session.pickDirectory()).toEqual({ path: null });
    } finally {
      noDialog();
    }
  });
});

// ─── createProject ─────────────────────────────────────────────────────────
// A new project is written only where the caller said (specs/desktop.md §4.5): the destination
// Arrives with the request and the backend never opens a folder picker of its own. Every test here
// Arms a directory dialog precisely so a stray backend-side picker would be observable.

describe("createProject", () => {
  const dialog = mock(async (): Promise<string | null> => FIXTURES);
  const armDialog = () => {
    dialog.mockClear();
    setDirectoryDialog(dialog);
  };

  test("throws when name or directory is missing", async () => {
    armDialog();
    try {
      await expect(
        createProject({
          destination: { kind: "path", parent: FIXTURES },
          directory: "",
          name: "",
        }),
      ).rejects.toThrow("name and directory are required");
    } finally {
      noDialog();
    }
  });

  test("throws when the request carries no usable path destination", async () => {
    armDialog();
    try {
      await expect(
        createProject({ directory: "x", name: "X" } as unknown as CreateProjectOpts),
      ).rejects.toThrow("A destination folder is required.");
      await expect(
        createProject({ destination: { kind: "path", parent: "" }, directory: "x", name: "X" }),
      ).rejects.toThrow("A destination folder is required.");
      // A repo destination belongs to the cloud platform; the desktop backend only writes to disk.
      await expect(
        createProject({
          destination: { kind: "repo", owner: "me", private: false, repo: "x" },
          directory: "x",
          name: "X",
        } as unknown as CreateProjectOpts),
      ).rejects.toThrow("A destination folder is required.");
      // The missing destination is reported, never papered over by opening a picker.
      expect(dialog).not.toHaveBeenCalled();
    } finally {
      noDialog();
    }
  });

  test("throws when the destination parent is a relative path", async () => {
    armDialog();
    try {
      await expect(
        createProject({
          destination: { kind: "path", parent: "relative/parent" },
          directory: "x",
          name: "X",
        }),
      ).rejects.toThrow("Destination folder must be an absolute path: relative/parent");
      expect(dialog).not.toHaveBeenCalled();
    } finally {
      noDialog();
    }
  });

  test("rejects a directory that is a path rather than a folder name", async () => {
    setup();
    armDialog();
    try {
      // The parent is fine, but joining a dot-segment onto it would land the project outside the
      // Folder the user actually chose.
      for (const directory of ["../escape", "nested/dir", ".."]) {
        await expect(
          createProject({
            destination: { kind: "path", parent: FIXTURES },
            directory,
            name: "Escape",
          }),
        ).rejects.toThrow("Directory must be a folder name, not a path");
      }
      expect(existsSync(join(FIXTURES, "..", "escape", "project.json"))).toBe(false);
      expect(dialog).not.toHaveBeenCalled();
    } finally {
      noDialog();
    }
  });

  test("scaffolds a blank project under the chosen destination without opening a dialog", async () => {
    setup();
    armDialog();
    try {
      const result = await createProject({
        description: "A new site",
        destination: { kind: "path", parent: FIXTURES },
        directory: "my-new-site",
        name: "My New Site",
        url: "https://new.example",
      });
      expect(result.root).toBe(join(FIXTURES, "my-new-site"));
      expect(result.config.name).toBe("My New Site");
      expect(existsSync(join(FIXTURES, "my-new-site", "project.json"))).toBe(true);
      expect(existsSync(join(FIXTURES, "my-new-site", "pages"))).toBe(true);
      // The freshly-scaffolded project becomes the active project.
      expect(getProjectRoot()).toBe(join(FIXTURES, "my-new-site"));
      // The caller supplied the destination, so the native picker stayed shut.
      expect(dialog).not.toHaveBeenCalled();
    } finally {
      noDialog();
      cleanup();
    }
  });

  test("forwards a built-in template id to the generator", async () => {
    setup();
    armDialog();
    try {
      const result = await createProject({
        destination: { kind: "path", parent: FIXTURES },
        directory: "my-app",
        name: "My App",
        template: "mobile-first",
      });
      const media = (result.config as { $media?: Record<string, string> }).$media;
      expect(media?.["--"]).toBe("375px");
      expect(media?.["--lg"]).toBe("(min-width: 1024px)");
      expect(dialog).not.toHaveBeenCalled();
    } finally {
      noDialog();
      cleanup();
    }
  });

  test("forwards design quickstart options to the generator", async () => {
    setup();
    armDialog();
    try {
      const result = await createProject({
        design: { accent: "#ff5500" },
        destination: { kind: "path", parent: FIXTURES },
        directory: "my-designed-site",
        name: "My Designed Site",
      });
      const { style } = result.config as { style?: Record<string, string> };
      expect(style?.["--color-primary"]).toBe("#ff5500");
      expect(dialog).not.toHaveBeenCalled();
    } finally {
      noDialog();
      cleanup();
    }
  });
});

process.on("exit", () => {
  try {
    cleanup();
  } catch {}
});

// ─── openExternal ────────────────────────────────────────────────────────────

/* The shim's own function rather than a session method: opening a URL is a shell capability with no
   project state. Studio's Preview link handler is the only caller (specs/desktop.md §3.5). */
describe("openExternal", () => {
  test("forwards the url to the shell and wraps the result", async () => {
    const { init } = await import("../src/utils");
    await init();
    expect(await openExternal({ url: "https://example.com/docs" })).toEqual({ ok: true });
    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  test("reports ok: false when the shell refuses", async () => {
    const { init } = await import("../src/utils");
    await init();
    expect(await openExternal({ url: "ftp://example.com" })).toEqual({ ok: false });
  });
});
