/**
 * Client — the browser-safe Better Auth client wrapper.
 *
 * Wraps `createAuthClient` from better-auth/client (verified against 1.6.23: `signIn.email`,
 * `signUp.email`, `signIn.social`, `signOut`, `getSession`, each returning `{ data, error }`)
 * behind a module-level singleton pointed at the site's own /_jx/auth mount. Everything here is
 * typed structurally against the narrow slice the session store and auth actions consume, so
 * bundles never depend on Better Auth's inferred mega-types.
 */

import { createAuthClient } from "better-auth/client";
import { AUTH_BASE_PATH } from "./config.ts";

/** The `{ data, error }` envelope every client call resolves to. */
export interface AuthClientResult {
  data?: unknown;
  error?: { message?: string; status?: number } | null;
}

/** The Better Auth client slice consumed by the session store and the auth actions. */
export interface JxAuthClient {
  signIn: {
    email: (input: {
      email: string;
      password: string;
      callbackURL?: string;
    }) => Promise<AuthClientResult>;
    social: (input: { provider: string; callbackURL?: string }) => Promise<AuthClientResult>;
  };
  signUp: {
    email: (input: { email: string; password: string; name: string }) => Promise<AuthClientResult>;
  };
  signOut: () => Promise<AuthClientResult>;
  getSession: () => Promise<AuthClientResult>;
}

let client: JxAuthClient | null = null;
let clientBase: string | null = null;

/** Sentinel base marking a host/test-injected client (always returned as-is). */
const INJECTED = "__injected__";

/** The auth route base URL: explicit, else the page's own origin + /_jx/auth. */
export function resolveAuthBaseUrl(baseUrl?: string): string {
  if (baseUrl) {
    return baseUrl;
  }
  if (typeof location === "undefined") {
    throw new TypeError("The jx auth client needs an explicit baseUrl outside browsers");
  }
  return `${location.origin}${AUTH_BASE_PATH}`;
}

/**
 * The shared auth client (created on first use, re-created when the base URL changes).
 *
 * @param {string} [baseUrl] - Auth route base URL; defaults to <origin>/_jx/auth
 * @returns {JxAuthClient}
 */
export function getAuthClient(baseUrl?: string): JxAuthClient {
  if (client !== null && clientBase === INJECTED) {
    return client;
  }
  const base = resolveAuthBaseUrl(baseUrl);
  if (!client || clientBase !== base) {
    client = createAuthClient({ baseURL: base }) as unknown as JxAuthClient;
    clientBase = base;
  }
  return client;
}

/** Inject a client instance (host/test hook; pass null to restore the default factory). */
export function setAuthClient(next: JxAuthClient | null): void {
  client = next;
  clientBase = next === null ? null : INJECTED;
}
