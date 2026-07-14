/**
 * Transport-agnostic collab host: the server half of the wire envelope, shared by the Bun dev
 * server and the Cloudflare platform DO. The embedder supplies sockets ({@link RoomSocket}),
 * identity per connection, and source loading; the host owns rooms (one Y.Doc per path,
 * server-seeded `source` per the schema contract), the y-protocols sync handshake, project-level
 * awareness relay, read-only enforcement, and the docEpoch/doc-reset lifecycle.
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
import type { CollabIdentity } from "./provider.ts";
import { sourceText } from "./schema.ts";

export interface RoomSocket {
  send: (data: Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
}

export interface CollabHostOptions {
  /** Current file text for seeding a room's source, or null when unavailable. */
  loadSource: (path: string) => Promise<string | null>;
  /** Refuse a path with an error code (e.g. "binary-file"), or null to allow. */
  rejectPath?: (path: string) => string | null;
  /** A room's source text changed (debounce and persist in the embedder). */
  onSourceChange?: (path: string) => void;
  /** A client asked to persist this path now; resolve when durable. */
  onFlush?: (path: string) => Promise<void> | void;
  /** The last subscriber left a room (schedule teardown in the embedder). */
  onEmpty?: (path: string) => void;
}

interface Room {
  doc: Y.Doc;
  epoch: number;
  subscribers: Set<HostConnection>;
  ready: Promise<void>;
  /** The source text as of the last persist (seed or markPersisted) — the room-dirty baseline. */
  baseline: string;
  /** True while the live source differs from `baseline`; mirrored to peers via `doc-dirty`. */
  dirty: boolean;
}

export interface HostConnection {
  handleMessage: (data: Uint8Array) => void;
  close: () => void;
}

export interface CollabHost {
  connect: (socket: RoomSocket, identity: CollabIdentity) => HostConnection;
  /**
   * Out-of-band content replacement: bump the path's epoch, drop its Y history, and tell every
   * subscriber to re-open. The invariant "Y history never dies without an epoch bump" lives here.
   */
  resetDoc: (path: string) => void;
  /** The room's current source text, or null when no room is live. */
  sourceOf: (path: string) => string | null;
  /** Live subscriber count (0 when the room is absent). */
  subscriberCount: (path: string) => number;
  /** Destroy an empty room (embedder teardown after its grace period). */
  destroyRoomIfEmpty: (path: string) => void;
  /**
   * The embedder folded the room's source to durable storage: reset the dirty baseline to the
   * current source and broadcast `doc-dirty{false}` to every subscriber. Called from `onFlush`
   * after a successful write.
   */
  markPersisted: (path: string) => void;
  destroy: () => void;
}

export function createCollabHost(options: CollabHostOptions): CollabHost {
  const rooms = new Map<string, Room>();
  /** Epochs survive room teardown so re-opened docs never reuse a dead history's epoch. */
  const epochs = new Map<string, number>();
  const connections = new Set<InternalConnection>();
  const awarenessDoc = new Y.Doc();
  const awareness = new Awareness(awarenessDoc);
  // The host's own (empty) local state must not leak into rosters.
  awareness.setLocalState(null);

  interface InternalConnection extends HostConnection {
    socket: RoomSocket;
    identity: CollabIdentity;
    subscribed: Set<string>;
    /** Awareness clientIDs this socket controls (removed on close). */
    controlledIds: Set<number>;
    warnedReadOnly: boolean;
    closed: boolean;
  }

  const send = (conn: InternalConnection, frame: CollabFrame) => {
    try {
      conn.socket.send(encodeFrame(frame));
    } catch {
      // A dying socket cleans up through its close handler.
    }
  };

  const sendControl = (conn: InternalConnection, message: ControlMessage) => {
    send(conn, { message, type: "control" });
  };

  const broadcastToRoom = (room: Room, frame: CollabFrame, except?: InternalConnection) => {
    const data = encodeFrame(frame);
    for (const subscriber of room.subscribers) {
      const target = subscriber as InternalConnection;
      if (target !== except && !target.closed) {
        try {
          target.socket.send(data);
        } catch {
          // Skip dying sockets.
        }
      }
    }
  };

  const ensureRoom = (path: string): Room => {
    const existing = rooms.get(path);
    if (existing) {
      return existing;
    }
    const doc = new Y.Doc();
    const epoch = epochs.get(path) ?? 0;
    epochs.set(path, epoch);
    const room: Room = {
      baseline: "",
      dirty: false,
      doc,
      epoch,
      ready: Promise.resolve(),
      subscribers: new Set(),
    };
    room.ready = (async () => {
      const source = await options.loadSource(path);
      if (source === null) {
        throw new Error("content-not-loaded");
      }
      // The seeded text IS the on-disk state — the initial clean baseline.
      room.baseline = source;
      doc.transact(() => {
        sourceText(doc).insert(0, source);
      }, "seed");
    })();
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const current = rooms.get(path);
      if (!current || current.doc !== doc) {
        return;
      }
      const body = encoding.createEncoder();
      syncProtocol.writeUpdate(body, update);
      broadcastToRoom(
        current,
        { body: encoding.toUint8Array(body), epoch: current.epoch, path, type: "doc-sync" },
        origin instanceof Object && "socket" in origin ? (origin as InternalConnection) : undefined,
      );
      options.onSourceChange?.(path);
      // Room-level dirty: broadcast on transition so every peer's Save affordance stays in sync.
      const nowDirty = sourceText(current.doc).toString() !== current.baseline;
      if (nowDirty !== current.dirty) {
        current.dirty = nowDirty;
        broadcastToRoom(current, {
          message: { dirty: nowDirty, path, type: "doc-dirty" },
          type: "control",
        });
      }
    });
    rooms.set(path, room);
    return room;
  };

  const handleOpen = async (conn: InternalConnection, path: string) => {
    const rejection = options.rejectPath?.(path) ?? null;
    if (rejection) {
      sendControl(conn, { code: rejection, message: `Refused: ${rejection}`, path, type: "error" });
      return;
    }
    const room = ensureRoom(path);
    try {
      await room.ready;
    } catch {
      rooms.delete(path);
      sendControl(conn, {
        code: "content-not-loaded",
        message: "The file is not available for co-editing yet",
        path,
        type: "error",
      });
      return;
    }
    if (conn.closed || rooms.get(path) !== room) {
      return;
    }
    room.subscribers.add(conn);
    conn.subscribed.add(path);
    sendControl(conn, { epoch: room.epoch, path, type: "opened" });
    // The joiner learns the room's current unsaved state (it may join a room others have dirtied).
    sendControl(conn, { dirty: room.dirty, path, type: "doc-dirty" });
    // Server-initiated step1: learn the client's state (it replies step2 + its own step1).
    const body = encoding.createEncoder();
    syncProtocol.writeSyncStep1(body, room.doc);
    send(conn, { body: encoding.toUint8Array(body), epoch: room.epoch, path, type: "doc-sync" });
  };

  const handleDocSync = (
    conn: InternalConnection,
    path: string,
    epoch: number,
    body: Uint8Array,
  ) => {
    const room = rooms.get(path);
    if (!room || !conn.subscribed.has(path) || epoch !== room.epoch) {
      sendControl(conn, {
        epoch: epochs.get(path) ?? 0,
        path,
        type: "doc-reset",
      });
      return;
    }
    const decoder = decoding.createDecoder(body);
    const messageType = decoding.readVarUint(decoder);
    const readOnly = conn.identity.permission === "read";
    if (readOnly && messageType !== syncProtocol.messageYjsSyncStep1) {
      if (!conn.warnedReadOnly) {
        conn.warnedReadOnly = true;
        sendControl(conn, {
          code: "read-only",
          message: "Write access required",
          path,
          type: "error",
        });
      }
      return;
    }
    const reply = encoding.createEncoder();
    switch (messageType) {
      case syncProtocol.messageYjsSyncStep1: {
        syncProtocol.readSyncStep1(decoder, reply, room.doc);
        break;
      }
      case syncProtocol.messageYjsSyncStep2: {
        syncProtocol.readSyncStep2(decoder, room.doc, conn);
        break;
      }
      case syncProtocol.messageYjsUpdate: {
        syncProtocol.readUpdate(decoder, room.doc, conn);
        break;
      }
      default: {
        return;
      }
    }
    if (encoding.length(reply) > 0) {
      send(conn, { body: encoding.toUint8Array(reply), epoch: room.epoch, path, type: "doc-sync" });
    }
  };

  const handleAwareness = (conn: InternalConnection, body: Uint8Array) => {
    // Track which clientIDs this socket controls so its states drop on close.
    try {
      const decoder = decoding.createDecoder(body);
      const count = decoding.readVarUint(decoder);
      for (let i = 0; i < count; i++) {
        conn.controlledIds.add(decoding.readVarUint(decoder));
        decoding.readVarUint(decoder);
        decoding.readVarString(decoder);
      }
    } catch {
      return;
    }
    applyAwarenessUpdate(awareness, body, conn);
    const data = encodeFrame({ body, type: "awareness" });
    for (const other of connections) {
      if (other !== conn && !other.closed) {
        try {
          other.socket.send(data);
        } catch {
          // Skip dying sockets.
        }
      }
    }
  };

  const unsubscribe = (conn: InternalConnection, path: string) => {
    const room = rooms.get(path);
    conn.subscribed.delete(path);
    if (room) {
      room.subscribers.delete(conn);
      if (room.subscribers.size === 0) {
        options.onEmpty?.(path);
      }
    }
  };

  return {
    connect(socket, identity) {
      const conn: InternalConnection = {
        close: () => {
          if (conn.closed) {
            return;
          }
          conn.closed = true;
          // Detached copy: unsubscribe mutates the set mid-walk.
          const paths = [...conn.subscribed];
          for (const path of paths) {
            unsubscribe(conn, path);
          }
          connections.delete(conn);
          // Only ids the awareness actually adopted can be removed/encoded (a client may have
          // Announced ids whose updates were stale and never applied).
          const known = [...conn.controlledIds].filter((id) => awareness.meta.has(id));
          if (known.length > 0) {
            removeAwarenessStates(awareness, known, "disconnect");
            const removal = encodeAwarenessUpdate(awareness, known);
            const data = encodeFrame({ body: removal, type: "awareness" });
            for (const other of connections) {
              if (!other.closed) {
                try {
                  other.socket.send(data);
                } catch {
                  // Skip dying sockets.
                }
              }
            }
          }
        },
        closed: false,
        controlledIds: new Set(),
        handleMessage: (data) => {
          let frame: CollabFrame;
          try {
            frame = decodeFrame(data);
          } catch {
            sendControl(conn, {
              code: "unknown-frame",
              message: "Malformed frame",
              type: "error",
            });
            return;
          }
          switch (frame.type) {
            case "control": {
              const { message } = frame;
              if (message.type === "open") {
                void handleOpen(conn, message.path);
              } else if (message.type === "flush") {
                void (async () => {
                  await options.onFlush?.(message.path);
                  sendControl(conn, { path: message.path, type: "flush-ack" });
                })();
              }
              return;
            }
            case "doc-sync": {
              handleDocSync(conn, frame.path, frame.epoch, frame.body);
              return;
            }
            case "doc-close": {
              unsubscribe(conn, frame.path);
              return;
            }
            default: {
              // The only remaining variant is the awareness frame.
              handleAwareness(conn, frame.body);
            }
          }
        },
        identity,
        socket,
        subscribed: new Set(),
        warnedReadOnly: false,
      };
      connections.add(conn);
      sendControl(conn, {
        color: identity.color,
        login: identity.login,
        permission: identity.permission,
        type: "hello",
        ...(identity.name === undefined ? {} : { name: identity.name }),
        ...(identity.avatarUrl === undefined ? {} : { avatarUrl: identity.avatarUrl }),
      });
      // Late joiners receive the current presence roster immediately.
      const states = awareness.getStates();
      if (states.size > 0) {
        send(conn, {
          body: encodeAwarenessUpdate(awareness, [...states.keys()]),
          type: "awareness",
        });
      }
      return conn;
    },

    destroy() {
      // Detached copy: close() removes connections mid-walk.
      const live = [...connections];
      for (const conn of live) {
        conn.close();
      }
      for (const room of rooms.values()) {
        room.doc.destroy();
      }
      rooms.clear();
      awareness.destroy();
      awarenessDoc.destroy();
    },

    destroyRoomIfEmpty(path) {
      const room = rooms.get(path);
      if (room && room.subscribers.size === 0) {
        room.doc.destroy();
        rooms.delete(path);
      }
    },

    markPersisted(path) {
      const room = rooms.get(path);
      if (!room) {
        return;
      }
      room.baseline = sourceText(room.doc).toString();
      if (room.dirty) {
        room.dirty = false;
        broadcastToRoom(room, {
          message: { dirty: false, path, type: "doc-dirty" },
          type: "control",
        });
      }
    },

    resetDoc(path) {
      const nextEpoch = (epochs.get(path) ?? 0) + 1;
      epochs.set(path, nextEpoch);
      const room = rooms.get(path);
      if (!room) {
        return;
      }
      broadcastToRoom(room, {
        message: { epoch: nextEpoch, path, type: "doc-reset" },
        type: "control",
      });
      for (const subscriber of room.subscribers) {
        (subscriber as InternalConnection).subscribed.delete(path);
      }
      room.doc.destroy();
      rooms.delete(path);
    },

    sourceOf(path) {
      const room = rooms.get(path);
      return room ? sourceText(room.doc).toString() : null;
    },

    subscriberCount(path) {
      return rooms.get(path)?.subscribers.size ?? 0;
    },
  };
}
