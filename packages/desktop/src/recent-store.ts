/**
 * User-level recent-projects store. Shared across all projects and windows (and, on chromium,
 * across the per-project browser profiles that can't see each other's localStorage) by writing a
 * single JSON file in the platform-conventional config directory (see user-config.ts).
 */

import { configFile, migrateLegacyStore } from "./user-config";
import { readJsonStore, writeStore } from "./user-store";
import type { RecentProjectEntry } from "./rpc-schema";

const STORE_NAME = "recent-projects.json";

/** Read the recent-projects list, tolerating a missing or corrupt store file. */
export async function readRecents(): Promise<RecentProjectEntry[]> {
  return readJsonStore(
    await migrateLegacyStore(STORE_NAME),
    [] as RecentProjectEntry[],
    (value): value is RecentProjectEntry[] => Array.isArray(value),
  );
}

/**
 * Persist the full recent-projects list, creating the parent directory if needed.
 *
 * A whole-list replace is right here, unlike settings: the list IS the value, and every writer has
 * just read it. What it gains from the shared primitive is the atomic rename — a torn
 * recent-projects file reads back as "no recent projects", which is a bad way to learn about a
 * crash mid-write.
 */
export async function writeRecents(projects: RecentProjectEntry[]): Promise<void> {
  await writeStore(configFile(STORE_NAME), projects);
}
