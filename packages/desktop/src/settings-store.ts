/**
 * User-level settings store. Shared across all projects and windows (and, on chromium, across the
 * per-project browser profiles that can't see each other's localStorage) by writing a single JSON
 * file in the platform-conventional config directory (see user-config.ts).
 *
 * **Writes are patches, not replacements**, and that is the point of this module rather than a
 * refinement of it. The whole-map `writeSettings` it replaces let any window overwrite the file
 * with its own view of the settings — so a window that held none, which on the chromium launcher is
 * an ordinary welcome window with its own empty browser profile, could clear the credentials
 * another window had just stored. A key named by neither `set` nor `remove` is now left exactly as
 * it was found, so a writer can only ever change what it actually knows about. That also preserves
 * keys this build has never heard of: a setting written by a newer version, or by hand.
 *
 * Values (API keys included) are stored in plaintext — the same trust level as the localStorage
 * store this replaces — so the file is written owner-only (0600) on POSIX. See `user-store.ts` for
 * why that needs a fresh inode rather than `writeFile`'s `mode`.
 */

import { watch } from "node:fs";
import { dirname, basename } from "node:path";
import { configFile, migrateLegacyStore } from "./user-config";
import { readStringStore, updateStore } from "./user-store";
import type { SettingsPatch } from "@jxsuite/protocol";

const STORE_NAME = "settings.json";

/**
 * Read the settings map, tolerating a missing or corrupt store file. Non-string values are dropped
 * so the result always satisfies the platform contract's Record<string, string>.
 */
export async function readSettings(): Promise<Record<string, string>> {
  return readStringStore(await migrateLegacyStore(STORE_NAME));
}

/**
 * Apply `patch` to the stored settings and return the result.
 *
 * The read and the write happen under one lock, so two concurrent patches compose instead of one
 * overwriting the other. The resulting map is returned so a caller can broadcast it without a
 * second read that might see a third writer's work.
 */
export async function patchSettings(patch: SettingsPatch): Promise<Record<string, string>> {
  const file = await migrateLegacyStore(STORE_NAME);
  return updateStore(file, readStringStore, (current) => {
    const next = { ...current };
    for (const [key, value] of Object.entries(patch.set ?? {})) {
      next[key] = value;
    }
    for (const key of patch.remove ?? []) {
      delete next[key];
    }
    return next;
  });
}

/**
 * Call `onChange` with the settings whenever the store file changes on disk.
 *
 * A directory watch rather than in-process fan-out, because in-process fan-out cannot reach the
 * window that needs it: the chromium launcher gives every window its own OS process, so a change
 * made in one is invisible to another until something reads the file again. Watching the file is
 * also what makes a hand-edit of `settings.json` show up without a restart.
 *
 * Fires for this process's own writes too. That is harmless and deliberately not filtered here —
 * the receiver applies the settings as a diff against what it already holds, so its own write
 * produces no change and announces nothing. Filtering by pid would be a second mechanism that has
 * to agree with the first.
 *
 * Degrades to a no-op where `fs.watch` is unavailable (some network filesystems), on the same
 * reasoning as `window-registry.ts`'s focus watch: a window that never hears about another's change
 * is stale until its next boot, which is where it was before this existed.
 */
export function watchSettings(onChange: (settings: Record<string, string>) => void): () => void {
  const file = configFile(STORE_NAME);
  const target = basename(file);
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(dirname(file), (_event, filename) => {
      if (filename !== target) {
        return;
      }
      void readSettings().then(onChange, () => {
        // An unreadable store is the same as no news; the next write brings another event.
      });
    });
  } catch {
    return () => {};
  }
  return () => watcher.close();
}
