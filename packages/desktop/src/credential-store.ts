/**
 * Credential store — OAuth tokens at rest, owner-only, in the app's config directory.
 *
 * **Separate from `settings-store.ts` on purpose.** Settings are handed to the webview wholesale by
 * the `getSettings` RPC and rendered in the preferences UI; a token in there would be readable by
 * any script running in the webview, which is the exposure this store exists to remove. Nothing
 * here is returned as a map — the RPC surface answers "is one stored" and "sign in", never "give me
 * everything".
 *
 * **The limitation, stated rather than hidden:** the file is plaintext, protected by filesystem
 * permissions (`0600`) and nothing else. Another process running as the same user can read it. The
 * right answer is the OS keychain — Keychain Services, libsecret, DPAPI — which is a native
 * dependency per platform and a much larger change than this one. Until then, this is strictly
 * better than a browser storage entry, and no better than that.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configFile } from "./user-config";

const STORE_NAME = "credentials.json";

/** Read the whole store, tolerating a missing or corrupt file. Never leaves this module. */
async function readStore(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(configFile(STORE_NAME), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Write the store owner-only.
 *
 * `chmod` runs after the write rather than relying on `writeFile`'s mode, which only applies when
 * the file is created — an existing world-readable file would keep its mode forever otherwise.
 */
async function writeStore(store: Record<string, string>): Promise<void> {
  const file = configFile(STORE_NAME);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(file, 0o600);
  }
}

/**
 * The stored credential for `name`, or null.
 *
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export async function readCredential(name: string): Promise<string | null> {
  const store = await readStore();
  return store[name] ?? null;
}

/**
 * Store (or, with null, remove) the credential for `name`.
 *
 * @param {string} name
 * @param {string | null} value
 * @returns {Promise<void>}
 */
export async function writeCredential(name: string, value: string | null): Promise<void> {
  const store = await readStore();
  if (value === null) {
    delete store[name];
  } else {
    store[name] = value;
  }
  await writeStore(store);
}
