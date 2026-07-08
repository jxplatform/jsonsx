/**
 * Provider contract types — what `StudioPlatform.collab?.(docPath)` resolves to. Type-only on
 * purpose: Studio's base bundle imports this without pulling yjs in; the runtime lives behind a
 * dynamic import of the concrete provider.
 */

import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { CollabPermission } from "./envelope.ts";

export type CollabStatus = "connecting" | "connected" | "offline";

export interface CollabIdentity {
  login: string;
  name?: string;
  avatarUrl?: string;
  color: string;
  permission: CollabPermission;
}

/**
 * A live co-editing session for one document. The Y.Doc starts EMPTY and fills from the provider
 * (server-seeded source; client-derived structure) — never seed it locally before whenSynced.
 */
export interface CollabHandle {
  doc: Y.Doc;
  /** The connection's shared project-level awareness (one instance across all open docs). */
  awareness: Awareness;
  /** Resolves after the initial sync handshake completes for this doc. */
  whenSynced: Promise<void>;
  /** Identity issued by the server's hello; null until the connection greeted. */
  identity: () => CollabIdentity | null;
  /** Ask the provider to persist this doc to durable storage now (Cmd+S). */
  flush: () => Promise<void>;
  /** Connection status changes (shared per connection). Returns an unsubscribe. */
  onStatus: (cb: (status: CollabStatus) => void) => () => void;
  /**
   * The server reset this doc's history (epoch bump after discard/pull/external write). The handle
   * is dead: destroy it and re-acquire a fresh one via platform.collab.
   */
  onReset: (cb: () => void) => () => void;
  destroy: () => void;
}

export type CollabCapability = (docPath: string) => Promise<CollabHandle | null>;
