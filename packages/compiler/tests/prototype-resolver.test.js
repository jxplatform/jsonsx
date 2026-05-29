import { describe, test, expect } from "bun:test";
import { resolvePrototypes } from "../src/site/prototype-resolver.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "_fixtures_proto");

function setup() {
  mkdirSync(FIXTURES, { recursive: true });

  writeFileSync(
    join(FIXTURES, "Multiplier.js"),
    `export class Multiplier {
      constructor(config) { this.a = config.a ?? 1; this.b = config.b ?? 1; }
      async resolve() { return this.a * this.b; }
    }`,
  );

  writeFileSync(
    join(FIXTURES, "Multiplier.class.json"),
    JSON.stringify({
      title: "Multiplier",
      $implementation: "./Multiplier.js",
      $defs: { fields: {} },
    }),
  );

  writeFileSync(
    join(FIXTURES, "NoImpl.class.json"),
    JSON.stringify({
      title: "NoImpl",
      $defs: { fields: {} },
    }),
  );
}

function cleanup() {
  rmSync(FIXTURES, { recursive: true, force: true });
}

// ─── resolvePrototypes ─────────────────────────────────────────────────────

describe("resolvePrototypes", () => {
  test("skips doc without state", async () => {
    /** @type {Record<string, any>} */
    const doc = { children: [] };
    await resolvePrototypes(doc, {}, "/tmp");
    expect(doc.state).toBeUndefined();
  });

  test("skips builtin prototypes (Function, Array, etc.)", async () => {
    const doc = {
      state: {
        fn: { $prototype: "Function", body: "state.x++" },
        items: { $prototype: "Array", items: [] },
        storage: { $prototype: "LocalStorage", key: "data" },
      },
    };
    await resolvePrototypes(doc, {}, "/tmp");
    expect(doc.state.fn.$prototype).toBe("Function");
    expect(doc.state.items.$prototype).toBe("Array");
    expect(doc.state.storage.$prototype).toBe("LocalStorage");
  });

  test("skips entries without $prototype", async () => {
    const doc = { state: { count: 0, name: "test" } };
    await resolvePrototypes(doc, {}, "/tmp");
    expect(doc.state.count).toBe(0);
    expect(doc.state.name).toBe("test");
  });

  test("skips entries with timing != compiler", async () => {
    const doc = {
      state: {
        serverFn: { $prototype: "MyClass", timing: "server", $src: "./x.class.json" },
        clientFn: { $prototype: "MyClass", timing: "client", $src: "./x.class.json" },
      },
    };
    await resolvePrototypes(doc, {}, "/tmp");
    expect(doc.state.serverFn.$prototype).toBe("MyClass");
    expect(doc.state.clientFn.$prototype).toBe("MyClass");
  });

  test("skips entries with no $src and no matching import", async () => {
    const doc = {
      state: { data: { $prototype: "CSVLoader" } },
      imports: {},
    };
    await resolvePrototypes(doc, {}, "/tmp");
    expect(doc.state.data.$prototype).toBe("CSVLoader");
  });

  test("resolves $prototype with $src pointing to .class.json", async () => {
    setup();
    try {
      const doc = {
        state: {
          result: {
            $prototype: "Multiplier",
            $src: "./Multiplier.class.json",
            a: 6,
            b: 7,
          },
        },
      };
      await resolvePrototypes(doc, { sourcePath: join(FIXTURES, "page.json") }, FIXTURES);
      expect(/** @type {any} */ (doc.state.result)).toBe(42);
    } finally {
      cleanup();
    }
  });

  test("resolves $prototype via imports map", async () => {
    setup();
    try {
      const doc = {
        state: {
          result: { $prototype: "Multiplier", a: 3, b: 5 },
        },
        imports: { Multiplier: "./Multiplier.class.json" },
      };
      await resolvePrototypes(doc, { sourcePath: join(FIXTURES, "page.json") }, FIXTURES);
      expect(/** @type {any} */ (doc.state.result)).toBe(15);
    } finally {
      cleanup();
    }
  });

  test("throws gracefully when .class.json has no $implementation", async () => {
    setup();
    try {
      const doc = {
        state: {
          result: { $prototype: "NoImpl", $src: "./NoImpl.class.json" },
        },
      };
      await resolvePrototypes(doc, { sourcePath: join(FIXTURES, "page.json") }, FIXTURES);
      // Should warn but not crash — state entry remains as-is or gets error
      expect(doc.state.result).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("resolves from project root when no sourcePath", async () => {
    setup();
    try {
      const doc = {
        state: {
          result: { $prototype: "Multiplier", $src: "./Multiplier.class.json", a: 2, b: 8 },
        },
      };
      await resolvePrototypes(doc, {}, FIXTURES);
      expect(/** @type {any} */ (doc.state.result)).toBe(16);
    } finally {
      cleanup();
    }
  });

  test("strips reserved keys from config passed to class", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "Echo.js"),
        `export class Echo {
          constructor(config) { this.config = config; }
          async resolve() { return this.config; }
        }`,
      );
      writeFileSync(
        join(FIXTURES, "Echo.class.json"),
        JSON.stringify({
          title: "Echo",
          $implementation: "./Echo.js",
          $defs: { fields: {} },
        }),
      );

      const doc = {
        state: {
          result: {
            $prototype: "Echo",
            $src: "./Echo.class.json",
            timing: "compiler",
            description: "test",
            default: "ignored",
            customArg: "kept",
          },
        },
      };
      await resolvePrototypes(doc, { sourcePath: join(FIXTURES, "page.json") }, FIXTURES);
      expect(doc.state.result.customArg).toBe("kept");
      expect(doc.state.result.$prototype).toBeUndefined();
      expect(doc.state.result.description).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("resolves MarkdownFile via explicit imports", async () => {
    const mdFixtures = join(import.meta.dir, "_fixtures_builtin_md");
    mkdirSync(mdFixtures, { recursive: true });
    writeFileSync(join(mdFixtures, "test.md"), "---\ntitle: Test Page\n---\n\nHello world\n");
    try {
      const doc = {
        imports: {
          MarkdownFile: "@jxsuite/parser/MarkdownFile.class.json",
        },
        state: {
          page: {
            $prototype: "MarkdownFile",
            src: "./test.md",
            timing: "compiler",
          },
        },
      };
      await resolvePrototypes(doc, { sourcePath: join(mdFixtures, "page.json") }, mdFixtures);
      const page = /** @type {any} */ (doc.state.page);
      expect(page.frontmatter.title).toBe("Test Page");
      expect(page.$children).toBeArray();
      expect(page.$children.length).toBeGreaterThan(0);
      expect(page.slug).toBe("test");
    } finally {
      rmSync(mdFixtures, { recursive: true, force: true });
    }
  });

  test("resolves MarkdownCollection via explicit imports", async () => {
    const mdFixtures = join(import.meta.dir, "_fixtures_builtin_mdc");
    mkdirSync(mdFixtures, { recursive: true });
    writeFileSync(
      join(mdFixtures, "a.md"),
      "---\ntitle: First\ndate: 2025-01-01\n---\n\nFirst post\n",
    );
    writeFileSync(
      join(mdFixtures, "b.md"),
      "---\ntitle: Second\ndate: 2025-02-01\n---\n\nSecond post\n",
    );
    try {
      const doc = {
        imports: {
          MarkdownCollection: "@jxsuite/parser/MarkdownCollection.class.json",
        },
        state: {
          posts: {
            $prototype: "MarkdownCollection",
            src: "./*.md",
            timing: "compiler",
          },
        },
      };
      await resolvePrototypes(doc, { sourcePath: join(mdFixtures, "page.json") }, mdFixtures);
      const posts = /** @type {any[]} */ (/** @type {unknown} */ (doc.state.posts));
      expect(posts).toBeArray();
      expect(posts.length).toBe(2);
      const titles = posts.map((p) => p.frontmatter.title);
      expect(titles).toContain("First");
      expect(titles).toContain("Second");
    } finally {
      rmSync(mdFixtures, { recursive: true, force: true });
    }
  });

  test("explicit imports override built-in prototype mappings", async () => {
    setup();
    try {
      const doc = {
        state: {
          result: { $prototype: "MarkdownFile", a: 4, b: 9 },
        },
        imports: { MarkdownFile: "./Multiplier.class.json" },
      };
      await resolvePrototypes(doc, { sourcePath: join(FIXTURES, "page.json") }, FIXTURES);
      expect(/** @type {any} */ (doc.state.result)).toBe(36);
    } finally {
      cleanup();
    }
  });

  test("warns and preserves state when module does not export expected class", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "WrongExport.js"),
        `export class DifferentName { constructor() {} }`,
      );
      writeFileSync(
        join(FIXTURES, "WrongExport.class.json"),
        JSON.stringify({
          title: "WrongExport",
          $implementation: "./WrongExport.js",
          $defs: { fields: {} },
        }),
      );

      const doc = {
        state: {
          result: {
            $prototype: "WrongExport",
            $src: "./WrongExport.class.json",
          },
        },
      };
      await resolvePrototypes(doc, { sourcePath: join(FIXTURES, "page.json") }, FIXTURES);
      expect(doc.state.result).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("returns instance directly when class has no resolve method", async () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "Simple.js"),
        `export class Simple {
          constructor(config) { this.value = config.value ?? "default"; }
        }`,
      );
      writeFileSync(
        join(FIXTURES, "Simple.class.json"),
        JSON.stringify({
          title: "Simple",
          $implementation: "./Simple.js",
          $defs: { fields: {} },
        }),
      );

      const doc = {
        state: {
          result: {
            $prototype: "Simple",
            $src: "./Simple.class.json",
            value: "hello",
          },
        },
      };
      await resolvePrototypes(doc, { sourcePath: join(FIXTURES, "page.json") }, FIXTURES);
      expect(doc.state.result.value).toBe("hello");
    } finally {
      cleanup();
    }
  });
});

process.on("exit", () => {
  try {
    cleanup();
  } catch {}
});
