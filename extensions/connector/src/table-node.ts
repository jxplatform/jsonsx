/**
 * Table-node — direct-database resolution for TableQuery/TableEntry under node/Bun.
 *
 * The dev server's resolve proxy and compiler-timing SSG bakes land here (browsers fetch /_jx/data
 * instead — see table-state.ts). The connection resolves through the first-party provider map
 * (`resolveDialect`); sqlite connections are additively auto-synced before the first read so a
 * fresh project queries cleanly. Errors propagate — the state classes turn them into warnings +
 * empty results.
 */

import { Kysely } from "kysely";
import { fromStorage, planTable } from "./columns.ts";
import { resolveDialect } from "./connectors.ts";
import { syncTables } from "./ddl.ts";
import { applyFilter, applySort, normalizeFilter, normalizeSort } from "./query.ts";
import { tablesForConnection } from "./provider-utils.ts";
import type { SqlDialectKind } from "./columns.ts";
import type { ConnectionsConfig } from "./connectors.ts";
import type { DynamicDatabase } from "./query.ts";
import type { TableQueryDef } from "./table-shared.ts";
import type { TableDef } from "./types.ts";

/** The `_project`-bearing config shape hosts inject into state classes. */
export interface TableNodeConfig extends TableQueryDef {
  id?: unknown;
  _project?: {
    config?: ConnectionsConfig & { data?: Record<string, TableDef> };
    root?: string;
    data?: Record<string, TableDef>;
    [key: string]: unknown;
  };
}

interface OpenedTable {
  db: Kysely<DynamicDatabase>;
  kind: SqlDialectKind;
  tables: Record<string, TableDef>;
  tableName: string;
}

/** Open the table's connection, auto-syncing local sqlite databases additively. */
async function openTable(config: TableNodeConfig): Promise<OpenedTable> {
  const project = config._project ?? {};
  const projectConfig = project.config ?? {};
  const tables = projectConfig.data ?? project.data ?? {};
  const tableName = config.table ?? "";
  const tableDef = tables[tableName];
  if (!tableDef) {
    throw new Error(`unknown table "${tableName}" (no data section entry)`);
  }
  const env: Record<string, unknown> = {
    ...process.env,
    ...(project.root === undefined ? {} : { JX_PROJECT_ROOT: project.root }),
  };
  const { dialect, type } = await resolveDialect(tableDef.connection, projectConfig, env);
  const db = new Kysely<DynamicDatabase>({ dialect });
  const connection = projectConfig.connections?.[tableDef.connection];
  if (connection?.provider === "sqlite") {
    // Additive-only and idempotent — a fresh local database materializes on first read.
    await syncTables(db, tablesForConnection(tables, tableDef.connection), { dialect: type });
  }
  return { db, kind: type, tableName, tables };
}

/**
 * Query a table with the def's filter/sort/limit/offset (the content grammar).
 *
 * @param {TableNodeConfig} config
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function queryTable(config: TableNodeConfig): Promise<Record<string, unknown>[]> {
  const { db, kind, tables, tableName } = await openTable(config);
  try {
    const plan = planTable(tableName, tables[tableName]!, tables, kind);
    let qb = db.selectFrom(tableName).selectAll();
    qb = applyFilter(qb, normalizeFilter(config.filter), plan.columns);
    qb = applySort(qb, normalizeSort(config.sort), plan.columns);
    if (typeof config.limit === "number" && config.limit > 0) {
      qb = qb.limit(config.limit);
    }
    if (typeof config.offset === "number" && config.offset > 0) {
      qb = qb.limit(config.limit ?? 100_000_000).offset(config.offset);
    }
    const rows = await qb.execute();
    return rows.map((row) => fromStorage(plan.columns, row));
  } finally {
    await db.destroy();
  }
}

/**
 * Fetch one row by id, or null.
 *
 * @param {TableNodeConfig} config
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getEntry(
  config: TableNodeConfig,
  id: string,
): Promise<Record<string, unknown> | null> {
  const { db, kind, tables, tableName } = await openTable(config);
  try {
    const plan = planTable(tableName, tables[tableName]!, tables, kind);
    const key = plan.idType === "integer" ? Number(id) : id;
    const row = await db.selectFrom(tableName).selectAll().where("id", "=", key).executeTakeFirst();
    return row ? fromStorage(plan.columns, row) : null;
  } finally {
    await db.destroy();
  }
}
