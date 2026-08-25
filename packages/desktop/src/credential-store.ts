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

import { configFile } from "./user-config";
import { readStringStore, updateStore } from "./user-store";

const STORE_NAME = "credentials.json";

/**
 * The stored credential for `name`, or null.
 *
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export async function readCredential(name: string): Promise<string | null> {
  const store = await readStringStore(configFile(STORE_NAME));
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
  /* Read and write under one lock. This was a read-modify-write with an `await` between the halves
     and nothing holding the file, so two credentials written at once each read the same base and
     the second dropped the first. */
  await updateStore(configFile(STORE_NAME), readStringStore, (current) => {
    const next = { ...current };
    if (value === null) {
      delete next[name];
    } else {
      next[name] = value;
    }
    return next;
  });
}
