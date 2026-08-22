/**
 * Watch-policy.ts — the entry filter both filesystem watchers hand to chokidar.
 *
 * A watcher is pointed at a directory a **user** chose, and a user's directory holds things that
 * are not project content and that `fs.watch` does not merely decline to watch:
 *
 * - **Unix sockets, FIFOs and device nodes** answer `fs.watch` with `ENXIO`, which chokidar turns
 *   into an `error` event — one per entry, and fatal to a watcher with no `error` listener.
 * - **A symlink out of the tree** is followed by default, so one link can turn a project watcher into
 *   a walk of the whole filesystem. `~/.wine/dosdevices/z:` points at `/`, and that is exactly what
 *   it did.
 *
 * Both were reached at once by a launcher that adopted `$HOME` as a project root. That defect is
 * fixed where it was made (`packages/desktop/src/chromium/index.ts`), but a watcher must survive
 * being pointed at an ordinary directory rather than depend on never being pointed at one — so the
 * rules live here, stated once, because `watch.ts` (dev server) and `refactor/watcher.ts` (desktop
 * session) both need them and neither owns the other.
 *
 * Symlinks are contained rather than banned: a link resolving back inside the root is project
 * content (a workspace member, a shared assets directory) and keeps its events. Only one leaving
 * the root — or dangling, which is what `find -xtype l -delete` leaves behind in a nix bundle — is
 * dropped.
 *
 * @docs framework/build/dev-server
 */

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Stats } from "node:fs";

/** Is `candidate` the base directory itself, or somewhere beneath it? */
function isInside(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Resolve `root` through any symlinks so containment is judged against real paths on both sides. An
 * unresolvable root is not this function's error to raise — chokidar reports it — so the lexical
 * path stands in and every symlink under it then reads as "outside".
 */
function realBase(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/**
 * Build the `ignored` predicate for a watcher rooted at `root`, composing the caller's own
 * path-name rule (`node_modules`, `dist`, …) with the entry-kind rules above.
 *
 * Chokidar calls this with the entry's `lstat` during its directory walk and without stats before
 * it has them; a stats-less call can only be judged by name, so it is.
 */
export function createWatchIgnore(
  root: string,
  isIgnoredPath: (path: string) => boolean,
): (path: string, stats?: Stats) => boolean {
  let base: string | null = null;
  return (path: string, stats?: Stats): boolean => {
    if (isIgnoredPath(path)) {
      return true;
    }
    if (!stats) {
      return false;
    }
    if (stats.isSymbolicLink()) {
      base ??= realBase(root);
      try {
        return !isInside(base, realpathSync(path));
      } catch {
        return true;
      }
    }
    // Anything that is not a directory or a regular file is a socket, a FIFO or a device node.
    return !stats.isDirectory() && !stats.isFile();
  };
}
