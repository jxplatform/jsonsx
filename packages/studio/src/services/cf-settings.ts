/// <reference lib="dom" />
/**
 * Cf-settings — local persistence for the Cloudflare publish connection on
 * platforms without a hosted OAuth broker (dev server, desktop). The API
 * token is stored like the AI key: localStorage first, mirrored through the
 * platform settings backend where one exists. It only ever leaves the machine
 * to the same-origin `/__studio/cf/proxy`, which forwards it as a bearer to
 * api.cloudflare.com (not CORS-enabled, hence the proxy).
 *
 * @license MIT
 */

import { persistSettings } from "./settings-store";

const TOKEN_STORAGE = "jx.cf.token";
const ACCOUNT_STORAGE = "jx.cf.accountId";

function read(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    const trimmed = (value || "").trim();
    if (trimmed) {
      globalThis.localStorage?.setItem(key, trimmed);
    } else {
      globalThis.localStorage?.removeItem(key);
    }
  } catch {
    // Storage unavailable (private mode) — the connection just won't persist.
  }
  persistSettings();
}

/** The stored Cloudflare API token, or "" when not connected. */
export function getCfToken(): string {
  return read(TOKEN_STORAGE);
}

/** Persist (or clear, with a blank value) the Cloudflare API token. */
export function setCfToken(token: string): void {
  write(TOKEN_STORAGE, token);
}

/** The selected Cloudflare account id, or "" when none chosen yet. */
export function getCfAccountId(): string {
  return read(ACCOUNT_STORAGE);
}

/** Persist (or clear) the selected Cloudflare account id. */
export function setCfAccountId(accountId: string): void {
  write(ACCOUNT_STORAGE, accountId);
}
