import { describe, expect, test } from "bun:test";

import {
  ContentCollection,
  ContentEntry,
  evaluateFilterRule,
  findEntry,
  queryContentType,
} from "../src/content";
import type { ContentLoaderEntry } from "../src/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(id: string, data: Record<string, unknown> = {}): ContentLoaderEntry {
  return { body: null, data, id };
}

const posts: ContentLoaderEntry[] = [
  makeEntry("alpha", {
    date: "2026-01-01",
    draft: false,
    tags: ["news", "tech"],
    title: "Alpha",
    views: 10,
  }),
  makeEntry("beta", { date: "2026-03-01", draft: true, tags: [], title: "Beta", views: 30 }),
  makeEntry("gamma", {
    date: "2026-02-01",
    slug: "the-gamma",
    tags: ["news"],
    title: "Gamma",
    views: 20,
  }),
];

function makeProject(entries: ContentLoaderEntry[] = posts) {
  return { content: new Map([["posts", entries]]) };
}

// ─── evaluateFilterRule ───────────────────────────────────────────────────────

describe("evaluateFilterRule", () => {
  const entry = makeEntry("post-1", {
    count: 5,
    empties: [],
    nothing: null,
    tags: ["a", "b"],
    title: "Hello World",
  });

  test("== matches data field equality", () => {
    expect(evaluateFilterRule({ field: "title", op: "==", value: "Hello World" }, entry)).toBe(
      true,
    );
    expect(evaluateFilterRule({ field: "title", op: "==", value: "Other" }, entry)).toBe(false);
  });

  test("field 'id' reads entry.id rather than data", () => {
    expect(evaluateFilterRule({ field: "id", op: "==", value: "post-1" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "id", op: "!=", value: "post-1" }, entry)).toBe(false);
  });

  test("!= matches inequality", () => {
    expect(evaluateFilterRule({ field: "title", op: "!=", value: "Other" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "title", op: "!=", value: "Hello World" }, entry)).toBe(
      false,
    );
  });

  test("empty matches null, empty string, empty array, and missing fields", () => {
    expect(evaluateFilterRule({ field: "nothing", op: "empty" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "missing", op: "empty" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "empties", op: "empty" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "title", op: "empty" }, entry)).toBe(false);
    expect(evaluateFilterRule({ field: "blank", op: "empty" }, makeEntry("x", { blank: "" }))).toBe(
      true,
    );
  });

  test("not empty is the inverse of empty", () => {
    expect(evaluateFilterRule({ field: "title", op: "not empty" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "tags", op: "not empty" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "nothing", op: "not empty" }, entry)).toBe(false);
    expect(evaluateFilterRule({ field: "empties", op: "not empty" }, entry)).toBe(false);
  });

  test("contains checks array membership", () => {
    expect(evaluateFilterRule({ field: "tags", op: "contains", value: "a" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "tags", op: "contains", value: "z" }, entry)).toBe(false);
  });

  test("contains checks string substring", () => {
    expect(evaluateFilterRule({ field: "title", op: "contains", value: "World" }, entry)).toBe(
      true,
    );
    expect(evaluateFilterRule({ field: "title", op: "contains", value: "world" }, entry)).toBe(
      false,
    );
  });

  test("contains is false for non-string non-array actuals", () => {
    expect(evaluateFilterRule({ field: "count", op: "contains", value: "5" }, entry)).toBe(false);
  });

  test("contains coerces nullish value to empty string for string actuals", () => {
    expect(evaluateFilterRule({ field: "title", op: "contains" }, entry)).toBe(true);
  });

  test("not contains for arrays and strings", () => {
    expect(evaluateFilterRule({ field: "tags", op: "not contains", value: "z" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "tags", op: "not contains", value: "a" }, entry)).toBe(
      false,
    );
    expect(evaluateFilterRule({ field: "title", op: "not contains", value: "xyz" }, entry)).toBe(
      true,
    );
    expect(evaluateFilterRule({ field: "title", op: "not contains", value: "Hello" }, entry)).toBe(
      false,
    );
  });

  test("not contains is false for non-string non-array actuals", () => {
    expect(evaluateFilterRule({ field: "count", op: "not contains", value: "5" }, entry)).toBe(
      false,
    );
  });

  test("numeric comparison operators coerce values", () => {
    expect(evaluateFilterRule({ field: "count", op: ">", value: 4 }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "count", op: ">", value: 5 }, entry)).toBe(false);
    expect(evaluateFilterRule({ field: "count", op: "<", value: 6 }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "count", op: "<", value: 5 }, entry)).toBe(false);
    expect(evaluateFilterRule({ field: "count", op: ">=", value: 5 }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "count", op: ">=", value: 6 }, entry)).toBe(false);
    expect(evaluateFilterRule({ field: "count", op: "<=", value: 5 }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "count", op: "<=", value: 4 }, entry)).toBe(false);
  });

  test("numeric comparisons accept string-typed values", () => {
    expect(evaluateFilterRule({ field: "count", op: ">", value: "3" }, entry)).toBe(true);
  });

  test("unknown operator passes everything through", () => {
    expect(evaluateFilterRule({ field: "title", op: "regex", value: ".*" }, entry)).toBe(true);
    expect(evaluateFilterRule({ field: "missing", op: "???" }, entry)).toBe(true);
  });
});

// ─── queryContentType ─────────────────────────────────────────────────────────

describe("queryContentType", () => {
  test("returns a copy of all entries when no query given", () => {
    const result = queryContentType(posts);
    expect(result).toEqual(posts);
    expect(result).not.toBe(posts);
  });

  test("does not mutate the input array when sorting", () => {
    const original = [...posts];
    queryContentType(posts, { sort: { field: "views", order: "desc" } });
    expect(posts).toEqual(original);
  });

  test("filters with an array of rules (all must match)", () => {
    const result = queryContentType(posts, {
      filter: [
        { field: "tags", op: "contains", value: "news" },
        { field: "views", op: ">", value: 15 },
      ],
    });
    expect(result.map((e) => e.id)).toEqual(["gamma"]);
  });

  test("filters with a shorthand object (implicit ==)", () => {
    const result = queryContentType(posts, { filter: { draft: true } });
    expect(result.map((e) => e.id)).toEqual(["beta"]);
  });

  test("non-array non-object filter yields no rules and keeps everything", () => {
    const result = queryContentType(posts, { filter: "draft" as never });
    expect(result).toHaveLength(3);
  });

  test("sorts ascending by default", () => {
    const result = queryContentType(posts, { sort: { field: "views" } });
    expect(result.map((e) => e.id)).toEqual(["alpha", "gamma", "beta"]);
  });

  test("sorts descending when order is desc", () => {
    const result = queryContentType(posts, { sort: { field: "date", order: "desc" } });
    expect(result.map((e) => e.id)).toEqual(["beta", "gamma", "alpha"]);
  });

  test("sorts by id field", () => {
    const result = queryContentType(posts, { sort: { field: "id", order: "desc" } });
    expect(result.map((e) => e.id)).toEqual(["gamma", "beta", "alpha"]);
  });

  test("sorts with multiple rules, falling through ties", () => {
    const entries = [
      makeEntry("b", { group: 1, rank: 2 }),
      makeEntry("a", { group: 1, rank: 1 }),
      makeEntry("c", { group: 0, rank: 9 }),
    ];
    const result = queryContentType(entries, {
      sort: [{ field: "group" }, { field: "rank", order: "desc" }],
    });
    expect(result.map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  test("missing sort fields fall back to empty string", () => {
    const entries = [makeEntry("with", { weight: 5 }), makeEntry("without", {})];
    const result = queryContentType(entries, { sort: { field: "weight" } });
    expect(result.map((e) => e.id)).toEqual(["without", "with"]);
  });

  test("equal sort keys keep stable order via 0 comparator", () => {
    const entries = [makeEntry("one", { v: 1 }), makeEntry("two", { v: 1 })];
    const result = queryContentType(entries, { sort: { field: "v" } });
    expect(result.map((e) => e.id)).toEqual(["one", "two"]);
  });

  test("applies a positive limit", () => {
    const result = queryContentType(posts, { limit: 2, sort: { field: "id" } });
    expect(result.map((e) => e.id)).toEqual(["alpha", "beta"]);
  });

  test("ignores zero and negative limits", () => {
    expect(queryContentType(posts, { limit: 0 })).toHaveLength(3);
    expect(queryContentType(posts, { limit: -1 })).toHaveLength(3);
  });

  test("combines filter, sort, and limit", () => {
    const result = queryContentType(posts, {
      filter: [{ field: "tags", op: "not empty" }],
      limit: 1,
      sort: { field: "views", order: "desc" },
    });
    expect(result.map((e) => e.id)).toEqual(["gamma"]);
  });
});

// ─── findEntry ────────────────────────────────────────────────────────────────

describe("findEntry", () => {
  test("returns the matching entry by id", () => {
    expect(findEntry(posts, "beta")?.data.title).toBe("Beta");
  });

  test("returns null when no entry matches", () => {
    expect(findEntry(posts, "missing")).toBeNull();
  });

  test("returns null for an empty entry list", () => {
    expect(findEntry([], "anything")).toBeNull();
  });
});

// ─── ContentCollection ────────────────────────────────────────────────────────

describe("ContentCollection", () => {
  test("stores its config", () => {
    const config = { contentType: "posts" };
    expect(new ContentCollection(config).config).toBe(config);
  });

  test("resolves all entries for a known content type", () => {
    const collection = new ContentCollection({ _project: makeProject(), contentType: "posts" });
    expect(collection.resolve()).toHaveLength(3);
  });

  test("returns [] when the content type is unknown", () => {
    const collection = new ContentCollection({ _project: makeProject(), contentType: "pages" });
    expect(collection.resolve()).toEqual([]);
  });

  test("returns [] when contentType is omitted", () => {
    const collection = new ContentCollection({ _project: makeProject() });
    expect(collection.resolve()).toEqual([]);
  });

  test("returns [] when no project context is present", () => {
    expect(new ContentCollection({ contentType: "posts" }).resolve()).toEqual([]);
  });

  test("returns [] when the project has no contentTypes map", () => {
    expect(new ContentCollection({ _project: {}, contentType: "posts" }).resolve()).toEqual([]);
  });

  test("applies filter, sort, and limit from config", () => {
    const collection = new ContentCollection({
      _project: makeProject(),
      contentType: "posts",
      filter: [{ field: "tags", op: "contains", value: "news" }],
      limit: 1,
      sort: { field: "views", order: "desc" },
    });
    expect(collection.resolve().map((e) => e.id)).toEqual(["gamma"]);
  });

  test("applies a shorthand object filter", () => {
    const collection = new ContentCollection({
      _project: makeProject(),
      contentType: "posts",
      filter: { title: "Alpha" },
    });
    expect(collection.resolve().map((e) => e.id)).toEqual(["alpha"]);
  });
});

// ─── ContentEntry ─────────────────────────────────────────────────────────────

describe("ContentEntry", () => {
  test("stores its config", () => {
    const config = { contentType: "posts", id: "alpha" };
    expect(new ContentEntry(config).config).toBe(config);
  });

  test("resolves an entry by literal id", () => {
    const entry = new ContentEntry({ _project: makeProject(), contentType: "posts", id: "alpha" });
    expect(entry.resolve()?.data.title).toBe("Alpha");
  });

  test("returns null when the content type is unknown", () => {
    const entry = new ContentEntry({ _project: makeProject(), contentType: "pages", id: "alpha" });
    expect(entry.resolve()).toBeNull();
  });

  test("returns null when no project context is present", () => {
    expect(new ContentEntry({ contentType: "posts", id: "alpha" }).resolve()).toBeNull();
  });

  test("returns null when no id is provided", () => {
    const entry = new ContentEntry({ _project: makeProject(), contentType: "posts" });
    expect(entry.resolve()).toBeNull();
  });

  test("returns null when the id matches nothing", () => {
    const entry = new ContentEntry({ _project: makeProject(), contentType: "posts", id: "nope" });
    expect(entry.resolve()).toBeNull();
  });

  test("resolves a $params $ref through document path params", () => {
    const entry = new ContentEntry({
      _document: { route: { _pathParams: { slug: "gamma" } } },
      _project: makeProject(),
      contentType: "posts",
      id: { $ref: "#/$params/slug" },
    });
    expect(entry.resolve()?.data.title).toBe("Gamma");
  });

  test("returns null when the $params $ref has no matching path param", () => {
    const entry = new ContentEntry({
      _document: { route: { _pathParams: {} } },
      _project: makeProject(),
      contentType: "posts",
      id: { $ref: "#/$params/slug" },
    });
    expect(entry.resolve()).toBeNull();
  });

  test("returns null for a $params $ref with no document context", () => {
    const entry = new ContentEntry({
      _project: makeProject(),
      contentType: "posts",
      id: { $ref: "#/$params/slug" },
    });
    expect(entry.resolve()).toBeNull();
  });

  test("non-$params object ids are passed through and find nothing", () => {
    const entry = new ContentEntry({
      _project: makeProject(),
      contentType: "posts",
      id: { $ref: "#/$defs/something" },
    });
    expect(entry.resolve()).toBeNull();
  });

  test("matches against a custom data field when field is set", () => {
    const entry = new ContentEntry({
      _project: makeProject(),
      contentType: "posts",
      field: "slug",
      id: "the-gamma",
    });
    expect(entry.resolve()?.id).toBe("gamma");
  });

  test("returns null when the custom field matches nothing", () => {
    const entry = new ContentEntry({
      _project: makeProject(),
      contentType: "posts",
      field: "slug",
      id: "missing",
    });
    expect(entry.resolve()).toBeNull();
  });

  test("field 'id' falls back to the id lookup", () => {
    const entry = new ContentEntry({
      _project: makeProject(),
      contentType: "posts",
      field: "id",
      id: "beta",
    });
    expect(entry.resolve()?.data.title).toBe("Beta");
  });
});
