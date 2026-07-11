/**
 * Config — the project.json `auth` section and its mapping onto BetterAuthOptions.
 *
 * The section carries identifiers and env-var NAMES only (specs/extensions.md §13): the signing
 * secret comes from `env[secretEnv]` (default BETTER_AUTH_SECRET), social-provider credentials from
 * their `clientIdEnv`/`clientSecretEnv` vars (defaults <ID>_CLIENT_ID / <ID>_CLIENT_SECRET). This
 * module is pure and dependency-free so browser bundles (session store, actions) can share the
 * section types and the SessionInfo mapping without pulling the Better Auth server in.
 */

import type { SessionInfo } from "@jxsuite/connector/types";

/** The Better Auth route subtree (specs/extensions.md §11: the auth mount's basePath). */
export const AUTH_BASE_PATH = "/_jx/auth";

/** Default NAME of the env var holding the Better Auth signing secret. */
export const DEFAULT_SECRET_ENV = "BETTER_AUTH_SECRET";

/** One social provider entry: env-var NAMES for the OAuth credentials, never values. */
export interface AuthProviderDef {
  clientIdEnv?: string;
  clientSecretEnv?: string;
}

/** The project.json `auth` section (identifiers and env-var names only). */
export interface AuthSection {
  /** Connection holding the auth system tables; defaults to the first-declared connection. */
  connection?: string;
  secretEnv?: string;
  methods?: { emailPassword?: boolean };
  providers?: Record<string, AuthProviderDef>;
  redirects?: { afterSignIn?: string; afterSignOut?: string };
  roles?: string[];
  trustedOrigins?: string[];
  [key: string]: unknown;
}

/** The `connections`-bearing slice of a project config (the connector owns the full type). */
export interface AuthProjectConfig {
  connections?: Record<string, { provider: string; [key: string]: unknown }>;
  auth?: AuthSection;
  [key: string]: unknown;
}

type Env = Record<string, unknown>;

/** The connection name the auth tables live on: declared, else the first-declared connection. */
export function resolveAuthConnectionName(
  section: AuthSection,
  projectConfig: AuthProjectConfig,
): string {
  const name = section.connection ?? Object.keys(projectConfig.connections ?? {})[0];
  if (!name) {
    throw new Error(
      'The "auth" section needs a database connection, but the project declares none ' +
        '(add a "connections" entry, or set auth.connection)',
    );
  }
  return name;
}

/** The signing secret from `env[secretEnv]`, failing closed with the env-var name when unset. */
export function resolveAuthSecret(section: AuthSection, env: Env): string {
  const name = section.secretEnv ?? DEFAULT_SECRET_ENV;
  const value = env[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `Auth is not configured: set the ${name} secret (in .dev.vars locally, ` +
        `or \`wrangler secret put ${name}\` in production)`,
    );
  }
  return value;
}

/** Default env-var NAME for a provider credential (`github` → `GITHUB_CLIENT_ID`). */
function defaultProviderEnv(providerId: string, suffix: "CLIENT_ID" | "CLIENT_SECRET"): string {
  return `${providerId.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

/**
 * Social providers with resolvable credentials, in Better Auth's `socialProviders` shape. Providers
 * whose env vars are unset are omitted (fail-closed: no half-configured OAuth).
 */
export function resolveSocialProviders(
  section: AuthSection,
  env: Env,
): Record<string, { clientId: string; clientSecret: string }> {
  const out: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const [id, def] of Object.entries(section.providers ?? {})) {
    const clientId = env[def.clientIdEnv ?? defaultProviderEnv(id, "CLIENT_ID")];
    const clientSecret = env[def.clientSecretEnv ?? defaultProviderEnv(id, "CLIENT_SECRET")];
    if (typeof clientId === "string" && clientId !== "" && typeof clientSecret === "string") {
      out[id] = { clientId, clientSecret };
    }
  }
  return out;
}

/**
 * Map the auth section + env onto BetterAuthOptions (typed structurally — the exact
 * BetterAuthOptions type lives in better-auth, which this pure module never imports).
 *
 * @param {AuthSection} section
 * @param {Env} env
 * @param {object} [extras]
 * @param {unknown} [extras.database] - Better Auth database config ({ dialect, type })
 * @param {string} [extras.secret] - Signing secret (omit for secret-free uses like migrations)
 * @returns {Record<string, unknown>} Options for `betterAuth()` / `getMigrations()`
 */
export function buildAuthOptions(
  section: AuthSection,
  env: Env,
  extras: { database?: unknown; secret?: string } = {},
): Record<string, unknown> {
  const socialProviders = resolveSocialProviders(section, env);
  const roles = section.roles ?? [];
  const baseURL = env["BETTER_AUTH_URL"];
  return {
    // Without BETTER_AUTH_URL Better Auth derives the origin from each incoming request, which
    // Is correct for same-origin /_jx/auth mounts; setting it pins callbacks for OAuth flows.
    ...(typeof baseURL === "string" && baseURL !== "" ? { baseURL } : {}),
    basePath: AUTH_BASE_PATH,
    emailAndPassword: { enabled: section.methods?.emailPassword ?? true },
    ...(Object.keys(socialProviders).length > 0 ? { socialProviders } : {}),
    ...(roles.length > 0
      ? {
          user: {
            additionalFields: {
              // Roles are assigned via the data grid, never by sign-up input.
              role: { input: false, required: false, type: "string" },
            },
          },
        }
      : {}),
    ...(section.trustedOrigins && section.trustedOrigins.length > 0
      ? { trustedOrigins: section.trustedOrigins }
      : {}),
    ...(extras.database === undefined ? {} : { database: extras.database }),
    ...(extras.secret === undefined ? {} : { secret: extras.secret }),
  };
}

/**
 * Map a Better Auth session payload ({ user, session }) onto the connector's SessionInfo shape.
 *
 * @param {unknown} data - `auth.api.getSession` result or the client's `getSession().data`
 * @returns {SessionInfo | null}
 */
export function toSessionInfo(data: unknown): SessionInfo | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const { user, session } = data as { user?: Record<string, unknown>; session?: unknown };
  if (!user || typeof user.id !== "string") {
    return null;
  }
  return {
    userId: user.id,
    ...(typeof user.role === "string" && user.role !== "" ? { role: user.role } : {}),
    user,
    ...(session === undefined ? {} : { session }),
  };
}
