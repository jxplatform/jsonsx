/**
 * User-level recent-projects store. Shared across all projects and windows (and, on chromium,
 * across the per-project browser profiles that can't see each other's localStorage) by writing a
 * single JSON file in the platform-conventional config directory (see user-config.ts).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configFile, migrateLegacyStore } from "./user-config";
import type { RecentProjectEntry } from "./rpc-schema";

const STORE_NAME = "recent-projects.json";

/** Read the recent-projects list, tolerating a missing or corrupt store file. */
export async function readRecents(): Promise<RecentProjectEntry[]> {
  try {
    const raw = await readFile(await migrateLegacyStore(STORE_NAME), "utf8");
    const parsed = JSON.parse(raw) as RecentProjectEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Persist the full recent-projects list, creating the parent directory if needed. */
export async function writeRecents(projects: RecentProjectEntry[]): Promise<void> {
  const file = configFile(STORE_NAME);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(projects, null, 2), "utf8");
}
