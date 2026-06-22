/** Watch.js — File watcher + SSE live reload */

import { watch as chokidarWatch } from "chokidar";
import { relative } from "node:path";
import { rebuild } from "./build.ts";
import { coalesceFsEvents, toFsEvent } from "./refactor/fs-events.ts";
import type { BuildEntry } from "./types.ts";
import type { FsEventPayload } from "./refactor/fs-events.ts";

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/.jx/**",
  "**/.devenv/**",
  "**/.direnv/**",
  "**/bun.lockb",
  "**/bun.lock",
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
 * @param {{ ignore?: string[]; debounce?: number; reloadOnAnyChange?: boolean }} [opts]
 * @returns {{
 *   broadcast: () => void;
 *   handleSSE: () => Response;
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
  } = {},
) {
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const debounceMs = opts.debounce ?? 50;
  const reloadOnAnyChange = opts.reloadOnAnyChange ?? false;

  const clients = new Set<(msg: string) => void>();
  const encoder = new TextEncoder();

  function broadcast() {
    for (const send of clients) {
      send("data: reload\n\n");
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

  function handleSSE() {
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
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ignored: (watchedPath) => shouldIgnore(watchedPath, ignore),
  });

  watcher.on("all", (eventType, changedPath) => {
    const filename = relative(root, changedPath);
    if (!filename || filename.startsWith("..")) {
      return;
    }

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

  return { broadcast, broadcastEvent, handleSSE, watcher };
}
