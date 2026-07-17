import { describe, expect, test } from "bun:test";
import { EXTENSION_CAPABILITIES, FormatEntry, buildFormatRegistry } from "../src/format-registry";
import type { FormatHostIO } from "../src/format-registry";

describe("EXTENSION_CAPABILITIES", () => {
  test("includes the build-time emit role", () => {
    expect(EXTENSION_CAPABILITIES).toContain("emit");
  });
});

const MARKDOWN_CLASS = {
  $defs: {
    methods: {
      discover: { identifier: "discover", role: "discover", scope: "static" },
      load: { identifier: "load", role: "load", scope: "static" },
      parse: {
        identifier: "parse",
        role: "parse",
        scope: "static",
        timing: ["compiler", "server", "client"],
      },
      resolve: { identifier: "resolve", role: "method", scope: "instance" },
      serialize: {
        identifier: "serialize",
        role: "serialize",
        scope: "static",
        timing: ["compiler", "server", "client"],
      },
    },
  },
  $implementation: "./markdown.js",
  $prototype: "Class",
  $studio: { elements: { block: ["p", "h1"] }, modes: ["edit", "preview"] },
  format: {
    documentKinds: ["page", "component", "content"],
    exportTarget: true,
    extensions: [".md"],
    mediaType: "text/markdown",
  },
  title: "Markdown",
};

const CSV_CLASS = {
  $defs: {
    methods: {
      load: { identifier: "load", role: "load", scope: "static" },
      parse: { identifier: "parse", role: "parse", scope: "static" },
    },
  },
  $implementation: "./csv.js",
  $prototype: "Class",
  format: { documentKinds: ["content"], extensions: [".csv"], remote: true },
  title: "Csv",
};

function makeIO(
  files: Record<string, unknown>,
  modules: Record<string, unknown> = {},
): FormatHostIO {
  return {
    importModule: async (path) => {
      if (!(path in modules)) {
        throw new Error(`no module: ${path}`);
      }
      return modules[path] as Record<string, unknown>;
    },
    loadJson: async (path) => {
      if (!(path in files)) {
        throw new Error(`not found: ${path}`);
      }
      return files[path] as Record<string, unknown>;
    },
    resolvePath: (base, ref) => new URL(ref, `file://${base}`).pathname,
  };
}

describe("buildFormatRegistry", () => {
  test("discovers format classes from imports map", async () => {
    const io = makeIO({ "/proj/Markdown.class.json": MARKDOWN_CLASS });
    const registry = await buildFormatRegistry(
      { Layout: "./layouts/main.json", Markdown: "./Markdown.class.json" },
      io,
      "/proj/project.json",
    );
    expect(registry.entries.length).toBe(1);
    expect(registry.byName("Markdown")).toBeInstanceOf(FormatEntry);
  });

  test("skips non-.class.json imports without loading them", async () => {
    const io = makeIO({});
    const registry = await buildFormatRegistry({ Layout: "./layouts/main.json" }, io, "/proj/x");
    expect(registry.entries.length).toBe(0);
  });

  test("skips class files without a format block", async () => {
    const io = makeIO({
      "/proj/Calculator.class.json": {
        $prototype: "Class",
        title: "Calculator",
      },
    });
    const registry = await buildFormatRegistry(
      { Calculator: "./Calculator.class.json" },
      io,
      "/proj/project.json",
    );
    expect(registry.entries.length).toBe(0);
  });

  test("skips unreadable imports silently", async () => {
    const io = makeIO({});
    const registry = await buildFormatRegistry(
      { Missing: "./Missing.class.json" },
      io,
      "/proj/project.json",
    );
    expect(registry.entries.length).toBe(0);
  });

  test("skips imports whose path resolution throws, keeping resolvable entries", async () => {
    const io = makeIO({ "/proj/Markdown.class.json": MARKDOWN_CLASS });
    io.resolvePath = (base, ref) => {
      if (ref.startsWith("@missing/")) {
        throw new Error(`Cannot find module '${ref}'`);
      }
      return new URL(ref, `file://${base}`).pathname;
    };
    const registry = await buildFormatRegistry(
      { Broken: "@missing/pkg/Broken.class.json", Markdown: "./Markdown.class.json" },
      io,
      "/proj/project.json",
    );
    expect(registry.entries.length).toBe(1);
    expect(registry.byName("Markdown")).toBeInstanceOf(FormatEntry);
  });

  test("throws on ambiguous (extension, capability) claims", async () => {
    const other = structuredClone(MARKDOWN_CLASS);
    other.title = "OtherMd";
    const io = makeIO({
      "/proj/Markdown.class.json": MARKDOWN_CLASS,
      "/proj/OtherMd.class.json": other,
    });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(
      buildFormatRegistry(
        { Markdown: "./Markdown.class.json", OtherMd: "./OtherMd.class.json" },
        io,
        "/proj/project.json",
      ),
    ).rejects.toThrow(/Format conflict/);
  });

  test("allows two classes claiming the same extension with disjoint capabilities", async () => {
    const parser = {
      $defs: { methods: { parse: { identifier: "parse", role: "parse" } } },
      $implementation: "./a.js",
      format: { extensions: [".md"] },
      title: "MdParse",
    };
    const loader = {
      $defs: { methods: { load: { identifier: "load", role: "load" } } },
      $implementation: "./b.js",
      format: { extensions: [".md"] },
      title: "MdLoad",
    };
    const io = makeIO({ "/p/A.class.json": parser, "/p/B.class.json": loader });
    const registry = await buildFormatRegistry(
      { A: "./A.class.json", B: "./B.class.json" },
      io,
      "/p/project.json",
    );
    expect(registry.byExtension(".md", "parse")?.name).toBe("A");
    expect(registry.byExtension(".md", "load")?.name).toBe("B");
  });
});

describe("FormatRegistry lookups", () => {
  async function registry() {
    const io = makeIO({
      "/p/Csv.class.json": CSV_CLASS,
      "/p/Markdown.class.json": MARKDOWN_CLASS,
    });
    return buildFormatRegistry(
      { Csv: "./Csv.class.json", Markdown: "./Markdown.class.json" },
      io,
      "/p/project.json",
    );
  }

  test("byExtension normalizes extension and is capability-qualified", async () => {
    const reg = await registry();
    expect(reg.byExtension("md")?.name).toBe("Markdown");
    expect(reg.byExtension(".MD")?.name).toBe("Markdown");
    expect(reg.byExtension(".csv", "load")?.name).toBe("Csv");
    expect(reg.byExtension(".csv", "serialize")).toBeUndefined();
    expect(reg.byExtension(".toml")).toBeUndefined();
  });

  test("withCapability filters by declared roles", async () => {
    const reg = await registry();
    expect(reg.withCapability("serialize").map((e) => e.name)).toEqual(["Markdown"]);
    expect(reg.withCapability("load").map((e) => e.name)).toEqual(["Csv", "Markdown"]);
  });

  test("documentExtensions filters by kind and never includes .json", async () => {
    const reg = await registry();
    expect(reg.documentExtensions()).toEqual([".csv", ".md"]);
    expect(reg.documentExtensions("page")).toEqual([".md"]);
    expect(reg.documentExtensions("content")).toEqual([".csv", ".md"]);
  });

  test("has() reports claimed extensions", async () => {
    const reg = await registry();
    expect(reg.has(".md")).toBe(true);
    expect(reg.has("csv")).toBe(true);
    expect(reg.has(".yaml")).toBe(false);
  });

  test("exposes format metadata and studio hints", async () => {
    const reg = await registry();
    const md = reg.byName("Markdown")!;
    expect(md.exportTarget).toBe(true);
    expect(md.mediaType).toBe("text/markdown");
    expect(md.studio?.modes).toEqual(["edit", "preview"]);
    const csv = reg.byName("Csv")!;
    expect(csv.remote).toBe(true);
    expect(csv.studio).toBeNull();
  });

  test("capability timing defaults to compiler+server", async () => {
    const reg = await registry();
    expect(reg.byName("Markdown")!.capabilities.parse?.timing).toEqual([
      "compiler",
      "server",
      "client",
    ]);
    expect(reg.byName("Csv")!.capabilities.parse?.timing).toEqual(["compiler", "server"]);
  });
});

describe("FormatEntry.call", () => {
  test("invokes the static capability method on the implementation export", async () => {
    const calls: unknown[][] = [];
    const io = makeIO(
      { "/p/Markdown.class.json": MARKDOWN_CLASS },
      {
        "/p/markdown.js": {
          Markdown: {
            parse: (...args: unknown[]) => {
              calls.push(args);
              return { tagName: "article" };
            },
          },
        },
      },
    );
    const reg = await buildFormatRegistry({ Markdown: "./Markdown.class.json" }, io, "/p/x");
    const result = await reg.byName("Markdown")!.call("parse", "# hi", { base: "/p" });
    expect(result).toEqual({ tagName: "article" });
    expect(calls[0]).toEqual(["# hi", { base: "/p" }]);
  });

  test("throws a clear error for undeclared capabilities", async () => {
    const io = makeIO({ "/p/Csv.class.json": CSV_CLASS });
    const reg = await buildFormatRegistry({ Csv: "./Csv.class.json" }, io, "/p/x");
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(reg.byName("Csv")!.call("serialize", {})).rejects.toThrow(
      /does not declare a "serialize" capability/,
    );
  });

  test("throws when the implementation lacks the static method", async () => {
    const io = makeIO({ "/p/Csv.class.json": CSV_CLASS }, { "/p/csv.js": { Csv: {} } });
    const reg = await buildFormatRegistry({ Csv: "./Csv.class.json" }, io, "/p/x");
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(reg.byName("Csv")!.call("parse", "a,b")).rejects.toThrow(
      /no static "parse" method/,
    );
  });
});
