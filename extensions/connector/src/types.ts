/**
 * Connector contract types (specs/extensions.md §11–§12, plan Part 4a).
 *
 * These are the shapes the connector publishes for its dependents: the auth extension implements
 * `JxAuthHooks` against `AuthorizeInput`/`AuthorizeDecision`, server hosts share one
 * `JxServerContext` across ordered mounts, and every module in this package speaks the table /
 * connection definitions declared in project.json's `data` and `connections` sections.
 */

// ─── Field / table schema ─────────────────────────────────────────────────────

/**
 * A column field schema — the JSON-Schema subset published as the core field union
 * (`JxFieldSchema`) plus the relationship-ref form (`{ $ref: "#/<section>/<name>" }`,
 * specs/relationships.md §1). Plain JxFieldSchema + RelationshipRef cover columns v1; the connector
 * ships no field-union extras.
 */
export interface ColumnFieldSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  /** Relationship reference: "#/<sectionKey>/<entryName>". */
  $ref?: string;
  items?: ColumnFieldSchema;
  properties?: Record<string, ColumnFieldSchema>;
  required?: string[];
  enum?: unknown[];
  format?: string;
  default?: unknown;
  description?: string;
}

/** The `schema` block of a table definition. */
export interface TableSchema {
  type?: "object";
  properties?: Record<string, ColumnFieldSchema>;
  required?: string[];
}

/** One entry of the project.json `data` section. */
export interface TableDef {
  connection: string;
  schema: TableSchema;
  id?: "uuid" | "integer";
  timestamps?: boolean;
  indexes?: (string | string[])[];
  permissions?: TablePermissions;
  ownerField?: string;
}

/** One entry of the project.json `connections` section (identifiers only — never secrets). */
export interface ConnectionDef {
  provider: string;
  binding?: string;
  databaseId?: string;
  accountId?: string;
  urlEnv?: string;
  hyperdriveId?: string;
  file?: string;
  /** Connection name, injected by hosts when passing the def to connector capabilities. */
  $name?: string;
  [key: string]: unknown;
}

// ─── Permissions ──────────────────────────────────────────────────────────────

export type PermissionAction = "read" | "insert" | "update" | "delete";

/** Access rule: `role:<r>` grants the named role (evaluated by the auth extension). */
export type PermissionRule = "public" | "none" | "authenticated" | "owner" | `role:${string}`;

export type TablePermissions = Partial<Record<PermissionAction, PermissionRule>>;

/** Default rules when a table declares none: reads are public, writes are closed. */
export const DEFAULT_PERMISSIONS: Record<PermissionAction, PermissionRule> = {
  delete: "none",
  insert: "none",
  read: "public",
  update: "none",
};

// ─── Auth contract (implemented by @jxsuite/auth in Part 4b) ─────────────────

/** The session shape auth hooks resolve from a request. */
export interface SessionInfo {
  userId: string;
  role?: string;
  /** Full user record, when the auth provider exposes one. */
  user?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AuthorizeInput {
  table: string;
  action: PermissionAction;
  rule: PermissionRule;
  session: SessionInfo | null;
  ownerField?: string;
}

export interface AuthorizeDecision {
  allow: boolean;
  /** HTTP status for a denial (401 unauthenticated, 403 forbidden). */
  status?: number;
  error?: string;
  /** Columns forced onto insert/update payloads (e.g. the owner id). */
  setColumns?: Record<string, unknown>;
  /** Row filter scoping reads/writes to the owner: `WHERE <field> = <value>`. */
  whereOwner?: { field: string; value: unknown } | null;
}

/** The hooks an auth mount publishes on the shared server context. */
export interface JxAuthHooks {
  getSession: (request: Request, env: Record<string, unknown>) => Promise<SessionInfo | null>;
  authorize: (input: AuthorizeInput, env: Record<string, unknown>) => Promise<AuthorizeDecision>;
}

/**
 * One shared mutable context per worker isolate, passed to every mount in `server.order`
 * (specs/extensions.md §11). The auth mount (order 10) sets `auth`; the data mount (order 20)
 * consumes it and fails closed when it is absent.
 */
export interface JxServerContext {
  auth?: JxAuthHooks;
  [key: string]: unknown;
}

// ─── Deploy / dialect capability results ─────────────────────────────────────

/** Result shape of the `deploySchema` connector capability. */
export interface DeploySchemaResult {
  statements: string[];
  applied: boolean;
  warnings: string[];
}

/** Result shape of the `testConnection` connector capability. */
export interface TestConnectionResult {
  ok: boolean;
  error?: string;
}
