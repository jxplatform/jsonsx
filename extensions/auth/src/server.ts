/**
 * Server — the Better Auth instance factory and migration planner (node/Bun/Workers only).
 *
 * `createJxAuth` resolves the auth database through the connector: a host-provided provider map
 * (`options.connectors`, carrying the dev server's `local: "sqlite"` stand-ins) when available,
 * else `resolveDialect` over the first-party providers — either way yielding Better Auth's
 * `database: { dialect, type }` Kysely config. `getAuthMigrations` compiles Better Auth's additive
 * system-table sync (verified against better-auth 1.6.23: `getMigrations` from
 * `better-auth/db/migration` returns { toBeCreated, toBeAdded, runMigrations, compileMigrations })
 * into push steps of kind "auth", composed by the host after the connector plan — the connector
 * never special-cases auth.
 */

import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { resolveDialect } from "@jxsuite/connector";
import {
  buildAuthOptions,
  resolveAuthConnectionName,
  resolveAuthSecret,
  toSessionInfo,
} from "./config.ts";
import type { Dialect } from "kysely";
import type { ConnectionDef, SessionInfo } from "@jxsuite/connector/types";
import type { AuthProjectConfig, AuthSection } from "./config.ts";

type Env = Record<string, unknown>;

/** The provider surface the auth extension needs (a slice of ConnectorProvider). */
export interface AuthConnectorProvider {
  kind: "sqlite" | "postgres";
  dialect: (connection: ConnectionDef, env: Env) => Dialect | Promise<Dialect>;
}

/** The Better Auth surface consumed here (structural — betterAuth() returns a far larger type). */
export interface JxAuthInstance {
  handler: (request: Request) => Promise<Response>;
  api: { getSession: (input: { headers: Headers }) => Promise<unknown> };
}

export interface CreateJxAuthOptions {
  /** Provider implementations keyed by `connector.provider` id (dev stand-ins applied by hosts). */
  connectors?: Record<string, AuthConnectorProvider> | undefined;
  /** Run Better Auth's additive migrations before serving (dev-server first-touch sync). */
  autoSync?: boolean | undefined;
}

/** Resolve the auth connection's Kysely dialect + type, preferring host-provided stand-ins. */
async function resolveAuthDatabase(
  section: AuthSection,
  projectConfig: AuthProjectConfig,
  env: Env,
  connectors?: Record<string, AuthConnectorProvider>,
): Promise<{ dialect: Dialect; type: "sqlite" | "postgres"; connection: string }> {
  const connection = resolveAuthConnectionName(section, projectConfig);
  const def = projectConfig.connections?.[connection];
  if (!def) {
    throw new Error(`Auth names unknown connection "${connection}" (no such connections entry)`);
  }
  const provider = connectors?.[def.provider];
  if (provider) {
    const dialect = await provider.dialect({ ...def, $name: connection } as ConnectionDef, env);
    return { connection, dialect, type: provider.kind };
  }
  const resolved = await resolveDialect(connection, projectConfig, env);
  return { connection, dialect: resolved.dialect, type: resolved.type };
}

/**
 * Create a Better Auth instance for a project's auth section.
 *
 * @param {AuthSection} section - The project.json `auth` section
 * @param {AuthProjectConfig} projectConfig - Project config (connections lookup)
 * @param {Env} env - Host environment (bindings + env vars; the secret lives here)
 * @param {CreateJxAuthOptions} [options]
 * @returns {Promise<JxAuthInstance>}
 */
export async function createJxAuth(
  section: AuthSection,
  projectConfig: AuthProjectConfig,
  env: Env,
  options: CreateJxAuthOptions = {},
): Promise<JxAuthInstance> {
  const secret = resolveAuthSecret(section, env);
  const { dialect, type } = await resolveAuthDatabase(
    section,
    projectConfig,
    env,
    options.connectors,
  );
  const authOptions = buildAuthOptions(section, env, {
    database: { dialect, type },
    secret,
  });
  if (options.autoSync) {
    const migrations = await getMigrations(authOptions as Parameters<typeof getMigrations>[0]);
    await migrations.runMigrations();
  }
  return betterAuth(authOptions as Parameters<typeof betterAuth>[0]) as JxAuthInstance;
}

/**
 * Resolve a request's session through Better Auth into the connector's SessionInfo shape.
 *
 * @param {JxAuthInstance} auth
 * @param {Request} request
 * @returns {Promise<SessionInfo | null>}
 */
export async function getSessionContext(
  auth: JxAuthInstance,
  request: Request,
): Promise<SessionInfo | null> {
  const data = await auth.api.getSession({ headers: request.headers });
  return toSessionInfo(data);
}

// ─── Migrations (push plan) ───────────────────────────────────────────────────

/** One push step of the auth migration plan (protocol DataPushStep shape, kind "auth"). */
export interface AuthPushStep {
  kind: "auth";
  table?: string;
  summary: string;
  sql: string;
  connection: string;
}

export interface AuthMigrationsResult {
  steps: AuthPushStep[];
  /** Execute the compiled migration (no-op when steps is empty). */
  apply: () => Promise<void>;
  /** The connection the auth tables live on. */
  connection: string;
}

/** Split a compiled migration blob into single SQL statements. */
export function splitSqlStatements(sqlBlob: string): string[] {
  return sqlBlob
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

/** Classify one auth DDL statement into a push step (kind "auth" throughout). */
export function classifyAuthStatement(statement: string, connection: string): AuthPushStep {
  const createTable = statement.match(/^create table "?([\w.]+)"?/i);
  if (createTable) {
    return {
      connection,
      kind: "auth",
      sql: statement,
      summary: `Create auth table "${createTable[1]!}"`,
      table: createTable[1]!,
    };
  }
  const addColumn = statement.match(/^alter table "?([\w.]+)"? add column "?([\w.]+)"?/i);
  if (addColumn) {
    return {
      connection,
      kind: "auth",
      sql: statement,
      summary: `Add auth column "${addColumn[2]!}" to "${addColumn[1]!}"`,
      table: addColumn[1]!,
    };
  }
  const index = statement.match(/^create (?:unique )?index "?([\w.]+)"? on "?([\w.]+)"?/i);
  if (index) {
    return {
      connection,
      kind: "auth",
      sql: statement,
      summary: `Create auth index "${index[1]!}" on "${index[2]!}"`,
      table: index[2]!,
    };
  }
  return { connection, kind: "auth", sql: statement, summary: statement };
}

/**
 * Compile Better Auth's additive system-table migration into push steps plus an apply function. The
 * secret is intentionally not required here — planning and pushing schemas must work before the
 * signing secret is provisioned.
 *
 * @param {AuthSection} section
 * @param {AuthProjectConfig} projectConfig
 * @param {Env} env
 * @param {object} [options]
 * @param {Record<string, AuthConnectorProvider>} [options.connectors] - Provider stand-ins
 * @returns {Promise<AuthMigrationsResult>}
 */
export async function getAuthMigrations(
  section: AuthSection,
  projectConfig: AuthProjectConfig,
  env: Env,
  options: { connectors?: Record<string, AuthConnectorProvider> | undefined } = {},
): Promise<AuthMigrationsResult> {
  const { dialect, type, connection } = await resolveAuthDatabase(
    section,
    projectConfig,
    env,
    options.connectors,
  );
  const authOptions = buildAuthOptions(section, env, { database: { dialect, type } });
  const migrations = await getMigrations(authOptions as Parameters<typeof getMigrations>[0]);
  const sqlBlob = await migrations.compileMigrations();
  const steps = splitSqlStatements(sqlBlob).map((statement) =>
    classifyAuthStatement(statement, connection),
  );
  return {
    apply: async () => {
      if (steps.length > 0) {
        await migrations.runMigrations();
      }
    },
    connection,
    steps,
  };
}
