/**
 * Provider-utils — shared machinery behind the connector capability methods.
 *
 * Each provider (d1, supabase, sqlite) resolves a Kysely dialect its own way; deploySchema and
 * testConnection are then identical: open Kysely over the dialect, run the additive sync (or a
 * probe select), and always destroy the instance. Kept separate from connectors.ts so the provider
 * modules can share it without an import cycle.
 */

import { Kysely, sql } from "kysely";
import { syncTables } from "./ddl.ts";
import type { Dialect } from "kysely";
import type { SqlDialectKind } from "./columns.ts";
import type { DynamicDatabase } from "./query.ts";
import type { ConnectionDef, DeploySchemaResult, TableDef, TestConnectionResult } from "./types.ts";

/** The static capability surface of a connector provider implementation. */
export interface ConnectorProvider {
  kind: SqlDialectKind;
  dialect: (connection: ConnectionDef, env: Record<string, unknown>) => Dialect | Promise<Dialect>;
  deploySchema: (
    tables: Record<string, TableDef>,
    connection: ConnectionDef,
    options: { env: Record<string, unknown>; dryRun?: boolean },
  ) => Promise<DeploySchemaResult>;
  bindings: (connection: ConnectionDef) => Record<string, unknown>;
  testConnection: (
    connection: ConnectionDef,
    env: Record<string, unknown>,
  ) => Promise<TestConnectionResult>;
}

/**
 * Run the additive schema sync over a dialect, always destroying the Kysely instance.
 *
 * @param {Dialect} dialect
 * @param {SqlDialectKind} kind
 * @param {Record<string, TableDef>} tables
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<DeploySchemaResult>}
 */
export async function deployWithDialect(
  dialect: Dialect,
  kind: SqlDialectKind,
  tables: Record<string, TableDef>,
  options: { dryRun?: boolean } = {},
): Promise<DeploySchemaResult> {
  const db = new Kysely<DynamicDatabase>({ dialect });
  try {
    return await syncTables(db, tables, { dialect: kind, dryRun: options.dryRun ?? false });
  } finally {
    await db.destroy();
  }
}

/**
 * Probe a dialect with `select 1`.
 *
 * @param {Dialect} dialect
 * @returns {Promise<TestConnectionResult>}
 */
export async function testWithDialect(dialect: Dialect): Promise<TestConnectionResult> {
  const db = new Kysely<DynamicDatabase>({ dialect });
  try {
    await sql`select 1`.execute(db);
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  } finally {
    await db.destroy();
  }
}

/** The tables of one connection (a data section filtered by connection name). */
export function tablesForConnection(
  tables: Record<string, TableDef>,
  connectionName: string,
): Record<string, TableDef> {
  const out: Record<string, TableDef> = {};
  for (const [name, def] of Object.entries(tables)) {
    if (def.connection === connectionName) {
      out[name] = def;
    }
  }
  return out;
}
