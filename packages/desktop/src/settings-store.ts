/**
 * User-level settings store. Shared across all projects and windows (and, on chromium, across the
 * per-project browser profiles that can't see each other's localStorage) by writing a single JSON
 * file in the platform-conventional config directory (see user-config.ts).
 *
 * Values (API keys included) are stored in plaintext — the same trust level as the localStorage
 * store this replaces — so the file is written owner-only (0600) on POSIX.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configFile, migrateLegacyStore } from "./user-config";

const STORE_NAME = "settings.json";

/**
 * Read the settings map, tolerating a missing or corrupt store file. Non-string values are dropped
 * so the result always satisfies the platform contract's Record<string, string>.
 */
export async function readSettings(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(await migrateLegacyStore(STORE_NAME), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const settings: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        settings[key] = value;
      }
    }
    return settings;
  } catch {
    return {};
  }
}

/** Persist the full settings map, creating the parent directory if needed. */
export async function writeSettings(settings: Record<string, string>): Promise<void> {
  const file = configFile(STORE_NAME);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
}
