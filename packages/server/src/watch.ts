/** Watch.js — File watcher + SSE live reload */

import { watch as chokidarWatch } from "chokidar";
import { relative } from "node:path";
import { rebuild } from "./build.ts";
import { coalesceFsEvents, toFsEvent } from "./refactor/fs-events.ts";
import { createWatchIgnore } from "./watch-policy.ts";
import { createSseHub } from "./sse.ts";
import { invalidateReferenceCache } from "./refactor/find-refs.ts";
import type { BuildEntry } from "./types.ts";
import type { FsEventPayload } from "./refactor/fs-events.ts";

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.cache/**",
  "**/.git/**",
  "**/.jx/**",
  "**/.devenv/**",
  "**/.direnv/**",
  "**/bun.lockb",
  "**/bun.lock",
  // Bun test temporary directories — created/deleted transiently, cause EINVAL on
  // Fs.watch when cleaned up mid-scan.
  "**/__test-*/**",
];

/** @param {string} value */
function normalizePath(value: string) {
  return value.replaceAll("\\", "/");
}

/**
 * @param {string} pathname
 * @param {string[]} ignore
 */
function shouldIgnore(pathname: string, ignore: string[]) {
  const normalizedPath = normalizePath(pathname);
  return ignore.some((pattern) => {
    const normalizedPattern = normalizePath(pattern);
    if (normalizedPattern.startsWith("**/") && normalizedPattern.endsWith("/**")) {
      const segment = normalizedPattern.slice(3, -3);
      return normalizedPath.includes(`/${segment}/`) || normalizedPath.endsWith(`/${segment}`);
    }
    if (normalizedPattern.startsWith("**/")) {
      const suffix = normalizedPattern.slice(3);
      return normalizedPath.endsWith(`/${suffix}`) || normalizedPath === suffix;
    }
    return normalizedPath.includes(normalizedPattern);
  });
}

export { shouldIgnore };

/*
 * The stream itself lives in `sse.ts`, shared with the live preview origin's channel — the reading
 * of the EventSource contract it encodes (`retry:`, the `id:` that arms `Last-Event-ID`, one reload
 * on resume and none on a first connection) is specified once, in specs/server.md §3.1, and having
 * two of it is how one of them silently stops reconnecting. Re-exported here because `RECONNECT_MS`
 * is part of what this module's consumers already read.
 */
export { RECONNECT_MS } from "./sse.ts";

export const SSE_SCRIPT = `\n<script>new EventSource('/__reload').onmessage=()=>location.reload()</script>`;

/** @param {string} html */
export function injectSSE(html: string) {
  return html.includes("</body>")
    ? html.replace("</body>", `${SSE_SCRIPT}\n</body>`)
    : html + SSE_SCRIPT;
}

/**
 * Create the file watcher + SSE system.
 *
 * @param {string} root - Absolute path to watch
 * @param {BuildEntry[]} builds - Build entries (for selective rebuild)
 * @param {{
 *   ignore?: string[];
 *   debounce?: number;
 *   reloadOnAnyChange?: boolean;
 *   preReload?: (filename: string) => Promise<void> | void;
 * }} [opts]
 * @returns {{
 *   broadcast: () => void;
 *   handleSSE: (request?: Request) => Response;
 *   watcher: import("chokidar").FSWatcher;
 * }}
 */
export function createWatcher(
  root: string,
  builds: BuildEntry[],
  opts: {
    ignore?: string[];
    debounce?: number;
    reloadOnAnyChange?: boolean;
    /** Runs before the reload broadcast — e.g. `jx dev` rebuilds the site here. */
    preReload?: (filename: string) => Promise<void> | void;
  } = {},
) {
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const debounceMs = opts.debounce ?? 50;
  const reloadOnAnyChange = opts.reloadOnAnyChange ?? false;
  const { preReload } = opts;

  const { broadcast, broadcastEvent, handleSSE } = createSseHub();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let fsTimer: ReturnType<typeof setTimeout> | null = null;
  let fsBuffer: FsEventPayload[] = [];
  const fsDebounceMs = 40;
  const watcher = chokidarWatch(root, {
    awaitWriteFinish: {
      pollInterval: 10,
      stabilityThreshold: debounceMs,
    },
    /* See watch-policy.ts: `ignore` is a name rule and cannot see that an entry is a unix socket
       (ENXIO from fs.watch) or a symlink pointing out of the project (a walk of the filesystem). */
    followSymlinks: true,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ignored: createWatchIgnore(root, (watchedPath) => shouldIgnore(watchedPath, ignore)),
  });

  watcher.on("all", (eventType, changedPath) => {
    const filename = relative(root, changedPath);
    if (!filename || filename.startsWith("..")) {
      return;
    }

    // The usage query's cache is invalidated by the filesystem, never by a timer — a delete
    // Confirmation that says "used on 7 pages" must be answering about the tree as it is now.
    invalidateReferenceCache(root);

    // Structured FS events for the studio sidebar (coalesced + batched), emitted as a named "fs"
    // SSE event so the preview iframe ignores them while the studio shell subscribes to them.
    const fsEvent = toFsEvent(eventType, root, changedPath);
    if (fsEvent) {
      fsBuffer = coalesceFsEvents(fsBuffer, fsEvent);
      clearTimeout(fsTimer ?? undefined);
      fsTimer = setTimeout(() => {
        if (fsBuffer.length > 0) {
          broadcastEvent("fs", { events: fsBuffer });
          fsBuffer = [];
        }
      }, fsDebounceMs);
    }

    clearTimeout(timer ?? undefined);
    timer = setTimeout(async () => {
      if (preReload) {
        try {
          await preReload(filename);
        } catch (error) {
          console.error(`[watch] preReload failed: ${(error as Error).message}`);
        }
      }
      if (builds.length > 0) {
        const result = await rebuild(builds, filename);
        if (!result.success) {
          return;
        }
        if (result.rebuilt.length > 0) {
          broadcast();
          return;
        }
      }
      console.log(`Changed  → ${filename}`);
      if (reloadOnAnyChange) {
        broadcast();
      }
    }, debounceMs);
  });

  // Gracefully handle watch errors (e.g. EINVAL on transient Bun test dirs).
  watcher.on("error", (err) => {
    const error = err as Error;
    if (error.message?.includes("EINVAL")) {
      return;
    }
    console.error("[watch] chokidar error:", error.message ?? error);
  });

  return { broadcast, broadcastEvent, handleSSE, watcher };
}
