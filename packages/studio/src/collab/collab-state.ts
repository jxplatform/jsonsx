/**
 * Reactive per-tab collab state, kept OUTSIDE the Tab type: UI reads it through collabState(tab),
 * and non-collab builds never touch it. The path registry answers "is this file co-edited?" for the
 * fs-sync/reload guards without importing the session machinery.
 */

import { reactive, toRaw } from "../reactivity";
import type { Tab } from "../tabs/tab";
import type { CollabAwarenessState } from "@jxsuite/collab/awareness-types";

export type CollabTabStatus = "detached" | "connecting" | "synced" | "offline";

export interface PeerPresence {
  clientId: number;
  state: CollabAwarenessState;
}

export interface TabCollabState {
  status: CollabTabStatus;
  /** True once a session is attached and past its initial sync. */
  active: boolean;
  readOnly: boolean;
  /** Other clients' awareness states (this project connection, all docs). */
  peers: PeerPresence[];
  /**
   * True while source holds the canonical lock (someone is co-editing the code view): structural
   * surfaces soft-freeze and the canvas previews the source reconciler's parses.
   */
  sourceCanonical: boolean;
}

const states = new WeakMap<Tab, TabCollabState>();
const attachedPaths = new Map<string, number>();

export function collabState(tab: Tab): TabCollabState {
  // Key on the raw tab: writers (the collab session, via ensureCollab's raw tab) and readers
  // (toolbar/tab-strip, via reactive `workspace.tabs.get` proxies) must resolve the same entry.
  const key = toRaw(tab as unknown as object) as Tab;
  let state = states.get(key);
  if (!state) {
    state = reactive({
      active: false,
      peers: [],
      readOnly: false,
      sourceCanonical: false,
      status: "detached",
    }) as TabCollabState;
    states.set(key, state);
  }
  return state;
}

export function isCollabActive(tab: Tab): boolean {
  return states.get(tab)?.active === true;
}

/** Track which project-relative paths have live sessions (fs-event/reload suppression). */
export function registerCollabPath(path: string): void {
  attachedPaths.set(path, (attachedPaths.get(path) ?? 0) + 1);
}

export function unregisterCollabPath(path: string): void {
  const count = attachedPaths.get(path) ?? 0;
  if (count <= 1) {
    attachedPaths.delete(path);
  } else {
    attachedPaths.set(path, count - 1);
  }
}

/** True while some tab co-edits this path — its Y.Doc is ahead of any provider write-back. */
export function isCollabPath(path: string): boolean {
  return attachedPaths.has(path.replaceAll("\\", "/"));
}
