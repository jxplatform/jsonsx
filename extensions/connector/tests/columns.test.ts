/**
 * Columns — field schema → column plan mapping and storage coercion (specs/relationships.md §1, §3;
 * plan Part 4a "columns.ts").
 */

import { describe, expect, test } from "bun:test";
import {
  fromStorage,
  idDataType,
  newRowId,
  parseRefPointer,
  planTable,
  toStorage,
} from "../src/columns";
import type { TableDef } from "../src/types";

const TABLES: Record<string, TableDef> = {
  comments: {
    connection: "main",
    ownerField: "user_id",
    schema: {
      properties: {
        approved: { type: "boolean" },
        author: { $ref: "#/data/users" },
        message: { type: "string" },
        post: { $ref: "#/content/posts" },
        rating: { type: "number" },
        tags: { items: { $ref: "#/content/tags" }, type: "array" },
        views: { type: "integer" },
      },
      required: ["message"],
      type: "object",
    },
  },
  posts: {
    connection: "main",
    id: "integer",
    indexes: ["title", ["title", "message"]],
    schema: {
      properties: {
        message: { type: "string" },
        related: { items: { $ref: "#/data/posts" }, type: "array" },
        title: { type: "string" },
      },
      type: "object",
    },
    timestamps: false,
  },
  users: {
    connection: "main",
    schema: {
      properties: {
        friends: { items: { $ref: "#/data/posts" }, type: "array" },
        meta: { type: "object" },
        name: { type: "string" },
      },
      type: "object",
    },
  },
};

describe("parseRefPointer", () => {
  test("parses section/name pointers and rejects everything else", () => {
    expect(parseRefPointer("#/data/users")).toEqual({ name: "users", section: "data" });
    expect(parseRefPointer("#/content/blog-posts")).toEqual({
      name: "blog-posts",
      section: "content",
    });
    expect(parseRefPointer("#/state/x/y")).toBeNull();
    expect(parseRefPointer("./local.json")).toBeNull();
    expect(parseRefPointer(42)).toBeNull();
    expect(parseRefPointer(null)).toBeNull();
  });
});

describe("planTable", () => {
  const plan = planTable("comments", TABLES.comments!, TABLES, "sqlite");

  test("maps scalar types per dialect", () => {
    const byField = new Map(plan.columns.map((c) => [c.field, c]));
    expect(byField.get("message")!.dataType).toBe("text");
    expect(byField.get("rating")!.dataType).toBe("real");
    expect(byField.get("views")!.dataType).toBe("integer");
    expect(byField.get("approved")!.dataType).toBe("integer");

    const pg = planTable("comments", TABLES.comments!, TABLES, "postgres");
    const pgByField = new Map(pg.columns.map((c) => [c.field, c]));
    expect(pgByField.get("rating")!.dataType).toBe("double precision");
    expect(pgByField.get("approved")!.dataType).toBe("boolean");
  });

  test("to-one references become <field>_id text columns", () => {
    const author = plan.columns.find((c) => c.field === "author")!;
    expect(author.column).toBe("author_id");
    expect(author.ref).toEqual({ name: "users", section: "data" });
    const post = plan.columns.find((c) => c.field === "post")!;
    expect(post.column).toBe("post_id");
    expect(post.ref!.section).toBe("content");
  });

  test("to-many refs to non-table sections become JSON id-list columns", () => {
    const tags = plan.columns.find((c) => c.field === "tags")!;
    expect(tags.column).toBe("tags");
    expect(tags.storage).toBe("json");
    expect(tags.manyRef).toBe(true);
  });

  test("ownerField materializes as a text column even when undeclared", () => {
    const owner = plan.columns.find((c) => c.field === "user_id")!;
    expect(owner.column).toBe("user_id");
    expect(owner.dataType).toBe("text");
  });

  test("table-to-table to-many refs become junction specs per relationships.md §3", () => {
    const users = planTable("users", TABLES.users!, TABLES, "sqlite");
    expect(users.junctions).toEqual([
      {
        field: "friends",
        sourceColumn: "users_id",
        sourceIdType: "text",
        sourceTable: "users",
        table: "users_friends",
        targetColumn: "posts_id",
        targetIdType: "integer",
        targetTable: "posts",
      },
    ]);
  });

  test("self-references suffix the target junction column with _2", () => {
    const posts = planTable("posts", TABLES.posts!, TABLES, "sqlite");
    const [junction] = posts.junctions;
    expect(junction!.table).toBe("posts_related");
    expect(junction!.sourceColumn).toBe("posts_id");
    expect(junction!.targetColumn).toBe("posts_id_2");
  });

  test("indexes resolve field names to physical columns", () => {
    const posts = planTable("posts", TABLES.posts!, TABLES, "sqlite");
    expect(posts.indexes).toEqual([["title"], ["title", "message"]]);
    expect(posts.timestamps).toBe(false);
    expect(posts.idType).toBe("integer");
  });
});

describe("id helpers", () => {
  test("idDataType and newRowId follow the id strategy", () => {
    expect(idDataType("uuid")).toBe("text");
    expect(idDataType("integer")).toBe("integer");
    expect(newRowId("integer")).toBeUndefined();
    const id = newRowId("uuid");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("storage coercion", () => {
  const plan = planTable("comments", TABLES.comments!, TABLES, "sqlite");
  const approved = plan.columns.find((c) => c.field === "approved")!;
  const tags = plan.columns.find((c) => c.field === "tags")!;
  const message = plan.columns.find((c) => c.field === "message")!;

  test("booleans store as 0/1 on sqlite and stay booleans on postgres", () => {
    expect(toStorage(approved, true, "sqlite")).toBe(1);
    expect(toStorage(approved, false, "sqlite")).toBe(0);
    expect(toStorage(approved, true, "postgres")).toBe(true);
    expect(toStorage(approved, null, "sqlite")).toBeNull();
  });

  test("json columns round-trip through serialized text", () => {
    const stored = toStorage(tags, ["a", "b"], "sqlite");
    expect(stored).toBe('["a","b"]');
    const row = fromStorage(plan.columns, { approved: 1, message: "hi", tags: stored });
    expect(row.tags).toEqual(["a", "b"]);
    expect(row.approved).toBe(true);
    expect(row.message).toBe("hi");
  });

  test("malformed stored JSON degrades to the raw string", () => {
    const row = fromStorage(plan.columns, { tags: "{not json" });
    expect(row.tags).toBe("{not json");
  });

  test("plain values pass through", () => {
    expect(toStorage(message, "hello", "sqlite")).toBe("hello");
    expect(fromStorage(plan.columns, { message: null }).message).toBeNull();
  });
});
