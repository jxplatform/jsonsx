/// <reference lib="dom" />
/**
 * Settings-store.js — sync of user settings between localStorage and the platform backend.
 *
 * LocalStorage stays the synchronous source of truth for every consumer (ai-settings getters read
 * it directly). On platforms with a backend user-settings store (desktop/chromium — where
 * localStorage does not roam across browser profiles), the persisted keys are hydrated from the
 * backend at boot and written through on every change. The dev server omits the platform methods
 * and settings remain localStorage-only.
 *
 * @license MIT
 */

import { getPlatform, hasPlatform } from "../platform";

/** The localStorage keys mirrored into the platform's user-settings store. */
export const PERSISTED_SETTINGS_KEYS = ["jx.ai.openaiKey", "jx.ai.baseUrl", "jx.ai.model"] as const;

/** Read a localStorage value defensively, treating unavailable/throwing storage as empty. */
function readLocal(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/**
 * Pull the persisted settings from the backend store into localStorage. Call once after the
 * platform is registered; a no-op on platforms without a settings store (dev server).
 *
 * Migration: keys the backend does not know yet but localStorage does (an existing user upgrading
 * from localStorage-only builds) are pushed back to the backend once, fire-and-forget.
 */
export async function hydrateSettings(): Promise<void> {
  if (!hasPlatform()) {
    return;
  }
  const platform = getPlatform();
  if (!platform.getSettings) {
    return;
  }
  let stored: Record<string, string>;
  try {
    stored = await platform.getSettings();
  } catch {
    return;
  }
  const merged: Record<string, string> = { ...stored };
  let needsMigration = false;
  for (const key of PERSISTED_SETTINGS_KEYS) {
    const backendValue = stored[key];
    if (backendValue) {
      try {
        globalThis.localStorage?.setItem(key, backendValue);
      } catch {
        /* Storage unavailable — consumers fall back to defaults. */
      }
    } else {
      const localValue = readLocal(key);
      if (localValue) {
        merged[key] = localValue;
        needsMigration = true;
      }
    }
  }
  if (needsMigration && platform.saveSettings) {
    void platform.saveSettings(merged).catch(() => {});
  }
}

/**
 * Write the current values of the persisted keys through to the backend store, fire-and-forget.
 * Call after mutating any of {@link PERSISTED_SETTINGS_KEYS} in localStorage; a no-op on platforms
 * without a settings store (dev server).
 */
export function persistSettings(): void {
  if (!hasPlatform()) {
    return;
  }
  const platform = getPlatform();
  if (!platform.saveSettings) {
    return;
  }
  const settings: Record<string, string> = {};
  for (const key of PERSISTED_SETTINGS_KEYS) {
    const value = readLocal(key);
    if (value) {
      settings[key] = value;
    }
  }
  void platform.saveSettings(settings).catch(() => {});
}
