/// <reference lib="dom" />
/**
 * Cf-settings — the Cloudflare publish connection on platforms without a hosted OAuth broker (dev
 * server, desktop). The API token is stored like the AI key, over `settings/kernel.ts`. It only ever
 * leaves the machine to the same-origin `/__studio/cf/proxy`, which forwards it as a bearer to
 * api.cloudflare.com (not CORS-enabled, hence the proxy).
 *
 * As with the AI provider, a blank value is a VALUE: {@link clearCfConnection} is the deletion path,
 * so nothing can revoke a connection by rendering an empty field into a setter.
 *
 * @license MIT
 */

import { SETTINGS } from "./settings/definitions";
import { clearSettings, readStoredSetting, setSetting } from "./settings/kernel";

/** The stored Cloudflare API token, or "" when not connected. */
export function getCfToken(): string {
  return readStoredSetting(SETTINGS.cfToken);
}

/** Persist the Cloudflare API token. Blank stores blank — see {@link clearCfConnection}. */
export function setCfToken(token: string): void {
  setSetting(SETTINGS.cfToken, token || "");
}

/** The selected Cloudflare account id, or "" when none chosen yet. */
export function getCfAccountId(): string {
  return readStoredSetting(SETTINGS.cfAccountId);
}

/** Persist the selected Cloudflare account id. Blank stores blank. */
export function setCfAccountId(accountId: string): void {
  setSetting(SETTINGS.cfAccountId, accountId || "");
}

/** Forget the connection — token and account together. What Disconnect calls. */
export function clearCfConnection(): void {
  clearSettings([SETTINGS.cfToken, SETTINGS.cfAccountId]);
}
