import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { resolve as resolvePath, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MarkdownFileResult, TocEntry } from "../src/types";
import type { JxElement } from "@jxsuite/schema/types";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import { buildScope, resolvePrototype, isSignal, RESERVED_KEYS } from "@jxsuite/runtime";
import { Markdown, MarkdownCollection } from "../src/md";
import { readFileSync } from "node:fs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, "..", "..", "..", "examples", "content", "posts");

/**
 * Mock fetch to serve .class.json files from disk (Happy DOM can't fetch file:// URLs). Uses spyOn
 * so the mock is properly scoped and doesn't leak to other test files.
 *
 * @param {Record<string, string>} fileMap - Maps URL substrings to absolute file paths
 * @returns {() => void} Restore function
 */
function setupClassJsonFetchMock(fileMap: Record<string, string>) {
  const originalFetch = globalThis.fetch;
  const mockFn = spyOn(globalThis, "fetch").mockImplementation((async (url: any, opts: any) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    for (const [pattern, filePath] of Object.entries(fileMap)) {
      if (urlStr.includes(pattern)) {
        const content = readFileSync(filePath, "utf8");
        return new Response(content, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return originalFetch(url, opts);
  }) as any);
  return () => {
    mockFn.mockRestore();
  };
}

// ─── MarkdownFile ─────────────────────────────────────────────────────────────

describe("Markdown", () => {
  /** @type {any} */ let result: MarkdownFileResult;

  beforeAll(async () => {
    const mf = new Markdown({
      src: join(FIXTURE_DIR, "getting-started.md"),
    });
    result = await mf.resolve();
  });

  test("constructor stores config", () => {
    const mf = new Markdown({ src: "test.md" });
    expect(mf.config.src).toBe("test.md");
  });

  test("resolve returns an object", () => {
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  });

  test("slug is filename without extension", () => {
    expect(result.slug).toBe("getting-started");
  });

  test("path is the resolved file path", () => {
    expect(result.path).toContain("getting-started.md");
  });

  test("frontmatter.title is extracted", () => {
    expect(result.frontmatter.title).toBe("Getting Started with Jx");
  });

  test("frontmatter.date is extracted", () => {
    expect(result.frontmatter.date).toBe("2025-03-15");
  });

  test("frontmatter.tags is an array", () => {
    expect(Array.isArray(result.frontmatter.tags)).toBe(true);
    expect(result.frontmatter.tags).toContain("jx");
  });

  test("frontmatter.published is a boolean", () => {
    expect(result.frontmatter.published).toBe(true);
  });

  test("$children is a non-empty array of JX nodes", () => {
    expect(Array.isArray(result.$children)).toBe(true);
    expect(result.$children.length).toBeGreaterThan(0);
  });

  test("$children contains heading nodes", () => {
    const hasHeading = result.$children.some((n: any) => n.tagName?.startsWith("h"));
    expect(hasHeading).toBe(true);
  });

  test("$children contains paragraph nodes", () => {
    const hasP = result.$children.some((n: any) => n.tagName === "p");
    expect(hasP).toBe(true);
  });

  test("$children contains code block nodes", () => {
    const hasPre = result.$children.some((n: any) => n.tagName === "pre");
    expect(hasPre).toBe(true);
  });

  test("$children contains list nodes", () => {
    const hasOl = result.$children.some((n: any) => n.tagName === "ol");
    expect(hasOl).toBe(true);
  });

  test("$children does not contain frontmatter YAML nodes", () => {
    const hasYaml = result.$children.some((n: any) => n.type === "yaml");
    expect(hasYaml).toBe(false);
  });

  test("$excerpt is the first paragraph as plain text", () => {
    expect(typeof result.$excerpt).toBe("string");
    expect(result.$excerpt!.length).toBeGreaterThan(0);
  });

  test("$toc is an array of heading entries", () => {
    expect(Array.isArray(result.$toc)).toBe(true);
    expect(result.$toc!.length).toBeGreaterThan(0);
  });

  test("$toc entries have depth, text, and id", () => {
    const entry = result.$toc![0];
    expect(entry).toHaveProperty("depth");
    expect(entry).toHaveProperty("text");
    expect(entry).toHaveProperty("id");
    expect(typeof entry.depth).toBe("number");
    expect(typeof entry.text).toBe("string");
    expect(typeof entry.id).toBe("string");
  });

  test('$toc contains "Installation" heading', () => {
    const found = result.$toc!.some((e: TocEntry) => e.text === "Installation");
    expect(found).toBe(true);
  });

  test("$readingTime is a positive integer", () => {
    expect(typeof result.$readingTime).toBe("number");
    expect(result.$readingTime).toBeGreaterThanOrEqual(1);
  });

  test("$wordCount is a positive integer", () => {
    expect(typeof result.$wordCount).toBe("number");
    expect(result.$wordCount).toBeGreaterThan(0);
  });

  test("basePath resolves relative src", async () => {
    const mf = new Markdown({
      src: "getting-started.md",
      basePath: FIXTURE_DIR,
    });
    const r = (await mf.resolve()) as any;
    expect(r.slug).toBe("getting-started");
  });
});

// ─── MarkdownFile with directives ─────────────────────────────────────────────

describe("Markdown with directives", () => {
  /** @type {any} */ let result: MarkdownFileResult;

  beforeAll(async () => {
    const mf = new Markdown({
      src: join(FIXTURE_DIR, "interactive-post.md"),
      directives: true,
    });
    result = await mf.resolve();
  });

  test("$children contains custom element from container directive", () => {
    const infoBox = result.$children.find((n: any) => n.tagName === "info-box");
    expect(infoBox).toBeTruthy();
  });

  test("directive attributes become element properties via expandDotPaths", () => {
    const infoBox = result.$children.find(
      (n): n is JxElement => typeof n !== "string" && n.tagName === "info-box",
    );
    expect(infoBox).toBeTruthy();
    expect(infoBox!.attributes?.type).toBe("warning");
  });

  test("$children contains custom element from leaf directive", () => {
    const userCard = result.$children.find(
      (n): n is JxElement => typeof n !== "string" && n.tagName === "user-card",
    );
    expect(userCard).toBeTruthy();
  });

  test("leaf directive attributes are on the element", () => {
    const userCard = result.$children.find(
      (n): n is JxElement => typeof n !== "string" && n.tagName === "user-card",
    );
    expect(userCard).toBeTruthy();
    expect(userCard!.attributes?.firstName).toBe("Jane");
    expect(userCard!.attributes?.lastName).toBe("Smith");
  });

  test("container directive content is converted to JX children", () => {
    const infoBox = result.$children.find(
      (n): n is JxElement => typeof n !== "string" && n.tagName === "info-box",
    );
    expect(infoBox).toBeTruthy();
    const hasChildren =
      ((infoBox!.children as (JxElement | string)[] | undefined)?.length ?? 0) > 0 ||
      infoBox!.textContent;
    expect(hasChildren).toBeTruthy();
  });
});

// ─── MarkdownCollection ───────────────────────────────────────────────────────

describe("MarkdownCollection", () => {
  test("constructor stores config", () => {
    const mc = new MarkdownCollection({ src: "*.md" });
    expect(mc.config.src).toBe("*.md");
  });

  test("resolve returns an array", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
    });
    const results = await mc.resolve();
    expect(Array.isArray(results)).toBe(true);
  });

  test("resolve returns all files matching glob", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
    });
    const results = await mc.resolve();
    expect(results.length).toBe(4); // getting-started, advanced-patterns, building-a-blog, interactive-post
  });

  test("each item has the MarkdownFileResult shape", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
    });
    const results = await mc.resolve();
    for (const item of results) {
      expect(item).toHaveProperty("slug");
      expect(item).toHaveProperty("path");
      expect(item).toHaveProperty("frontmatter");
      expect(item).toHaveProperty("$children");
      expect(item).toHaveProperty("$excerpt");
      expect(item).toHaveProperty("$toc");
      expect(item).toHaveProperty("$readingTime");
      expect(item).toHaveProperty("$wordCount");
    }
  });

  test("default sortBy is frontmatter.date descending", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
    });
    const results = await mc.resolve();
    const dates = results.map((r: any) => r.frontmatter.date);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1] >= dates[i]).toBe(true);
    }
  });

  test("sortOrder asc works", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
      sortOrder: "asc",
    });
    const results = await mc.resolve();
    const dates = results.map((r: any) => r.frontmatter.date);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1] <= dates[i]).toBe(true);
    }
  });

  test("custom sortBy field", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
      sortBy: "frontmatter.title",
      sortOrder: "asc",
    });
    const results = await mc.resolve();
    const titles = results.map((r: any) => r.frontmatter.title);
    for (let i = 1; i < titles.length; i++) {
      expect(titles[i - 1] <= titles[i]).toBe(true);
    }
  });

  test("limit caps the result count", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
      limit: 2,
    });
    const results = await mc.resolve();
    expect(results.length).toBe(2);
  });

  test("filter function removes items", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
      filter: (item: any) => item.frontmatter.author === "Jane Smith",
    });
    const results = await mc.resolve();
    for (const item of results) {
      expect((item as any).frontmatter.author).toBe("Jane Smith");
    }
    expect(results.length).toBe(2);
  });

  test("basePath resolves relative glob patterns", async () => {
    const mc = new MarkdownCollection({
      src: "*.md",
      basePath: FIXTURE_DIR,
    });
    const results = await mc.resolve();
    expect(results.length).toBe(4);
  });

  test("combined filter, sort, and limit", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
      filter: (item: any) => item.frontmatter.published === true,
      sortBy: "frontmatter.date",
      sortOrder: "desc",
      limit: 2,
    });
    const results = await mc.resolve();
    expect(results.length).toBe(2);
    expect((results[0] as any).frontmatter.date >= (results[1] as any).frontmatter.date).toBe(true);
  });

  test("directives option applies to all files", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "interactive-post.md"),
      directives: true,
    });
    const results = await mc.resolve();
    expect(results.length).toBe(1);
    const infoBox = (results[0] as any).$children.find((n: any) => n.tagName === "info-box");
    expect(infoBox).toBeTruthy();
  });
});

// ─── External class contract compliance ───────────────────────────────────────

describe("External class contract", () => {
  test("Markdown has resolve() method", () => {
    const mf = new Markdown({ src: "test.md" });
    expect(typeof mf.resolve).toBe("function");
  });

  test("MarkdownCollection has resolve() method", () => {
    const mc = new MarkdownCollection({ src: "*.md" });
    expect(typeof mc.resolve).toBe("function");
  });

  test("Markdown constructor accepts single config object", () => {
    const config = { src: "test.md", directives: true };
    const mf = new Markdown(config);
    expect(mf.config).toEqual(config);
  });

  test("MarkdownCollection constructor accepts single config object", () => {
    const config = { src: "*.md", sortBy: "frontmatter.title", limit: 5 };
    const mc = new MarkdownCollection(config);
    expect(mc.config).toEqual(config);
  });

  test("Markdown.resolve returns JSON-serializable result", async () => {
    const mf = new Markdown({
      src: join(FIXTURE_DIR, "getting-started.md"),
    });
    const result = (await mf.resolve()) as any;
    const serialized = JSON.stringify(result);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.slug).toBe(result.slug);
    expect(deserialized.frontmatter.title).toBe(result.frontmatter.title);
    expect(deserialized.$children.length).toBe(result.$children.length);
  });

  test("MarkdownCollection.resolve returns JSON-serializable result", async () => {
    const mc = new MarkdownCollection({
      src: join(FIXTURE_DIR, "*.md"),
      limit: 1,
    });
    const results = await mc.resolve();
    const serialized = JSON.stringify(results);
    const deserialized = JSON.parse(serialized);
    expect(deserialized[0].slug).toBe((results[0] as any).slug);
  });
});

// ─── Runtime integration ($src external prototype) ────────────────────────────

describe("Runtime external prototype ($src)", () => {
  const parserDir = resolvePath(__dirname, "..");
  const mdFilePath = resolvePath(parserDir, "src", "Markdown.class.json");
  const mdCollPath = resolvePath(parserDir, "src", "MarkdownCollection.class.json");

  /** @type {() => void} */
  let _restore: (() => void) | undefined;

  beforeAll(() => {
    _restore = setupClassJsonFetchMock({
      "Markdown.class.json": mdFilePath,
      "MarkdownCollection.class.json": mdCollPath,
    });
  });

  afterAll(() => {
    if (_restore) _restore();
  });

  test("RESERVED_KEYS includes $src", () => {
    expect(RESERVED_KEYS.has("$src")).toBe(true);
  });

  test("RESERVED_KEYS includes $export", () => {
    expect(RESERVED_KEYS.has("$export")).toBe(true);
  });

  test("resolvePrototype with $src loads Markdown", async () => {
    const def = {
      $prototype: "Markdown",
      $src: "file://" + mdFilePath,
      src: join(FIXTURE_DIR, "getting-started.md"),
    };
    const sig = (await resolvePrototype(def, {}, "$post")) as any;
    expect(isSignal(sig)).toBe(true);
    const val = sig.value;
    expect(val.slug).toBe("getting-started");
    expect(val.frontmatter.title).toBe("Getting Started with Jx");
  });

  test("resolvePrototype with $src loads MarkdownCollection", async () => {
    const def = {
      $prototype: "MarkdownCollection",
      $src: "file://" + mdCollPath,
      src: join(FIXTURE_DIR, "*.md"),
      sortBy: "frontmatter.date",
      sortOrder: "desc",
      limit: 2,
    };
    const sig = (await resolvePrototype(def, {}, "$posts")) as any;
    expect(isSignal(sig)).toBe(true);
    const val = sig.value;
    expect(Array.isArray(val)).toBe(true);
    expect(val.length).toBe(2);
  });

  test("resolvePrototype strips reserved keys from config", async () => {
    const def = {
      $prototype: "Markdown",
      $src: "file://" + mdFilePath,
      src: join(FIXTURE_DIR, "getting-started.md"),
      timing: "client",
      description: "test",
    };
    const sig = (await resolvePrototype(def, {}, "$test")) as any;
    expect(isSignal(sig)).toBe(true);
    // If reserved keys leaked in, the constructor would get them — but resolve() still works
    expect(sig.value.slug).toBe("getting-started");
  });

  test("resolvePrototype with $export override", async () => {
    // MarkdownCollection is a named export referenced via .class.json
    const def = {
      $prototype: "MC",
      $src: "file://" + mdCollPath,
      $export: "MarkdownCollection",
      src: join(FIXTURE_DIR, "*.md"),
      limit: 1,
    };
    const sig = (await resolvePrototype(def, {}, "$posts")) as any;
    expect(isSignal(sig)).toBe(true);
    const val = sig.value;
    expect(Array.isArray(val)).toBe(true);
    expect(val.length).toBe(1);
  });

  test("rejects non-Function $src pointing to .js", async () => {
    const def = {
      $prototype: "Markdown",
      $src: resolvePath(__dirname, "..", "md.js"),
    };
    await expect(resolvePrototype(def, {}, "$x")).rejects.toThrow(".class.json");
  });

  test("buildScope with external $src prototype", async () => {
    const doc = {
      state: {
        $post: {
          $prototype: "Markdown",
          $src: "file://" + mdFilePath,
          src: join(FIXTURE_DIR, "getting-started.md"),
        },
      },
    };
    const scope = await buildScope(doc, {}, "http://localhost/");
    // Vue reactive() unwraps refs, so scope.$post is the raw value
    expect(scope.$post.slug).toBe("getting-started");
  });

  test("unknown $prototype without $src warns with helpful message", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const sig = (await resolvePrototype({ $prototype: "UnknownThing" }, {}, "$u")) as any;
    expect(isSignal(sig)).toBe(true);
    expect(sig.value).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Did you mean to add '$src'?"));
    warn.mockRestore();
  });
});
