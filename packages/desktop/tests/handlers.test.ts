import { describe, test, expect, mock } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DirEntry, ComponentMeta } from "../src/rpc-schema";
import type { StudioSchema } from "../src/handlers";

mock.module("electrobun/bun", () => ({
  Utils: { openFileDialog: async () => [] },
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
}));

const {
  setProjectRoot,
  getProjectRoot,
  setFileDialog,
  listDirectory,
  handleReadFile,
  handleReadFileAsDataUrl,
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
} = await import("../src/handlers");

const FIXTURES = join(import.meta.dir, "_fixtures_handlers");

function setup() {
  mkdirSync(FIXTURES, { recursive: true });
  setProjectRoot(FIXTURES);
}

function cleanup() {
  rmSync(FIXTURES, { recursive: true, force: true });
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
      await handleWriteFile({ path: "output.txt", content: "test content" });
      const content = await handleReadFile({ path: "output.txt" });
      expect(content).toBe("test content");
    } finally {
      cleanup();
    }
  });

  test("creates parent directories", async () => {
    setup();
    try {
      await handleWriteFile({ path: "a/b/c/deep.txt", content: "deep" });
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
          tagName: "my-button",
          $id: "btn-001",
          state: {
            label: { type: "string", default: "Click" },
            count: { type: "number", default: 0 },
            onClick: { $prototype: "Function", body: "state.count++" },
          },
          children: [],
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

  test("skips non-component JSON files", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "config.json"), JSON.stringify({ name: "My Project" }));
      writeFileSync(join(FIXTURES, "page.json"), JSON.stringify({ tagName: "div", children: [] }));

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
        JSON.stringify({ tagName: "my-ext", children: [] }),
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
          tagName: "my-card",
          $elements: [{ $ref: "./icon.json" }],
          children: [],
        }),
      );
      writeFileSync(
        join(FIXTURES, "no-elements.json"),
        JSON.stringify({ tagName: "my-box", children: [] }),
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
          tagName: "my-counter",
          state: {
            count: 5,
            label: "hello",
          },
          children: [],
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
          title: "Counter",
          description: "A counter component",
          $defs: {
            parameters: {
              initial: {
                identifier: "initial",
                type: { type: "number" },
                description: "Initial count value",
              },
            },
            fields: {
              count: {
                role: "field",
                identifier: "count",
                type: { type: "number" },
                default: 0,
              },
              _internal: {
                role: "field",
                access: "private",
                identifier: "_internal",
                type: { type: "string" },
              },
            },
            constructor: {
              parameters: [{ $ref: "#/$defs/parameters/initial" }],
            },
          },
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
          title: "Widget",
          $defs: {
            parameters: {},
            fields: {
              size: {
                role: "field",
                identifier: "size",
                type: { type: "string" },
                default: "md",
              },
            },
          },
        }),
      );

      const schema = (await fetchPluginSchema({
        src: "./Widget.class.json",
        base: "file:///components/page.json",
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
          title: "Base",
          $defs: {
            parameters: {},
            fields: {
              baseField: {
                role: "field",
                identifier: "baseField",
                type: { type: "string" },
              },
            },
          },
        }),
      );
      writeFileSync(
        join(FIXTURES, "Child.class.json"),
        JSON.stringify({
          title: "Child",
          extends: { $ref: "./Base.class.json" },
          $defs: {
            parameters: {},
            fields: {
              childField: {
                role: "field",
                identifier: "childField",
                type: { type: "number" },
              },
            },
          },
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
          title: "Timer",
          $defs: {
            parameters: {},
            fields: {
              interval: {
                role: "field",
                identifier: "interval",
                type: { type: "number" },
                default: 1000,
              },
            },
          },
        }),
      );

      const schema = (await fetchPluginSchema({
        src: "./something.ts",
        prototype: "Timer",
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
        src: "./Foo.class.json",
        base: "not-a-url",
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
        src: "./something.ts",
        prototype: "Broken",
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
        src: "./bad-module.ts",
        prototype: "BadModule",
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
        src: "./MyPlugin.ts",
        prototype: "MyPlugin",
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
        src: "./plain.ts",
        prototype: "plain",
      });
      // plain is a function without .schema, so returns null
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
      await handleUploadFile({ path: "upload.bin", data });
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
      await handleUploadFile({ path: "a/b/upload.bin", data });
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
      await expect(handleUploadFile({ path: "../../evil.bin", data })).rejects.toThrow(
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

// ─── handleReadFileAsDataUrl ──────────────────────────────────────────────

describe("handleReadFileAsDataUrl", () => {
  test("returns data URL for PNG file", async () => {
    setup();
    try {
      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      writeFileSync(join(FIXTURES, "image.png"), pngData);
      const result = await handleReadFileAsDataUrl({ path: "image.png" });
      expect(result).toStartWith("data:image/png;base64,");
      const base64 = result.replace("data:image/png;base64,", "");
      expect(Buffer.from(base64, "base64")).toEqual(pngData);
    } finally {
      cleanup();
    }
  });

  test("detects JPEG mime type", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "photo.jpg"), Buffer.from([0xff, 0xd8]));
      const result = await handleReadFileAsDataUrl({ path: "photo.jpg" });
      expect(result).toStartWith("data:image/jpeg;base64,");
    } finally {
      cleanup();
    }
  });

  test("detects SVG mime type", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "icon.svg"), "<svg></svg>");
      const result = await handleReadFileAsDataUrl({ path: "icon.svg" });
      expect(result).toStartWith("data:image/svg+xml;base64,");
    } finally {
      cleanup();
    }
  });

  test("uses octet-stream for unknown extensions", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "file.xyz"), "data");
      const result = await handleReadFileAsDataUrl({ path: "file.xyz" });
      expect(result).toStartWith("data:application/octet-stream;base64,");
    } finally {
      cleanup();
    }
  });

  test("falls back to public/ directory", async () => {
    setup();
    try {
      mkdirSync(join(FIXTURES, "public"), { recursive: true });
      writeFileSync(join(FIXTURES, "public", "logo.png"), Buffer.from([0x89, 0x50]));
      const result = await handleReadFileAsDataUrl({ path: "logo.png" });
      expect(result).toStartWith("data:image/png;base64,");
    } finally {
      cleanup();
    }
  });

  test("throws for non-existent file in both root and public/", async () => {
    setup();
    try {
      await expect(handleReadFileAsDataUrl({ path: "missing.png" })).rejects.toThrow(
        "File not found",
      );
    } finally {
      cleanup();
    }
  });

  test("rejects path traversal", async () => {
    setup();
    try {
      await expect(handleReadFileAsDataUrl({ path: "../../etc/passwd" })).rejects.toThrow(
        "Path outside project root",
      );
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
      expect(result!.handle.root).toBe(".");
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

process.on("exit", () => {
  try {
    cleanup();
  } catch {}
});
