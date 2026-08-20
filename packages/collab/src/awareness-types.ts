/**
 * The project-level awareness contract. One y-protocols Awareness instance rides each provider
 * connection (not one per document): every client publishes a single state describing who they are
 * and where they're working, which gives file-tree presence for free; per-document cursor overlays
 * filter the same states by focusedPath.
 */

import type { JxPath } from "@jxsuite/schema/types";

export interface CollabUser {
  login: string;
  name?: string;
  avatarUrl?: string;
  /** Presence color, assigned deterministically by the server (hello) or colorForKey. */
  color: string;
}

export interface CollabAwarenessState {
  user: CollabUser;
  /** Project-relative path of the document the client is focused on, or null. */
  focusedPath: string | null;
  /** Which representation the client is editing (drives the Phase-B canonical lock). */
  mode?: "structure" | "source";
  /**
   * The client's structural (canvas) selection in the focused document — the whole SET.
   *
   * A list because `session.selection` is one (studio §6.5): a peer who has selected six cards
   * publishes six paths, and the remote canvas draws a presence box for each. A peer with one node
   * selected publishes a one-entry list, which draws exactly the one box it always did.
   */
  structuralSelection?: JxPath[] | null;
  /**
   * RESERVED for the code view: the in-buffer text cursor as {anchor, head} Y.RelativePosition
   * JSON. `studio/src/collab/monaco-binding.ts`'s bindMonacoToYText owns this field via
   * setLocalStateField("selection", …) while a code view is bound, and sets it back to null when it
   * unbinds; nothing else may write it. The shape is y-monaco's, deliberately — a peer on an older
   * Studio publishes and reads exactly this.
   */
  selection?: { anchor: unknown; head: unknown } | null;
  /**
   * Whether this client may write (from the server hello). Drives reconciler election — the lowest
   * write-capable clientID mirrors derived representations. Advisory only: the server drops updates
   * from read-only sockets regardless.
   */
  canWrite?: boolean;
}

/** Eight distinguishable presence hues (dark-theme friendly). */
export const PRESENCE_PALETTE = [
  "#4f9cf9",
  "#e5484d",
  "#30a46c",
  "#f5a524",
  "#8e4ec6",
  "#00a2c7",
  "#e93d82",
  "#a8845c",
] as const;

/** Deterministic palette pick — the same key always maps to the same color. */
export function colorForKey(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash, 33) + (key.codePointAt(i) ?? 0);
  }
  const index = Math.abs(hash) % PRESENCE_PALETTE.length;
  return PRESENCE_PALETTE[index]!;
}
