/**
 * Data-service — thin PAL wrapper over the optional data-surface members
 * (dataConnections/dataConnectionTest/dataPush/dataRows/row CRUD/listSecrets/setSecrets).
 *
 * Every helper degrades cleanly when the platform omits the member family (older backends, cloud
 * without DB reach): list-shaped calls resolve null/empty, action-shaped calls resolve an error
 * result instead of throwing. Secret VALUES only ever flow INTO setSecrets — reads are names-only
 * (specs/extensions.md §13).
 */

import { getPlatform } from "../platform";
import type {
  DataConnectionsResponse,
  DataConnectionTestResult,
  DataPushResult,
  DataRowDelete,
  DataRowInsert,
  DataRowsQuery,
  DataRowsResult,
  DataRowUpdate,
  SecretsSetRequest,
  SecretsSetResponse,
  StudioPlatform,
} from "../types";

/** The registered platform, or null before registration (early boot, bare tests). */
function platformOrNull(): StudioPlatform | null {
  try {
    return getPlatform();
  } catch {
    return null;
  }
}

/** True when the platform serves the data grid (the family's gating member is dataRows). */
export function dataSurfaceAvailable(): boolean {
  return typeof platformOrNull()?.dataRows === "function";
}

/** True when the platform can store secret values (backs the "secret" form control). */
export function secretsAvailable(): boolean {
  return typeof platformOrNull()?.setSecrets === "function";
}

/** Connections with configured state and table names; null when the backend lacks the route. */
export async function fetchConnections(): Promise<DataConnectionsResponse | null> {
  const platform = platformOrNull();
  if (typeof platform?.dataConnections !== "function") {
    return null;
  }
  return platform.dataConnections();
}

/** Probe one connection; degrades to an error result instead of throwing. */
export async function testConnection(connection: string): Promise<DataConnectionTestResult> {
  const platform = platformOrNull();
  if (typeof platform?.dataConnectionTest !== "function") {
    return { error: "Connection tests are not supported by this backend", ok: false };
  }
  try {
    return await platform.dataConnectionTest(connection);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
}

/** Push table schemas (dryRun compiles the plan only); degrades to an error result. */
export async function pushSchema(opts?: {
  connection?: string;
  dryRun?: boolean;
}): Promise<DataPushResult> {
  const platform = platformOrNull();
  if (typeof platform?.dataPush !== "function") {
    return { applied: false, errors: ["Schema push is not supported by this backend"], plan: [] };
  }
  try {
    return await platform.dataPush(opts);
  } catch (error) {
    return {
      applied: false,
      errors: [error instanceof Error ? error.message : String(error)],
      plan: [],
    };
  }
}

/** A required data member, throwing a uniform degradation error when absent. */
function requireMember<K extends keyof StudioPlatform>(name: K): NonNullable<StudioPlatform[K]> {
  const platform = platformOrNull();
  const member = platform?.[name];
  if (member === undefined || member === null) {
    throw new Error(`The ${String(name)} surface is not supported by this backend`);
  }
  return member as NonNullable<StudioPlatform[K]>;
}

/** Page a table's rows (grid callers handle errors per load). */
export function fetchRows(query: DataRowsQuery): Promise<DataRowsResult> {
  return requireMember("dataRows")(query);
}

export function insertRow(req: DataRowInsert): Promise<{ row: Record<string, unknown> }> {
  return requireMember("dataInsertRow")(req);
}

export function updateRow(req: DataRowUpdate): Promise<{ row: Record<string, unknown> }> {
  return requireMember("dataUpdateRow")(req);
}

export function deleteRow(req: DataRowDelete): Promise<{ ok: boolean }> {
  return requireMember("dataDeleteRow")(req);
}

/** Configured secret env-var NAMES; null when the backend has no secrets surface. */
export async function listSecretNames(): Promise<string[] | null> {
  const platform = platformOrNull();
  if (typeof platform?.listSecrets !== "function") {
    return null;
  }
  return platform.listSecrets();
}

/** Write/remove secrets through the platform store (values flow in, names come back). */
export function saveSecrets(req: SecretsSetRequest): Promise<SecretsSetResponse> {
  return requireMember("setSecrets")(req);
}

/**
 * Derive the env-var NAME a secret-marked field stores its value under: CONSTANT_CASE of the entry
 * key (falling back to the section key) plus the field key minus its `Env` suffix — e.g. connection
 * "main" field "urlEnv" → "MAIN_URL"; section "auth" field "secretEnv" → "AUTH_SECRET". The NAME
 * goes into project.json; the VALUE goes to setSecrets.
 *
 * @param {string} sectionKey
 * @param {string | null} entryKey - The map-layout entry (connection) name, when any
 * @param {string} fieldKey
 * @returns {string}
 */
export function deriveSecretEnvName(
  sectionKey: string,
  entryKey: string | null,
  fieldKey: string,
): string {
  const constant = (raw: string) =>
    raw
      .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replaceAll(/[^A-Za-z0-9]+/g, "_")
      .replaceAll(/^_+|_+$/g, "")
      .toUpperCase();
  const parts = [entryKey ?? sectionKey, fieldKey.replace(/Env$/, "")]
    .map((part) => constant(part))
    .filter(Boolean);
  const name = parts.join("_") || "SECRET";
  return /^\d/.test(name) ? `JX_${name}` : name;
}
