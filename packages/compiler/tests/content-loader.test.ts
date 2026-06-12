/**
 * Content-loader.test.ts — Direct unit tests for src/site/content-loader.ts
 *
 * Complements content-types.test.ts (which exercises the happy paths through real parser format
 * classes) by covering the dispatch/error branches: missing sources, unregistered formats, remote
 * source rules, registry-driven discover/load, and JSON discovery edge cases. Format classes are
 * faked through real FormatEntry/FormatRegistry instances with a stub FormatHostIO so no network or
 * parser implementation is involved.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FormatEntry, FormatRegistry } from "@jxsuite/schema/format-registry";
import type { FormatHostIO } from "@jxsuite/schema/format-registry";
import type { ContentLoaderEntry } from "@jxsuite/parser/types";
import {
  getContentTypeElements,
  loadContentConfig,
  loadContentTypes,
  resolveContentTypeRefs,
} from "../src/site/content-loader.ts";

const TMP = resolve(import.meta.dir, "__test-content-loader__");

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(resolve(TMP, "content/things"), { recursive: true });
  writeFileSync(
    resolve(TMP, "content/things/one.json"),
    JSON.stringify({ id: "one", name: "One" }),
  );
  writeFileSync(resolve(TMP, "content/single.fake"), "raw fake body");
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

const origWarn = console.warn;
afterEach(() => {
  console.warn = origWarn;
});

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

// ─── loadContentConfig ───────────────────────────────────────────────────────

describe("loadContentConfig", () => {
  it("resolves contentDir under the project root", () => {
    const result = loadContentConfig(TMP);
    expect(result.contentDir).toBe(resolve(TMP, "content"));
    expect(result.config.contentTypes).toEqual({});
  });

  it("passes through contentTypes from the project config", () => {
    const result = loadContentConfig(TMP, {
      contentTypes: { posts: { source: "./content/posts/" } },
    });
    expect(result.config.contentTypes.posts).toEqual({ source: "./content/posts/" });
  });
});

// ─── loadContentTypes — dispatch and error branches ──────────────────────────

describe("loadContentTypes", () => {
  it("returns an empty map when there are no content types", async () => {
    const result = await loadContentTypes(TMP, {}, makeRegistry());
    expect(result.size).toBe(0);
  });

  it("returns empty entries for a content type without a source", async () => {
    const result = await loadContentTypes(
      TMP,
      { contentTypes: { empty: {} as { source: string } } },
      makeRegistry(),
    );
    expect(result.get("empty")).toEqual([]);
  });

  it("throws when format names a class missing from the registry", async () => {
    const promise = loadContentTypes(
      TMP,
      { contentTypes: { posts: { format: "Bogus", source: "./content/posts/" } } },
      makeRegistry(),
    );
    await expect(promise).rejects.toThrow(/format "Bogus" is not an imported format class/);
  });

  it("throws for a remote source without an explicit format", async () => {
    const promise = loadContentTypes(
      TMP,
      { contentTypes: { feed: { source: "https://example.com/feed.csv" } } },
      makeRegistry(),
    );
    await expect(promise).rejects.toThrow(/remote sources require an explicit "format"/);
  });

  it("throws for a remote source whose format is not remote-capable", async () => {
    const { entry } = makeFakeEntry("LocalOnly");
    const promise = loadContentTypes(
      TMP,
      {
        contentTypes: {
          feed: { format: "LocalOnly", source: "https://example.com/feed.fake" },
        },
      },
      makeRegistry(entry),
    );
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
    const result = await loadContentTypes(
      TMP,
      {
        contentTypes: {
          feed: {
            format: "RemoteFake",
            schema: { properties: { name: { type: "string" } }, required: ["name"] },
            source: "https://example.com/feed.fake",
          },
        },
      },
      makeRegistry(entry),
    );
    const feed = result.get("feed") as ContentLoaderEntry[];
    expect(feed.map((e) => e.id)).toEqual(["a", "b"]);
    expect(calls[0]?.method).toBe("load");
    expect(calls[0]?.args[0]).toBe("https://example.com/feed.fake");
  });

  it("warns and returns no entries when a remote load fails", async () => {
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    const { entry } = makeFakeEntry("RemoteFake", {
      loadImpl: () => {
        throw new Error("connection refused");
      },
      remote: true,
    });
    const result = await loadContentTypes(
      TMP,
      {
        contentTypes: {
          feed: { format: "RemoteFake", source: "https://example.com/feed.fake" },
        },
      },
      makeRegistry(entry),
    );
    expect(result.get("feed")).toEqual([]);
    expect(warnings.some((w) => w.includes("connection refused"))).toBe(true);
  });

  it("throws unknown-format error for an unregistered extension", async () => {
    const promise = loadContentTypes(
      TMP,
      { contentTypes: { data: { source: "./content/data.xyz" } } },
      makeRegistry(),
    );
    await expect(promise).rejects.toThrow(/No format class imported for "\.xyz"/);
  });

  it("throws a directory-specific error for extensionless sources without a format", async () => {
    const promise = loadContentTypes(
      TMP,
      { contentTypes: { docs: { source: "./content/docs/" } } },
      makeRegistry(),
    );
    await expect(promise).rejects.toThrow(/directory sources need an explicit "format"/);
  });

  it("uses the discover capability to enumerate entry files", async () => {
    const { calls, entry } = makeFakeEntry("FakeFmt", {
      discoverResult: ["/virtual/a.fake", "/virtual/b.fake"],
      loadImpl: (source) => [{ body: null, data: { src: source }, id: source }],
      withDiscover: true,
    });
    const result = await loadContentTypes(
      TMP,
      { contentTypes: { docs: { format: "FakeFmt", source: "./content/docs/" } } },
      makeRegistry(entry),
    );
    const docs = result.get("docs") as ContentLoaderEntry[];
    expect(docs.map((e) => e.id)).toEqual(["/virtual/a.fake", "/virtual/b.fake"]);
    expect(calls[0]?.method).toBe("discover");
    expect(calls[0]?.args[1]).toEqual({ baseDir: TMP });
  });

  it("falls back to the resolved source when the format lacks discover", async () => {
    const { calls, entry } = makeFakeEntry("FakeFmt", {
      loadImpl: (source) => [{ body: null, data: { src: source }, id: "solo" }],
    });
    const result = await loadContentTypes(
      TMP,
      { contentTypes: { docs: { format: "FakeFmt", source: "./content/single.fake" } } },
      makeRegistry(entry),
    );
    const docs = result.get("docs") as ContentLoaderEntry[];
    expect(docs).toHaveLength(1);
    expect(calls[0]?.method).toBe("load");
    expect(String(calls[0]?.args[0])).toContain("content/single.fake");
  });

  it("derives the format from the source extension when none is named", async () => {
    const { entry } = makeFakeEntry("FakeFmt", {
      loadImpl: () => [{ body: null, data: {}, id: "by-ext" }],
    });
    const result = await loadContentTypes(
      TMP,
      { contentTypes: { docs: { source: "./content/single.fake" } } },
      makeRegistry(entry),
    );
    expect((result.get("docs") as ContentLoaderEntry[])[0]?.id).toBe("by-ext");
  });

  it("validates registry-loaded entries against the schema", async () => {
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    const { entry } = makeFakeEntry("FakeFmt", {
      loadImpl: () => [{ body: null, data: { count: "ten" }, id: "bad" }],
    });
    await loadContentTypes(
      TMP,
      {
        contentTypes: {
          docs: {
            format: "FakeFmt",
            schema: {
              properties: { count: { type: "number" } },
              required: ["title"],
            },
            source: "./content/single.fake",
          },
        },
      },
      makeRegistry(entry),
    );
    expect(warnings.some((w) => w.includes('missing required field "title"'))).toBe(true);
    expect(warnings.some((w) => w.includes("expected number, got string"))).toBe(true);
  });

  it("loads native JSON entries via the explicit json format name", async () => {
    const result = await loadContentTypes(
      TMP,
      { contentTypes: { things: { format: "json", source: "./content/things/" } } },
      makeRegistry(),
    );
    const things = result.get("things") as ContentLoaderEntry[];
    expect(things).toHaveLength(1);
    expect(things[0]?.id).toBe("one");
    expect(things[0]?.data.name).toBe("One");
  });

  it("returns no entries for a missing JSON directory", async () => {
    const result = await loadContentTypes(
      TMP,
      { contentTypes: { ghosts: { format: "json", source: "./content/ghosts/" } } },
      makeRegistry(),
    );
    expect(result.get("ghosts")).toEqual([]);
  });

  it("returns no entries for a missing single JSON file", async () => {
    const result = await loadContentTypes(
      TMP,
      { contentTypes: { ghost: { format: "json", source: "./content/nope.json" } } },
      makeRegistry(),
    );
    expect(result.get("ghost")).toEqual([]);
  });

  it("builds the registry from project imports when none is supplied", async () => {
    // No imports → empty registry; a non-json extension must therefore throw
    const promise = loadContentTypes(TMP, {
      contentTypes: { data: { source: "./content/data.csv" } },
    });
    await expect(promise).rejects.toThrow(/No format class imported for "\.csv"/);
  });

  it("passes $elements-derived allowedNames in directive options", async () => {
    const { calls, entry } = makeFakeEntry("FakeFmt", {
      loadImpl: () => [{ body: null, data: {}, id: "x" }],
    });
    await loadContentTypes(
      TMP,
      {
        contentTypes: {
          docs: {
            $elements: ["my-widget", { $ref: "./card.json" }, 42 as unknown as string],
            format: "FakeFmt",
            source: "./content/single.fake",
          },
        },
      },
      makeRegistry(entry),
    );
    const loadOptions = calls[0]?.args[1] as { directiveOptions?: { allowedNames?: string[] } };
    expect(loadOptions.directiveOptions?.allowedNames).toEqual(["my-widget", "./card.json"]);
  });
});

// ─── getContentTypeElements ──────────────────────────────────────────────────

describe("getContentTypeElements", () => {
  it("returns undefined when the content type is not defined", () => {
    expect(getContentTypeElements(TMP, "missing", { contentTypes: {} })).toBeUndefined();
  });

  it("returns the $elements list for a defined content type", () => {
    const config = {
      contentTypes: { posts: { $elements: ["a-card"], source: "./content/posts/" } },
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
    // No schema → skip; schema but no loaded entries → skip; non-#/contentTypes ref → skip
    resolveContentTypeRefs(contentTypes, {
      contentTypes: {
        absent: {
          schema: { properties: { x: { $ref: "#/contentTypes/present" } } },
          source: "./a/",
        },
        noschema: { source: "./b/" },
        present: {
          schema: { properties: { a: { $ref: "#/$defs/Other" } } },
          source: "./c/",
        },
      },
    });
    expect(contentTypes.get("present")?.[0]?.data.a).toBe(1);
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
      contentTypes: {
        posts: {
          schema: { properties: { author: { $ref: "#/contentTypes/authors" } } },
          source: "./posts/",
        },
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
      contentTypes: {
        posts: {
          schema: { properties: { author: { $ref: "#/contentTypes/missing" } } },
          source: "./posts/",
        },
      },
    });
    expect(contentTypes.get("posts")?.[0]?.data.author).toBe("jane");
  });

  it("resolves a string id into the referenced entry", () => {
    const contentTypes = new Map<string, ContentLoaderEntry[]>([
      ["posts", [{ body: null, data: { author: "jane" }, id: "p1" }]],
      ["authors", [{ body: null, data: { name: "Jane" }, id: "jane" }]],
    ]);
    resolveContentTypeRefs(contentTypes, {
      contentTypes: {
        posts: {
          schema: { properties: { author: { $ref: "#/contentTypes/authors" } } },
          source: "./posts/",
        },
      },
    });
    const author = contentTypes.get("posts")?.[0]?.data.author as ContentLoaderEntry;
    expect(author.id).toBe("jane");
    expect(author.data.name).toBe("Jane");
  });
});
