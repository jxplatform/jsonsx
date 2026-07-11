/**
 * DDL — additive-only schema sync via the Kysely schema builder and introspector.
 *
 * The sync creates missing tables (with id and timestamp columns), adds missing columns to existing
 * tables, materializes junction tables for table↔table to-many references (specs/relationships.md
 * §3), and creates missing indexes. It NEVER drops or retypes anything: type drift, columns unknown
 * to the schema, and orphaned junction tables are reported as warnings, not fixed. `dryRun`
 * compiles the exact statements without executing them — the shape behind `jx db push --dry-run`
 * and the deploySchema capability.
 */

import { sql } from "kysely";
import { idDataType, planTable } from "./columns.ts";
import type { ColumnDataType, CreateTableBuilder, Kysely } from "kysely";
import type { SqlDialectKind, TablePlan } from "./columns.ts";
import type { DynamicDatabase } from "./query.ts";
import type { DeploySchemaResult, TableDef } from "./types.ts";

export interface SyncOptions {
  dialect: SqlDialectKind;
  /** Compile statements without executing them. */
  dryRun?: boolean;
}

/** Columns every synced table owns besides the schema fields. */
const SYSTEM_COLUMNS = new Set(["id", "created_at", "updated_at"]);

interface Executable {
  compile: () => { sql: string };
  execute: () => Promise<unknown>;
}

/**
 * Synchronize the `data` section's tables into a database, additively.
 *
 * @param {Kysely<DynamicDatabase>} db - Kysely instance over the target connection
 * @param {Record<string, TableDef>} tables - Table definitions (the tables of one connection)
 * @param {SyncOptions} options
 * @returns {Promise<DeploySchemaResult>}
 */
export async function syncTables(
  db: Kysely<DynamicDatabase>,
  tables: Record<string, TableDef>,
  options: SyncOptions,
): Promise<DeploySchemaResult> {
  const { dialect, dryRun = false } = options;
  const statements: string[] = [];
  const warnings: string[] = [];

  const plans = Object.entries(tables).map(([name, def]) => planTable(name, def, tables, dialect));

  const introspected = await db.introspection.getTables({ withInternalKyselyTables: false });
  const existing = new Map(introspected.map((t) => [t.name, t]));
  const existingIndexes = await indexNames(db, dialect);

  const run = async (builder: Executable): Promise<void> => {
    statements.push(builder.compile().sql);
    if (!dryRun) {
      await builder.execute();
    }
  };

  const desiredNames = new Set<string>();
  for (const plan of plans) {
    desiredNames.add(plan.table);
    for (const junction of plan.junctions) {
      desiredNames.add(junction.table);
    }
  }

  for (const plan of plans) {
    const table = existing.get(plan.table);
    if (!table) {
      await run(buildCreateTable(db, plan, dialect));
    } else {
      const byName = new Map(table.columns.map((c) => [c.name, c]));
      for (const col of plan.columns) {
        const current = byName.get(col.column);
        if (!current) {
          await run(
            db.schema.alterTable(plan.table).addColumn(col.column, col.dataType as ColumnDataType),
          );
          continue;
        }
        if (current.dataType.toLowerCase() !== col.dataType.toLowerCase()) {
          warnings.push(
            `${plan.table}.${col.column}: type drift (database has "${current.dataType}", ` +
              `schema wants "${col.dataType}") — additive-only sync never retypes`,
          );
        }
      }
      if (plan.timestamps) {
        for (const stamp of ["created_at", "updated_at"]) {
          if (!byName.has(stamp)) {
            await run(db.schema.alterTable(plan.table).addColumn(stamp, "text"));
          }
        }
      }
      const declared = new Set(plan.columns.map((c) => c.column));
      for (const col of table.columns) {
        if (!declared.has(col.name) && !SYSTEM_COLUMNS.has(col.name)) {
          warnings.push(
            `${plan.table}.${col.name}: column exists in the database but not in the schema — ` +
              `never dropped`,
          );
        }
      }
    }

    for (const junction of plan.junctions) {
      if (!existing.has(junction.table)) {
        await run(
          db.schema
            .createTable(junction.table)
            .addColumn(junction.sourceColumn, junction.sourceIdType as ColumnDataType, (c) =>
              c.notNull(),
            )
            .addColumn(junction.targetColumn, junction.targetIdType as ColumnDataType, (c) =>
              c.notNull(),
            )
            .addPrimaryKeyConstraint(`${junction.table}_pk`, [
              junction.sourceColumn,
              junction.targetColumn,
            ]),
        );
      }
      const indexName = `${junction.table}_${junction.targetColumn}_idx`;
      if (!existingIndexes.has(indexName)) {
        await run(
          db.schema.createIndex(indexName).on(junction.table).columns([junction.targetColumn]),
        );
      }
    }

    for (const columns of plan.indexes) {
      const indexName = `${plan.table}_${columns.join("_")}_idx`;
      if (!existingIndexes.has(indexName)) {
        await run(db.schema.createIndex(indexName).on(plan.table).columns(columns));
      }
    }
  }

  // Orphaned junction tables (a renamed to-many field leaves its old junction behind).
  const knownTables = new Set(plans.map((p) => p.table));
  for (const name of existing.keys()) {
    if (desiredNames.has(name) || knownTables.has(name)) {
      continue;
    }
    const looksLikeJunction = [...knownTables].some((t) => name.startsWith(`${t}_`));
    if (looksLikeJunction) {
      warnings.push(
        `${name}: junction table no longer matches any to-many field — orphaned, never dropped`,
      );
    }
  }

  return { applied: !dryRun, statements, warnings };
}

/** Build the CREATE TABLE for a plan (id strategy, timestamps, schema columns). */
function buildCreateTable(
  db: Kysely<DynamicDatabase>,
  plan: TablePlan,
  dialect: SqlDialectKind,
): CreateTableBuilder<string, string> {
  let builder = db.schema.createTable(plan.table) as CreateTableBuilder<string, string>;
  const idType = idDataType(plan.idType) as ColumnDataType;
  builder =
    plan.idType === "integer"
      ? builder.addColumn("id", idType, (c) =>
          dialect === "postgres"
            ? c.primaryKey().generatedAlwaysAsIdentity()
            : c.primaryKey().autoIncrement(),
        )
      : builder.addColumn("id", idType, (c) => c.primaryKey().notNull());
  if (plan.timestamps) {
    builder = builder.addColumn("created_at", "text").addColumn("updated_at", "text");
  }
  for (const col of plan.columns) {
    builder = builder.addColumn(col.column, col.dataType as ColumnDataType);
  }
  return builder;
}

/** Names of existing indexes (dialect-specific catalog queries; Kysely has no index introspection). */
async function indexNames(
  db: Kysely<DynamicDatabase>,
  dialect: SqlDialectKind,
): Promise<Set<string>> {
  try {
    const query =
      dialect === "postgres"
        ? sql<{ name: string }>`select indexname as name from pg_indexes`
        : sql<{ name: string }>`select name from sqlite_master where type = 'index'`;
    const { rows } = await query.execute(db);
    return new Set(rows.map((r) => r.name));
  } catch {
    // No catalog access (exotic dialect): fall back to emitting CREATE INDEX unconditionally.
    return new Set();
  }
}
