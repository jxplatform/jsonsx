/**
 * Worker — the framework-free /_jx/data mount (specs/extensions.md §11).
 *
 * `Data.mount(options, ctx)` returns a plain fetch-style handler implementing the canonical wire
 * contract:
 *
 *     GET    /_jx/data/:table        ?filter=<json>&sort=<json>&limit=&offset=&include=
 *     GET    /_jx/data/:table/:id
 *     POST   /_jx/data/:table
 *     PATCH  /_jx/data/:table/:id
 *     DELETE /_jx/data/:table/:id
 *
 * Authorization is fail-closed: `public` rules pass without auth, `none` always denies, and every
 * other rule requires `ctx.auth` (the auth mount, order 10) — absent auth means 401. Grants may
 * carry `setColumns` (forced payload columns, e.g. the owner id) and `whereOwner` (row scoping) per
 * the connector types contract. Kysely instances are memoized per connection inside the mount
 * closure — one per isolate, since the generated worker mounts at module init. Runs on Workers,
 * Bun, and node: no framework, no node imports, no `new Function`.
 */

import { Kysely } from "kysely";
import { fromStorage, newRowId, planTable, toStorage } from "./columns.ts";
import { syncTables } from "./ddl.ts";
import { applyFilter, applySort, columnForField, normalizeFilter, normalizeSort } from "./query.ts";
import { tablesForConnection } from "./provider-utils.ts";
import { validateRow } from "./validate.ts";
import type { Dialect } from "kysely";
import type { ColumnSpec, SqlDialectKind, TablePlan } from "./columns.ts";
import type { DynamicDatabase } from "./query.ts";
import type {
  AuthorizeDecision,
  ConnectionDef,
  JxServerContext,
  PermissionAction,
  TableDef,
} from "./types.ts";
import { DEFAULT_PERMISSIONS } from "./types.ts";

/** The provider surface the data mount needs (a slice of ConnectorProvider). */
export interface DataMountProvider {
  kind: SqlDialectKind;
  dialect: (connection: ConnectionDef, env: Record<string, unknown>) => Dialect | Promise<Dialect>;
}

export interface DataMountOptions {
  /** Route subtree this mount owns. Defaults to "/_jx/data". */
  basePath?: string;
  /** Extension-contributed project sections (needs `data` and `connections`). */
  sections: {
    data?: Record<string, TableDef>;
    connections?: Record<string, ConnectionDef>;
    [key: string]: unknown;
  };
  /** Provider implementations keyed by `connector.provider` id. */
  connectors: Record<string, DataMountProvider>;
  /** Additively sync each connection's tables on first touch (dev server / local sqlite). */
  autoSync?: boolean;
}

/** Per-isolate mount state: memoized Kysely instances and first-touch sync promises. */
export interface DataMountState {
  dbs: Map<string, Promise<{ db: Kysely<DynamicDatabase>; kind: SqlDialectKind }>>;
}

/** Create fresh mount state (exported for hosts that dispatch without `Data.mount`). */
export function createDataMountState(): DataMountState {
  return { dbs: new Map() };
}

type Env = Record<string, unknown>;

/** JSON error response helper. */
function fail(status: number, error: string, issues?: unknown): Response {
  return Response.json({ error, ...(issues === undefined ? {} : { issues }) }, { status });
}

/**
 * Handle one /_jx/data request.
 *
 * @param {Request} request
 * @param {Env} env - Worker env (bindings + vars)
 * @param {DataMountOptions} options
 * @param {JxServerContext} ctx - Shared mount context (auth hooks live here)
 * @param {DataMountState} [state] - Memoized connections; omit for a throwaway state
 * @returns {Promise<Response>}
 */
export async function handleDataRequest(
  request: Request,
  env: Env,
  options: DataMountOptions,
  ctx: JxServerContext,
  state: DataMountState = createDataMountState(),
): Promise<Response> {
  const url = new URL(request.url);
  const basePath = options.basePath ?? "/_jx/data";
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    return fail(404, "Not found");
  }
  const segments = url.pathname.slice(basePath.length).split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > 2) {
    return fail(404, "Not found");
  }
  const [tableName, rawId] = segments as [string, string?];

  const tables = options.sections.data ?? {};
  const tableDef = tables[tableName];
  if (!tableDef) {
    return fail(404, `Unknown table "${tableName}"`);
  }

  const { method } = request;
  let action: PermissionAction;
  if (method === "GET") {
    action = "read";
  } else if (method === "POST" && rawId === undefined) {
    action = "insert";
  } else if (method === "PATCH" && rawId !== undefined) {
    action = "update";
  } else if (method === "DELETE" && rawId !== undefined) {
    action = "delete";
  } else {
    return fail(405, "Method not allowed");
  }

  const authorized = await authorize(request, env, ctx, tableName, tableDef, action);
  if (authorized instanceof Response) {
    return authorized;
  }
  const { decision } = authorized;

  let db: Kysely<DynamicDatabase>;
  let kind: SqlDialectKind;
  try {
    ({ db, kind } = await getDb(state, options, env, tableDef.connection));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(500, `Connection error: ${message}`);
  }

  const plan = planTable(tableName, tableDef, tables, kind);
  const id = rawId === undefined ? undefined : parseId(plan, rawId);
  if (rawId !== undefined && id === undefined) {
    return fail(404, "Not found");
  }

  try {
    switch (action) {
      case "read": {
        return id === undefined
          ? await listRows(db, plan, tables, kind, url, decision)
          : await getRow(db, plan, tables, kind, url, decision, id);
      }
      case "insert": {
        return await insertRow(db, plan, tableDef, kind, request, decision);
      }
      case "update": {
        return await updateRow(db, plan, tableDef, kind, request, decision, id!);
      }
      default: {
        return await deleteRow(db, plan, decision, id!);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(500, message);
  }
}

/** The mount + section-owner class for the `data` section. */
export const Data = {
  /** Static `mount` capability (specs/extensions.md §11): one shared handler per isolate. */
  mount(options: DataMountOptions, ctx: JxServerContext) {
    const state = createDataMountState();
    return (request: Request, env: Env): Promise<Response> =>
      handleDataRequest(request, env, options, ctx, state);
  },

  /** Static `projectData` capability: expose the table definitions as `_project.data`. */
  projectData(sectionValue: unknown): Record<string, TableDef> {
    const section = (sectionValue ?? {}) as Record<string, TableDef>;
    return { ...section };
  },
};

// ─── Authorization ────────────────────────────────────────────────────────────

/**
 * Resolve the rule for an action and evaluate it — fail-closed without `ctx.auth`.
 *
 * @returns {Promise<Response | { decision: AuthorizeDecision }>} An error response, or the grant
 */
async function authorize(
  request: Request,
  env: Env,
  ctx: JxServerContext,
  table: string,
  tableDef: TableDef,
  action: PermissionAction,
): Promise<Response | { decision: AuthorizeDecision }> {
  const rule = tableDef.permissions?.[action] ?? DEFAULT_PERMISSIONS[action];
  if (rule === "public") {
    return { decision: { allow: true } };
  }
  if (rule === "none") {
    return fail(403, `${action} is disabled for "${table}"`);
  }
  const { auth } = ctx;
  if (!auth) {
    // Fail-closed rule (specs/extensions.md §11): without an auth mount, only "public" passes.
    return fail(401, `${action} on "${table}" requires authentication (no auth mount configured)`);
  }
  const session = await auth.getSession(request, env);
  const decision = await auth.authorize(
    {
      action,
      rule,
      session,
      table,
      ...(tableDef.ownerField === undefined ? {} : { ownerField: tableDef.ownerField }),
    },
    env,
  );
  if (!decision.allow) {
    const status = decision.status ?? (session ? 403 : 401);
    return fail(status, decision.error ?? "Forbidden");
  }
  return { decision };
}

// ─── Connections ──────────────────────────────────────────────────────────────

/** Open (or reuse) the Kysely instance for a connection, syncing on first touch if configured. */
function getDb(
  state: DataMountState,
  options: DataMountOptions,
  env: Env,
  connectionName: string,
): Promise<{ db: Kysely<DynamicDatabase>; kind: SqlDialectKind }> {
  const memo = state.dbs.get(connectionName);
  if (memo) {
    return memo;
  }
  const open = (async () => {
    const connections = options.sections.connections ?? {};
    const connection = connections[connectionName];
    if (!connection) {
      throw new Error(`table names unknown connection "${connectionName}"`);
    }
    const provider = options.connectors[connection.provider];
    if (!provider) {
      throw new Error(`no connector provider "${connection.provider}" is available`);
    }
    const dialect = await provider.dialect({ ...connection, $name: connectionName }, env);
    const db = new Kysely<DynamicDatabase>({ dialect });
    if (options.autoSync) {
      const tables = tablesForConnection(options.sections.data ?? {}, connectionName);
      await syncTables(db, tables, { dialect: provider.kind });
    }
    return { db, kind: provider.kind };
  })();
  state.dbs.set(connectionName, open);
  open.catch(() => state.dbs.delete(connectionName));
  return open;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/** Parse a path id per the table's id strategy (integer ids must be integral). */
function parseId(plan: TablePlan, rawId: string): string | number | undefined {
  if (plan.idType === "integer") {
    const num = Number(rawId);
    return Number.isInteger(num) ? num : undefined;
  }
  return rawId;
}

/** Apply whereOwner to any builder with a `where(col, "=", value)` method. */
function applyOwner<T extends { where: (col: never, op: never, value: never) => T }>(
  qb: T,
  decision: AuthorizeDecision,
  specs: ColumnSpec[],
): T {
  const owner = decision.whereOwner;
  if (!owner) {
    return qb;
  }
  const column = columnForField(owner.field, specs);
  return qb.where(column as never, "=" as never, owner.value as never);
}

async function listRows(
  db: Kysely<DynamicDatabase>,
  plan: TablePlan,
  tables: Record<string, TableDef>,
  kind: SqlDialectKind,
  url: URL,
  decision: AuthorizeDecision,
): Promise<Response> {
  const params = url.searchParams;
  let filter: unknown = null;
  let sort: unknown = null;
  try {
    filter = parseJsonParam(params.get("filter"));
    sort = parseJsonParam(params.get("sort"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(400, message);
  }
  const limit = positiveInt(params.get("limit"));
  const offset = positiveInt(params.get("offset"));

  let qb = db.selectFrom(plan.table).selectAll();
  qb = applyOwner(qb, decision, plan.columns);
  qb = applyFilter(qb, normalizeFilter(filter), plan.columns);
  qb = applySort(qb, normalizeSort(sort), plan.columns);
  if (limit !== undefined) {
    qb = qb.limit(limit);
  } else if (offset !== undefined) {
    // SQL needs a LIMIT for OFFSET to apply; a page this size is effectively "no limit".
    qb = qb.limit(100_000_000);
  }
  if (offset !== undefined) {
    qb = qb.offset(offset);
  }

  const raw = await qb.execute();
  let rows = raw.map((row) => fromStorage(plan.columns, row));
  rows = await expandIncludes(db, plan, tables, kind, includeFields(params), rows);
  return Response.json(rows);
}

async function getRow(
  db: Kysely<DynamicDatabase>,
  plan: TablePlan,
  tables: Record<string, TableDef>,
  kind: SqlDialectKind,
  url: URL,
  decision: AuthorizeDecision,
  id: string | number,
): Promise<Response> {
  let qb = db.selectFrom(plan.table).selectAll().where("id", "=", id);
  qb = applyOwner(qb, decision, plan.columns);
  const raw = await qb.executeTakeFirst();
  if (!raw) {
    return fail(404, "Not found");
  }
  const rows = await expandIncludes(db, plan, tables, kind, includeFields(url.searchParams), [
    fromStorage(plan.columns, raw),
  ]);
  return Response.json(rows[0]);
}

async function insertRow(
  db: Kysely<DynamicDatabase>,
  plan: TablePlan,
  tableDef: TableDef,
  kind: SqlDialectKind,
  request: Request,
  decision: AuthorizeDecision,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (body === null) {
    return fail(400, "Body must be JSON");
  }
  const { valid, errors, value } = validateRow(tableDef, body);
  if (!valid) {
    return fail(400, "Validation failed", errors);
  }
  for (const [field, schema] of Object.entries(tableDef.schema.properties ?? {})) {
    if (value[field] === undefined && schema.default !== undefined) {
      value[field] = schema.default;
    }
  }
  Object.assign(value, decision.setColumns ?? {});

  const { row, junctionValues } = splitRow(plan, kind, value);
  if (plan.idType === "uuid") {
    row.id = newRowId("uuid");
  }
  if (plan.timestamps) {
    const now = new Date().toISOString();
    row.created_at = now;
    row.updated_at = now;
  }

  const inserted = await db.insertInto(plan.table).values(row).returningAll().executeTakeFirst();
  const stored = inserted ?? row;
  const rowId = stored.id as string | number;
  await writeJunctions(db, plan, rowId, junctionValues);

  const result = { ...fromStorage(plan.columns, stored), ...junctionValues };
  return Response.json(result, { status: 201 });
}

async function updateRow(
  db: Kysely<DynamicDatabase>,
  plan: TablePlan,
  tableDef: TableDef,
  kind: SqlDialectKind,
  request: Request,
  decision: AuthorizeDecision,
  id: string | number,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (body === null) {
    return fail(400, "Body must be JSON");
  }
  if (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) {
    return fail(400, "Empty patch");
  }
  const { valid, errors, value } = validateRow(tableDef, body, { partial: true });
  if (!valid) {
    return fail(400, "Validation failed", errors);
  }
  Object.assign(value, decision.setColumns ?? {});

  const { row, junctionValues } = splitRow(plan, kind, value);
  if (plan.timestamps) {
    row.updated_at = new Date().toISOString();
  }

  let stored: Record<string, unknown> | undefined;
  if (Object.keys(row).length > 0) {
    let uq = db.updateTable(plan.table).set(row).where("id", "=", id);
    uq = applyOwner(uq, decision, plan.columns);
    stored = await uq.returningAll().executeTakeFirst();
  } else {
    let sq = db.selectFrom(plan.table).selectAll().where("id", "=", id);
    sq = applyOwner(sq, decision, plan.columns);
    stored = await sq.executeTakeFirst();
  }
  if (!stored) {
    return fail(404, "Not found");
  }
  await writeJunctions(db, plan, id, junctionValues);

  const result = { ...fromStorage(plan.columns, stored), ...junctionValues };
  return Response.json(result);
}

async function deleteRow(
  db: Kysely<DynamicDatabase>,
  plan: TablePlan,
  decision: AuthorizeDecision,
  id: string | number,
): Promise<Response> {
  let dq = db.deleteFrom(plan.table).where("id", "=", id);
  dq = applyOwner(dq, decision, plan.columns);
  const result = await dq.executeTakeFirst();
  if ((result.numDeletedRows ?? 0n) === 0n) {
    return fail(404, "Not found");
  }
  // Junction rows referencing the deleted row are cleaned per junction table.
  for (const junction of plan.junctions) {
    await db.deleteFrom(junction.table).where(junction.sourceColumn, "=", id).execute();
  }
  return Response.json({ ok: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Split a validated payload into storage columns and junction (to-many table ref) values. */
function splitRow(
  plan: TablePlan,
  kind: SqlDialectKind,
  value: Record<string, unknown>,
): { row: Record<string, unknown>; junctionValues: Record<string, unknown> } {
  const row: Record<string, unknown> = {};
  const junctionValues: Record<string, unknown> = {};
  const junctionFields = new Set(plan.junctions.map((j) => j.field));
  for (const [field, raw] of Object.entries(value)) {
    if (junctionFields.has(field)) {
      junctionValues[field] = raw;
      continue;
    }
    const spec = plan.columns.find((c) => c.field === field);
    if (spec) {
      row[spec.column] = toStorage(spec, raw, kind);
    } else {
      // Grant-forced columns (setColumns) may target columns outside the schema.
      row[field] = raw;
    }
  }
  return { junctionValues, row };
}

/** Replace the junction rows for the given source row (delete + insert). */
async function writeJunctions(
  db: Kysely<DynamicDatabase>,
  plan: TablePlan,
  rowId: string | number,
  junctionValues: Record<string, unknown>,
): Promise<void> {
  for (const junction of plan.junctions) {
    const value = junctionValues[junction.field];
    if (value === undefined) {
      continue;
    }
    await db.deleteFrom(junction.table).where(junction.sourceColumn, "=", rowId).execute();
    const ids: unknown[] = Array.isArray(value) ? (value as unknown[]) : [];
    for (const targetId of ids) {
      await db
        .insertInto(junction.table)
        .values({ [junction.sourceColumn]: rowId, [junction.targetColumn]: targetId })
        .execute();
    }
  }
}

/** Expand `?include=` fields: to-one table refs and to-many junctions (content refs are skipped). */
async function expandIncludes(
  db: Kysely<DynamicDatabase>,
  plan: TablePlan,
  tables: Record<string, TableDef>,
  kind: SqlDialectKind,
  fields: string[],
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (fields.length === 0 || rows.length === 0) {
    return rows;
  }
  for (const field of fields) {
    const spec = plan.columns.find((c) => c.field === field && c.ref !== null && !c.manyRef);
    if (spec && spec.ref!.section === "data" && tables[spec.ref!.name]) {
      const targetDef = tables[spec.ref!.name]!;
      const targetPlan = planTable(spec.ref!.name, targetDef, tables, kind);
      const ids = [...new Set(rows.map((r) => r[spec.column]).filter((v) => v != null))];
      if (ids.length === 0) {
        continue;
      }
      const targets = await db
        .selectFrom(targetPlan.table)
        .selectAll()
        .where("id", "in", ids)
        .execute();
      const byId = new Map(
        targets.map((t) => [t.id as string | number, fromStorage(targetPlan.columns, t)]),
      );
      for (const row of rows) {
        const key = row[spec.column];
        row[field] = key == null ? null : (byId.get(key as string | number) ?? null);
      }
      continue;
    }

    const junction = plan.junctions.find((j) => j.field === field);
    if (junction && tables[junction.targetTable]) {
      const targetPlan = planTable(
        junction.targetTable,
        tables[junction.targetTable]!,
        tables,
        kind,
      );
      const rowIds = rows.map((r) => r.id).filter((v) => v != null);
      if (rowIds.length === 0) {
        continue;
      }
      const links = await db
        .selectFrom(junction.table)
        .selectAll()
        .where(junction.sourceColumn, "in", rowIds)
        .execute();
      const targetIds = [...new Set(links.map((l) => l[junction.targetColumn]))];
      const targets =
        targetIds.length > 0
          ? await db.selectFrom(targetPlan.table).selectAll().where("id", "in", targetIds).execute()
          : [];
      const byId = new Map(
        targets.map((t) => [t.id as string | number, fromStorage(targetPlan.columns, t)]),
      );
      for (const row of rows) {
        const mine = links.filter((l) => l[junction.sourceColumn] === row.id);
        row[field] = mine
          .map((l) => byId.get(l[junction.targetColumn] as string | number))
          .filter((t) => t !== undefined);
      }
    }
  }
  return rows;
}

/** Parse a JSON query param, throwing a wire-friendly error on malformed input. */
function parseJsonParam(raw: string | null): unknown {
  if (raw === null || raw === "") {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Malformed JSON query parameter: ${raw}`, { cause: error });
  }
}

/** Parse a non-negative integer query param. */
function positiveInt(raw: string | null): number | undefined {
  if (raw === null || raw === "") {
    return undefined;
  }
  const num = Number(raw);
  return Number.isInteger(num) && num >= 0 ? num : undefined;
}

/** Parse the `include` param into field names. */
function includeFields(params: URLSearchParams): string[] {
  const raw = params.get("include");
  return raw
    ? raw
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : [];
}
