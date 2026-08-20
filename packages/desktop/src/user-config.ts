/**
 * Platform-conventional per-user config location for the desktop app's stores, coordinated by
 * env-paths: `$XDG_CONFIG_HOME`/`~/.config` on Linux, `%APPDATA%` (Roaming) on Windows, and the
 * user Library on macOS — all under one `jx-studio` app directory.
 */

import envPaths from "env-paths";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Absolute path of `name` inside the app's config directory. Environment overrides
 * ($XDG_CONFIG_HOME, %APPDATA%) are honored per call; the home directory itself is captured once by
 * env-paths at module load.
 */
export function configFile(name: string): string {
  return join(envPaths("jx-studio", { suffix: "" }).config, name);
}

/**
 * Absolute path of `name` inside the app's DATA directory — `$XDG_DATA_HOME`/`~/.local/share` on
 * Linux, `%LOCALAPPDATA%` on Windows, the user Library on macOS.
 *
 * Separate from {@link configFile} because the two answer different questions. Config is what the
 * user chose and would want to keep; this is what the running app knows about itself — which
 * windows are open, where their browser profiles live — and losing it costs nothing but a restart.
 */
export function dataFile(name: string): string {
  return join(envPaths("jx-studio", { suffix: "" }).data, name);
}

/**
 * One-time migration: releases before the env-paths move kept store files under `~/.jx`. When the
 * new-location file is absent and a legacy one exists, copy it across (the legacy file is left in
 * place so a downgrade still works). Returns the new-location path either way.
 */
export async function migrateLegacyStore(name: string): Promise<string> {
  const file = configFile(name);
  const legacy = resolve(homedir(), ".jx", name);
  if (!existsSync(file) && existsSync(legacy)) {
    try {
      await mkdir(dirname(file), { recursive: true });
      await copyFile(legacy, file);
    } catch {
      // Best-effort: an unreadable legacy file just means the caller starts fresh.
    }
  }
  return file;
}
