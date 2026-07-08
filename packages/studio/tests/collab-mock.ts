/**
 * In-memory collab provider for studio tests: a hub holds one "server" Y.Doc per path; every handle
 * wires bidirectional updates and awareness to it, no sockets involved. Mirrors the real provider
 * contract (whenSynced, identity from hello, flush, onStatus/onReset, destroy).
 */

import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { CollabHandle, CollabIdentity, CollabStatus } from "@jxsuite/collab/provider";

interface Connection {
  doc: Y.Doc;
  awareness: Awareness;
  statusCbs: Set<(status: CollabStatus) => void>;
  resetCbs: Set<() => void>;
  destroyed: boolean;
}

export interface MockCollabHub {
  capability: (docPath: string) => Promise<CollabHandle | null>;
  /** The hub-side authoritative doc for a path (created on first open). */
  serverDoc: (path: string) => Y.Doc;
  /** Fire a doc-reset for every live handle on this path (fresh server doc next open). */
  reset: (path: string) => void;
  /** Push a connection status to every live handle on this path. */
  setStatus: (path: string, status: CollabStatus) => void;
  /** Paths flushed via handle.flush(), in order. */
  flushes: string[];
  /** Live handle count per path. */
  connectionCount: (path: string) => number;
}

export function createMockCollabHub(
  opts: {
    identity?: Partial<CollabIdentity>;
    /** Paths the provider refuses (capability resolves null). */
    refuse?: string[];
    /** Delay whenSynced forever (sync-timeout testing). */
    neverSync?: boolean;
  } = {},
): MockCollabHub {
  const servers = new Map<string, Y.Doc>();
  const connections = new Map<string, Set<Connection>>();
  const flushes: string[] = [];
  const refuse = new Set(opts.refuse);

  const identity: CollabIdentity = {
    color: "#4f9cf9",
    login: "octocat",
    permission: "write",
    ...opts.identity,
  };

  const serverDoc = (path: string): Y.Doc => {
    let doc = servers.get(path);
    if (!doc) {
      doc = new Y.Doc();
      servers.set(path, doc);
    }
    return doc;
  };

  const connsFor = (path: string): Set<Connection> => {
    let set = connections.get(path);
    if (!set) {
      set = new Set();
      connections.set(path, set);
    }
    return set;
  };

  const capability = (docPath: string): Promise<CollabHandle | null> => {
    if (refuse.has(docPath)) {
      return Promise.resolve(null);
    }
    const server = serverDoc(docPath);
    const conns = connsFor(docPath);
    const conn: Connection = {
      awareness: new Awareness(new Y.Doc()),
      destroyed: false,
      doc: new Y.Doc(),
      resetCbs: new Set(),
      statusCbs: new Set(),
    };

    const clientListener = (update: Uint8Array, origin: unknown) => {
      if (origin !== "mock-hub" && !conn.destroyed) {
        Y.applyUpdate(server, update, conn);
      }
    };
    const serverListener = (update: Uint8Array, origin: unknown) => {
      if (origin !== conn && !conn.destroyed) {
        Y.applyUpdate(conn.doc, update, "mock-hub");
      }
    };
    conn.doc.on("update", clientListener);
    server.on("update", serverListener);

    const awarenessListener = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === "mock-hub" || conn.destroyed) {
        return;
      }
      const changed = [...changes.added, ...changes.updated, ...changes.removed];
      const update = encodeAwarenessUpdate(conn.awareness, changed);
      for (const other of conns) {
        if (other !== conn && !other.destroyed) {
          applyAwarenessUpdate(other.awareness, update, "mock-hub");
        }
      }
    };
    conn.awareness.on("update", awarenessListener);

    // Initial sync: adopt the server's current state.
    Y.applyUpdate(conn.doc, Y.encodeStateAsUpdate(server), "mock-hub");
    conns.add(conn);

    const handle: CollabHandle = {
      awareness: conn.awareness,
      destroy: () => {
        if (conn.destroyed) {
          return;
        }
        conn.destroyed = true;
        conn.doc.off("update", clientListener);
        server.off("update", serverListener);
        conn.awareness.off("update", awarenessListener);
        conn.awareness.destroy();
        conns.delete(conn);
      },
      doc: conn.doc,
      flush: () => {
        flushes.push(docPath);
        return Promise.resolve();
      },
      identity: () => identity,
      onReset: (cb) => {
        conn.resetCbs.add(cb);
        return () => conn.resetCbs.delete(cb);
      },
      onStatus: (cb) => {
        conn.statusCbs.add(cb);
        return () => conn.statusCbs.delete(cb);
      },
      whenSynced: opts.neverSync ? new Promise<void>(() => {}) : Promise.resolve(),
    };
    return Promise.resolve(handle);
  };

  return {
    capability,
    connectionCount: (path) => connsFor(path).size,
    flushes,
    reset: (path) => {
      servers.delete(path);
      // Detached copy: reset callbacks detach sessions, mutating the set mid-walk.
      const live = [...connsFor(path)];
      for (const conn of live) {
        for (const cb of conn.resetCbs) {
          cb();
        }
      }
    },
    serverDoc,
    setStatus: (path, status) => {
      for (const conn of connsFor(path)) {
        for (const cb of conn.statusCbs) {
          cb(status);
        }
      }
    },
  };
}

/** Flush pending microtasks/timers so async attach flows settle. */
export async function settleCollab(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
