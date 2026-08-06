/**
 * Tests for src/content/entry-model.ts — collection resolution and schema-defaults seeding. Pure
 * module, so these run without a DOM beyond the harness's import-time bootstrap. The draft rules
 * moved to src/content/draft-state.ts; tests/draft-state.test.ts asserts them.
 */
import { resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  collectionNames,
  collectionOfPath,
  entryCollection,
  entryCollections,
  missingRequired,
  seedEntry,
} from "../src/content/entry-model";
import type { ContentTypeSchema } from "@jxsuite/schema/types";

const BLOG_SCHEMA: ContentTypeSchema = {
  properties: {
    author: { $ref: "#/content/authors" },
    draft: { type: "boolean", default: false },
    pubDate: { type: "string", format: "date" },
    tags: { items: { type: "string" }, type: "array" },
    title: { type: "string" },
    weight: { type: "number" },
  },
  required: ["title", "pubDate", "author"],
  type: "object",
};

function withContent(content: Record<string, unknown>): void {
  resetStudioState({ projectConfig: { content } });
}

beforeEach(() => {
  withContent({
    authors: {
      format: "json",
      schema: { properties: { name: { type: "string" } } },
      source: "./content/authors/",
    },
    blog: { format: "Markdown", schema: BLOG_SCHEMA, source: "./content/blog/" },
    products: {
      schema: { properties: { sku: { type: "string" } } },
      source: "./content/catalog.csv",
    },
  });
});

describe("collections", () => {
  test("names every declared content type, in declaration order", () => {
    expect(collectionNames()).toEqual(["authors", "blog", "products"]);
  });

  test("resolves a directory-backed collection to its dir, extension and schema", () => {
    const blog = entryCollection("blog");
    expect(blog?.dir).toBe("content/blog");
    expect(blog?.ext).toBe(".json"); // No Markdown format class registered in this process.
    expect(blog?.schema).toBe(BLOG_SCHEMA);
  });

  test("refuses a file-backed collection — a CSV catalogue has rows, not entry files", () => {
    expect(entryCollection("products")).toBeNull();
    expect(entryCollections().map((c) => c.name)).toEqual(["authors", "blog"]);
  });

  test("refuses a name the project does not declare", () => {
    expect(entryCollection("nope")).toBeNull();
  });

  test("maps a document path back to its collection, and answers null off it", () => {
    expect(collectionOfPath("content/blog/hello.json")?.name).toBe("blog");
    expect(collectionOfPath("pages/index.md")).toBeNull();
    expect(collectionOfPath(null)).toBeNull();
  });
});

describe("seedEntry", () => {
  test("takes declared defaults and fills required fields with typed empties", () => {
    expect(seedEntry(BLOG_SCHEMA)).toEqual({
      author: "",
      draft: false,
      pubDate: "",
      title: "",
    });
  });

  test("omits optional properties that declare no default", () => {
    const seed = seedEntry(BLOG_SCHEMA);
    expect(Object.hasOwn(seed, "tags")).toBe(false);
    expect(Object.hasOwn(seed, "weight")).toBe(false);
  });

  test("leaves no required field absent — the whole promise of seeding", () => {
    expect(missingRequired(BLOG_SCHEMA, seedEntry(BLOG_SCHEMA))).toEqual([]);
  });

  test("names the required fields an existing entry does not have", () => {
    expect(missingRequired(BLOG_SCHEMA, { title: "Hello" })).toEqual(["pubDate", "author"]);
  });

  test("types each empty by the property's own type", () => {
    expect(
      seedEntry({
        properties: {
          count: { type: "integer" },
          flag: { type: "boolean" },
          list: { type: "array" },
          nested: {
            properties: { inner: { type: "string" } },
            required: ["inner"],
            type: "object",
          },
          text: { type: "string" },
        },
        required: ["count", "flag", "list", "nested", "text"],
      }),
    ).toEqual({ count: 0, flag: false, list: [], nested: { inner: "" }, text: "" });
  });

  test("clones object defaults so two seeded entries never share one", () => {
    const schema: ContentTypeSchema = {
      properties: { meta: { default: { a: 1 }, type: "object" } },
    };
    const first = seedEntry(schema) as { meta: { a: number } };
    const second = seedEntry(schema) as { meta: { a: number } };
    first.meta.a = 2;
    expect(second.meta.a).toBe(1);
  });

  test("answers an empty record for a collection with no schema at all", () => {
    expect(seedEntry(null)).toEqual({});
    expect(seedEntry({})).toEqual({});
    expect(missingRequired(null, {})).toEqual([]);
  });
});
