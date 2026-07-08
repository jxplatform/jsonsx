/**
 * Collab.ts — the dev server's realtime co-editing endpoint (`/__studio/collab`): the reference
 * implementation of the Jx collab wire contract, built on `@jxsuite/collab/room`.
 *
 * Rooms are keyed by server-root-relative path; a room's Y.Text source seeds from the file on disk
 * and writes back (debounced) so every non-collab consumer — preview, live reload, plain editors —
 * keeps working off the real file. Genuinely external file changes (not our own write-back echo)
 * bump the doc's epoch and reset subscribers, per the contract. No persistence beyond the files
 * themselves: this is deliberately a reference implementation.
 */

import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { colorForKey } from "@jxsuite/collab/awareness-types";
import { createCollabHost } from "@jxsuite/collab/room";
import { assertAccessible } from "./studio-api";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { HostConnection } from "@jxsuite/collab/room";

const WRITE_BACK_DEBOUNCE_MS = 800;
const EMPTY_ROOM_GRACE_MS = 30_000;

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "bmp",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "webm",
  "wav",
  "ogg",
  "pdf",
  "zip",
  "gz",
]);

function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export interface CollabSocketData {
  connection: HostConnection | null;
}

export interface CollabRegistry {
  /**
   * Handle a request to /__studio/collab: WebSocket upgrades become collab connections; a plain GET
   * answers the capability probe. Returns undefined when the upgrade was accepted (Bun sends the
   * 101 itself).
   */
  handleRequest: (
    req: Request,
    server: { upgrade: (req: Request, opts: { data: CollabSocketData }) => boolean },
  ) => Response | undefined;
  /** Bun.serve websocket handlers backing the upgraded connections. */
  websocket: WebSocketHandler<CollabSocketData>;
  /** Watcher hook: a file changed on disk (absolute path). Echoes of our write-back are ignored. */
  handleExternalChange: (absPath: string) => void;
  /** Flush pending write-backs and tear everything down. */
  stop: () => Promise<void>;
}

export function createCollabRegistry(opts: {
  absRoot: string;
  activeProjectRoot: () => string | null;
}): CollabRegistry {
  const { absRoot } = opts;
  let connectionCounter = 0;
  let stopped = false;

  const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const destroyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Content we last wrote (or are about to write) per path — the watcher-echo signature. */
  const lastWritten = new Map<string, string>();

  const absPathFor = (relPath: string): string => {
    const abs = resolve(absRoot, relPath);
    assertAccessible(abs, absRoot, opts.activeProjectRoot());
    return abs;
  };

  const relPathFor = (absPath: string): string => {
    const rel = absPath.startsWith(absRoot)
      ? absPath.slice(absRoot.length).replace(/^\/+/, "")
      : absPath;
    return rel.replaceAll("\\", "/");
  };

  const persist = async (path: string): Promise<void> => {
    const source = host.sourceOf(path);
    if (source === null) {
      return;
    }
    if (lastWritten.get(path) === source) {
      return;
    }
    lastWritten.set(path, source);
    try {
      await writeFile(absPathFor(path), source, "utf8");
    } catch {
      // Disk write failures leave the room live; the next change retries.
    }
  };

  const host = createCollabHost({
    loadSource: async (path) => {
      try {
        return await readFile(absPathFor(path), "utf8");
      } catch {
        return null;
      }
    },
    onEmpty: (path) => {
      const existing = destroyTimers.get(path);
      if (existing) {
        clearTimeout(existing);
      }
      destroyTimers.set(
        path,
        setTimeout(() => {
          destroyTimers.delete(path);
          void persist(path).then(() => host.destroyRoomIfEmpty(path));
        }, EMPTY_ROOM_GRACE_MS),
      );
    },
    onFlush: (path) => {
      const timer = writeTimers.get(path);
      if (timer) {
        clearTimeout(timer);
        writeTimers.delete(path);
      }
      return persist(path);
    },
    onSourceChange: (path) => {
      const existing = writeTimers.get(path);
      if (existing) {
        clearTimeout(existing);
      }
      writeTimers.set(
        path,
        setTimeout(() => {
          writeTimers.delete(path);
          void persist(path);
        }, WRITE_BACK_DEBOUNCE_MS),
      );
    },
    rejectPath: (path) => {
      if (isBinaryPath(path)) {
        return "binary-file";
      }
      try {
        absPathFor(path);
        return null;
      } catch {
        return "content-not-loaded";
      }
    },
  });

  return {
    handleExternalChange(absPath) {
      const path = relPathFor(absPath);
      if (host.subscriberCount(path) === 0 && host.sourceOf(path) === null) {
        return;
      }
      void (async () => {
        let content: string | null = null;
        try {
          content = await readFile(absPathFor(path), "utf8");
        } catch {
          content = null;
        }
        // Our own write-back (or a no-op save) is not an external change.
        if (
          content !== null &&
          (content === lastWritten.get(path) || content === host.sourceOf(path))
        ) {
          return;
        }
        host.resetDoc(path);
      })();
    },

    handleRequest(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = server.upgrade(req, { data: { connection: null } });
        return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
      }
      return Response.json({ collab: true, version: 1 });
    },

    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const timer of writeTimers.values()) {
        clearTimeout(timer);
      }
      for (const timer of destroyTimers.values()) {
        clearTimeout(timer);
      }
      const flushes: Promise<void>[] = [];
      for (const path of writeTimers.keys()) {
        flushes.push(persist(path));
      }
      writeTimers.clear();
      destroyTimers.clear();
      await Promise.all(flushes);
      host.destroy();
    },

    websocket: {
      close(ws: ServerWebSocket<CollabSocketData>) {
        ws.data.connection?.close();
        ws.data.connection = null;
      },
      message(ws: ServerWebSocket<CollabSocketData>, message: string | Buffer) {
        if (typeof message === "string") {
          return;
        }
        ws.data.connection?.handleMessage(new Uint8Array(message));
      },
      open(ws: ServerWebSocket<CollabSocketData>) {
        connectionCounter += 1;
        const login = `local-${connectionCounter}`;
        ws.data.connection = host.connect(
          {
            close: () => ws.close(),
            send: (data) => {
              ws.send(data);
            },
          },
          { color: colorForKey(login), login, permission: "write" },
        );
      },
    },
  };
}
