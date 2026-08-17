/**
 * Data-api — the `/__studio/data/*` + `/__studio/secrets` owner console (specs/extensions.md §13).
 *
 * These routes are the project OWNER's admin surface over the connector extension's connections and
 * tables: row CRUD here intentionally bypasses table permission rules BY DESIGN — the boundary is
 * the backend's own gate (the dev server's loopback/token guard in front of `/__studio/*`; cloud
 * backends must gate on collaboration permission instead). Secret VALUES never leave the backend:
 * the secrets routes list env-var NAMES only and write `.dev.vars` (wrangler convention).
 *
 * The server is core and must never import `@jxsuite/connector` (dep-rules enforce this): every
 * connector capability (dialect, deploySchema, testConnection) dispatches through the project's
 * extension registry, reusing the dev server's `local: "<provider>"` stand-in rule from jx-mounts
 * (specs/extensions.md §12). Only the generic Kysely surface (row CRUD + introspection) runs here.
 *
 * Auth-task: auth extensions contribute additional push steps here — compose their migration steps
 * (kind "auth") after the connector plan inside {@link pushDataSchema}.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Kysely, sql } from "kysely";
import { buildProjectExtensionRegistry } from "@jxsuite/compiler/format-host";
import { errorMessage } from "@jxsuite/schema/parse";
import { loadDevVars, parseDevVars } from "./dev-vars.ts";
import { resolveConnectorStandins } from "./jx-mounts.ts";
import { writeFile } from "node:fs/promises";
import type { Dialect } from "kysely";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { FormatEntry } from "@jxsuite/schema/format-registry";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type {
  DataColumnMeta,
  DataConnectionInfo,
  DataConnectionsResponse,
  DataConnectionTestResult,
  DataPushRequest,
  DataPushResult,
  DataPushStep,
  DataRowDelete,
  DataRowInsert,
  DataRowsQuery,
  DataRowsResult,
  DataRowUpdate,
  SecretsListResponse,
  SecretsSetRequest,
  SecretsSetResponse,
} from "@jxsuite/protocol";
import { problem, problemTypeForStatus } from "./problem.ts";

// ─── Local section shapes (structural — the connector owns the full types) ───

/** One `connections` entry: identifiers and env-var names only, never secrets. */
interface ConnectionDef {
  provider?: string;
  [key: string]: unknown;
}

/** One `data` entry (the slice this console needs). */
interface TableDef {
  connection?: string;
  id?: string;
  timestamps?: boolean;
  schema?: { properties?: Record<string, unknown> };
}

interface ProjectSections {
  config: ProjectConfig;
  connections: Record<string, ConnectionDef>;
  tables: Record<string, TableDef>;
}

/** Loosely-typed Kysely database — dynamic tables are only known at runtime. */
type Db = Kysely<Record<string, Record<string, unknown>>>;

/** A route-mappable failure (`status` becomes the HTTP status). */
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The shape of the connector `deploySchema` capability result. */
interface DeployResult {
  statements: string[];
  applied: boolean;
  warnings: string[];
}

// ─── Project + registry resolution ───────────────────────────────────────────

/** Per-project registry cache, invalidated when project.json's mtime moves. */
const registryCache = new Map<string, { mtime: number; registry: Promise<ExtensionRegistry> }>();

/** Reset the registry cache (test hook). */
export function resetDataApi(): void {
  registryCache.clear();
}

/** Read the project's config + connector-owned sections; 404 when there is no project.json. */
function getProject(projectRoot: string): ProjectSections {
  const path = resolve(projectRoot, "project.json");
  let config: ProjectConfig;
  try {
    config = JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
  } catch (error) {
    throw new ApiError(404, `No project.json under "${projectRoot}"`, { cause: error });
  }
  // Section keys are the connector's host wire contract (the same literals jx-mounts passes to
  // The Data mount's options.sections) — JSON introspection, not a connector import.
  const cfg = config as Record<string, unknown>;
  const connections = (cfg.connections ?? {}) as Record<string, ConnectionDef>;
  const tables = (cfg.data ?? {}) as Record<string, TableDef>;
  return { config, connections, tables };
}

/** Build (or reuse) the project's extension registry, keyed on project.json's mtime. */
function getRegistry(projectRoot: string, config: ProjectConfig): Promise<ExtensionRegistry> {
  const projectJsonPath = resolve(projectRoot, "project.json");
  const mtime = statSync(projectJsonPath).mtimeMs;
  const cached = registryCache.get(projectRoot);
  if (cached && cached.mtime === mtime) {
    return cached.registry;
  }
  const registry = buildProjectExtensionRegistry(projectRoot, config);
  registryCache.set(projectRoot, { mtime, registry });
  return registry;
}

/** The mount environment: process.env merged under `.dev.vars` plus JX_PROJECT_ROOT. */
function buildEnv(projectRoot: string): Record<string, unknown> {
  return { ...process.env, ...loadDevVars(projectRoot), JX_PROJECT_ROOT: projectRoot };
}

/**
 * The registry entry serving a provider, after the dev `local: "<provider>"` stand-in rule
 * (specs/extensions.md §12) — identical to jx-mounts' resolution.
 */
function providerEntry(registry: ExtensionRegistry, provider: string): FormatEntry {
  const entries = registry.connectors();
  const entry = entries.find((e) => e.connector!.provider === provider);
  if (!entry) {
    throw new ApiError(400, `No connector provider "${provider}" is available`);
  }
  const { local } = entry.connector!;
  return typeof local === "string"
    ? (entries.find((e) => e.connector!.provider === local) ?? entry)
    : entry;
}

/** The connection def by name, 404 when undeclared. */
function connectionDef(project: ProjectSections, name: string): ConnectionDef {
  const def = project.connections[name];
  if (!def) {
    throw new ApiError(404, `Unknown connection "${name}"`);
  }
  return def;
}

/** Tables of one connection (the data section filtered by connection name). */
function tablesFor(project: ProjectSections, connection: string): Record<string, TableDef> {
  const out: Record<string, TableDef> = {};
  for (const [name, def] of Object.entries(project.tables)) {
    if (def.connection === connection) {
      out[name] = def;
    }
  }
  return out;
}

/**
 * The connection a rows request resolves against: the declared table's connection, else the
 * explicit `connection` parameter, else the first-declared connection (system tables live on it).
 */
function connectionForTable(project: ProjectSections, table: string, explicit?: string): string {
  const declared = project.tables[table]?.connection;
  const name = declared ?? explicit ?? Object.keys(project.connections)[0];
  if (!name) {
    throw new ApiError(400, "The project declares no connections");
  }
  connectionDef(project, name);
  return name;
}

/** Open a Kysely instance for a connection through the registry, run `fn`, always destroy. */
async function withDb<T>(
  projectRoot: string,
  project: ProjectSections,
  connectionName: string,
  fn: (db: Db, kind: string) => Promise<T>,
): Promise<T> {
  const def = connectionDef(project, connectionName);
  const registry = await getRegistry(projectRoot, project.config);
  const entry = providerEntry(registry, String(def.provider ?? ""));
  const env = buildEnv(projectRoot);
  const dialect = (await entry.call("dialect", { ...def, $name: connectionName }, env)) as Dialect;
  const db = new Kysely<Record<string, Record<string, unknown>>>({ dialect });
  try {
    return await fn(db, String(entry.connector!.kind ?? "sqlite"));
  } finally {
    await db.destroy();
  }
}

// ─── Introspection ────────────────────────────────────────────────────────────

/** Introspect one table's columns, with primary-key detection; 404 for unknown tables. */
async function tableColumns(db: Db, kind: string, table: string): Promise<DataColumnMeta[]> {
  const tables = await db.introspection.getTables({ withInternalKyselyTables: false });
  const meta = tables.find((t) => t.name === table);
  if (!meta) {
    throw new ApiError(404, `Unknown table "${table}"`);
  }
  const pks = await primaryKeys(db, kind, table);
  return meta.columns.map((c) => {
    const column: DataColumnMeta = { name: c.name, type: c.dataType };
    if (pks.has(c.name)) {
      column.pk = true;
    }
    if (c.isNullable) {
      column.nullable = true;
    }
    return column;
  });
}

/**
 * Primary-key column names. SQLite exposes them via `pragma_table_info`; every other dialect falls
 * back to the connector's convention (the synthesized `id` column — auth system tables use it
 * too).
 */
async function primaryKeys(db: Db, kind: string, table: string): Promise<Set<string>> {
  if (kind === "sqlite") {
    try {
      const { rows } = await sql<{ name: string }>`
        select name from pragma_table_info(${sql.lit(table)}) where pk > 0
      `.execute(db);
      if (rows.length > 0) {
        return new Set(rows.map((r) => r.name));
      }
    } catch {
      // No pragma access — fall through to the convention.
    }
  }
  return new Set(["id"]);
}

/** Light storage coercion for admin writes, keyed on the introspected column types. */
function coerceValues(
  values: Record<string, unknown>,
  columns: DataColumnMeta[],
): Record<string, unknown> {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const column = byName.get(key);
    if (!column) {
      throw new ApiError(400, `Unknown column "${key}"`);
    }
    const numeric = /int|real|double|numeric|decimal/i.test(column.type);
    if (typeof raw === "boolean" && numeric) {
      out[key] = raw ? 1 : 0;
    } else if (
      typeof raw === "string" &&
      numeric &&
      raw.trim() !== "" &&
      !Number.isNaN(Number(raw))
    ) {
      out[key] = Number(raw);
    } else if (raw !== null && typeof raw === "object") {
      out[key] = JSON.stringify(raw);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/** Normalize a wire pk value against the pk column's type (integer pks arrive as strings). */
function normalizePk(pk: string | number, columns: DataColumnMeta[]): string | number {
  const pkMeta = columns.find((c) => c.pk);
  if (typeof pk === "string" && pkMeta && /int/i.test(pkMeta.type) && /^\d+$/.test(pk)) {
    return Number(pk);
  }
  return pk;
}

/** The pk column name (introspected; "id" by convention when nothing is flagged). */
function pkColumn(columns: DataColumnMeta[]): string {
  return columns.find((c) => c.pk)?.name ?? "id";
}

// ─── Connections ──────────────────────────────────────────────────────────────

/** Env-var NAMES a connection references (keys ending in "Env") that resolve to no value. */
function missingSecretNames(def: ConnectionDef, env: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const [key, value] of Object.entries(def)) {
    if (key.endsWith("Env") && typeof value === "string" && value !== "" && env[value] == null) {
      missing.push(value);
    }
  }
  return missing;
}

/**
 * List the project's connections with configuration state, reachable table names, and provider
 * metadata from the registry descriptors. Introspection is best-effort: unreachable or
 * secret-missing connections report their declared tables only.
 *
 * @param {string} projectRoot
 * @returns {Promise<DataConnectionsResponse>}
 */
export async function listDataConnections(projectRoot: string): Promise<DataConnectionsResponse> {
  const project = getProject(projectRoot);
  const registry = await getRegistry(projectRoot, project.config);
  const entries = registry.connectors();
  const env = buildEnv(projectRoot);
  const names = Object.keys(project.connections);

  const connections: DataConnectionInfo[] = [];
  for (const [index, name] of names.entries()) {
    const def = project.connections[name]!;
    const provider = String(def.provider ?? "");
    const entry = entries.find((e) => e.connector!.provider === provider) ?? null;
    const missingSecrets = missingSecretNames(def, env);
    let tables = Object.keys(tablesFor(project, name));

    if (entry && missingSecrets.length === 0) {
      try {
        const discovered = await withDb(projectRoot, project, name, async (db) => {
          const list = await db.introspection.getTables({ withInternalKyselyTables: false });
          return list.map((t) => t.name);
        });
        tables = [...new Set([...tables, ...discovered])];
      } catch {
        // Unreachable connection: fall back to the declared tables.
      }
    }

    connections.push({
      configured: missingSecrets.length === 0,
      connector: entry
        ? {
            provider,
            ...(entry.connector!.kind == null ? {} : { kind: String(entry.connector!.kind) }),
            ...(entry.connector!.local == null ? {} : { local: String(entry.connector!.local) }),
            ...(typeof entry.classDef.description === "string"
              ? { description: entry.classDef.description }
              : {}),
          }
        : null,
      isDefault: index === 0,
      missingSecrets,
      name,
      provider,
      settings: { ...def },
      tables,
    });
  }
  return { connections };
}

/**
 * Probe a connection through the registry's testConnection capability (stand-in applied).
 *
 * @param {string} projectRoot
 * @param {string} connection - Connection name from the `connections` section
 * @returns {Promise<DataConnectionTestResult>}
 */
export async function testDataConnection(
  projectRoot: string,
  connection: string,
): Promise<DataConnectionTestResult> {
  const project = getProject(projectRoot);
  const def = connectionDef(project, connection);
  const registry = await getRegistry(projectRoot, project.config);
  const entry = providerEntry(registry, String(def.provider ?? ""));
  const env = buildEnv(projectRoot);
  const result = (await entry.call(
    "testConnection",
    { ...def, $name: connection },
    env,
  )) as DataConnectionTestResult;
  return { ok: result.ok === true, ...(result.error === undefined ? {} : { error: result.error }) };
}

// ─── Push ─────────────────────────────────────────────────────────────────────

/** Classify one compiled DDL statement into a push-plan step. */
export function classifyStatement(
  statement: string,
  declaredTables: Set<string>,
  connection: string,
): DataPushStep {
  const createTable = statement.match(/^create table "?([\w.]+)"?/i);
  if (createTable) {
    const table = createTable[1]!;
    const junction = !declaredTables.has(table);
    return {
      connection,
      kind: junction ? "junction" : "createTable",
      sql: statement,
      summary: junction ? `Create junction table "${table}"` : `Create table "${table}"`,
      table,
    };
  }
  const addColumn = statement.match(/^alter table "?([\w.]+)"? add column "?([\w.]+)"?/i);
  if (addColumn) {
    return {
      connection,
      kind: "addColumn",
      sql: statement,
      summary: `Add column "${addColumn[2]!}" to "${addColumn[1]!}"`,
      table: addColumn[1]!,
    };
  }
  const index = statement.match(/^create index "?([\w.]+)"? on "?([\w.]+)"?/i);
  if (index) {
    return {
      connection,
      kind: "index",
      sql: statement,
      summary: `Create index "${index[1]!}" on "${index[2]!}"`,
      table: index[2]!,
    };
  }
  return { connection, kind: "statement", sql: statement, summary: statement };
}

/**
 * Push the project's table schemas through the registry's deploySchema capability — additive-only,
 * with `dryRun` compiling the plan without executing it.
 *
 * @param {string} projectRoot
 * @param {DataPushRequest} request
 * @returns {Promise<DataPushResult>}
 */
export async function pushDataSchema(
  projectRoot: string,
  request: DataPushRequest = {},
): Promise<DataPushResult> {
  const project = getProject(projectRoot);
  const dryRun = request.dryRun === true;
  if (request.connection !== undefined) {
    connectionDef(project, request.connection);
  }
  const targets = request.connection ? [request.connection] : Object.keys(project.connections);
  const registry = await getRegistry(projectRoot, project.config);
  const env = buildEnv(projectRoot);
  const declared = new Set(Object.keys(project.tables));

  const plan: DataPushStep[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const name of targets) {
    const def = project.connections[name]!;
    try {
      const entry = providerEntry(registry, String(def.provider ?? ""));
      const result = (await entry.call(
        "deploySchema",
        tablesFor(project, name),
        {
          ...def,
          $name: name,
        },
        { dryRun, env },
      )) as DeployResult;
      plan.push(...result.statements.map((s) => classifyStatement(s, declared, name)));
      warnings.push(...result.warnings);
    } catch (error) {
      errors.push(`${name}: ${errorMessage(error)}`);
    }
  }

  // Section-owner push steps: any non-connector project contribution declaring a deploySchema
  // Capability composes its own migration steps after the connector plan (the auth extension's
  // Land as kind "auth" — its section key). The host stays extension-agnostic: registry dispatch
  // Only, no auth import, no "auth" literal, and the same connector stand-ins the mounts see.
  const sectionOwners = registry
    .projectContributions()
    .filter((entry) => entry.connector === null && entry.capabilities.deploySchema);
  if (sectionOwners.length > 0) {
    const connectors = await resolveConnectorStandins(registry);
    for (const entry of sectionOwners) {
      const { key } = entry.project!;
      const section = (project.config as Record<string, unknown>)[key];
      if (section === undefined || section === null) {
        continue;
      }
      try {
        const result = (await entry.call("deploySchema", section, project.config, {
          ...(request.connection === undefined ? {} : { connection: request.connection }),
          connectors,
          dryRun,
          env,
        })) as { steps?: DataPushStep[]; warnings?: string[] };
        for (const step of result.steps ?? []) {
          step.kind ||= key;
          plan.push(step);
        }
        warnings.push(...(result.warnings ?? []));
      } catch (error) {
        errors.push(`${key}: ${errorMessage(error)}`);
      }
    }
  }

  return {
    applied: !dryRun && errors.length === 0,
    plan,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// ─── Rows (admin CRUD — intentionally permission-free, see the module header) ─

/**
 * Page a table's rows with column metadata and a total count.
 *
 * @param {string} projectRoot
 * @param {DataRowsQuery} query
 * @returns {Promise<DataRowsResult>}
 */
export async function queryDataRows(
  projectRoot: string,
  query: DataRowsQuery,
): Promise<DataRowsResult> {
  const project = getProject(projectRoot);
  const connection = connectionForTable(project, query.table, query.connection);
  return withDb(projectRoot, project, connection, async (db, kind) => {
    const columns = await tableColumns(db, kind, query.table);
    const names = new Set(columns.map((c) => c.name));
    if (query.orderBy !== undefined && !names.has(query.orderBy)) {
      throw new ApiError(400, `Unknown orderBy column "${query.orderBy}"`);
    }
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 500);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);

    const { rows: counted } = await sql<{ c: number | bigint }>`
      select count(*) as c from ${sql.table(query.table)}
    `.execute(db);
    const total = Number(counted[0]?.c ?? 0);

    let qb = db.selectFrom(query.table).selectAll().limit(limit).offset(offset);
    if (query.orderBy !== undefined) {
      qb = qb.orderBy(query.orderBy, query.dir === "desc" ? "desc" : "asc");
    }
    const rows = (await qb.execute()) as Record<string, unknown>[];
    return { columns, rows, total };
  });
}

/**
 * Insert a row. For DECLARED tables the console applies the connector's storage conveniences — a
 * generated uuid id and created_at/updated_at timestamps; undeclared (system) tables get the
 * payload verbatim.
 *
 * @param {string} projectRoot
 * @param {DataRowInsert} request
 * @returns {Promise<{ row: Record<string, unknown> }>}
 */
export async function insertDataRow(
  projectRoot: string,
  request: DataRowInsert,
): Promise<{ row: Record<string, unknown> }> {
  const project = getProject(projectRoot);
  const connection = connectionForTable(project, request.table, request.connection);
  const declared = project.tables[request.table];
  return withDb(projectRoot, project, connection, async (db, kind) => {
    const columns = await tableColumns(db, kind, request.table);
    const row = coerceValues(request.values ?? {}, columns);
    const names = new Set(columns.map((c) => c.name));
    if (declared) {
      if ((declared.id ?? "uuid") === "uuid" && row.id == null) {
        row.id = crypto.randomUUID();
      }
      if (declared.timestamps !== false) {
        const now = new Date().toISOString();
        if (names.has("created_at") && row.created_at == null) {
          row.created_at = now;
        }
        if (names.has("updated_at") && row.updated_at == null) {
          row.updated_at = now;
        }
      }
    }
    const inserted = await db
      .insertInto(request.table)
      .values(row)
      .returningAll()
      .executeTakeFirst();
    return { row: (inserted ?? row) as Record<string, unknown> };
  });
}

/**
 * Update a row keyed on its introspected primary key.
 *
 * @param {string} projectRoot
 * @param {DataRowUpdate} request
 * @returns {Promise<{ row: Record<string, unknown> }>}
 */
export async function updateDataRow(
  projectRoot: string,
  request: DataRowUpdate,
): Promise<{ row: Record<string, unknown> }> {
  const project = getProject(projectRoot);
  const connection = connectionForTable(project, request.table, request.connection);
  const declared = project.tables[request.table];
  return withDb(projectRoot, project, connection, async (db, kind) => {
    const columns = await tableColumns(db, kind, request.table);
    const set = coerceValues(request.set ?? {}, columns);
    if (Object.keys(set).length === 0) {
      throw new ApiError(400, "Empty update");
    }
    const names = new Set(columns.map((c) => c.name));
    if (declared && declared.timestamps !== false && names.has("updated_at")) {
      set.updated_at ??= new Date().toISOString();
    }
    const updated = await db
      .updateTable(request.table)
      .set(set)
      .where(pkColumn(columns), "=", normalizePk(request.pk, columns))
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      throw new ApiError(404, "Not found");
    }
    return { row: updated as Record<string, unknown> };
  });
}

/**
 * Delete a row keyed on its introspected primary key.
 *
 * @param {string} projectRoot
 * @param {DataRowDelete} request
 * @returns {Promise<{ ok: true }>}
 */
export async function deleteDataRow(
  projectRoot: string,
  request: DataRowDelete,
): Promise<{ ok: true }> {
  const project = getProject(projectRoot);
  const connection = connectionForTable(project, request.table, request.connection);
  return withDb(projectRoot, project, connection, async (db, kind) => {
    const columns = await tableColumns(db, kind, request.table);
    const result = await db
      .deleteFrom(request.table)
      .where(pkColumn(columns), "=", normalizePk(request.pk, columns))
      .executeTakeFirst();
    if ((result.numDeletedRows ?? 0n) === 0n) {
      throw new ApiError(404, "Not found");
    }
    return { ok: true };
  });
}

// ─── Secrets (.dev.vars; names only on the way out) ──────────────────────────

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The configured secret env-var NAMES — never values.
 *
 * @param {string} projectRoot
 * @returns {Promise<SecretsListResponse>}
 */
export async function listSecretNames(projectRoot: string): Promise<SecretsListResponse> {
  getProject(projectRoot);
  return { names: Object.keys(loadDevVars(projectRoot)) };
}

/** A line's KEY when it is a `KEY=value` assignment; null for comments/blank/malformed lines. */
function assignmentKey(rawLine: string): string | null {
  const line = rawLine.trim();
  if (line === "" || line.startsWith("#")) {
    return null;
  }
  const eq = line.indexOf("=");
  if (eq === -1) {
    return null;
  }
  return line.slice(0, eq).trim() || null;
}

/**
 * Write/remove secrets in `<project>/.dev.vars`, preserving comments and line order: existing
 * assignments are replaced in place, removed keys drop their line, and new keys append.
 *
 * @param {string} projectRoot
 * @param {SecretsSetRequest} request
 * @returns {Promise<SecretsSetResponse>}
 */
export async function setProjectSecrets(
  projectRoot: string,
  request: SecretsSetRequest,
): Promise<SecretsSetResponse> {
  getProject(projectRoot);
  const set = request.set ?? {};
  const remove = new Set(request.remove);
  for (const [name, value] of Object.entries(set)) {
    if (!SECRET_NAME.test(name)) {
      throw new ApiError(400, `Invalid secret name "${name}"`);
    }
    if (typeof value !== "string" || value.includes("\n")) {
      throw new ApiError(400, `Secret "${name}" must be a single-line string`);
    }
  }
  for (const name of remove) {
    if (!SECRET_NAME.test(name)) {
      throw new ApiError(400, `Invalid secret name "${name}"`);
    }
  }

  const path = resolve(projectRoot, ".dev.vars");
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const pending = new Map(Object.entries(set));
  const out: string[] = [];
  for (const line of original.split("\n")) {
    const key = assignmentKey(line);
    if (key !== null && remove.has(key)) {
      continue;
    }
    if (key !== null && pending.has(key)) {
      out.push(`${key}=${pending.get(key)!}`);
      pending.delete(key);
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out.at(-1) === "") {
    out.pop();
  }
  for (const [name, value] of pending) {
    out.push(`${name}=${value}`);
  }
  const text = out.length > 0 ? `${out.join("\n")}\n` : "";
  await writeFile(path, text, "utf8");
  return { names: Object.keys(parseDevVars(text)), ok: true };
}

// ─── HTTP surface ─────────────────────────────────────────────────────────────

/** Resolve the target project root from the `dir` param with the studio-api containment rule. */
function resolveProjectRoot(url: URL, root: string, activeProjectRoot: string | null): string {
  const dir = url.searchParams.get("dir") || activeProjectRoot || root;
  const abs = isAbsolute(dir) ? dir : resolve(root, dir);
  const contained = (base: string) => {
    const rel = relative(base, abs);
    return !rel.startsWith("..") && !rel.startsWith("/");
  };
  if (contained(root) || (activeProjectRoot !== null && contained(activeProjectRoot))) {
    return abs;
  }
  throw new ApiError(400, "Path outside project root");
}

/** Parse a JSON request body, 400 on malformed input. */
async function jsonBody<T>(req: Request): Promise<T> {
  const body = (await req.json().catch(() => null)) as T | null;
  if (body === null || typeof body !== "object") {
    throw new ApiError(400, "Body must be JSON");
  }
  return body;
}

/** A required string param, 400 when missing. */
function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new ApiError(400, `Missing ${name} param`);
  }
  return value;
}

/** An optional integer query param. */
function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") {
    return undefined;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Handle a `/__studio/data/*` or `/__studio/secrets` request; null when the path is neither.
 *
 * @param {Request} req
 * @param {URL} url
 * @param {string} root - Server root
 * @param {string | null} [activeProjectRoot] - The activated studio project, when any
 * @returns {Promise<Response | null>}
 */
export async function handleDataApi(
  req: Request,
  url: URL,
  root: string,
  activeProjectRoot: string | null = null,
): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/__studio/data/") && path !== "/__studio/secrets") {
    return null;
  }
  try {
    const projectRoot = resolveProjectRoot(url, root, activeProjectRoot);
    const route = `${req.method} ${path}`;
    switch (route) {
      case "GET /__studio/data/connections": {
        return Response.json(await listDataConnections(projectRoot));
      }
      case "POST /__studio/data/connections/test": {
        const body = await jsonBody<{ connection?: string }>(req);
        if (!body.connection) {
          throw new ApiError(400, "Missing connection");
        }
        return Response.json(await testDataConnection(projectRoot, body.connection));
      }
      case "POST /__studio/data/push": {
        const body = await jsonBody<DataPushRequest>(req);
        return Response.json(await pushDataSchema(projectRoot, body));
      }
      case "GET /__studio/data/rows": {
        const query: DataRowsQuery = {
          table: requiredParam(url, "table"),
          ...(url.searchParams.get("connection")
            ? { connection: url.searchParams.get("connection")! }
            : {}),
          ...(intParam(url, "limit") === undefined ? {} : { limit: intParam(url, "limit")! }),
          ...(intParam(url, "offset") === undefined ? {} : { offset: intParam(url, "offset")! }),
          ...(url.searchParams.get("orderBy") ? { orderBy: url.searchParams.get("orderBy")! } : {}),
          ...(url.searchParams.get("dir") === "desc" ? { dir: "desc" as const } : {}),
        };
        return Response.json(await queryDataRows(projectRoot, query));
      }
      case "POST /__studio/data/rows": {
        const body = await jsonBody<DataRowInsert>(req);
        return Response.json(await insertDataRow(projectRoot, body), { status: 201 });
      }
      case "PUT /__studio/data/rows": {
        const body = await jsonBody<DataRowUpdate>(req);
        return Response.json(await updateDataRow(projectRoot, body));
      }
      case "DELETE /__studio/data/rows": {
        return Response.json(
          await deleteDataRow(projectRoot, {
            pk: requiredParam(url, "pk"),
            table: requiredParam(url, "table"),
            ...(url.searchParams.get("connection")
              ? { connection: url.searchParams.get("connection")! }
              : {}),
          }),
        );
      }
      case "GET /__studio/secrets": {
        return Response.json(await listSecretNames(projectRoot));
      }
      case "PUT /__studio/secrets": {
        const body = await jsonBody<SecretsSetRequest>(req);
        return Response.json(await setProjectSecrets(projectRoot, body));
      }
      default: {
        throw new ApiError(405, "Method not allowed");
      }
    }
  } catch (error) {
    /*
     * The one place a status is computed rather than named, so the TYPE is derived from it here
     * instead of at each throw. `ApiError` predates the registry and carries only a status; mapping
     * it once keeps the alternative — a `ProblemTypeName` threaded through every throw site — out
     * of a file whose failures are all shapes of "the request was wrong".
     */
    const status = error instanceof ApiError ? error.status : 500;
    return problem(problemTypeForStatus(status), errorMessage(error));
  }
}
