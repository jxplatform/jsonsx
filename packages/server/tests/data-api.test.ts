/**
 * Data-api.test.ts — the /__studio/data/* + /__studio/secrets owner console (plan Part 4a).
 *
 * Uses a tempdir project with the real @jxsuite/connector extension over local sqlite: connections
 * listing (configured/missingSecrets/isDefault + registry metadata), test, push dry-run/apply, the
 * permission-free admin row CRUD (declared, junction, and undeclared tables), the names-only
 * secrets surface over .dev.vars, and the path-traversal/missing-project error paths.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyStatement,
  deleteDataRow,
  handleDataApi,
  insertDataRow,
  listDataConnections,
  listSecretNames,
  pushDataSchema,
  queryDataRows,
  resetDataApi,
  setProjectSecrets,
  testDataConnection,
  updateDataRow,
} from "../src/data-api";
import type { DataConnectionsResponse, DataPushResult, DataRowsResult } from "@jxsuite/protocol";

const TMP = resolve(import.meta.dir, "__test-data-api__");

function writeFixture(relPath: string, content: string | object) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

interface CallOptions {
  body?: unknown;
  params?: Record<string, string>;
  root?: string;
  active?: string | null;
}

function call(method: string, path: string, opts: CallOptions = {}): Promise<Response | null> {
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    url.searchParams.set(key, value);
  }
  const body =
    opts.body === undefined
      ? {}
      : { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) };
  return handleDataApi(
    new Request(url, { method, ...body }),
    url,
    opts.root ?? TMP,
    opts.active ?? null,
  );
}

async function json<T>(res: Response | null): Promise<T> {
  expect(res).not.toBeNull();
  return (await res!.json()) as T;
}

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  resetDataApi();

  writeFixture("project.json", {
    connections: {
      main: { provider: "sqlite" },
      remote: { provider: "supabase", urlEnv: "MISSING_DB_URL" },
      bogus: { provider: "nope" },
      broken: { file: "/dev/null/nope/x.sqlite", provider: "sqlite" },
    },
    data: {
      posts: {
        connection: "main",
        indexes: ["title"],
        schema: {
          properties: {
            meta: { type: "object" },
            published: { type: "boolean" },
            tags: { items: { $ref: "#/data/tags" }, type: "array" },
            title: { type: "string" },
            views: { type: "integer" },
          },
          required: ["title"],
          type: "object",
        },
      },
      tags: {
        connection: "main",
        schema: { properties: { name: { type: "string" } }, type: "object" },
      },
      comments: {
        connection: "main",
        id: "integer",
        schema: { properties: { message: { type: "string" } }, type: "object" },
      },
      notes: {
        connection: "main",
        schema: { properties: { body: { type: "string" } }, type: "object" },
        timestamps: false,
      },
    },
    extensions: ["@jxsuite/connector"],
    name: "Data Api Fixture",
  });
  writeFixture(".dev.vars", "# Seeded comment\nEXISTING_KEY=old\nOTHER=1\n");
  writeFixture("sub/project.json", { name: "Sub Project" });
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  resetDataApi();
});

describe("routing and guards", () => {
  test("non-data paths return null", async () => {
    expect(await call("GET", "/__studio/files")).toBeNull();
    expect(await call("GET", "/__studio/datax")).toBeNull();
  });

  test("unknown method on a known path is 405", async () => {
    const res = await call("PATCH", "/__studio/data/rows", { params: { table: "posts" } });
    expect(res!.status).toBe(405);
  });

  test("path traversal via dir is rejected", async () => {
    const res = await call("GET", "/__studio/data/connections", { params: { dir: "../outside" } });
    expect(res!.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toContain("outside project root");
  });

  test("a dir under the active project root is allowed", async () => {
    const res = await call("GET", "/__studio/secrets", {
      active: TMP,
      params: { dir: TMP },
      root: resolve(TMP, "elsewhere"),
    });
    expect(res!.status).toBe(200);
  });

  test("a directory without project.json is 404", async () => {
    mkdirSync(resolve(TMP, "ghost"), { recursive: true });
    const res = await call("GET", "/__studio/data/connections", { params: { dir: "ghost" } });
    expect(res!.status).toBe(404);
  });

  test("malformed JSON bodies are 400", async () => {
    const res = await call("POST", "/__studio/data/push", { body: "not json" });
    expect(res!.status).toBe(400);
  });
});

describe("connections", () => {
  test("lists connections with configured state, registry metadata, and table names", async () => {
    const { connections } = await json<DataConnectionsResponse>(
      await call("GET", "/__studio/data/connections"),
    );
    expect(connections.map((c) => c.name)).toEqual(["main", "remote", "bogus", "broken"]);

    const main = connections[0]!;
    expect(main.isDefault).toBe(true);
    expect(main.configured).toBe(true);
    expect(main.missingSecrets).toEqual([]);
    expect(main.provider).toBe("sqlite");
    expect(main.connector?.kind).toBe("sqlite");
    expect(main.tables.toSorted()).toEqual(["comments", "notes", "posts", "tags"]);
    expect(main.settings).toEqual({ provider: "sqlite" });

    const remote = connections[1]!;
    expect(remote.isDefault).toBe(false);
    expect(remote.configured).toBe(false);
    expect(remote.missingSecrets).toEqual(["MISSING_DB_URL"]);
    expect(remote.connector?.kind).toBe("postgres");
    expect(remote.tables).toEqual([]);

    const bogus = connections[2]!;
    expect(bogus.connector).toBeNull();
    expect(bogus.configured).toBe(true);

    // Configured but unreachable: introspection fails and declared tables win.
    const broken = connections[3]!;
    expect(broken.configured).toBe(true);
    expect(broken.tables).toEqual([]);
  });

  test("projects without a connector extension list no connections", async () => {
    const { connections } = await listDataConnections(resolve(TMP, "sub"));
    expect(connections).toEqual([]);
  });

  test("testConnection probes through the registry", async () => {
    expect(await testDataConnection(TMP, "main")).toEqual({ ok: true });
    const broken = await testDataConnection(TMP, "broken");
    expect(broken.ok).toBe(false);
    expect(broken.error).toBeTruthy();
  });

  test("test route validates its inputs", async () => {
    const ok = await call("POST", "/__studio/data/connections/test", {
      body: { connection: "main" },
    });
    expect(await json<{ ok: boolean }>(ok)).toEqual({ ok: true });
    const unknown = await call("POST", "/__studio/data/connections/test", {
      body: { connection: "nope" },
    });
    expect(unknown!.status).toBe(404);
    const missing = await call("POST", "/__studio/data/connections/test", { body: {} });
    expect(missing!.status).toBe(400);
    const bogus = await call("POST", "/__studio/data/connections/test", {
      body: { connection: "bogus" },
    });
    expect(bogus!.status).toBe(400);
  });
});

describe("push", () => {
  test("dry-run compiles a classified plan without applying", async () => {
    const result = await json<DataPushResult>(
      await call("POST", "/__studio/data/push", { body: { connection: "main", dryRun: true } }),
    );
    expect(result.applied).toBe(false);
    expect(result.errors).toBeUndefined();

    const byKind = (kind: string) => result.plan.filter((s) => s.kind === kind);
    expect(
      byKind("createTable")
        .map((s) => s.table)
        .toSorted(),
    ).toEqual(["comments", "notes", "posts", "tags"]);
    expect(byKind("junction").map((s) => s.table)).toEqual(["posts_tags"]);
    expect(byKind("index").length).toBeGreaterThanOrEqual(2);
    for (const step of result.plan) {
      expect(step.sql).toBeTruthy();
      expect(step.summary).toBeTruthy();
      expect(step.connection).toBe("main");
    }
  });

  test("apply executes the plan; a second push is a no-op", async () => {
    const applied = await pushDataSchema(TMP, { connection: "main" });
    expect(applied.applied).toBe(true);
    expect(applied.plan.length).toBeGreaterThan(0);
    expect(existsSync(resolve(TMP, ".jx/data/main.sqlite"))).toBe(true);

    const again = await pushDataSchema(TMP, { connection: "main" });
    expect(again.applied).toBe(true);
    expect(again.plan).toEqual([]);
  });

  test("pushing every connection surfaces per-connection errors", async () => {
    const result = await pushDataSchema(TMP, {});
    expect(result.applied).toBe(false);
    expect(result.errors?.length).toBe(3);
    expect(result.errors?.some((e) => e.startsWith("remote:"))).toBe(true);
    expect(result.errors?.some((e) => e.startsWith("bogus:"))).toBe(true);
    expect(result.errors?.some((e) => e.startsWith("broken:"))).toBe(true);
    // The reachable connection still contributed its (empty, already-applied) plan.
    expect(result.plan).toEqual([]);
  });

  test("pushing an unknown connection is 404", async () => {
    const res = await call("POST", "/__studio/data/push", { body: { connection: "nope" } });
    expect(res!.status).toBe(404);
  });

  test("classifyStatement falls back to a generic statement step", () => {
    const step = classifyStatement("drop view something", new Set(), "main");
    expect(step.kind).toBe("statement");
    expect(step.summary).toBe("drop view something");
  });
});

describe("rows", () => {
  test("insert applies uuid + timestamp conveniences and storage coercion", async () => {
    const res = await call("POST", "/__studio/data/rows", {
      body: {
        table: "posts",
        values: { meta: { a: 1 }, published: true, title: "Hello", views: "3" },
      },
    });
    expect(res!.status).toBe(201);
    const { row } = await json<{ row: Record<string, unknown> }>(res);
    expect(typeof row.id).toBe("string");
    expect((row.id as string).length).toBe(36);
    expect(row.views).toBe(3);
    expect(row.published).toBe(1);
    expect(row.meta).toBe(JSON.stringify({ a: 1 }));
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  test("insert rejects unknown columns", async () => {
    const res = await call("POST", "/__studio/data/rows", {
      body: { table: "posts", values: { nope: "x" } },
    });
    expect(res!.status).toBe(400);
  });

  test("lists rows with columns metadata, total, ordering, and paging", async () => {
    await insertDataRow(TMP, { table: "posts", values: { title: "Apple" } });
    await insertDataRow(TMP, { table: "posts", values: { title: "Zebra" } });

    const page = await json<DataRowsResult>(
      await call("GET", "/__studio/data/rows", {
        params: { dir: ".", limit: "2", orderBy: "title", table: "posts" },
      }),
    );
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.title)).toEqual(["Apple", "Hello", "Zebra"].slice(0, 2));
    const id = page.columns.find((c) => c.name === "id");
    expect(id?.pk).toBe(true);
    expect(page.columns.map((c) => c.name)).toContain("created_at");

    const desc = await queryDataRows(TMP, { dir: "desc", orderBy: "title", table: "posts" });
    expect(desc.rows[0]!.title).toBe("Zebra");
    const last = await queryDataRows(TMP, {
      limit: 0,
      offset: 2,
      orderBy: "title",
      table: "posts",
    });
    expect(last.rows).toHaveLength(1);

    const badLimit = await json<DataRowsResult>(
      await call("GET", "/__studio/data/rows", { params: { limit: "abc", table: "posts" } }),
    );
    expect(badLimit.rows.length).toBe(3);
  });

  test("orderBy must be a real column; unknown tables are 404; table param required", async () => {
    const bad = await call("GET", "/__studio/data/rows", {
      params: { orderBy: "nope", table: "posts" },
    });
    expect(bad!.status).toBe(400);
    const unknown = await call("GET", "/__studio/data/rows", { params: { table: "ghost" } });
    expect(unknown!.status).toBe(404);
    const missing = await call("GET", "/__studio/data/rows");
    expect(missing!.status).toBe(400);
  });

  test("update commits by pk (normalizing integer pks) and bumps updated_at", async () => {
    const { row } = await insertDataRow(TMP, { table: "comments", values: { message: "hi" } });
    expect(typeof row.id).toBe("number");

    const res = await call("PUT", "/__studio/data/rows", {
      body: { pk: String(row.id), set: { message: "edited" }, table: "comments" },
    });
    const updated = await json<{ row: Record<string, unknown> }>(res);
    expect(updated.row.message).toBe("edited");
    expect(updated.row.updated_at).toBeTruthy();

    const gone = await call("PUT", "/__studio/data/rows", {
      body: { pk: 999, set: { message: "x" }, table: "comments" },
    });
    expect(gone!.status).toBe(404);
    const empty = await call("PUT", "/__studio/data/rows", {
      body: { pk: row.id, set: {}, table: "comments" },
    });
    expect(empty!.status).toBe(400);
  });

  test("tables with timestamps disabled skip the conveniences", async () => {
    const { row } = await insertDataRow(TMP, { table: "notes", values: { body: "n1" } });
    expect(row.created_at).toBeUndefined();
    const updated = await updateDataRow(TMP, {
      pk: row.id as string,
      set: { body: "n2" },
      table: "notes",
    });
    expect(updated.row.body).toBe("n2");
  });

  test("delete removes by pk and 404s on a second attempt", async () => {
    const { row } = await insertDataRow(TMP, { table: "tags", values: { name: "temp" } });
    const res = await call("DELETE", "/__studio/data/rows", {
      params: { pk: String(row.id), table: "tags" },
    });
    expect(await json<{ ok: boolean }>(res)).toEqual({ ok: true });
    const again = await deleteDataRow(TMP, { pk: row.id as string, table: "tags" }).catch(
      (error: { status?: number }) => error,
    );
    expect((again as { status?: number }).status).toBe(404);
  });

  test("undeclared tables (junctions, system tables) are browsable via explicit connection", async () => {
    const junction = await json<DataRowsResult>(
      await call("GET", "/__studio/data/rows", {
        params: { connection: "main", table: "posts_tags" },
      }),
    );
    expect(junction.total).toBe(0);
    expect(
      junction.columns
        .filter((c) => c.pk)
        .map((c) => c.name)
        .toSorted(),
    ).toEqual(["posts_id", "tags_id"]);

    // A pk-less table (no pragma pk rows) falls back to the id convention: no column flagged.
    const { Database } = await import("bun:sqlite");
    const db = new Database(resolve(TMP, ".jx/data/main.sqlite"));
    db.run("create table if not exists syslog (msg text)");
    db.close();
    const syslog = await queryDataRows(TMP, { table: "syslog" });
    expect(syslog.columns.some((c) => c.pk)).toBe(false);
    const inserted = await insertDataRow(TMP, { table: "syslog", values: { msg: "raw" } });
    expect(inserted.row.msg).toBe("raw");
  });

  test("rows on a project without connections is 400", async () => {
    const res = await call("GET", "/__studio/data/rows", {
      params: { dir: "sub", table: "anything" },
    });
    expect(res!.status).toBe(400);
  });
});

describe("secrets", () => {
  test("list returns names only", async () => {
    const res = await json<{ names: string[] }>(await call("GET", "/__studio/secrets"));
    expect(res.names).toEqual(["EXISTING_KEY", "OTHER"]);
    expect(JSON.stringify(res)).not.toContain("old");
  });

  test("set updates in place, preserves comments/order, appends, and removes", async () => {
    const res = await json<{ ok: boolean; names: string[] }>(
      await call("PUT", "/__studio/secrets", {
        body: { remove: ["OTHER"], set: { EXISTING_KEY: "new value", FRESH: "v1" } },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.names).toEqual(["EXISTING_KEY", "FRESH"]);

    const text = readFileSync(resolve(TMP, ".dev.vars"), "utf8");
    expect(text).toBe("# Seeded comment\nEXISTING_KEY=new value\nFRESH=v1\n");
  });

  test("invalid names and multi-line values are rejected", async () => {
    const badName = await call("PUT", "/__studio/secrets", { body: { set: { "BAD NAME": "x" } } });
    expect(badName!.status).toBe(400);
    const multiline = await call("PUT", "/__studio/secrets", { body: { set: { OK: "a\nb" } } });
    expect(multiline!.status).toBe(400);
    const nonString = await call("PUT", "/__studio/secrets", { body: { set: { OK: 5 } } });
    expect(nonString!.status).toBe(400);
    const badRemove = await call("PUT", "/__studio/secrets", { body: { remove: ["BAD NAME"] } });
    expect(badRemove!.status).toBe(400);
  });

  test("removing every key leaves an empty file; a missing file lists nothing", async () => {
    await setProjectSecrets(TMP, { remove: ["EXISTING_KEY", "FRESH"] });
    expect(readFileSync(resolve(TMP, ".dev.vars"), "utf8")).toBe("# Seeded comment\n");
    await setProjectSecrets(TMP, { remove: [] });
    const emptied = await listSecretNames(TMP);
    expect(emptied.names).toEqual([]);

    const sub = resolve(TMP, "sub");
    const absent = await listSecretNames(sub);
    expect(absent.names).toEqual([]);
    await setProjectSecrets(sub, { set: { ONLY: "1" } });
    expect(readFileSync(resolve(sub, ".dev.vars"), "utf8")).toBe("ONLY=1\n");
  });
});

describe("push with the auth extension (section-owner deploySchema)", () => {
  const AUTH_DIR = resolve(TMP, "authproj");

  beforeAll(() => {
    writeFixture("authproj/project.json", {
      auth: { connection: "main" },
      connections: { main: { provider: "sqlite" } },
      data: {
        comments: {
          connection: "main",
          ownerField: "author_id",
          permissions: { insert: "authenticated", read: "public", update: "owner" },
          schema: {
            properties: { author_id: { type: "string" }, message: { type: "string" } },
            required: ["message"],
            type: "object",
          },
        },
      },
      extensions: ["@jxsuite/connector", "@jxsuite/auth"],
      name: "Auth Push Fixture",
    });
  });

  test("dry-run composes kind-auth steps after the connector plan", async () => {
    const result = await pushDataSchema(AUTH_DIR, { dryRun: true });
    expect(result.applied).toBe(false);
    expect(result.errors).toBeUndefined();

    const kinds = result.plan.map((step) => step.kind);
    const authSteps = result.plan.filter((step) => step.kind === "auth");
    expect(kinds).toContain("createTable");
    expect(authSteps.length).toBeGreaterThan(0);
    // Every auth step trails the connector statements.
    expect(kinds.indexOf("auth")).toBeGreaterThan(kinds.lastIndexOf("createTable"));
    expect(authSteps.map((step) => step.table)).toContain("user");
    for (const step of authSteps) {
      expect(step.connection).toBe("main");
      expect(step.sql).toBeTruthy();
      expect(step.summary).toContain("auth");
    }
  });

  test("apply creates the auth system tables; a second push is a clean no-op", async () => {
    const applied = await pushDataSchema(AUTH_DIR, {});
    expect(applied.applied).toBe(true);
    expect(applied.plan.some((step) => step.kind === "auth" && step.table === "user")).toBe(true);

    const rows = await queryDataRows(AUTH_DIR, { table: "user" });
    expect(rows.total).toBe(0);
    expect(rows.columns.some((column) => column.name === "email")).toBe(true);

    const again = await pushDataSchema(AUTH_DIR, {});
    expect(again.plan).toEqual([]);
    expect(again.applied).toBe(true);
  });

  test("a push filtered to a foreign connection skips the auth steps", async () => {
    writeFixture("authproj2/project.json", {
      auth: { connection: "main" },
      connections: {
        main: { provider: "sqlite" },
        other: { file: "./other.sqlite", provider: "sqlite" },
      },
      extensions: ["@jxsuite/connector", "@jxsuite/auth"],
      name: "Auth Push Filter Fixture",
    });
    const result = await pushDataSchema(resolve(TMP, "authproj2"), {
      connection: "other",
      dryRun: true,
    });
    expect(result.errors).toBeUndefined();
    expect(result.plan.filter((step) => step.kind === "auth")).toEqual([]);
  });
});
