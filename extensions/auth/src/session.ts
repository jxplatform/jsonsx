/**
 * Session — the module-level session store and the `Session` state class.
 *
 * One store per page: the first `Session.resolve()` fetches the session through the auth client,
 * later resolves reuse the in-flight/last value, and every auth action refresh notifies subscribers
 * — `subscribe()` rides the runtime's existing ref machinery, so any `state` entry with
 * `"$prototype": "Session"` updates live across sign-in/sign-out. Outside browsers `resolve()`
 * returns null, keeping statically generated pages on the signed-out state.
 */

import { getAuthClient } from "./client.ts";
import { toSessionInfo } from "./config.ts";
import type { SessionInfo } from "@jxsuite/connector/types";

export type SessionListener = (session: SessionInfo | null) => void;

let current: SessionInfo | null = null;
let pending: Promise<SessionInfo | null> | null = null;
const listeners = new Set<SessionListener>();

/** True when running in a browser (session fetching is a client-only concern). */
export function inBrowser(): boolean {
  return typeof document !== "undefined" && typeof fetch === "function";
}

function notify(): void {
  for (const listener of listeners) {
    listener(current);
  }
}

/** The last-known session (synchronous access; null when signed out or never fetched). */
export function currentSession(): SessionInfo | null {
  return current;
}

/**
 * Fetch the session through the auth client, update the store, and notify subscribers.
 *
 * @param {string} [baseUrl] - Auth route base URL; defaults to <origin>/_jx/auth
 * @returns {Promise<SessionInfo | null>}
 */
export async function fetchSession(baseUrl?: string): Promise<SessionInfo | null> {
  const run = (async () => {
    try {
      const { data } = await getAuthClient(baseUrl).getSession();
      current = toSessionInfo(data);
    } catch {
      // Fail-closed: an unreachable auth backend reads as signed out.
      current = null;
    }
    notify();
    return current;
  })();
  pending = run;
  return run;
}

/** Refresh the store in the background (auth actions call this after every state change). */
export function refreshSession(baseUrl?: string): void {
  void fetchSession(baseUrl);
}

/** Drop the session locally (sign-out) and notify subscribers. */
export function clearSession(): void {
  current = null;
  pending = Promise.resolve(null);
  notify();
}

/**
 * Subscribe to session changes.
 *
 * @param {SessionListener} listener
 * @returns {() => void} Unsubscribe
 */
export function subscribeSession(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reset the store (test hook). */
export function resetSessionStore(): void {
  current = null;
  pending = null;
  listeners.clear();
}

/** Config of the Session state class. */
export interface SessionConfig {
  baseUrl?: string;
  [key: string]: unknown;
}

export class Session {
  config: SessionConfig;

  constructor(config: SessionConfig = {}) {
    this.config = config;
  }

  /** SessionInfo for the signed-in user, or null — always null outside browsers (SSG-safe). */
  async resolve(): Promise<SessionInfo | null> {
    if (!inBrowser()) {
      return null;
    }
    pending ??= fetchSession(this.config.baseUrl);
    return pending;
  }

  /** Ride the runtime ref machinery: push every session change into the wrapping signal. */
  subscribe(callback: SessionListener): void {
    subscribeSession(callback);
    if (pending === null && inBrowser()) {
      pending = fetchSession(this.config.baseUrl);
    }
  }
}
