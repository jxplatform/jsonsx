/**
 * Content-loader tests — the parser's extension-model content loader (src/content-loader.ts).
 *
 * Dispatch and error branches use real FormatEntry/FormatRegistry instances backed by in-memory
 * fake implementations (no parser code involved); the Content capability tests build a real
 * ExtensionRegistry from a fixture manifest pointing at the package's own class descriptors, so
 * markdown content loads through the actual Markdown class exactly as a host would drive it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ProjectConfig } from "@jxsuite/schema/types";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import { FormatEntry, FormatRegistry } from "@jxsuite/schema/format-registry";
import type { FormatHostIO } from "@jxsuite/schema/format-registry";
import {
  Content,
  contentAssetMounts,
  getContentTypeElements,
  loadContentConfig,
  loadContentSection,
  localesForExpansion,
  resolveContentTypeRefs,
} from "../src/content-loader.ts";
import type { ContentLoaderEntry, ContentSection } from "../src/content-loader.ts";

const TMP = mkdtempSync(join(tmpdir(), "jx-parser-content-loader-"));

beforeAll(() => {
  // JSON fixtures
  mkdirSync(resolve(TMP, "content/things"), { recursive: true });
  writeFileSync(
    resolve(TMP, "content/things/one.json"),
    JSON.stringify({ id: "one", name: "One" }),
  );
  mkdirSync(resolve(TMP, "content/array"), { recursive: true });
  writeFileSync(
    resolve(TMP, "content/array/list.json"),
    JSON.stringify([{ id: "two", name: "Two" }, { name: "anon" }]),
  );
  writeFileSync(resolve(TMP, "content/plain.json"), JSON.stringify({ name: "no-id" }));
  writeFileSync(resolve(TMP, "content/single.fake"), "raw fake body");

  // Markdown + authors fixtures for the extension-registry-driven Content tests
  mkdirSync(resolve(TMP, "content/posts"), { recursive: true });
  writeFileSync(
    resolve(TMP, "content/posts/hello.md"),
    "---\ntitle: Hello\nauthor: jane\nreviewers:\n  - jane\n  - ghost\n---\n\n# Hello World\n",
  );
  mkdirSync(resolve(TMP, "content/authors"), { recursive: true });
  writeFileSync(
    resolve(TMP, "content/authors/jane.json"),
    JSON.stringify({ id: "jane", name: "Jane" }),
  );

  // Nested markdown tree for path-based id derivation
  mkdirSync(resolve(TMP, "content/tree/guides/nested"), { recursive: true });
  writeFileSync(resolve(TMP, "content/tree/root.md"), "---\ntitle: Root\n---\n\nRoot.\n");
  writeFileSync(resolve(TMP, "content/tree/guides/deep.md"), "---\ntitle: Deep\n---\n\nDeep.\n");
  writeFileSync(
    resolve(TMP, "content/tree/guides/nested/index.md"),
    "---\ntitle: Nested\n---\n\nNested.\n",
  );

  // Extension fixture: a manifest naming the package's real class descriptors
  mkdirSync(resolve(TMP, "ext"), { recursive: true });
  writeFileSync(
    resolve(TMP, "ext/jx-extension.json"),
    JSON.stringify({
      classes: {
        Content: resolve(import.meta.dir, "../src/Content.class.json"),
        Markdown: resolve(import.meta.dir, "../src/Markdown.class.json"),
      },
      name: "parser-fixture",
    }),
  );
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

const origWarn = console.warn;
afterEach(() => {
  console.warn = origWarn;
});

function captureWarnings(): string[] {
  const warnings: string[] = [];
  console.warn = (msg: string) => warnings.push(msg);
  return warnings;
}

// ─── Fake format machinery ───────────────────────────────────────────────────

interface FakeImplOptions {
  remote?: boolean;
  withDiscover?: boolean;
  discoverResult?: string[];
  loadImpl?: (source: string, options?: Record<string, unknown>) => unknown;
}

/** Build a real FormatEntry backed by an in-memory implementation class. */
function makeFakeEntry(name: string, opts: FakeImplOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const Impl = {
    discover: (...args: unknown[]) => {
      calls.push({ args, method: "discover" });
      return opts.discoverResult ?? [];
    },
    load: (...args: unknown[]) => {
      calls.push({ args, method: "load" });
      if (opts.loadImpl) {
        return opts.loadImpl(args[0] as string, args[1] as Record<string, unknown>);
      }
      return [{ body: null, data: { name: "fake" }, id: "fake-entry" }];
    },
  };
  const io: FormatHostIO = {
    importModule: () => Promise.resolve({ [name]: Impl }),
    loadJson: () => Promise.reject(new Error("not used")),
    resolvePath: (_base, ref) => ref,
  };
  const methods: Record<string, { role: string; identifier: string }> = {
    load: { identifier: "load", role: "load" },
  };
  if (opts.withDiscover) {
    methods.discover = { identifier: "discover", role: "discover" };
  }
  const classDef = {
    $defs: { methods },
    $implementation: "./fake.js",
    format: {
      extensions: [".fake"],
      ...(opts.remote ? { remote: true } : {}),
    },
    title: name,
  };
  const entry = new FormatEntry(name, "/virtual/fake.class.json", classDef, io);
  return { calls, entry };
}

function makeRegistry(...entries: FormatEntry[]) {
  return new FormatRegistry(entries);
}

// ─── Real extension registry fixture ─────────────────────────────────────────

/** Node-backed FormatHostIO: real fs + dynamic import, with a .js → .ts source fallback. */
function makeNodeIO(): FormatHostIO {
  return {
    importModule: async (path) => {
      try {
        return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
      } catch {
        const tsPath = `${path.slice(0, -3)}.ts`;
        return (await import(pathToFileURL(tsPath).href)) as Record<string, unknown>;
      }
    },
    loadJson: (path) =>
      Promise.resolve(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>),
    resolvePath: (base, ref) => (isAbsolute(ref) ? ref : resolve(dirname(base), ref)),
  };
}

async function buildFixtureRegistry(): Promise<ExtensionRegistry> {
  return await buildExtensionRegistry(["./ext"], makeNodeIO(), resolve(TMP, "project.json"));
}

// ─── loadContentConfig ───────────────────────────────────────────────────────

describe("loadContentConfig", () => {
  it("resolves contentDir under the project root", () => {
    const result = loadContentConfig(TMP);
    expect(result.contentDir).toBe(resolve(TMP, "content"));
    expect(result.config.content).toEqual({});
  });

  it("passes through the content section from the project config", () => {
    const result = loadContentConfig(TMP, {
      content: { posts: { source: "./content/posts/" } },
    });
    expect(result.config.content.posts).toEqual({ source: "./content/posts/" });
  });
});

// ─── loadContentSection — dispatch and error branches ────────────────────────

describe("loadContentSection", () => {
  it("returns an empty map for an empty section", async () => {
    const result = await loadContentSection({}, TMP, makeRegistry());
    expect(result.size).toBe(0);
  });

  it("returns empty entries for a content type without a source", async () => {
    const section = { empty: {} as { source: string } };
    const result = await loadContentSection(section, TMP, makeRegistry());
    expect(result.get("empty")).toEqual([]);
  });

  it("throws when format names a class missing from the registry", async () => {
    const section = { posts: { format: "Bogus", source: "./content/posts/" } };
    const promise = loadContentSection(section, TMP, makeRegistry());
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(promise).rejects.toThrow(/format "Bogus" is not a registered format class/);
  });

  it("throws for a remote source without an explicit format", async () => {
    const section = { feed: { source: "https://example.com/feed.csv" } };
    const promise = loadContentSection(section, TMP, makeRegistry());
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(promise).rejects.toThrow(/remote sources require an explicit "format"/);
  });

  it("throws for a remote source whose format is not remote-capable", async () => {
    const { entry } = makeFakeEntry("LocalOnly");
    const section = { feed: { format: "LocalOnly", source: "https://example.com/feed.fake" } };
    const promise = loadContentSection(section, TMP, makeRegistry(entry));
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(promise).rejects.toThrow(/does not support remote sources/);
  });

  it("loads remote entries through a remote-capable format", async () => {
    const { calls, entry } = makeFakeEntry("RemoteFake", {
      loadImpl: () => [
        { body: null, data: { name: "Remote A" }, id: "a" },
        { body: null, data: { name: "Remote B" }, id: "b" },
      ],
      remote: true,
    });
    const section = {
      feed: {
        format: "RemoteFake",
        schema: { properties: { name: { type: "string" } }, required: ["name"] },
        source: "https://example.com/feed.fake",
      },
    };
    const result = await loadContentSection(section, TMP, makeRegistry(entry));
    const feed = result.get("feed") as ContentLoaderEntry[];
    expect(feed.map((e) => e.id)).toEqual(["a", "b"]);
    expect(calls[0]?.method).toBe("load");
    expect(calls[0]?.args[0]).toBe("https://example.com/feed.fake");
  });

  it("warns and returns no entries when a remote load fails", async () => {
    const warnings = captureWarnings();
    const { entry } = makeFakeEntry("RemoteFake", {
      loadImpl: () => {
        throw new Error("connection refused");
      },
      remote: true,
    });
    const section = { feed: { format: "RemoteFake", source: "https://example.com/feed.fake" } };
    const result = await loadContentSection(section, TMP, makeRegistry(entry));
    expect(result.get("feed")).toEqual([]);
    expect(warnings.some((w) => w.includes("connection refused"))).toBe(true);
  });

  it("throws unknown-format error for an unregistered extension", async () => {
    const section = { data: { source: "./content/data.xyz" } };
    const promise = loadContentSection(section, TMP, makeRegistry());
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(promise).rejects.toThrow(/No format class registered for "\.xyz"/);
  });

  it("throws a directory-specific error for extensionless sources without a format", async () => {
    const section = { docs: { source: "./content/docs/" } };
    const promise = loadContentSection(section, TMP, makeRegistry());
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(promise).rejects.toThrow(/directory sources need an explicit "format"/);
  });

  it("uses the discover capability to enumerate entry files", async () => {
    const { calls, entry } = makeFakeEntry("FakeFmt", {
      discoverResult: ["/virtual/a.fake", "/virtual/b.fake"],
      loadImpl: (source) => [{ body: null, data: { src: source }, id: source }],
      withDiscover: true,
    });
    const section = { docs: { format: "FakeFmt", source: "./content/docs/" } };
    const result = await loadContentSection(section, TMP, makeRegistry(entry));
    const docs = result.get("docs") as ContentLoaderEntry[];
    expect(docs.map((e) => e.id)).toEqual(["/virtual/a.fake", "/virtual/b.fake"]);
    expect(calls[0]?.method).toBe("discover");
    expect(calls[0]?.args[1]).toEqual({ baseDir: TMP });
  });

  it("falls back to the resolved source when the format lacks discover", async () => {
    const { calls, entry } = makeFakeEntry("FakeFmt", {
      loadImpl: (source) => [{ body: null, data: { src: source }, id: "solo" }],
    });
    const section = { docs: { format: "FakeFmt", source: "./content/single.fake" } };
    const result = await loadContentSection(section, TMP, makeRegistry(entry));
    const docs = result.get("docs") as ContentLoaderEntry[];
    expect(docs).toHaveLength(1);
    expect(calls[0]?.method).toBe("load");
    expect(String(calls[0]?.args[0])).toContain("content/single.fake");
  });

  it("derives the format from the source extension when none is named", async () => {
    const { entry } = makeFakeEntry("FakeFmt", {
      loadImpl: () => [{ body: null, data: {}, id: "by-ext" }],
    });
    const section = { docs: { source: "./content/single.fake" } };
    const result = await loadContentSection(section, TMP, makeRegistry(entry));
    expect((result.get("docs") as ContentLoaderEntry[])[0]?.id).toBe("by-ext");
  });

  it("validates registry-loaded entries against the schema", async () => {
    const warnings = captureWarnings();
    const { entry } = makeFakeEntry("FakeFmt", {
      loadImpl: () => [
        { body: null, data: { arr: "x", count: "ten", flag: "y", name: 5, skip: null }, id: "bad" },
      ],
    });
    const section = {
      docs: {
        format: "FakeFmt",
        schema: {
          properties: {
            arr: { type: "array" },
            count: { type: "number" },
            flag: { type: "boolean" },
            name: { type: "string" },
            skip: { type: "string" },
          },
          required: ["title"],
        },
        source: "./content/single.fake",
      },
    };
    await loadContentSection(section, TMP, makeRegistry(entry));
    expect(warnings.some((w) => w.includes('missing required field "title"'))).toBe(true);
    expect(warnings.some((w) => w.includes("expected string, got number"))).toBe(true);
    expect(warnings.some((w) => w.includes("expected number, got string"))).toBe(true);
    expect(warnings.some((w) => w.includes("expected boolean, got string"))).toBe(true);
    expect(warnings.some((w) => w.includes("expected array, got string"))).toBe(true);
    expect(warnings.some((w) => w.includes('field "skip"'))).toBe(false);
  });

  it("loads native JSON entries via the explicit json format name", async () => {
    const section = { things: { format: "json", source: "./content/things/" } };
    const result = await loadContentSection(section, TMP, makeRegistry());
    const things = result.get("things") as ContentLoaderEntry[];
    expect(things).toHaveLength(1);
    expect(things[0]?.id).toBe("one");
    expect(things[0]?.data.name).toBe("One");
  });

  it("loads JSON array files with per-item ids and index fallbacks", async () => {
    const section = {
      rows: {
        format: "json",
        schema: { properties: { name: { type: "string" } } },
        source: "./content/array/",
      },
    };
    const result = await loadContentSection(section, TMP, makeRegistry());
    const rows = result.get("rows") as ContentLoaderEntry[];
    expect(rows.map((e) => e.id)).toEqual(["two", "list-1"]);
  });

  it("derives JSON from a .json source extension and falls back to the filename id", async () => {
    const section = { plain: { source: "./content/plain.json" } };
    const result = await loadContentSection(section, TMP, makeRegistry());
    const plain = result.get("plain") as ContentLoaderEntry[];
    expect(plain).toHaveLength(1);
    expect(plain[0]?.id).toBe("plain");
    expect(plain[0]?.data.name).toBe("no-id");
  });

  it("returns no entries for a missing JSON directory", async () => {
    const section = { ghosts: { format: "json", source: "./content/ghosts/" } };
    const result = await loadContentSection(section, TMP, makeRegistry());
    expect(result.get("ghosts")).toEqual([]);
  });

  it("returns no entries for a missing single JSON file", async () => {
    const section = { ghost: { format: "json", source: "./content/nope.json" } };
    const result = await loadContentSection(section, TMP, makeRegistry());
    expect(result.get("ghost")).toEqual([]);
  });

  it("passes $elements-derived allowedNames in directive options", async () => {
    const { calls, entry } = makeFakeEntry("FakeFmt", {
      loadImpl: () => [{ body: null, data: {}, id: "x" }],
    });
    const section = {
      docs: {
        $elements: ["my-widget", { $ref: "./card.json" }, 42 as unknown as string],
        format: "FakeFmt",
        source: "./content/single.fake",
      },
    };
    await loadContentSection(section, TMP, makeRegistry(entry));
    const loadOptions = calls[0]?.args[1] as { directiveOptions?: { allowedNames?: string[] } };
    expect(loadOptions.directiveOptions?.allowedNames).toEqual(["my-widget", "./card.json"]);
  });

  it("passes sourceRoot to load for directory sources but not single files", async () => {
    const { calls, entry } = makeFakeEntry("FakeFmt", {
      discoverResult: [resolve(TMP, "content/single.fake")],
      loadImpl: () => [{ body: null, data: {}, id: "x" }],
      withDiscover: true,
    });
    const section = { docs: { format: "FakeFmt", source: "./content/" } };
    await loadContentSection(section, TMP, makeRegistry(entry));
    const dirLoad = calls.find((c) => c.method === "load");
    const dirOptions = dirLoad ? (dirLoad.args[1] as { sourceRoot?: string }) : undefined;
    expect(dirOptions?.sourceRoot).toBe(resolve(TMP, "content"));

    calls.length = 0;
    const single = { one: { format: "FakeFmt", source: "./content/single.fake" } };
    await loadContentSection(single, TMP, makeRegistry(entry));
    const singleLoad = calls.find((c) => c.method === "load");
    const singleOptions = singleLoad ? (singleLoad.args[1] as { sourceRoot?: string }) : undefined;
    expect(singleOptions?.sourceRoot).toBeUndefined();
  });
});

// ─── getContentTypeElements ──────────────────────────────────────────────────

describe("getContentTypeElements", () => {
  it("returns undefined when the content type is not defined", () => {
    expect(getContentTypeElements(TMP, "missing", { content: {} })).toBeUndefined();
  });

  it("returns the $elements list for a defined content type", () => {
    const config = {
      content: { posts: { $elements: ["a-card"], source: "./content/posts/" } },
    };
    expect(getContentTypeElements(TMP, "posts", config)).toEqual(["a-card"]);
  });
});

// ─── resolveContentTypeRefs ──────────────────────────────────────────────────

describe("resolveContentTypeRefs", () => {
  it("skips content types without schema properties or entries", () => {
    const contentTypes = new Map<string, ContentLoaderEntry[]>([
      ["present", [{ body: null, data: { a: 1 }, id: "p" }]],
    ]);
    // No schema → skip; schema but no loaded entries → skip; non-#/content ref → skip
    resolveContentTypeRefs(contentTypes, {
      absent: {
        schema: { properties: { x: { $ref: "#/content/present" } } },
        source: "./a/",
      },
      noschema: { source: "./b/" },
      present: {
        schema: { properties: { a: { $ref: "#/$defs/Other" } } },
        source: "./c/",
      },
    });
    expect(contentTypes.get("present")?.[0]?.data.a).toBe(1);
  });

  it("warns on dangling relationship ids and unknown target types", () => {
    const warnings = captureWarnings();
    const contentTypes = new Map<string, ContentLoaderEntry[]>([
      [
        "posts",
        [{ body: null, data: { author: "ghost-author", reviewers: ["jane", "nobody"] }, id: "p1" }],
      ],
      ["authors", [{ body: null, data: { name: "Jane" }, id: "jane" }]],
    ]);
    resolveContentTypeRefs(contentTypes, {
      posts: {
        schema: {
          properties: {
            author: { $ref: "#/content/authors" },
            category: { $ref: "#/content/categories" },
            reviewers: { items: { $ref: "#/content/authors" }, type: "array" },
          },
        },
        source: "./posts/",
      },
    });
    expect(
      warnings.some((w) => w.includes('references missing "authors" entry "ghost-author"')),
    ).toBe(true);
    expect(warnings.some((w) => w.includes('references missing "authors" entry "nobody"'))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes('references unknown content type "categories"'))).toBe(
      true,
    );
    // Resolvable id still resolves; dangling ids stay untouched
    const reviewers = contentTypes.get("posts")?.[0]?.data.reviewers as unknown[];
    expect((reviewers[0] as ContentLoaderEntry).id).toBe("jane");
    expect(reviewers[1]).toBe("nobody");
  });

  it("does not resolve legacy #/contentTypes/ pointers", () => {
    const contentTypes = new Map<string, ContentLoaderEntry[]>([
      ["posts", [{ body: null, data: { author: "jane" }, id: "p1" }]],
      ["authors", [{ body: null, data: { name: "Jane" }, id: "jane" }]],
    ]);
    resolveContentTypeRefs(contentTypes, {
      posts: {
        schema: { properties: { author: { $ref: "#/contentTypes/authors" } } },
        source: "./posts/",
      },
    });
    expect(contentTypes.get("posts")?.[0]?.data.author).toBe("jane");
  });

  it("leaves unresolved ids and non-string values untouched", () => {
    const contentTypes = new Map<string, ContentLoaderEntry[]>([
      [
        "posts",
        [
          { body: null, data: { author: "ghost" }, id: "p1" },
          { body: null, data: { author: 7 }, id: "p2" },
        ],
      ],
      ["authors", [{ body: null, data: { name: "Jane" }, id: "jane" }]],
    ]);
    resolveContentTypeRefs(contentTypes, {
      posts: {
        schema: { properties: { author: { $ref: "#/content/authors" } } },
        source: "./posts/",
      },
    });
    expect(contentTypes.get("posts")?.[0]?.data.author).toBe("ghost");
    expect(contentTypes.get("posts")?.[1]?.data.author).toBe(7);
  });

  it("skips refs to content types that are not loaded", () => {
    const contentTypes = new Map<string, ContentLoaderEntry[]>([
      ["posts", [{ body: null, data: { author: "jane" }, id: "p1" }]],
    ]);
    resolveContentTypeRefs(contentTypes, {
      posts: {
        schema: { properties: { author: { $ref: "#/content/missing" } } },
        source: "./posts/",
      },
    });
    expect(contentTypes.get("posts")?.[0]?.data.author).toBe("jane");
  });

  it("resolves a to-one string id into the referenced entry", () => {
    const contentTypes = new Map<string, ContentLoaderEntry[]>([
      ["posts", [{ body: null, data: { author: "jane" }, id: "p1" }]],
      ["authors", [{ body: null, data: { name: "Jane" }, id: "jane" }]],
    ]);
    resolveContentTypeRefs(contentTypes, {
      posts: {
        schema: { properties: { author: { $ref: "#/content/authors" } } },
        source: "./posts/",
      },
    });
    const author = contentTypes.get("posts")?.[0]?.data.author as ContentLoaderEntry;
    expect(author.id).toBe("jane");
    expect(author.data.name).toBe("Jane");
  });

  it("resolves to-many id arrays through items.$ref, keeping unresolved elements", () => {
    const contentTypes = new Map<string, ContentLoaderEntry[]>([
      [
        "posts",
        [
          { body: null, data: { tags: ["alpha", "ghost", 7] }, id: "p1" },
          { body: null, data: { tags: "not-an-array" }, id: "p2" },
        ],
      ],
      ["tags", [{ body: null, data: { label: "Alpha" }, id: "alpha" }]],
    ]);
    resolveContentTypeRefs(contentTypes, {
      posts: {
        schema: {
          properties: { tags: { items: { $ref: "#/content/tags" }, type: "array" } },
        },
        source: "./posts/",
      },
    });
    const tags = contentTypes.get("posts")?.[0]?.data.tags as unknown[];
    expect((tags[0] as ContentLoaderEntry).data.label).toBe("Alpha");
    expect(tags[1]).toBe("ghost");
    expect(tags[2]).toBe(7);
    expect(contentTypes.get("posts")?.[1]?.data.tags).toBe("not-an-array");
  });
});

// ─── Content.projectData (real extension registry) ───────────────────────────

describe("Content.projectData", () => {
  it("loads the section through the real Markdown class and resolves relationships", async () => {
    const registry = await buildFixtureRegistry();
    const section: ContentSection = {
      authors: { format: "json", source: "./content/authors/" },
      posts: {
        format: "Markdown",
        schema: {
          properties: {
            author: { $ref: "#/content/authors" },
            reviewers: { items: { $ref: "#/content/authors" }, type: "array" },
            title: { type: "string" },
          },
          required: ["title"],
          type: "object",
        },
        source: "./content/posts/",
      },
    };
    const data = await Content.projectData(section, { projectConfig: {}, registry, root: TMP });

    expect([...data.keys()].toSorted()).toEqual(["authors", "posts"]);
    const posts = data.get("posts") as ContentLoaderEntry[];
    expect(posts).toHaveLength(1);
    const post = posts[0] as ContentLoaderEntry;
    expect(post.id).toBe("hello");
    expect(post.data.title).toBe("Hello");
    expect(post.body).toContain("# Hello World");

    // To-one and to-many relationship refs resolved via #/content/ pointers
    const author = post.data.author as ContentLoaderEntry;
    expect(author.id).toBe("jane");
    expect(author.data.name).toBe("Jane");
    const reviewers = post.data.reviewers as unknown[];
    expect((reviewers[0] as ContentLoaderEntry).id).toBe("jane");
    expect(reviewers[1]).toBe("ghost");
  });

  it("derives path-based ids for markdown files in subdirectories of the source", async () => {
    const registry = await buildFixtureRegistry();
    const section: ContentSection = { tree: { format: "Markdown", source: "./content/tree/" } };
    const data = await Content.projectData(section, { projectConfig: {}, registry, root: TMP });
    const ids = (data.get("tree") as ContentLoaderEntry[]).map((e) => e.id).toSorted();
    expect(ids).toEqual(["guides/deep", "guides/nested", "root"]);
  });

  it("returns an empty map for a nullish section value", async () => {
    const registry = await buildFixtureRegistry();
    const data = await Content.projectData(undefined, { registry, root: TMP });
    expect(data.size).toBe(0);
  });

  it("dispatches through the Content.class.json descriptor in the registry", async () => {
    const registry = await buildFixtureRegistry();
    const entry = registry.byProjectKey("content");
    expect(entry?.name).toBe("Content");
    expect(entry?.project?.referenceable).toBe(true);
    expect(entry?.capabilities.projectData?.identifier).toBe("projectData");
    expect(entry?.capabilities.projectData?.timing).toEqual(["compiler", "server"]);
    expect(entry?.capabilities.resolvePaths?.discriminator).toBe("contentType");
    expect(registry.byPathsDiscriminator("contentType")?.name).toBe("Content");

    const section = { things: { format: "json", source: "./content/things/" } };
    const data = (await entry?.call("projectData", section, {
      projectConfig: {},
      registry,
      root: TMP,
    })) as Map<string, ContentLoaderEntry[]>;
    expect(data.get("things")?.[0]?.id).toBe("one");
  });
});

// ─── Content.resolvePaths ────────────────────────────────────────────────────

describe("Content.resolvePaths", () => {
  const data = new Map<string, ContentLoaderEntry[]>([
    [
      "posts",
      [
        { body: null, data: { title: "Hello" }, id: "hello" },
        { body: null, data: {}, id: "world" },
      ],
    ],
    ["blank", [{ body: null, data: {}, id: "" }]],
    ["none", []],
  ]);

  it("defaults to param slug and field id", async () => {
    const paths = await Content.resolvePaths({ contentType: "posts" }, { data, root: TMP });
    expect(paths).toEqual([{ slug: "hello" }, { slug: "world" }]);
  });

  /*
   * The route's own timestamp travelling with its parameters. Without it a collection route is
   * dated by the `[slug]` template that rendered it, so every post in an archive claims to have
   * been edited the moment the template was — see site-architecture.md §8.4.1.
   */
  it("carries the entry's own _meta alongside the route parameter", async () => {
    const dated = new Map<string, ContentLoaderEntry[]>([
      [
        "posts",
        [
          { _meta: { mtime: "2024-03-04T05:06:07Z" }, body: null, data: {}, id: "dated" },
          { body: null, data: {}, id: "undated" },
        ],
      ],
    ]);
    const paths = await Content.resolvePaths({ contentType: "posts" }, { data: dated, root: TMP });
    expect(paths).toEqual([
      { _meta: { mtime: "2024-03-04T05:06:07Z" }, slug: "dated" },
      { slug: "undated" },
    ]);
  });

  it("honors a custom param and field, falling back to the entry id", async () => {
    const paths = await Content.resolvePaths(
      { contentType: "posts", field: "title", param: "name" },
      { data, root: TMP },
    );
    expect(paths).toEqual([{ name: "Hello" }, { name: "world" }]);
  });

  it("filters out entries producing falsy param values", async () => {
    const warnings = captureWarnings();
    const paths = await Content.resolvePaths({ contentType: "blank" }, { data, root: TMP });
    expect(paths).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("warns and returns [] for a missing content type", async () => {
    const warnings = captureWarnings();
    const paths = await Content.resolvePaths({ contentType: "ghost" }, { data, root: TMP });
    expect(paths).toEqual([]);
    expect(warnings.some((w) => w.includes('content type "ghost"'))).toBe(true);
  });

  it("warns and returns [] for a content type with no entries", async () => {
    const warnings = captureWarnings();
    const paths = await Content.resolvePaths({ contentType: "none" }, { data, root: TMP });
    expect(paths).toEqual([]);
    expect(warnings.some((w) => w.includes('content type "none"'))).toBe(true);
  });
});

// ─── Asset mounts and content-relative references ────────────────────────────

describe("content asset mounts", () => {
  const MEDIA = resolve(TMP, "content/media");

  beforeAll(() => {
    mkdirSync(resolve(MEDIA, "images"), { recursive: true });
    mkdirSync(resolve(MEDIA, "nested"), { recursive: true });
    writeFileSync(resolve(MEDIA, "images/hero.png"), "png-bytes");
    writeFileSync(resolve(MEDIA, "images/my shot.png"), "png-bytes");
    writeFileSync(resolve(TMP, "outside.png"), "png-bytes");
    writeFileSync(
      resolve(MEDIA, "post.md"),
      [
        "---",
        "title: Post",
        "cover: ./images/hero.png",
        "gallery:",
        "  - ./images/hero.png",
        "code: packages/compiler/src/site/site-build.ts",
        "---",
        "",
        "![hero](./images/hero.png)",
        "",
        "![spaced](<./images/my shot.png>)",
        "",
        "![gone](./images/nope.png)",
        "",
        "![rooted](/images/hero.png)",
        "",
        "![remote](https://example.com/hero.png)",
        "",
        "![escaping](../../outside.png)",
        "",
      ].join("\n"),
    );
    writeFileSync(
      resolve(MEDIA, "nested/deep.md"),
      "---\ntitle: Deep\n---\n\n![hero](../images/hero.png)\n",
    );
  });

  const mediaSection: ContentSection = {
    media: {
      format: "Markdown",
      schema: {
        properties: {
          code: { type: "string" },
          cover: { format: "uri-reference", type: "string" },
          gallery: { items: { format: "uri-reference", type: "string" }, type: "array" },
          title: { type: "string" },
        },
        type: "object",
      },
      source: "./content/media/",
    },
  };

  /** Load the media content type through the real Markdown class. */
  async function loadMedia(): Promise<Map<string, ContentLoaderEntry[]>> {
    const registry = await buildFixtureRegistry();
    return await Content.projectData(mediaSection, { projectConfig: {}, registry, root: TMP });
  }

  /** The `src` of every img in an entry's rendered children. */
  function imageSrcs(entry: ContentLoaderEntry): string[] {
    const srcs: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") {
        return;
      }
      const record = node as Record<string, unknown>;
      const attributes = record.attributes as Record<string, unknown> | undefined;
      if (record.tagName === "img" && typeof attributes?.src === "string") {
        srcs.push(attributes.src);
      }
      for (const child of (record.children as unknown[]) ?? []) {
        walk(child);
      }
    };
    for (const child of entry.$children ?? []) {
      walk(child);
    }
    return srcs;
  }

  describe("Content.assets", () => {
    it("publishes each directory source at /content/<type>", () => {
      const mounts = Content.assets(
        { media: { source: "./content/media/" }, posts: { source: "./content/posts/" } },
        { root: TMP },
      );
      expect(mounts).toEqual([
        { dir: resolve(TMP, "content/media").split("\\").join("/"), urlPrefix: "/content/media" },
        { dir: resolve(TMP, "content/posts").split("\\").join("/"), urlPrefix: "/content/posts" },
      ]);
    });

    it("skips single-file, remote, missing, and source-less types", () => {
      const mounts = Content.assets(
        {
          bare: {},
          gone: { source: "./content/not-here/" },
          nav: { format: "json", source: "./content/plain.json" },
          remote: { format: "Csv", source: "https://example.com/data.csv" },
        },
        { root: TMP },
      );
      expect(mounts).toEqual([]);
    });

    it("warns and skips a content type name that is not URL-safe", () => {
      const warnings = captureWarnings();
      const mounts = Content.assets(
        { "odd name/x": { source: "./content/media/" } },
        { root: TMP },
      );
      expect(mounts).toEqual([]);
      expect(warnings.some((w) => w.includes("not URL-safe"))).toBe(true);
    });

    it("returns [] for an absent section", () => {
      expect(Content.assets(undefined, { root: TMP })).toEqual([]);
    });
  });

  describe("reference rewriting", () => {
    it("remaps entry-relative image srcs onto the mount", async () => {
      const warnings = captureWarnings();
      const data = await loadMedia();
      const post = (data.get("media") as ContentLoaderEntry[]).find((e) => e.id === "post")!;

      expect(imageSrcs(post)).toEqual([
        "/content/media/images/hero.png",
        "/content/media/images/my%20shot.png",
        "./images/nope.png",
        "/images/hero.png",
        "https://example.com/hero.png",
        "../../outside.png",
      ]);
      expect(warnings.some((w) => w.includes('references missing asset "./images/nope.png"'))).toBe(
        true,
      );
    });

    it("resolves against the entry's own directory, not the source root", async () => {
      const data = await loadMedia();
      const deep = (data.get("media") as ContentLoaderEntry[]).find((e) => e.id === "nested/deep")!;
      expect(imageSrcs(deep)).toEqual(["/content/media/images/hero.png"]);
    });

    it("remaps only frontmatter fields declared uri-reference", async () => {
      const data = await loadMedia();
      const post = (data.get("media") as ContentLoaderEntry[]).find((e) => e.id === "post")!;
      expect(post.data.cover).toBe("/content/media/images/hero.png");
      expect(post.data.gallery).toEqual(["/content/media/images/hero.png"]);
      expect(post.data.code).toBe("packages/compiler/src/site/site-build.ts");
    });

    it("leaves the raw body untouched so round-tripping still writes the authored path", async () => {
      const data = await loadMedia();
      const post = (data.get("media") as ContentLoaderEntry[]).find((e) => e.id === "post")!;
      expect(post.body).toContain("![hero](./images/hero.png)");
      expect(post.body).not.toContain("/content/media/");
    });
  });
});

// ─── {locale} sources ────────────────────────────────────────────────────────

describe("localesForExpansion", () => {
  it("reads the declared locales, deduplicated", () => {
    expect(
      localesForExpansion({ i18n: { defaultLocale: "en", locales: ["en", "fr", "en"] } }),
    ).toEqual(["en", "fr"]);
  });

  // A project may declare only a default; expanding over it alone is still a real expansion.
  it("falls back to the default locale when no list is given", () => {
    expect(localesForExpansion({ i18n: { defaultLocale: "de" } })).toEqual(["de"]);
  });

  it("a project with no i18n expands over nothing", () => {
    expect(localesForExpansion(({} as { config?: ProjectConfig }).config)).toEqual([]);
    expect(localesForExpansion({})).toEqual([]);
    expect(localesForExpansion({ i18n: {} })).toEqual([]);
  });
});

describe("Content.resolvePaths — localized collections", () => {
  const localized = new Map<string, ContentLoaderEntry[]>([
    [
      "blog",
      [
        { _meta: { locale: "en" }, body: null, data: {}, id: "hello" },
        { _meta: { locale: "en" }, body: null, data: {}, id: "solo" },
        { _meta: { locale: "fr" }, body: null, data: {}, id: "hello" },
      ],
    ],
  ]);

  /*
   * Two translations of one post share an id. Expanding both under `/fr/[slug]` would emit the
   * route twice and let the second overwrite the first — so the route's own locale is what scopes
   * a localized collection.
   */
  it("expands only the entries belonging to the route's locale", async () => {
    const fr = await Content.resolvePaths(
      { contentType: "blog" },
      { data: localized, locale: "fr", root: TMP },
    );
    expect(fr.map((p) => p.slug)).toEqual(["hello"]);

    const en = await Content.resolvePaths(
      { contentType: "blog" },
      { data: localized, locale: "en", root: TMP },
    );
    expect(en.map((p) => p.slug)).toEqual(["hello", "solo"]);
  });

  // An unlocalized collection must be untouched, whatever the route's locale happens to be.
  it("leaves a collection with no locales alone", async () => {
    const plain = new Map<string, ContentLoaderEntry[]>([
      [
        "posts",
        [
          { body: null, data: {}, id: "a" },
          { body: null, data: {}, id: "b" },
        ],
      ],
    ]);
    const paths = await Content.resolvePaths(
      { contentType: "posts" },
      { data: plain, locale: "fr", root: TMP },
    );
    expect(paths.map((p) => p.slug)).toEqual(["a", "b"]);
  });

  // A project without i18n gives no locale at all; the collection must not vanish.
  it("a route with no locale expands everything", async () => {
    const paths = await Content.resolvePaths(
      { contentType: "blog" },
      { data: localized, locale: null, root: TMP },
    );
    expect(paths).toHaveLength(3);
  });
});

// ─── {locale} sources — expansion, mounts, and per-locale assets ──────────────

describe("localized content types", () => {
  const I18N = resolve(TMP, "content/i18n-posts");
  const section: ContentSection = {
    "i18n-posts": { format: "Markdown", source: "./content/i18n-posts/{locale}/" },
  };
  const config: ProjectConfig = { i18n: { defaultLocale: "en", locales: ["en", "fr"] } };

  beforeAll(() => {
    for (const locale of ["en", "fr"]) {
      mkdirSync(resolve(I18N, locale), { recursive: true });
      writeFileSync(resolve(I18N, locale, "hero.png"), "png-bytes");
      writeFileSync(
        resolve(I18N, locale, "hello.md"),
        `---\ntitle: Hello ${locale}\n---\n\n![hero](./hero.png)\n`,
      );
    }
  });

  /*
   * One source, N directories, N mounts. They are published per locale because a French post's
   * `./hero.png` and its English translation's are different files that would otherwise land on
   * one URL — the second overwriting the first.
   */
  it("publishes one mount per locale the source expands over", () => {
    expect(contentAssetMounts(section, TMP, config)).toEqual([
      {
        dir: resolve(I18N, "en").split("\\").join("/"),
        urlPrefix: "/content/i18n-posts/en",
      },
      {
        dir: resolve(I18N, "fr").split("\\").join("/"),
        urlPrefix: "/content/i18n-posts/fr",
      },
    ]);
  });

  it("skips a locale with no directory, and a locale name that is not URL-safe", () => {
    const mounts = contentAssetMounts(section, TMP, {
      i18n: { defaultLocale: "en", locales: ["en", "de", "../evil"] },
    });
    expect(mounts.map((mount) => mount.urlPrefix)).toEqual(["/content/i18n-posts/en"]);
  });

  it("loads every locale's directory and stamps where each entry came from", async () => {
    const registry = await buildFixtureRegistry();
    const data = await Content.projectData(section, { projectConfig: config, registry, root: TMP });
    const entries = data.get("i18n-posts") as ContentLoaderEntry[];

    expect(entries.map((entry) => [entry.id, entry._meta?.locale])).toEqual([
      ["hello", "en"],
      ["hello", "fr"],
    ]);
    // The locale is the ONLY thing telling two translations of one id apart.
    expect(entries.map((entry) => entry.data.title)).toEqual(["Hello en", "Hello fr"]);
  });

  /*
   * The regression that made the per-locale mounts pointless: the lookup asks for `<type>/<locale>`
   * and the map was keyed by the last URL segment, so it always missed and a translated entry kept
   * its authored `./hero.png`.
   */
  /** The `src` of every img in an entry's rendered children. */
  const srcsOf = (entry: ContentLoaderEntry): string[] => {
    const srcs: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") {
        return;
      }
      const record = node as Record<string, unknown>;
      const attributes = record.attributes as Record<string, unknown> | undefined;
      if (record.tagName === "img" && typeof attributes?.src === "string") {
        srcs.push(attributes.src);
      }
      for (const child of (record.children as unknown[]) ?? []) {
        walk(child);
      }
    };
    for (const child of entry.$children ?? []) {
      walk(child);
    }
    return srcs;
  };

  it("rewrites a translated entry's assets onto its own locale's mount", async () => {
    const registry = await buildFixtureRegistry();
    const data = await Content.projectData(section, { projectConfig: config, registry, root: TMP });
    const entries = data.get("i18n-posts") as ContentLoaderEntry[];

    expect(entries.map((entry) => srcsOf(entry))).toEqual([
      ["/content/i18n-posts/en/hero.png"],
      ["/content/i18n-posts/fr/hero.png"],
    ]);
  });

  // Nothing to expand over is a warning and an empty collection, not a crash or a literal path.
  it("warns and loads nothing when the project declares no locales", async () => {
    const warnings = captureWarnings();
    const registry = await buildFixtureRegistry();
    const data = await Content.projectData(section, { projectConfig: {}, registry, root: TMP });

    expect(data.get("i18n-posts")).toEqual([]);
    expect(warnings.some((warning) => warning.includes("declares no i18n locales"))).toBe(true);
  });
});
