import { describe, expect, test } from "bun:test";
import { buildFormatRegistry, FormatEntry, type FormatHostIO } from "../src/format-registry";

const MARKDOWN_CLASS = {
  title: "Markdown",
  $prototype: "Class",
  $implementation: "./markdown.js",
  format: {
    extensions: [".md"],
    mediaType: "text/markdown",
    documentKinds: ["page", "component", "content"],
    exportTarget: true,
  },
  $studio: { modes: ["edit", "preview"], elements: { block: ["p", "h1"] } },
  $defs: {
    methods: {
      resolve: { role: "method", scope: "instance", identifier: "resolve" },
      parse: {
        role: "parse",
        scope: "static",
        identifier: "parse",
        timing: ["compiler", "server", "client"],
      },
      serialize: {
        role: "serialize",
        scope: "static",
        identifier: "serialize",
        timing: ["compiler", "server", "client"],
      },
      discover: { role: "discover", scope: "static", identifier: "discover" },
      load: { role: "load", scope: "static", identifier: "load" },
    },
  },
};

const CSV_CLASS = {
  title: "Csv",
  $prototype: "Class",
  $implementation: "./csv.js",
  format: { extensions: [".csv"], documentKinds: ["content"], remote: true },
  $defs: {
    methods: {
      parse: { role: "parse", scope: "static", identifier: "parse" },
      load: { role: "load", scope: "static", identifier: "load" },
    },
  },
};

function makeIO(
  files: Record<string, unknown>,
  modules: Record<string, unknown> = {},
): FormatHostIO {
  return {
    loadJson: async (path) => {
      if (!(path in files)) throw new Error(`not found: ${path}`);
      return files[path] as Record<string, unknown>;
    },
    importModule: async (path) => {
      if (!(path in modules)) throw new Error(`no module: ${path}`);
      return modules[path] as Record<string, unknown>;
    },
    resolvePath: (base, ref) => new URL(ref, `file://${base}`).pathname,
  };
}

describe("buildFormatRegistry", () => {
  test("discovers format classes from imports map", async () => {
    const io = makeIO({ "/proj/Markdown.class.json": MARKDOWN_CLASS });
    const registry = await buildFormatRegistry(
      { Markdown: "./Markdown.class.json", Layout: "./layouts/main.json" },
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
        title: "Calculator",
        $prototype: "Class",
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

  test("throws on ambiguous (extension, capability) claims", async () => {
    const other = structuredClone(MARKDOWN_CLASS);
    other.title = "OtherMd";
    const io = makeIO({
      "/proj/Markdown.class.json": MARKDOWN_CLASS,
      "/proj/OtherMd.class.json": other,
    });
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
      title: "MdParse",
      $implementation: "./a.js",
      format: { extensions: [".md"] },
      $defs: { methods: { parse: { role: "parse", identifier: "parse" } } },
    };
    const loader = {
      title: "MdLoad",
      $implementation: "./b.js",
      format: { extensions: [".md"] },
      $defs: { methods: { load: { role: "load", identifier: "load" } } },
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
      "/p/Markdown.class.json": MARKDOWN_CLASS,
      "/p/Csv.class.json": CSV_CLASS,
    });
    return buildFormatRegistry(
      { Markdown: "./Markdown.class.json", Csv: "./Csv.class.json" },
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
    expect(reg.withCapability("load").map((e) => e.name)).toEqual(["Markdown", "Csv"]);
  });

  test("documentExtensions filters by kind and never includes .json", async () => {
    const reg = await registry();
    expect(reg.documentExtensions()).toEqual([".md", ".csv"]);
    expect(reg.documentExtensions("page")).toEqual([".md"]);
    expect(reg.documentExtensions("content")).toEqual([".md", ".csv"]);
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
    await expect(reg.byName("Csv")!.call("serialize", {})).rejects.toThrow(
      /does not declare a "serialize" capability/,
    );
  });

  test("throws when the implementation lacks the static method", async () => {
    const io = makeIO({ "/p/Csv.class.json": CSV_CLASS }, { "/p/csv.js": { Csv: {} } });
    const reg = await buildFormatRegistry({ Csv: "./Csv.class.json" }, io, "/p/x");
    await expect(reg.byName("Csv")!.call("parse", "a,b")).rejects.toThrow(
      /no static "parse" method/,
    );
  });
});
