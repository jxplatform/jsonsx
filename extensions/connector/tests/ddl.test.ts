/**
 * DDL — additive-only sync over real bun:sqlite: creation, idempotence, column additions, junction
 * tables (relationships.md §3), drift warnings, and dry-run compilation.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { createBunSqliteDialect } from "../src/dialects/bun-sqlite";
import { syncTables } from "../src/ddl";
import type { DynamicDatabase } from "../src/query";
import type { TableDef } from "../src/types";

function makeDb(): Kysely<DynamicDatabase> {
  return new Kysely<DynamicDatabase>({
    dialect: createBunSqliteDialect({ database: new Database(":memory:") }),
  });
}

const COMMENTS: Record<string, TableDef> = {
  comments: {
    connection: "main",
    indexes: ["views"],
    schema: {
      properties: {
        approved: { type: "boolean" },
        message: { type: "string" },
        views: { type: "integer" },
      },
      required: ["message"],
      type: "object",
    },
  },
};

describe("syncTables", () => {
  test("creates tables with id, timestamps, columns, and indexes", async () => {
    const db = makeDb();
    const result = await syncTables(db, COMMENTS, { dialect: "sqlite" });
    expect(result.applied).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.statements.some((s) => s.startsWith('create table "comments"'))).toBe(true);
    expect(result.statements.some((s) => s.includes("comments_views_idx"))).toBe(true);

    const tables = await db.introspection.getTables();
    const columns = tables.find((t) => t.name === "comments")!.columns.map((c) => c.name);
    expect(columns.toSorted()).toEqual([
      "approved",
      "created_at",
      "id",
      "message",
      "updated_at",
      "views",
    ]);
    await db.destroy();
  });

  test("second run is a no-op (idempotence)", async () => {
    const db = makeDb();
    await syncTables(db, COMMENTS, { dialect: "sqlite" });
    const second = await syncTables(db, COMMENTS, { dialect: "sqlite" });
    expect(second.statements).toEqual([]);
    expect(second.warnings).toEqual([]);
    await db.destroy();
  });

  test("dryRun compiles statements without applying them", async () => {
    const db = makeDb();
    const result = await syncTables(db, COMMENTS, { dialect: "sqlite", dryRun: true });
    expect(result.applied).toBe(false);
    expect(result.statements.length).toBeGreaterThan(0);
    const tables = await db.introspection.getTables();
    expect(tables).toEqual([]);
    await db.destroy();
  });

  test("adds missing columns additively; never drops or retypes", async () => {
    const db = makeDb();
    await syncTables(db, COMMENTS, { dialect: "sqlite" });
    // Simulate drift: an extra column and a wrong-typed schema change.
    await sql`alter table comments add column legacy text`.execute(db);
    const evolved: Record<string, TableDef> = {
      comments: {
        connection: "main",
        schema: {
          properties: {
            message: { type: "integer" },
            rating: { type: "number" },
            views: { type: "integer" },
          },
          type: "object",
        },
      },
    };
    const result = await syncTables(db, evolved, { dialect: "sqlite" });
    expect(result.statements).toEqual(['alter table "comments" add column "rating" real']);
    expect(result.warnings.some((w) => w.includes("comments.message: type drift"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("comments.legacy"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("comments.approved"))).toBe(true);

    const tables = await db.introspection.getTables();
    const columns = tables.find((t) => t.name === "comments")!.columns.map((c) => c.name);
    expect(columns).toContain("approved");
    expect(columns).toContain("legacy");
    expect(columns).toContain("rating");
    await db.destroy();
  });

  test("integer id tables get autoincrement primary keys on sqlite", async () => {
    const db = makeDb();
    const tables: Record<string, TableDef> = {
      posts: {
        connection: "main",
        id: "integer",
        schema: { properties: { title: { type: "string" } }, type: "object" },
        timestamps: false,
      },
    };
    const result = await syncTables(db, tables, { dialect: "sqlite" });
    expect(result.statements[0]).toContain("autoincrement");
    await db.insertInto("posts").values({ title: "a" }).execute();
    await db.insertInto("posts").values({ title: "b" }).execute();
    const rows = await db.selectFrom("posts").selectAll().execute();
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    await db.destroy();
  });

  test("materializes junction tables with composite PK and target index", async () => {
    const db = makeDb();
    const tables: Record<string, TableDef> = {
      posts: {
        connection: "main",
        schema: {
          properties: {
            tags: { items: { $ref: "#/data/tags" }, type: "array" },
            title: { type: "string" },
          },
          type: "object",
        },
      },
      tags: {
        connection: "main",
        schema: { properties: { name: { type: "string" } }, type: "object" },
      },
    };
    const result = await syncTables(db, tables, { dialect: "sqlite" });
    expect(
      result.statements.some(
        (s) => s.startsWith('create table "posts_tags"') && s.includes("primary key"),
      ),
    ).toBe(true);
    expect(result.statements.some((s) => s.includes("posts_tags_tags_id_idx"))).toBe(true);

    const introspected = await db.introspection.getTables();
    const names = introspected.map((t) => t.name);
    expect(names).toContain("posts_tags");

    // Idempotent for junctions too.
    const second = await syncTables(db, tables, { dialect: "sqlite" });
    expect(second.statements).toEqual([]);
    await db.destroy();
  });

  test("reports orphaned junction tables as drift, never drops them", async () => {
    const db = makeDb();
    await sql`create table posts (id text primary key)`.execute(db);
    await sql`create table posts_oldtags (posts_id text, tags_id text)`.execute(db);
    const tables: Record<string, TableDef> = {
      posts: {
        connection: "main",
        schema: { properties: { title: { type: "string" } }, type: "object" },
        timestamps: false,
      },
    };
    const result = await syncTables(db, tables, { dialect: "sqlite" });
    expect(result.warnings.some((w) => w.includes("posts_oldtags") && w.includes("orphaned"))).toBe(
      true,
    );
    const introspected = await db.introspection.getTables();
    const names = introspected.map((t) => t.name);
    expect(names).toContain("posts_oldtags");
    await db.destroy();
  });

  test("postgres flavor compiles identity ids and pg types in dry-run", async () => {
    const db = makeDb();
    const tables: Record<string, TableDef> = {
      metrics: {
        connection: "main",
        id: "integer",
        schema: {
          properties: { flag: { type: "boolean" }, score: { type: "number" } },
          type: "object",
        },
        timestamps: false,
      },
    };
    const result = await syncTables(db, tables, { dialect: "postgres", dryRun: true });
    const [create] = result.statements;
    expect(create).toContain("generated always as identity");
    expect(create).toContain("double precision");
    expect(create).toContain('"flag" boolean');
    await db.destroy();
  });
});
