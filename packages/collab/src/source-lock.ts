/**
 * The canonical-representation lock for source-mode co-editing (the Phase-B dual-representation
 * design). `meta.canonical` says which representation is authoritative: "structure" (the default —
 * canvas/inspector edits flow through the op bridge and the elected reconciler mirrors them into
 * source text) or "source" (Monaco co-edits the Y.Text character-level; structural surfaces
 * soft-freeze and the source reconciler mirrors parses back into the structure tree for live
 * previews).
 *
 * Every flip bumps `meta.canonicalRev`; derived-representation writers stamp the rev they computed
 * against and observers discard stale mirrors. Flips are LWW-idempotent under concurrency: both
 * flippers serialize the same structure, so the merged text converges.
 */

import type { Doc } from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { metaMap, updateSourceText } from "./schema.ts";
import type { CollabAwarenessState } from "./awareness-types.ts";

export type CanonicalRepresentation = "structure" | "source";

export function canonicalOf(doc: Doc): CanonicalRepresentation {
  return metaMap(doc).get("canonical") === "source" ? "source" : "structure";
}

export function canonicalRevOf(doc: Doc): number {
  return Number(metaMap(doc).get("canonicalRev") ?? 0);
}

/**
 * Flip canonical to "source", seeding the text from `serialized` (the flipper's serialization of
 * the current structure). No-op (false) when source already holds the lock.
 */
export function acquireSourceCanonical(doc: Doc, serialized: string, origin: unknown): boolean {
  if (canonicalOf(doc) === "source") {
    return false;
  }
  doc.transact(() => {
    updateSourceText(doc, serialized, origin);
    const meta = metaMap(doc);
    meta.set("canonical", "source");
    meta.set("canonicalRev", canonicalRevOf(doc) + 1);
  }, origin);
  return true;
}

/** Flip canonical back to "structure" (the mirror is the caller's responsibility beforehand). */
export function releaseSourceCanonical(doc: Doc, origin: unknown): boolean {
  if (canonicalOf(doc) !== "source") {
    return false;
  }
  doc.transact(() => {
    const meta = metaMap(doc);
    meta.set("canonical", "structure");
    meta.set("canonicalRev", canonicalRevOf(doc) + 1);
  }, origin);
  return true;
}

/** Peers (excluding `selfClientId`) currently source-editing this doc, per awareness. */
export function otherSourceEditors(
  awareness: Awareness,
  path: string,
  selfClientId: number,
): number[] {
  const editors: number[] = [];
  for (const [clientId, raw] of awareness.getStates()) {
    const state = raw as Partial<CollabAwarenessState>;
    if (clientId !== selfClientId && state.mode === "source" && state.focusedPath === path) {
      editors.push(clientId);
    }
  }
  return editors;
}

/**
 * The source reconciler — the lowest write-capable clientID among this doc's source editors
 * (including self when in source mode) — owns parsing Y.Text back into the structure tree.
 */
export function isSourceReconciler(awareness: Awareness, path: string): boolean {
  const self = awareness.clientID;
  const selfState = awareness.getStates().get(self) as Partial<CollabAwarenessState> | undefined;
  if (selfState?.mode !== "source" || selfState.focusedPath !== path) {
    return false;
  }
  let lowest = self;
  for (const [clientId, raw] of awareness.getStates()) {
    const state = raw as Partial<CollabAwarenessState>;
    if (
      state.mode === "source" &&
      state.focusedPath === path &&
      state.canWrite !== false &&
      clientId < lowest
    ) {
      lowest = clientId;
    }
  }
  return lowest === self;
}
