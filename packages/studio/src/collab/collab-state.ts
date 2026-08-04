/**
 * Reactive per-tab collab state, kept OUTSIDE the Tab type: UI reads it through collabState(tab),
 * and non-collab builds never touch it. The path registry answers "is this file co-edited?" for the
 * fs-sync/reload guards without importing the session machinery.
 */

import { reactive, toRaw } from "../reactivity";
import type { Tab } from "../tabs/tab";
import type { CollabAwarenessState } from "@jxsuite/collab/awareness-types";

/**
 * What co-editing is doing for this tab.
 *
 * `"detached"` used to mean three different things at once and say none of them: this build has no
 * collaboration at all, this project has collaboration but this tab is solo, and the attach was
 * tried and it FAILED. §7.4: a freeze is currently indistinguishable from a bug, and so was a
 * broken connection. `"unavailable"` and `"failed"` split the third and first cases out, so the
 * chip can say which one it is.
 */
export type CollabTabStatus =
  | "unavailable"
  | "detached"
  | "connecting"
  | "synced"
  | "offline"
  | "failed";

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
   *
   * The freeze is real and it is brief, and until now its only rendering was a grey line for three
   * seconds — which is exactly what a bug looks like. It gets an indicator (§7.4).
   */
  sourceCanonical: boolean;
  /**
   * Why the last attach failed, when it did. Empty while `status` is anything but `"failed"`.
   *
   * The attach used to swallow its own exception into `status = "detached"`, so a dead relay, an
   * expired token and a project that simply is not shared all produced the same silence.
   */
  attachError: string;
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
      attachError: "",
      peers: [],
      readOnly: false,
      sourceCanonical: false,
      status: "unavailable",
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
