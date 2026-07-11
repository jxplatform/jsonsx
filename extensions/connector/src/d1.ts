/**
 * D1 provider — Cloudflare D1 connections.
 *
 * Inside a deployed Worker the connection's `binding` names a real D1 binding on `env` and queries
 * go through kysely-d1. Everywhere else (deploy, tests, compiler-timing SSG bakes) the provider
 * falls back to the D1 HTTP API using `CLOUDFLARE_API_TOKEN` (+ `accountId` from the connection or
 * `CLOUDFLARE_ACCOUNT_ID`). Connection entries carry identifiers only; the token is always an env
 * value (specs/extensions.md §13).
 */

import { D1Dialect } from "kysely-d1";
import { createD1HttpDialect } from "./dialects/d1-http.ts";
import { deployWithDialect, testWithDialect } from "./provider-utils.ts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Dialect } from "kysely";
import type { ConnectorProvider } from "./provider-utils.ts";
import type { ConnectionDef } from "./types.ts";

/** Resolve a D1 dialect for a connection (binding first, HTTP API fallback). */
function d1Dialect(connection: ConnectionDef, env: Record<string, unknown>): Dialect {
  const { binding, databaseId, $name = "connection" } = connection;
  const bound = binding ? env[binding] : undefined;
  if (bound) {
    return new D1Dialect({ database: bound as D1Database });
  }
  const apiToken = env["CLOUDFLARE_API_TOKEN"];
  const accountId = connection.accountId ?? env["CLOUDFLARE_ACCOUNT_ID"];
  if (typeof apiToken === "string" && typeof accountId === "string" && databaseId) {
    return createD1HttpDialect({ accountId, apiToken, databaseId });
  }
  throw new Error(
    `D1 connection "${$name}" is unreachable: no "${binding ?? "<binding>"}" binding on env, ` +
      `and the HTTP API needs databaseId + CLOUDFLARE_API_TOKEN + accountId/CLOUDFLARE_ACCOUNT_ID`,
  );
}

export const D1 = {
  bindings: (connection: ConnectionDef) => ({
    d1_databases: [
      {
        binding: connection.binding ?? "DB",
        ...(connection.databaseId === undefined ? {} : { database_id: connection.databaseId }),
        database_name: connection.$name ?? connection.binding ?? "DB",
      },
    ],
  }),
  deploySchema: async (
    tables: Parameters<ConnectorProvider["deploySchema"]>[0],
    connection: ConnectionDef,
    options: { env: Record<string, unknown>; dryRun?: boolean },
  ) => {
    const dialect = d1Dialect(connection, options.env);
    return deployWithDialect(dialect, "sqlite", tables, { dryRun: options.dryRun ?? false });
  },
  dialect: d1Dialect,
  kind: "sqlite",
  testConnection: async (connection: ConnectionDef, env: Record<string, unknown>) => {
    try {
      return await testWithDialect(d1Dialect(connection, env));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), ok: false };
    }
  },
} satisfies ConnectorProvider;
