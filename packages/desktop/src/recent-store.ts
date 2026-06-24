/**
 * User-level recent-projects store. Shared across all projects and windows (and, on chromium,
 * across the per-project browser profiles that can't see each other's localStorage) by writing a
 * single JSON file under the user's home directory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { RecentProjectEntry } from "./rpc-schema";

/** Absolute path of the user-level store file (resolved per call so $HOME changes are honored). */
function storeFile(): string {
  return resolve(homedir(), ".jx", "recent-projects.json");
}

/** Read the recent-projects list, tolerating a missing or corrupt store file. */
export async function readRecents(): Promise<RecentProjectEntry[]> {
  try {
    const raw = await readFile(storeFile(), "utf8");
    const parsed = JSON.parse(raw) as RecentProjectEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Persist the full recent-projects list, creating the parent directory if needed. */
export async function writeRecents(projects: RecentProjectEntry[]): Promise<void> {
  const file = storeFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(projects, null, 2), "utf8");
}
