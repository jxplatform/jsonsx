/**
 * Bun-sqlite dialect — lifecycle paths beyond the CRUD suites: file-backed opening (parent dir
 * creation), transactions, streaming rejection, and misuse errors.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompiledQuery, Kysely, sql } from "kysely";
import { createBunSqliteDialect } from "../src/dialects/bun-sqlite";
import type { DynamicDatabase } from "../src/query";

describe("createBunSqliteDialect", () => {
  test("opens a file database, creating the parent directory, and closes it on destroy", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-bunsqlite-"));
    try {
      const file = join(root, "nested", "dir", "db.sqlite");
      const db = new Kysely<DynamicDatabase>({ dialect: createBunSqliteDialect({ url: file }) });
      await sql`create table t (id text)`.execute(db);
      expect(existsSync(file)).toBe(true);
      await db.destroy();

      // Reopen: the data persisted.
      const again = new Kysely<DynamicDatabase>({ dialect: createBunSqliteDialect({ url: file }) });
      const tables = await again.introspection.getTables();
      expect(tables.map((t) => t.name)).toEqual(["t"]);
      await again.destroy();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("transactions commit and roll back", async () => {
    const db = new Kysely<DynamicDatabase>({ dialect: createBunSqliteDialect() });
    await sql`create table t (id text)`.execute(db);

    await db.transaction().execute(async (trx) => {
      await trx.insertInto("t").values({ id: "kept" }).execute();
    });

    const failed = db.transaction().execute(async (trx) => {
      await trx.insertInto("t").values({ id: "discarded" }).execute();
      throw new Error("boom");
    });
    expect(failed).rejects.toThrow("boom");
    // Give the rollback a tick before asserting.
    await failed.catch(() => {});

    const rows = await db.selectFrom("t").selectAll().execute();
    expect(rows).toEqual([{ id: "kept" }]);
    await db.destroy();
  });

  test("streaming is rejected and use-before-init throws", async () => {
    const dialect = createBunSqliteDialect();
    const driver = dialect.createDriver();
    const uninitialized = driver.acquireConnection();
    const connection = await uninitialized;
    expect(connection.executeQuery(CompiledQuery.raw("select 1"))).rejects.toThrow("before init()");

    await driver.init();
    const ready = await driver.acquireConnection();
    expect(() => ready.streamQuery(CompiledQuery.raw("select 1"), 1)).toThrow(
      "does not support streaming",
    );
    await driver.releaseConnection(ready);
    await driver.destroy();
  });
});

describe("destroy releases the database file", () => {
  /*
   * A driver that reports itself destroyed while still holding the file is the failure this pins.
   * `executeQuery` prepares a statement per query and finalizes none, and bun:sqlite DEFERS a bare
   * `close()` while statements are outstanding — so the obvious spelling returns without releasing
   * anything. POSIX cannot see it (an open file still unlinks); Windows answers EBUSY, which is
   * where it surfaced. Deleting the directory is the assertion because that is the consequence
   * anyone actually meets: a temp fixture that will not clean up, or a project directory a desktop
   * window has quietly pinned.
   */
  test("the file can be deleted after destroy, having been queried through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-sqlite-release-"));
    const db = new Kysely<DynamicDatabase>({
      dialect: createBunSqliteDialect({ url: join(dir, "held.sqlite") }),
    });
    await sql`create table t (a integer)`.execute(db);
    await sql`insert into t (a) values (1)`.execute(db);
    await sql`select * from t`.execute(db);
    await db.destroy();

    expect(() => rmSync(dir, { recursive: true })).not.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});
