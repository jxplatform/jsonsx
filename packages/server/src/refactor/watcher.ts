/**
 * Watcher.ts — a small chokidar wrapper that emits coalesced, batched FS-event payloads to a sink.
 *
 * Used by the desktop project session (which has no SSE stream) to push filesystem changes to its
 * webview over RPC. The dev server keeps its own watcher in watch.ts (intertwined with
 * build/reload); both share the pure `toFsEvent`/`coalesceFsEvents` helpers.
 */

import { watch as chokidarWatch } from "chokidar";
import { coalesceFsEvents, toFsEvent } from "./fs-events.ts";
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
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ignored: (path) => isIgnored(path),
  });

  watcher.on("all", (eventType, changedPath) => {
    const event = toFsEvent(eventType, root, changedPath);
    if (!event) {
      return;
    }
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
