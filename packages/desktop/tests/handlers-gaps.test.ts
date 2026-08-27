// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityInfo, ExtensionCapability } from "@jxsuite/schema/format-registry";
import type { ComponentMeta } from "../src/rpc-schema";
import type { StudioSchema } from "../src/handlers";

void mock.module("electrobun/main", () => ({
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
  Utils: { openFileDialog: async () => [] },
}));

// ─── Format-host mock ────────────────────────────────────────────────────────

const entryCall = mock(async (..._args: unknown[]): Promise<unknown> => ({ parsed: true }));

/* Shapes here mirror the real FormatRegistry entry: `capabilities` is a
   Partial<Record<ExtensionCapability, CapabilityInfo>> map keyed by capability, and `documentKinds`
   is ("page"|"component"|"content")[]. An earlier fixture claimed a string array and a "markdown"
   document kind — shapes the product cannot produce, so the assertions below proved nothing. */
const fakeCapabilities: Partial<Record<ExtensionCapability, CapabilityInfo>> = {
  parse: { identifier: "parse", timing: ["compiler", "server"] },
  serialize: { identifier: "serialize", timing: ["compiler", "server"] },
};

const fakeEntry: Record<string, unknown> = {
  call: entryCall,
  capabilities: fakeCapabilities,
  documentKinds: ["content"],
  exportTarget: true,
  extensions: [".md"],
  mediaType: "text/markdown",
  name: "Markdown",
  remote: false,
  studio: { icon: "doc" },
};

const fakeFormats = {
  byName: (name: string) => (name === "Markdown" ? fakeEntry : undefined),
  entries: [fakeEntry],
};

// The extension registry wraps the formats view (project-session dispatches through .formats).
const fakeRegistry = { extensions: [], formats: fakeFormats };

const mockBuildRegistry = mock(async (_root: string, _config: unknown) => fakeRegistry);

const fakeExtensionsPayload = [
  {
    contributions: [
      {
        className: "Content",
        entrySchema: { type: "object" },
        project: { key: "content" },
        studio: { settings: { layout: "map" } },
      },
    ],
    classes: [{ name: "Content", path: "dist/content.class.json" }],
    name: "@jxsuite/parser",
    specifier: "@jxsuite/parser",
  },
];

const mockBuildPayload = mock((_registry: unknown) => fakeExtensionsPayload);

void mock.module("@jxsuite/compiler/format-host", () => ({
  buildExtensionsPayload: mockBuildPayload,
  buildProjectExtensionRegistry: mockBuildRegistry,
  /* The live preview parses non-JSON pages through this, and a module mock replaces the WHOLE
     module — so omitting it makes every import of `@jxsuite/server/live-preview` fail to link. */
  buildProjectFormatRegistry: mock(() => Promise.resolve({ byExtension: () => null })),
}));

const fakeBundles = {
  document: { $ref: "https://jxsuite.com/schema/v1" },
  project: { allOf: [{ $ref: "https://jxsuite.com/schema/project/core/v2" }] },
};

const mockReadBundles = mock(async (_root: string) => fakeBundles);

void mock.module("@jxsuite/compiler/schema-command", () => ({
  readBundledProjectSchemas: mockReadBundles,
}));

// ─── Resolve-proxy mock ──────────────────────────────────────────────────────

const mockHandleResolve = mock(
  async (_req: Request, _root: string, _x: unknown) =>
    new Response('{"resolved":true}', { status: 200 }),
);
const mockHandleServerFunction = mock(
  async (_req: Request, _root: string) => new Response('{"error":"boom"}', { status: 500 }),
);

void mock.module("@jxsuite/server/resolve", () => ({
  handleResolve: mockHandleResolve,
  handleServerFunction: mockHandleServerFunction,
}));

const {
  setProjectRoot,
  listFormats,
  listExtensions,
  fetchProjectSchemas,
  formatAction,
  jxResolve,
  jxServerFunction,
  discoverComponents,
  fetchPluginSchema,
} = await import("../src/handlers");

const FIXTURES = join(import.meta.dir, "_fixtures_handlers_gaps");

function setup() {
  mkdirSync(FIXTURES, { recursive: true });
  setProjectRoot(FIXTURES);
}

function cleanup() {
  rmSync(FIXTURES, { force: true, recursive: true });
  setProjectRoot(null);
}

beforeEach(() => {
  entryCall.mockClear();
  mockBuildRegistry.mockClear();
  mockBuildPayload.mockClear();
  mockReadBundles.mockClear();
  mockHandleResolve.mockClear();
  mockHandleServerFunction.mockClear();
});

// ─── listFormats ─────────────────────────────────────────────────────────────

describe("listFormats", () => {
  test("maps registry entries to plain metadata objects", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "project.json"), JSON.stringify({ name: "fmt-proj" }));
      const formats = await listFormats();
      expect(formats).toHaveLength(1);
      expect(formats[0]).toEqual({
        capabilities: fakeCapabilities,
        documentKinds: ["content"],
        exportTarget: true,
        extensions: [".md"],
        mediaType: "text/markdown",
        name: "Markdown",
        remote: false,
        studio: { icon: "doc" },
      });
      // Project config was parsed and forwarded to the registry builder
      const [root, config] = mockBuildRegistry.mock.calls[0]!;
      expect(root).toBe(FIXTURES);
      expect(config).toEqual({ name: "fmt-proj" });
    } finally {
      cleanup();
    }
  });

  test("caches the registry per project root", async () => {
    setup();
    try {
      await listFormats();
      await listFormats();
      expect(mockBuildRegistry).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  test("rebuilds the registry after setProjectRoot", async () => {
    setup();
    try {
      await listFormats();
      setProjectRoot(FIXTURES);
      await listFormats();
      expect(mockBuildRegistry).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  test("passes undefined config when project.json is missing", async () => {
    setup();
    try {
      await listFormats();
      const [, config] = mockBuildRegistry.mock.calls[0]!;
      expect(config).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("returns [] quietly (no registry build, no error log) when no project is open", async () => {
    setProjectRoot(null);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const formats = await listFormats();
      expect(formats).toEqual([]);
      // The welcome-screen path short-circuits before getFormatRegistry, so it neither builds a
      // Registry nor logs the misleading "No project open" error that used to spam the terminal.
      expect(mockBuildRegistry).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("returns [] when the registry builder throws", async () => {
    setup();
    try {
      mockBuildRegistry.mockImplementationOnce(async () => {
        throw new Error("registry exploded");
      });
      const formats = await listFormats();
      expect(formats).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// ─── listExtensions ──────────────────────────────────────────────────────────

describe("listExtensions", () => {
  test("builds the payload from the cached extension registry", async () => {
    setup();
    try {
      const extensions = await listExtensions();
      expect(extensions).toEqual(fakeExtensionsPayload);
      expect(mockBuildPayload).toHaveBeenCalledWith(fakeRegistry);
      // A subsequent listFormats reuses the same registry (one build for both channels).
      await listFormats();
      expect(mockBuildRegistry).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  test("returns [] quietly when no project is open", async () => {
    setProjectRoot(null);
    const extensions = await listExtensions();
    expect(extensions).toEqual([]);
    expect(mockBuildRegistry).not.toHaveBeenCalled();
  });

  test("returns [] and logs when the registry build fails", async () => {
    setup();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      mockBuildRegistry.mockImplementationOnce(async () => {
        throw new Error("registry exploded");
      });
      expect(await listExtensions()).toEqual([]);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      cleanup();
    }
  });
});

// ─── fetchProjectSchemas ─────────────────────────────────────────────────────

describe("fetchProjectSchemas", () => {
  test("returns the pre-bundled entry documents for the project root", async () => {
    setup();
    try {
      const schemas = await fetchProjectSchemas();
      expect(schemas).toEqual(fakeBundles);
      expect(mockReadBundles).toHaveBeenCalledWith(FIXTURES);
    } finally {
      cleanup();
    }
  });

  test("returns {} quietly when no project is open", async () => {
    setProjectRoot(null);
    expect(await fetchProjectSchemas()).toEqual({});
    expect(mockReadBundles).not.toHaveBeenCalled();
  });

  test("returns {} and logs when bundling fails (editor keeps bundled core schemas)", async () => {
    setup();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      mockReadBundles.mockImplementationOnce(async () => {
        throw new Error("no project.json");
      });
      expect(await fetchProjectSchemas()).toEqual({});
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      cleanup();
    }
  });
});

// ─── formatAction ────────────────────────────────────────────────────────────

describe("formatAction", () => {
  test("parse invokes the registry entry with source and options", async () => {
    setup();
    try {
      const result = await formatAction({
        action: "parse",
        format: "Markdown",
        options: { gfm: true },
        source: "# Title",
      });
      expect(result).toEqual({ parsed: true });
      expect(entryCall).toHaveBeenCalledWith("parse", "# Title", { gfm: true });
    } finally {
      cleanup();
    }
  });

  test("parse defaults source to empty string", async () => {
    setup();
    try {
      await formatAction({ action: "parse", format: "Markdown" });
      expect(entryCall).toHaveBeenCalledWith("parse", "", undefined);
    } finally {
      cleanup();
    }
  });

  test("serialize invokes the registry entry with doc and options", async () => {
    setup();
    try {
      entryCall.mockImplementationOnce(async () => "# Out");
      const result = await formatAction({
        action: "serialize",
        doc: { children: [] },
        format: "Markdown",
        options: { wrap: 80 },
      });
      expect(result).toBe("# Out");
      expect(entryCall).toHaveBeenCalledWith("serialize", { children: [] }, { wrap: 80 });
    } finally {
      cleanup();
    }
  });

  test("serialize defaults doc to empty object", async () => {
    setup();
    try {
      await formatAction({ action: "serialize", format: "Markdown" });
      expect(entryCall).toHaveBeenCalledWith("serialize", {}, undefined);
    } finally {
      cleanup();
    }
  });

  test("throws for an unknown format", async () => {
    setup();
    try {
      await expect(formatAction({ action: "parse", format: "Nope" })).rejects.toThrow(
        'Format "Nope" is not an imported format class',
      );
    } finally {
      cleanup();
    }
  });

  test("throws for an unsupported action", async () => {
    setup();
    try {
      await expect(formatAction({ action: "discover", format: "Markdown" })).rejects.toThrow(
        'Unsupported action "discover"',
      );
    } finally {
      cleanup();
    }
  });

  test("wraps non-Error rejection values in a plain Error", async () => {
    setup();
    try {
      entryCall.mockImplementationOnce(async () => {
        // Exercising the non-Error rejection branch is the point of this test
        // oxlint-disable-next-line eslint/no-throw-literal
        throw "bare string failure";
      });
      const promise = formatAction({ action: "parse", format: "Markdown", source: "x" });
      await expect(promise).rejects.toBeInstanceOf(Error);
      await promise.catch((error: Error) => {
        expect(error.message).toBe("bare string failure");
      });
    } finally {
      cleanup();
    }
  });

  test("throws when no project is open", async () => {
    setProjectRoot(null);
    await expect(formatAction({ action: "parse", format: "Markdown" })).rejects.toThrow(
      "No project open",
    );
  });
});

// ─── jxResolve / jxServerFunction ────────────────────────────────────────────

describe("jxResolve", () => {
  test("proxies the body to handleResolve and returns status + body", async () => {
    setup();
    try {
      const result = await jxResolve({ body: '{"$prototype":"ContentCollection"}' });
      expect(result).toEqual({ body: '{"resolved":true}', status: 200 });
      const [req, root, third] = mockHandleResolve.mock.calls[0]!;
      expect(root).toBe(FIXTURES);
      expect(third).toBe(FIXTURES);
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/__jx_resolve__");
      expect(await req.text()).toBe('{"$prototype":"ContentCollection"}');
    } finally {
      cleanup();
    }
  });

  test("throws when no project is open", async () => {
    setProjectRoot(null);
    await expect(jxResolve({ body: "{}" })).rejects.toThrow("No project open");
  });
});

describe("jxServerFunction", () => {
  test("proxies the body to handleServerFunction and returns status + body", async () => {
    setup();
    try {
      const result = await jxServerFunction({ body: '{"$src":"./fn.ts"}' });
      expect(result).toEqual({ body: '{"error":"boom"}', status: 500 });
      const [req, root] = mockHandleServerFunction.mock.calls[0]!;
      expect(root).toBe(FIXTURES);
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/__jx_server__");
      expect(await req.text()).toBe('{"$src":"./fn.ts"}');
    } finally {
      cleanup();
    }
  });

  test("throws when no project is open", async () => {
    setProjectRoot(null);
    await expect(jxServerFunction({ body: "{}" })).rejects.toThrow("No project open");
  });
});

// ─── discoverComponents prop edge cases ──────────────────────────────────────

describe("discoverComponents prop edge cases", () => {
  test("filters out null state entries and surfaces format hints", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "rich-state.json"),
        JSON.stringify({
          children: [],
          state: {
            body: { default: "", format: "markdown", type: "string" },
            broken: null,
            untyped: { default: 1 },
          },
          tagName: "my-rich",
        }),
      );

      const components = await discoverComponents({ dir: "." });
      const rich = components.find((c: ComponentMeta) => c.tagName === "my-rich")!;
      expect(rich).toBeDefined();

      const names = rich.props!.map((p) => p.name);
      expect(names).not.toContain("broken");

      const body = rich.props!.find((p) => p.name === "body") as Record<string, unknown>;
      expect(body.format).toBe("markdown");
      expect(body.type).toBe("string");

      const untyped = rich.props!.find((p) => p.name === "untyped") as Record<string, unknown>;
      expect(untyped.type).toBeUndefined();
      expect(untyped.default).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// ─── fetchPluginSchema extra branches ────────────────────────────────────────

describe("fetchPluginSchema schema extraction extras", () => {
  test("extracts examples, format, $studio, format block, and capabilities", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "Fancy.class.json"),
        JSON.stringify({
          $defs: {
            constructor: { parameters: [{ identifier: "source" }] },
            fields: {
              theme: {
                description: "Color theme",
                examples: ["dark"],
                identifier: "theme",
                initializer: "light",
                role: "field",
                type: { type: "string" },
              },
            },
            methods: {
              helper: { identifier: "helper", role: "utility" },
              parse: {
                identifier: "parseDoc",
                role: "parse",
                timing: ["server"],
              },
              serialize: { role: "serialize" },
            },
            parameters: {
              source: {
                examples: ["./content"],
                format: "path",
                identifier: "source",
                type: { type: "string" },
              },
            },
          },
          $studio: { icon: "sparkle" },
          format: { extensions: [".fancy"] },
          title: "Fancy",
        }),
      );

      const schema = (await fetchPluginSchema({ src: "./Fancy.class.json" })) as StudioSchema;
      expect(schema).not.toBeNull();

      // Parameter examples + format
      expect(schema.properties.source.examples).toEqual(["./content"]);
      expect(schema.properties.source.format).toBe("path");

      // Field description, initializer-as-default, examples
      expect(schema.properties.theme.description).toBe("Color theme");
      expect(schema.properties.theme.default).toBe("light");
      expect(schema.properties.theme.examples).toEqual(["dark"]);

      // Ctor param by identifier marks required (source has no default)
      expect(schema.required).toContain("source");

      // Format-extension metadata
      expect(schema.format).toEqual({ extensions: [".fancy"] });
      expect(schema.$studio).toEqual({ icon: "sparkle" });

      // Capability summary: explicit identifier/timing + defaults; non-capability roles skipped
      expect(schema.capabilities).toEqual({
        parse: { identifier: "parseDoc", timing: ["server"] },
        serialize: { identifier: "serialize", timing: ["compiler", "server"] },
      });
    } finally {
      cleanup();
    }
  });

  test("description falls back to title", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "Titled.class.json"),
        JSON.stringify({ $defs: { parameters: {} }, title: "Titled Thing" }),
      );
      const schema = (await fetchPluginSchema({ src: "./Titled.class.json" })) as StudioSchema;
      expect(schema.description).toBe("Titled Thing");
    } finally {
      cleanup();
    }
  });

  test("returns null when module exports a non-function", async () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "constants.ts"), "export const Thing = 42;");
      const result = await fetchPluginSchema({ prototype: "Thing", src: "./constants.ts" });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("resolves class from a default-export namespace object", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "ns.ts"),
        `class Widget { static schema = { type: "object", properties: {} }; }
export default { Widget };`,
      );
      const schema = (await fetchPluginSchema({
        prototype: "Widget",
        src: "./ns.ts",
      })) as StudioSchema;
      expect(schema).not.toBeNull();
      expect(schema.type).toBe("object");
    } finally {
      cleanup();
    }
  });

  test("resolves a bare specifier through the project's require", async () => {
    setup();
    try {
      const schema = (await fetchPluginSchema({
        src: "@jxsuite/parser/Markdown.class.json",
      })) as StudioSchema;
      expect(schema).not.toBeNull();
      expect(typeof schema.properties).toBe("object");
    } finally {
      cleanup();
    }
  });

  test("falls back to the desktop package's require when project resolution fails", async () => {
    // A root outside the repo tree has no node_modules ancestor that can resolve @jxsuite/*
    const tmpRoot = mkdtempSync(join(tmpdir(), "jx-gaps-"));
    setProjectRoot(tmpRoot);
    try {
      const schema = (await fetchPluginSchema({
        src: "@jxsuite/parser/Markdown.class.json",
      })) as StudioSchema;
      expect(schema).not.toBeNull();
      expect(typeof schema.properties).toBe("object");
    } finally {
      rmSync(tmpRoot, { force: true, recursive: true });
      setProjectRoot(null);
    }
  });

  test("returns null for an unresolvable bare specifier", async () => {
    setup();
    try {
      const result = await fetchPluginSchema({ src: "@jxsuite/does-not-exist-xyz" });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("throws when no project is open", async () => {
    setProjectRoot(null);
    await expect(fetchPluginSchema({ src: "./X.class.json" })).rejects.toThrow("No project open");
  });
});

process.on("exit", () => {
  try {
    cleanup();
  } catch {}
});
