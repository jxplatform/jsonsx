/**
 * The browser half of the wire envelope: one WebSocket per project, multiplexing every open
 * document. `createWsCollabConnection` owns the socket (exponential-backoff reconnect, re-open of
 * live docs on reconnect), the shared project-level Awareness, and per-doc sync state;
 * `openDoc(path)` hands out {@link CollabHandle}s for `StudioPlatform.collab`.
 */

import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { decodeFrame, encodeFrame } from "./envelope.ts";
import type { CollabFrame, ControlMessage } from "./envelope.ts";
import type { CollabHandle, CollabIdentity, CollabStatus } from "./provider.ts";

/** The subset of the WebSocket API the connection uses (injectable for tests). */
export interface WsLike {
  binaryType: string;
  readyState: number;
  send: (data: Uint8Array) => void;
  close: () => void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface WsCollabConnectionOptions {
  /** The ws(s):// endpoint for this project's collab socket. */
  url: string;
  /** WebSocket constructor override (tests, non-browser runtimes). */
  webSocketImpl?: new (url: string) => WsLike;
  /**
   * Called when the server refuses a doc with content-not-loaded: hydrate the file over HTTP (which
   * caches it server-side) so the retry can seed. One retry per open.
   */
  hydratePath?: (path: string) => Promise<void>;
  /** Give up on an openDoc after this long (falls back to solo editing). */
  openTimeoutMs?: number;
  /** Initial reconnect backoff (doubles to 30s). */
  reconnectDelayMs?: number;
}

export interface WsCollabConnection {
  openDoc: (path: string) => Promise<CollabHandle | null>;
  status: () => CollabStatus;
  destroy: () => void;
}

const WS_OPEN = 1;

interface DocEntry {
  doc: Y.Doc;
  epoch: number;
  opened: boolean;
  synced: boolean;
  hydrated: boolean;
  resolveOpen: ((ok: boolean) => void) | null;
  resolveSynced: () => void;
  whenSynced: Promise<void>;
  resetCbs: Set<() => void>;
  pendingFlush: Set<() => void>;
  handleDestroyed: boolean;
  /** Latest room-level dirty state from the server (survives reconnect on the same entry). */
  dirty: boolean;
  dirtyCbs: Set<(dirty: boolean) => void>;
}

export function createWsCollabConnection(options: WsCollabConnectionOptions): WsCollabConnection {
  const WebSocketCtor =
    options.webSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
  const openTimeoutMs = options.openTimeoutMs ?? 10_000;
  const docs = new Map<string, DocEntry>();
  const statusCbs = new Set<(status: CollabStatus) => void>();
  const awarenessDoc = new Y.Doc();
  const awareness = new Awareness(awarenessDoc);
  /* Clear the constructor's implicit {} state: it sits at clock 0, which applyAwarenessUpdate on
     the receiving side can never apply (currClock 0 < clock 0 is false) — publishing it would
     poison the server's controlled-id tracking. Real state arrives via setLocalState (clock ≥ 2). */
  awareness.setLocalState(null);

  let socket: WsLike | null = null;
  let identity: CollabIdentity | null = null;
  let status: CollabStatus = "connecting";
  let destroyed = false;
  let retryMs = options.reconnectDelayMs ?? 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (next: CollabStatus) => {
    if (status === next) {
      return;
    }
    status = next;
    for (const cb of statusCbs) {
      cb(next);
    }
  };

  const sendFrame = (frame: CollabFrame) => {
    if (socket && socket.readyState === WS_OPEN) {
      try {
        socket.send(encodeFrame(frame));
      } catch {
        // The close handler owns recovery.
      }
    }
  };

  const sendOpen = (path: string) => {
    sendFrame({ message: { path, type: "open" }, type: "control" });
  };

  // Local awareness changes always go to the wire (queued sends drop; awareness self-heals on
  // Reconnect via the full-state re-publish below).
  awareness.on(
    "update",
    (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === "remote") {
        return;
      }
      const changed = [...changes.added, ...changes.updated, ...changes.removed];
      sendFrame({ body: encodeAwarenessUpdate(awareness, changed), type: "awareness" });
    },
  );

  const handleControl = (message: ControlMessage) => {
    switch (message.type) {
      case "hello": {
        identity = {
          color: message.color,
          login: message.login,
          permission: message.permission,
          ...(message.name === undefined ? {} : { name: message.name }),
          ...(message.avatarUrl === undefined ? {} : { avatarUrl: message.avatarUrl }),
        };
        return;
      }
      case "opened": {
        const entry = docs.get(message.path);
        if (!entry) {
          return;
        }
        if (entry.opened && entry.epoch !== message.epoch) {
          // The doc's history moved while we were away: this handle is dead.
          fireReset(message.path, entry);
          return;
        }
        entry.epoch = message.epoch;
        entry.opened = true;
        entry.resolveOpen?.(true);
        entry.resolveOpen = null;
        // Client-initiated step1 (mirrors y-websocket): fetch the server's state.
        const body = encoding.createEncoder();
        syncProtocol.writeSyncStep1(body, entry.doc);
        sendFrame({
          body: encoding.toUint8Array(body),
          epoch: entry.epoch,
          path: message.path,
          type: "doc-sync",
        });
        return;
      }
      case "doc-reset": {
        const entry = docs.get(message.path);
        if (entry) {
          fireReset(message.path, entry);
        }
        return;
      }
      case "flush-ack": {
        const entry = docs.get(message.path);
        if (entry) {
          for (const resolve of entry.pendingFlush) {
            resolve();
          }
          entry.pendingFlush.clear();
        }
        return;
      }
      case "doc-dirty": {
        const entry = docs.get(message.path);
        if (entry) {
          entry.dirty = message.dirty;
          for (const cb of entry.dirtyCbs) {
            cb(message.dirty);
          }
        }
        return;
      }
      case "error": {
        if (!message.path) {
          return;
        }
        const entry = docs.get(message.path);
        if (!entry) {
          return;
        }
        if (message.code === "content-not-loaded" && options.hydratePath && !entry.hydrated) {
          entry.hydrated = true;
          void options.hydratePath(message.path).then(
            () => sendOpen(message.path!),
            () => {
              entry.resolveOpen?.(false);
              entry.resolveOpen = null;
            },
          );
          return;
        }
        if (!entry.opened) {
          // Fatal refusal (binary-file, too-large, unresolved hydration): fall back to solo.
          entry.resolveOpen?.(false);
          entry.resolveOpen = null;
        }
        break;
      }
      default: {
        break;
      }
    }
  };

  const handleDocSync = (path: string, epoch: number, body: Uint8Array) => {
    const entry = docs.get(path);
    if (!entry || !entry.opened || entry.epoch !== epoch) {
      return;
    }
    const decoder = decoding.createDecoder(body);
    const reply = encoding.createEncoder();
    const messageType = syncProtocol.readSyncMessage(decoder, reply, entry.doc, "remote");
    if (encoding.length(reply) > 0) {
      sendFrame({ body: encoding.toUint8Array(reply), epoch, path, type: "doc-sync" });
    }
    if (messageType === syncProtocol.messageYjsSyncStep2 && !entry.synced) {
      entry.synced = true;
      entry.resolveSynced();
    }
  };

  const fireReset = (path: string, entry: DocEntry) => {
    docs.delete(path);
    entry.resolveOpen?.(false);
    entry.resolveOpen = null;
    for (const cb of entry.resetCbs) {
      cb();
    }
    entry.doc.destroy();
  };

  const connect = () => {
    if (destroyed) {
      return;
    }
    setStatus("connecting");
    const ws = new WebSocketCtor(options.url);
    socket = ws;
    ws.binaryType = "arraybuffer";
    /* Each connect() builds a FRESH socket; single-assignment handlers are the point (and keep
       the injectable WsLike test surface minimal). */
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    ws.onopen = () => {
      retryMs = options.reconnectDelayMs ?? 1000;
      setStatus("connected");
      // Re-open every live doc and re-publish our awareness state.
      for (const path of docs.keys()) {
        sendOpen(path);
      }
      const local = awareness.getLocalState();
      if (local !== null) {
        sendFrame({
          body: encodeAwarenessUpdate(awareness, [awareness.clientID]),
          type: "awareness",
        });
      }
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    ws.onmessage = (event) => {
      const raw = event.data;
      const data =
        raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw instanceof Uint8Array ? raw : null;
      if (!data) {
        return;
      }
      let frame: CollabFrame;
      try {
        frame = decodeFrame(data);
      } catch {
        return;
      }
      switch (frame.type) {
        case "control": {
          handleControl(frame.message);
          return;
        }
        case "doc-sync": {
          handleDocSync(frame.path, frame.epoch, frame.body);
          return;
        }
        case "awareness": {
          applyAwarenessUpdate(awareness, frame.body, "remote");
          break;
        }
        default: {
          break;
        }
      }
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    ws.onclose = () => {
      if (destroyed) {
        return;
      }
      setStatus("offline");
      for (const entry of docs.values()) {
        entry.opened = false;
      }
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    ws.onerror = () => {
      // The close handler follows and owns retry.
    };
  };
  connect();

  return {
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      removeAwarenessStates(awareness, [awareness.clientID], "destroy");
      awareness.destroy();
      awarenessDoc.destroy();
      for (const [path, entry] of docs) {
        entry.resolveOpen?.(false);
        entry.doc.destroy();
        docs.delete(path);
      }
      socket?.close();
    },

    async openDoc(path: string): Promise<CollabHandle | null> {
      if (destroyed) {
        return null;
      }
      const existing = docs.get(path);
      if (existing && !existing.handleDestroyed) {
        return null;
      }
      let resolveSynced: () => void = () => {};
      const whenSynced = new Promise<void>((resolve) => {
        resolveSynced = resolve;
      });
      const entry: DocEntry = {
        dirty: false,
        dirtyCbs: new Set(),
        doc: new Y.Doc(),
        epoch: 0,
        handleDestroyed: false,
        hydrated: false,
        opened: false,
        pendingFlush: new Set(),
        resetCbs: new Set(),
        resolveOpen: null,
        resolveSynced,
        synced: false,
        whenSynced,
      };
      docs.set(path, entry);

      // Local doc updates go to the wire (unless they came FROM the wire).
      entry.doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === "remote" || !entry.opened) {
          return;
        }
        const body = encoding.createEncoder();
        syncProtocol.writeUpdate(body, update);
        sendFrame({
          body: encoding.toUint8Array(body),
          epoch: entry.epoch,
          path,
          type: "doc-sync",
        });
      });

      const openedOk = await new Promise<boolean>((resolve) => {
        entry.resolveOpen = resolve;
        const timer = setTimeout(() => {
          entry.resolveOpen = null;
          resolve(false);
        }, openTimeoutMs);
        entry.resolveOpen = (ok) => {
          clearTimeout(timer);
          resolve(ok);
        };
        sendOpen(path);
      });
      if (!openedOk) {
        if (docs.get(path) === entry) {
          docs.delete(path);
        }
        entry.doc.destroy();
        return null;
      }

      const handle: CollabHandle = {
        awareness,
        destroy: () => {
          if (entry.handleDestroyed) {
            return;
          }
          entry.handleDestroyed = true;
          if (docs.get(path) === entry) {
            docs.delete(path);
            sendFrame({ path, type: "doc-close" });
          }
          entry.doc.destroy();
        },
        doc: entry.doc,
        flush: () =>
          new Promise<void>((resolve) => {
            entry.pendingFlush.add(resolve);
            sendFrame({ message: { path, type: "flush" }, type: "control" });
          }),
        identity: () => identity,
        onDirty: (cb) => {
          entry.dirtyCbs.add(cb);
          // Deliver current state synchronously: the server's open-handshake `doc-dirty` may have
          // Already landed before the caller subscribes, and it must not miss the initial value.
          cb(entry.dirty);
          return () => entry.dirtyCbs.delete(cb);
        },
        onReset: (cb) => {
          entry.resetCbs.add(cb);
          return () => entry.resetCbs.delete(cb);
        },
        onStatus: (cb) => {
          statusCbs.add(cb);
          return () => statusCbs.delete(cb);
        },
        whenSynced: entry.whenSynced,
      };
      return handle;
    },

    status: () => status,
  };
}
