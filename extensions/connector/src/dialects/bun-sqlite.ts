/**
 * Bun-sqlite dialect — a minimal Kysely dialect over `bun:sqlite`.
 *
 * Backs the Sqlite connector and the dev server's `local: "sqlite"` stand-ins. The database opens
 * lazily inside `Driver.init()` (creating the parent directory when a file path is given), so
 * constructing the dialect stays synchronous and side-effect-free; tests and embedded hosts may
 * inject an already-open database instead. `bun:sqlite` is imported dynamically through an opaque
 * specifier so browser/worker bundles that merely reach this module's importers never try to
 * resolve it.
 */

import { CompiledQuery, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";
import type { SQLQueryBindings } from "bun:sqlite";
import type { DatabaseConnection, Dialect, Driver, QueryResult } from "kysely";

/** The subset of `bun:sqlite`'s Statement the driver uses (type-only import — erased). */
export interface BunSqliteStatementLike {
  columnNames: string[];
  all: (...params: SQLQueryBindings[]) => unknown[];
  run: (...params: SQLQueryBindings[]) => { changes: number; lastInsertRowid: number | bigint };
}

/** The subset of `bun:sqlite`'s Database the driver uses. */
export interface BunSqliteDatabaseLike {
  prepare: (sql: string) => BunSqliteStatementLike;
  close?: () => void;
}

export interface BunSqliteDialectConfig {
  /** SQLite file path (":memory:" for in-memory). Ignored when `database` is injected. */
  url?: string;
  /** An already-open database — the dialect will not close it on destroy. */
  database?: BunSqliteDatabaseLike;
}

/**
 * Create the Kysely dialect.
 *
 * @param {BunSqliteDialectConfig} [config]
 * @returns {Dialect}
 */
export function createBunSqliteDialect(config: BunSqliteDialectConfig = {}): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => createDriver(config),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}

/** Open the configured database (dynamic imports keep this module bundle-inert). */
async function openDatabase(config: BunSqliteDialectConfig): Promise<{
  db: BunSqliteDatabaseLike;
  owned: boolean;
}> {
  const { database, url } = config;
  if (database) {
    return { db: database, owned: false };
  }
  const file = url ?? ":memory:";
  if (file !== ":memory:") {
    // Ensure the parent directory exists (dev-server convention: <project>/.jx/data/).
    const fsSpecifier = "node:fs";
    const pathSpecifier = "node:path";
    const fs = (await import(fsSpecifier)) as {
      mkdirSync: (path: string, options: { recursive: boolean }) => void;
    };
    const path = (await import(pathSpecifier)) as { dirname: (path: string) => string };
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const sqliteSpecifier = "bun:sqlite";
  const sqlite = (await import(sqliteSpecifier)) as {
    Database: new (file: string) => BunSqliteDatabaseLike;
  };
  return { db: new sqlite.Database(file), owned: true };
}

/** Build the single-connection driver over one bun:sqlite database. */
function createDriver(config: BunSqliteDialectConfig): Driver {
  let db: BunSqliteDatabaseLike | null = null;
  let owned = false;

  const connection: DatabaseConnection = {
    executeQuery: async <R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> => {
      if (!db) {
        throw new Error("BunSqliteDialect used before init()");
      }
      const { sql, parameters } = compiledQuery;
      const stmt = db.prepare(sql);
      const bindings = parameters as SQLQueryBindings[];
      if (stmt.columnNames.length > 0) {
        return { rows: stmt.all(...bindings) as R[] };
      }
      const info = stmt.run(...bindings);
      return {
        insertId: BigInt(info.lastInsertRowid),
        numAffectedRows: BigInt(info.changes),
        rows: [],
      };
    },
    streamQuery: () => {
      throw new Error("BunSqliteDialect does not support streaming");
    },
  };

  return {
    acquireConnection: async () => connection,
    beginTransaction: async (conn) => {
      await conn.executeQuery(CompiledQuery.raw("begin"));
    },
    commitTransaction: async (conn) => {
      await conn.executeQuery(CompiledQuery.raw("commit"));
    },
    destroy: async () => {
      if (owned) {
        db?.close?.();
      }
      db = null;
    },
    init: async () => {
      ({ db, owned } = await openDatabase(config));
    },
    releaseConnection: async () => {
      // Single-connection driver — nothing to release.
    },
    rollbackTransaction: async (conn) => {
      await conn.executeQuery(CompiledQuery.raw("rollback"));
    },
  };
}
