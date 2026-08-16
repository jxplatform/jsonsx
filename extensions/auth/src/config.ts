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

/**
 * How long a session lives, and how often activity extends it (seconds).
 *
 * These are Better Auth's own defaults, restated so the lifetime is **this project's** decision and
 * shows up in a diff when it changes. A session lifetime that lives only in a dependency's default
 * is one nobody chose.
 */
export const SESSION_EXPIRES_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_SECONDS = 60 * 60 * 24;

/** Auth-route rate limit: requests per IP per window (seconds). */
export const RATE_LIMIT_MAX = 100;
export const RATE_LIMIT_WINDOW_SECONDS = 10;

/** Better Auth's own cookie-name prefix. Changing it signs every existing session out. */
const COOKIE_PREFIX = "better-auth";

/** The cookies `createCookieGetter` mints, all of them same-host and `Path=/`. */
const COOKIE_IDS = ["session_token", "session_data", "dont_remember", "account_data"];

/**
 * Whether this deployment's cookies must carry `Secure` — and therefore a name prefix.
 *
 * **Default secure, and only step down when the origin is positively known to be plain HTTP.**
 * Better Auth's own rule falls back to `NODE_ENV === "production"`, which is _false on Cloudflare
 * Workers_ — where `NODE_ENV` is simply unset — so the library's default silently produced
 * unprefixed, non-`Secure` session cookies on exactly the platform Jx deploys to. The one host that
 * genuinely serves auth over plain HTTP is the local dev server, and it pins `BETTER_AUTH_URL` to
 * its own origin so this reads `http:` there rather than guessing.
 *
 * @param {Env} env
 * @returns {boolean}
 */
export function cookiesAreSecure(env: Env): boolean {
  const baseURL = env["BETTER_AUTH_URL"];
  if (typeof baseURL === "string" && baseURL !== "") {
    return !baseURL.startsWith("http://");
  }
  return true;
}

/**
 * The `advanced` block: cookie names and attributes (RFC 6265bis §4.1.3).
 *
 * **`__Host-`, not `__Secure-`.** `__Secure-` only promises the cookie was set with `Secure`; a
 * page on a sibling origin — `evil.example.com` against `example.com` — can still overwrite it by
 * setting a `Domain`. `__Host-` forbids `Domain`, pins `Path=/`, and is therefore the prefix that
 * actually stops a session-fixation write. Better Auth's defaults already set `Path=/` and no
 * `Domain`, so the stronger prefix costs nothing.
 *
 * Getting there means turning **off** `useSecureCookies` and putting `Secure` back by hand: the
 * library prepends `__Secure-` to whatever name it is given, so leaving it on would mint
 * `__Secure-__Host-…`, a name no browser accepts. `secure: true` in `defaultCookieAttributes`
 * restores the attribute the flag would have set. `tests/config.test.ts` asserts the resulting
 * names, so a library upgrade that changes this is loud rather than silent.
 *
 * **`Partitioned` is not set, and must not default on.** CHIPS is for cookies in a _third-party_
 * context; Jx auth cookies are first-party to the site that serves them. Setting it would force
 * `SameSite=None; Secure` and partition the session per top-level site — signing a visitor out
 * whenever the embedding page changed.
 *
 * @param {boolean} secure
 * @returns {Record<string, unknown>}
 */
function advancedCookieOptions(secure: boolean): Record<string, unknown> {
  if (!secure) {
    // Plain-HTTP dev origin: a prefixed cookie without `Secure` is rejected outright.
    return { cookiePrefix: COOKIE_PREFIX, useSecureCookies: false };
  }
  const cookies: Record<string, { name: string }> = {};
  for (const id of COOKIE_IDS) {
    cookies[id] = { name: `__Host-${COOKIE_PREFIX}.${id}` };
  }
  return {
    cookiePrefix: COOKIE_PREFIX,
    cookies,
    defaultCookieAttributes: { secure: true },
    useSecureCookies: false,
  };
}

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
    advanced: advancedCookieOptions(cookiesAreSecure(env)),
    basePath: AUTH_BASE_PATH,
    emailAndPassword: { enabled: section.methods?.emailPassword ?? true },
    /*
     * Rate limiting is ON everywhere, not just in production. Better Auth gates its own default on
     * `NODE_ENV === "production"`, which is unset on Workers — so the limit was off in the one
     * place it matters. It is also on in dev deliberately: 100 requests per 10 seconds is far
     * beyond anything a person does by hand, and a limit that is disabled while you develop is a
     * limit nobody ever finds out is broken. Storage is Better Auth's in-memory default, which on
     * a serverless runtime is per-isolate — a speed bump for credential stuffing, not a wall.
     */
    rateLimit: { enabled: true, max: RATE_LIMIT_MAX, window: RATE_LIMIT_WINDOW_SECONDS },
    session: { expiresIn: SESSION_EXPIRES_SECONDS, updateAge: SESSION_UPDATE_SECONDS },
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
