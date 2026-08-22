/** Watch.js — File watcher + SSE live reload */

import { watch as chokidarWatch } from "chokidar";
import { relative } from "node:path";
import { rebuild } from "./build.ts";
import { coalesceFsEvents, toFsEvent } from "./refactor/fs-events.ts";
import { createWatchIgnore } from "./watch-policy.ts";
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

/**
 * Reconnection time advertised on the stream, in milliseconds (HTML Standard, `retry:`).
 *
 * The default is user-agent defined and measured in seconds, which on a dev server restart is long
 * enough for a save to look like it did nothing. Both endpoints are on loopback, so a reconnect
 * costs nothing and half a second lands inside a typical restart.
 */
export const RECONNECT_MS = 500;

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

  const clients = new Set<(msg: string) => void>();
  const encoder = new TextEncoder();

  /*
   * Monotonic reload counter, sent as the SSE `id:` of every reload frame.
   *
   * Its only job is to arm the browser: a stream that has never sent an `id:` makes the client omit
   * `Last-Event-ID` on reconnect, and then the server cannot tell a first connection from a
   * reconnection. **Nothing is buffered against it and nothing is replayed.** A reconnecting client
   * gets exactly one reload, because the page it is holding was built before the disconnect and a
   * full reload subsumes every event it missed — one is as correct as a hundred and finishes
   * sooner. Do not "complete" this into a replay buffer; there is no per-event state to replay.
   */
  let lastEventId = 0;

  function broadcast() {
    lastEventId += 1;
    const frame = `id: ${lastEventId}\ndata: reload\n\n`;
    for (const send of clients) {
      send(frame);
    }
  }

  /**
   * Send a _named_ SSE event. The preview iframe only listens to the default (unnamed) `onmessage`,
   * so named events (e.g. "fs") reach the studio shell without triggering a preview reload.
   */
  function broadcastEvent(event: string, payload: unknown) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const send of clients) {
      send(frame);
    }
  }

  /**
   * Open the live-reload stream.
   *
   * Two halves of the HTML Standard's EventSource contract that were missing, and are the whole of
   * `gap:sse-reconnect`:
   *
   * - **`retry:`** sets the reconnection time. The default is user-agent defined and is measured in
   *   seconds; during a dev-server restart that is long enough to watch a save do nothing. 500ms is
   *   loopback, so the reconnect costs nothing and lands inside the restart.
   * - **`Last-Event-ID`** is how the browser says "I was here before". It gets **one** reload and no
   *   replay — see the note on `lastEventId`. A dev server has no event log and needs none: the
   *   reload is idempotent and total.
   *
   * @param {Request} [request] - The stream request; read only for its `Last-Event-ID`
   * @returns {Response}
   */
  function handleSSE(request?: Request) {
    const resuming = (request?.headers.get("Last-Event-ID") ?? "") !== "";
    /** @type {((msg: string) => void) | undefined} */
    let send: ((msg: string) => void) | undefined;
    const stream = new ReadableStream({
      cancel() {
        if (send) {
          clients.delete(send);
        }
      },
      start(c) {
        send = (msg: string) => {
          try {
            c.enqueue(encoder.encode(msg));
          } catch {}
        };
        clients.add(send);
        // The retry interval is a stream-level field, so it is set once, before any event.
        send(`retry: ${RECONNECT_MS}\n\n`);
        if (resuming) {
          lastEventId += 1;
          send(`id: ${lastEventId}\ndata: reload\n\n`);
        }
        const hb = setInterval(() => {
          try {
            c.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            clearInterval(hb);
          }
        }, 15_000);
      },
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      },
    });
  }

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
