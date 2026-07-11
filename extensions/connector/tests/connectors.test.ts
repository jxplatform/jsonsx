/**
 * Connectors — provider capability methods (dialect selection, deploySchema, bindings,
 * testConnection) and the resolveDialect seam (plan Part 4a "classes"). Supabase's postgres-js
 * modules are mocked so its composition runs over an injected sqlite dialect.
 */

import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { createBunSqliteDialect } from "../src/dialects/bun-sqlite";
import type { DynamicDatabase } from "../src/query";
import type { TableDef } from "../src/types";

// Mock the postgres-js stack BEFORE importing the providers: Supabase.dialect composes
// `postgres(url)` into PostgresJSDialect — the mock swaps in an in-memory sqlite dialect while
// Preserving the URL wiring, so testConnection/deploySchema run real SQL.
const postgresCalls: { url: string; options: Record<string, unknown> }[] = [];
void mock.module("postgres", () => ({
  default: (url: string, options: Record<string, unknown>) => {
    postgresCalls.push({ options, url });
    if (url.includes("unreachable")) {
      throw new Error("connect ECONNREFUSED (mock)");
    }
    return { url };
  },
}));
void mock.module("kysely-postgres-js", () => ({
  PostgresJSDialect: class {
    #inner = createBunSqliteDialect({ database: new Database(":memory:") });
    createAdapter() {
      return this.#inner.createAdapter();
    }
    createDriver() {
      return this.#inner.createDriver();
    }
    createIntrospector(db: Kysely<unknown>) {
      return this.#inner.createIntrospector(db);
    }
    createQueryCompiler() {
      return this.#inner.createQueryCompiler();
    }
  },
}));

const { D1 } = await import("../src/d1");
const { Sqlite, sqliteFilePath } = await import("../src/sqlite");
const { Supabase, resolvePostgresUrl } = await import("../src/supabase");
const { PROVIDERS, resolveDialect } = await import("../src/connectors");

const TABLES: Record<string, TableDef> = {
  notes: {
    connection: "main",
    schema: { properties: { text: { type: "string" } }, type: "object" },
  },
};

describe("Sqlite provider", () => {
  test("resolves file paths from JX_PROJECT_ROOT, connection name, and file overrides", () => {
    expect(
      sqliteFilePath({ $name: "main", provider: "sqlite" }, { JX_PROJECT_ROOT: "/proj" }),
    ).toBe("/proj/.jx/data/main.sqlite");
    expect(
      sqliteFilePath({ file: "./db/x.sqlite", provider: "sqlite" }, { JX_PROJECT_ROOT: "/proj/" }),
    ).toBe("/proj/db/x.sqlite");
    expect(sqliteFilePath({ file: ":memory:", provider: "sqlite" }, {})).toBe(":memory:");
    expect(sqliteFilePath({ file: "/abs/x.sqlite", provider: "sqlite" }, {})).toBe("/abs/x.sqlite");
  });

  test("deploySchema + testConnection run real SQL against the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-conn-sqlite-"));
    try {
      const env = { JX_PROJECT_ROOT: root };
      const connection = { $name: "main", provider: "sqlite" };
      const dry = await Sqlite.deploySchema(TABLES, connection, { dryRun: true, env });
      expect(dry.applied).toBe(false);
      expect(dry.statements.some((s) => s.startsWith('create table "notes"'))).toBe(true);

      const applied = await Sqlite.deploySchema(TABLES, connection, { env });
      expect(applied.applied).toBe(true);

      const probe = await Sqlite.testConnection(connection, env);
      expect(probe).toEqual({ ok: true });

      expect(Sqlite.bindings()).toEqual({});
      expect(Sqlite.kind).toBe("sqlite");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("D1 provider", () => {
  test("bindings emit the d1_databases fragment", () => {
    expect(
      D1.bindings({ $name: "main", binding: "DB", databaseId: "uuid-1", provider: "d1" }),
    ).toEqual({
      d1_databases: [{ binding: "DB", database_id: "uuid-1", database_name: "main" }],
    });
    expect(D1.bindings({ provider: "d1" })).toEqual({
      d1_databases: [{ binding: "DB", database_name: "DB" }],
    });
  });

  test("dialect prefers the env binding and falls back to the HTTP API", () => {
    const bound = { fake: "d1-binding" };
    const viaBinding = D1.dialect({ binding: "DB", provider: "d1" }, { DB: bound });
    expect(viaBinding.constructor.name).toBe("D1Dialect");

    const viaHttp = D1.dialect(
      { databaseId: "uuid", provider: "d1" },
      { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
    );
    expect(typeof viaHttp.createDriver).toBe("function");

    expect(() => D1.dialect({ $name: "main", provider: "d1" }, {})).toThrow("unreachable");
  });

  test("testConnection reports unreachable connections instead of throwing", async () => {
    const result = await D1.testConnection({ $name: "main", provider: "d1" }, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unreachable");
  });

  test("deploySchema dry-runs through the HTTP API dialect", async () => {
    const sqls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sql: string };
      sqls.push(body.sql);
      return Response.json({ result: [{ meta: {}, results: [], success: true }], success: true });
    }) as typeof globalThis.fetch;
    try {
      const result = await D1.deploySchema(
        TABLES,
        { databaseId: "uuid", provider: "d1" },
        { dryRun: true, env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" } },
      );
      expect(result.applied).toBe(false);
      expect(result.statements.some((s) => s.startsWith('create table "notes"'))).toBe(true);
      // Dry-run still introspects (sqlite_master reads), but never executes DDL.
      expect(sqls.some((s) => s.includes("sqlite_master"))).toBe(true);
      expect(sqls.some((s) => s.startsWith("create table"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Supabase provider", () => {
  test("resolvePostgresUrl prefers the Hyperdrive binding over urlEnv", () => {
    const env = {
      HYPERDRIVE: { connectionString: "postgres://hyper" },
      SUPABASE_DB_URL: "postgres://direct",
    };
    expect(
      resolvePostgresUrl(
        { binding: "HYPERDRIVE", provider: "supabase", urlEnv: "SUPABASE_DB_URL" },
        env,
      ),
    ).toBe("postgres://hyper");
    expect(resolvePostgresUrl({ provider: "supabase", urlEnv: "SUPABASE_DB_URL" }, env)).toBe(
      "postgres://direct",
    );
    expect(() => resolvePostgresUrl({ $name: "sb", provider: "supabase" }, {})).toThrow(
      "unreachable",
    );
    expect(() => resolvePostgresUrl({ provider: "supabase", urlEnv: "MISSING_VAR" }, {})).toThrow(
      "MISSING_VAR",
    );
  });

  test("dialect composes postgres(url) with prepare disabled (pooler-safe)", async () => {
    const before = postgresCalls.length;
    const dialect = await Supabase.dialect(
      { provider: "supabase", urlEnv: "SUPABASE_DB_URL" },
      { SUPABASE_DB_URL: "postgres://direct" },
    );
    expect(typeof dialect.createDriver).toBe("function");
    const call = postgresCalls[before]!;
    expect(call.url).toBe("postgres://direct");
    expect(call.options.prepare).toBe(false);
  });

  test("deploySchema and testConnection run through the composed dialect", async () => {
    const env = { SUPABASE_DB_URL: "postgres://direct" };
    const connection = { $name: "sb", provider: "supabase", urlEnv: "SUPABASE_DB_URL" };
    const dry = await Supabase.deploySchema(TABLES, connection, { dryRun: true, env });
    expect(dry.statements.some((s) => s.includes("create table"))).toBe(true);

    const probe = await Supabase.testConnection(connection, env);
    expect(probe.ok).toBe(true);

    const bad = await Supabase.testConnection(
      { provider: "supabase", urlEnv: "BAD" },
      { BAD: "postgres://unreachable" },
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("ECONNREFUSED");
  });

  test("bindings emit the hyperdrive fragment only when hyperdriveId is set", () => {
    expect(
      Supabase.bindings({ binding: "HD", hyperdriveId: "hd-1", provider: "supabase" }),
    ).toEqual({ hyperdrive: [{ binding: "HD", id: "hd-1" }] });
    expect(Supabase.bindings({ hyperdriveId: "hd-1", provider: "supabase" })).toEqual({
      hyperdrive: [{ binding: "HYPERDRIVE", id: "hd-1" }],
    });
    expect(Supabase.bindings({ provider: "supabase" })).toEqual({});
  });
});

describe("resolveDialect", () => {
  const projectConfig = {
    connections: {
      local: { file: ":memory:", provider: "sqlite" },
      weird: { provider: "not-a-provider" },
    },
  };

  test("resolves a named connection to a live dialect + kind", async () => {
    const { dialect, type } = await resolveDialect("local", projectConfig, {});
    expect(type).toBe("sqlite");
    const db = new Kysely<DynamicDatabase>({ dialect });
    const probe = await sql`select 1 as one`.execute(db);
    expect(probe.rows).toEqual([{ one: 1 }]);
    await db.destroy();
  });

  test("unknown connections and providers are explicit errors", async () => {
    expect(resolveDialect("ghost", projectConfig, {})).rejects.toThrow(
      'Unknown connection "ghost"',
    );
    expect(resolveDialect("weird", projectConfig, {})).rejects.toThrow("not-a-provider");
  });

  test("the first-party provider map is keyed by provider id", () => {
    expect(Object.keys(PROVIDERS).toSorted()).toEqual(["d1", "sqlite", "supabase"]);
  });
});
