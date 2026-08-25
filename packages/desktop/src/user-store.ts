/**
 * The user-level JSON store primitive — one owner per file, one way to write one.
 *
 * Three stores live side by side in the app's config directory (`settings.json`,
 * `credentials.json`, `recent-projects.json`) and each had grown its own read/write pair. They
 * disagreed on the things that matter:
 *
 * - **Atomicity.** `settings-store.ts` and `recent-store.ts` called `writeFile` straight at the
 *   destination, which truncates first. An interrupted write — or one interleaved with another
 *   process's, which the chromium launcher makes routine by giving every window its own process —
 *   leaves torn JSON. Every reader here tolerates that by returning empty, so corruption presented
 *   to the user as _everything lost_ rather than as an error.
 * - **Permissions.** `writeFile`'s `mode` applies only when it CREATES the file.
 *   `credential-store.ts` knew this and chmod'd afterwards; the other two did not, so a store that
 *   arrived world-readable stayed that way — and `migrateLegacyStore`'s `copyFile` carries the
 *   legacy file's mode across, which is exactly how one arrives.
 * - **Concurrency.** `writeCredential` is a read-modify-write with an `await` in the middle and no
 *   lock, so two of them racing lose one edit.
 *
 * So: write to a sibling temp file, `chmod` the fresh inode, `rename` into place (atomic within a
 * directory), and serialize everything touching one path behind a per-path promise chain.
 *
 * The mutex is per PROCESS, which is the honest limit: it makes concurrent writes from one launcher
 * safe, and the atomic rename is what keeps a write from a second process from producing a torn
 * file rather than merely a lost update.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Distinguishes concurrent temp files from this process, as the pid distinguishes processes. */
let writeSeq = 0;

/** One promise chain per path, so two writers to one file never interleave. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `work` with exclusive access to `file`, relative to every other caller in this process.
 *
 * Failures do not poison the chain: the link is always resolved by the time the next one starts, so
 * one rejected write cannot strand every write behind it.
 */
function withStoreLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(file) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(
    file,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Read a `Record<string, string>` store, tolerating a missing or corrupt file.
 *
 * Non-string values are dropped rather than coerced, so the result always satisfies the contract
 * its callers publish.
 */
export async function readStringStore(file: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
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
 * Read any JSON store, tolerating a missing or corrupt file.
 *
 * @param file Absolute path.
 * @param fallback Returned when the file is absent, unreadable, or fails `accept`.
 * @param accept Narrows the parsed value; anything it rejects yields `fallback`.
 */
export async function readJsonStore<T>(
  file: string,
  fallback: T,
  accept: (value: unknown) => value is T,
): Promise<T> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return accept(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Write `value` to `file` atomically and owner-only.
 *
 * Not exported for direct use by a store that also reads — see {@link updateStore}, which holds the
 * lock across both halves.
 */
async function writeAtomically(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  writeSeq += 1;
  const temp = `${file}.${process.pid}.${writeSeq}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(temp, 0o600);
  }
  await rename(temp, file);
}

/** Replace a store's contents wholesale, atomically. */
export function writeStore(file: string, value: unknown): Promise<void> {
  return withStoreLock(file, () => writeAtomically(file, value));
}

/**
 * Read a store, transform it, and write the result back — with the lock held across BOTH halves.
 *
 * This is what makes a per-key edit safe. The read-modify-write it replaces released between the
 * read and the write, so two concurrent edits each read the same base and the second overwrote the
 * first's key.
 *
 * @returns Whatever `mutate` produced, i.e. the store as it now stands on disk.
 */
export function updateStore<T>(
  file: string,
  read: (file: string) => Promise<T>,
  mutate: (current: T) => T,
): Promise<T> {
  return withStoreLock(file, async () => {
    const next = mutate(await read(file));
    await writeAtomically(file, next);
    return next;
  });
}
