/**
 * Watcher.ts — a small chokidar wrapper that emits coalesced, batched FS-event payloads to a sink.
 *
 * Used by the desktop project session (which has no SSE stream) to push filesystem changes to its
 * webview over RPC. The dev server keeps its own watcher in watch.ts (intertwined with
 * build/reload); both share the pure `toFsEvent`/`coalesceFsEvents` helpers.
 */

import { watch as chokidarWatch } from "chokidar";
import { coalesceFsEvents, toFsEvent } from "./fs-events.ts";
import { invalidateReferenceCache } from "./find-refs.ts";
import { createWatchIgnore } from "../watch-policy.ts";
import type { FsEventPayload } from "./fs-events.ts";

const IGNORE_SEGMENTS = ["node_modules", ".git", "dist", ".jx", ".direnv", ".devenv"];

function isIgnored(path: string): boolean {
  const f = path.replaceAll("\\", "/");
  return IGNORE_SEGMENTS.some((s) => f.includes(`/${s}/`) || f.endsWith(`/${s}`));
}

export interface FsWatcherHandle {
  close: () => Promise<void>;
}

/**
 * Watch `root`, coalescing rapid changes and delivering batches to `sink`. Returns a handle whose
 * `close()` stops the watcher and clears any pending batch.
 */
export function createFsWatcher(
  root: string,
  sink: (events: FsEventPayload[]) => void,
  opts: { debounce?: number } = {},
): FsWatcherHandle {
  const debounceMs = opts.debounce ?? 40;
  let buffer: FsEventPayload[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher = chokidarWatch(root, {
    /* Left on deliberately: a symlink inside a project is project content, and its events belong
       in the sidebar. It is the link pointing OUT of the root that walks the watcher off into the
       rest of the filesystem, and createWatchIgnore drops exactly those — along with the sockets
       and device nodes fs.watch answers with ENXIO. */
    followSymlinks: true,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ignored: createWatchIgnore(root, isIgnored),
  });

  watcher.on("all", (eventType, changedPath) => {
    const event = toFsEvent(eventType, root, changedPath);
    if (!event) {
      return;
    }
    // Any move under the root can change who references what, so the usage cache drops the whole
    // Project rather than trying to derive which queries this one path could have affected.
    invalidateReferenceCache(root);
    buffer = coalesceFsEvents(buffer, event);
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      if (buffer.length > 0) {
        sink(buffer);
        buffer = [];
      }
    }, debounceMs);
  });

  /* An `error` with no listener is not logged by an EventEmitter, it is THROWN — which is how a
     directory holding a few unix sockets took the whole launcher down rather than losing a few
     watches. The filter above means these should now be rare; the listener means they are never
     fatal when they are not. */
  watcher.on("error", (err) => {
    const error = err as NodeJS.ErrnoException;
    console.error(`[fs-watch] ${error.message ?? String(error)}`);
  });

  return {
    close: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      buffer = [];
      await watcher.close();
    },
  };
}
