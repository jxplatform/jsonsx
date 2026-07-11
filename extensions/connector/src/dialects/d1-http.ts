/**
 * D1-http dialect — Kysely over Cloudflare's D1 HTTP API.
 *
 * Used where no D1 binding exists: `jx db push` from a developer machine, connection tests, and
 * compiler-timing SSG bakes. Every query POSTs to the accounts/{account}/d1/database/{database}
 * /query endpoint with a `CLOUDFLARE_API_TOKEN` bearer. Inside deployed Workers the kysely-d1
 * binding dialect is used instead (see d1.ts).
 */

import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";
import type { CompiledQuery, DatabaseConnection, Dialect, Driver, QueryResult } from "kysely";

export interface D1HttpDialectConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
  /** Injected fetch (tests); defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** API origin override; defaults to https://api.cloudflare.com. */
  baseUrl?: string;
}

interface D1HttpResponse {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: {
    success?: boolean;
    results?: Record<string, unknown>[];
    meta?: { changes?: number; last_row_id?: number };
  }[];
}

/**
 * Create the Kysely dialect over the D1 HTTP API.
 *
 * @param {D1HttpDialectConfig} config
 * @returns {Dialect}
 */
export function createD1HttpDialect(config: D1HttpDialectConfig): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => createDriver(config),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}

/** Execute one SQL statement against the HTTP endpoint. */
async function executeHttp<R>(
  config: D1HttpDialectConfig,
  sql: string,
  parameters: readonly unknown[],
): Promise<QueryResult<R>> {
  const { accountId, databaseId, apiToken, baseUrl = "https://api.cloudflare.com" } = config;
  const doFetch = config.fetch ?? globalThis.fetch;
  const url = `${baseUrl}/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const response = await doFetch(url, {
    body: JSON.stringify({ params: parameters, sql }),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as D1HttpResponse | null;
  if (!response.ok || !body?.success) {
    const detail =
      body?.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join("; ") || `HTTP ${response.status}`;
    throw new Error(`D1 HTTP API error: ${detail}`);
  }
  const [result] = body.result ?? [];
  const meta = result?.meta ?? {};
  return {
    ...(meta.last_row_id === undefined ? {} : { insertId: BigInt(meta.last_row_id) }),
    ...(meta.changes === undefined ? {} : { numAffectedRows: BigInt(meta.changes) }),
    rows: (result?.results ?? []) as R[],
  };
}

/** Build the stateless HTTP driver. */
function createDriver(config: D1HttpDialectConfig): Driver {
  const connection: DatabaseConnection = {
    executeQuery: <R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> =>
      executeHttp<R>(config, compiledQuery.sql, compiledQuery.parameters),
    streamQuery: () => {
      throw new Error("D1HttpDialect does not support streaming");
    },
  };
  return {
    acquireConnection: async () => connection,
    beginTransaction: async () => {
      // The HTTP API is per-statement; transactions are not supported.
    },
    commitTransaction: async () => {
      // See beginTransaction.
    },
    destroy: async () => {
      // Stateless — nothing to close.
    },
    init: async () => {
      // Stateless — nothing to open.
    },
    releaseConnection: async () => {
      // Stateless — nothing to release.
    },
    rollbackTransaction: async () => {
      throw new Error("D1HttpDialect cannot roll back (no transaction support)");
    },
  };
}
