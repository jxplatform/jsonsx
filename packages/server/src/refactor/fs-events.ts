/**
 * Fs-events.ts — pure translation + coalescing of chokidar events into the wire payloads the studio
 * sidebar consumes. No filesystem access (node:path.relative is a pure string op), so it is shared
 * by the dev-server watcher (watch.ts) and the desktop project session, and unit-tests directly.
 */

import { relative } from "node:path";

/** A filesystem change as broadcast to the studio shell (root-relative, forward-slashed path). */
export interface FsEventPayload {
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
  isDir: boolean;
}

const VALID = new Set(["add", "change", "unlink", "addDir", "unlinkDir"]);

/**
 * Map one chokidar event to a payload, or null for events we ignore (`ready`/`raw`/`error`) or
 * paths that escape the root.
 */
export function toFsEvent(
  eventType: string,
  root: string,
  changedPath: string,
): FsEventPayload | null {
  if (!VALID.has(eventType)) {
    return null;
  }
  const path = relative(root, changedPath).replaceAll("\\", "/");
  if (!path || path.startsWith("..")) {
    return null;
  }
  return {
    isDir: eventType === "addDir" || eventType === "unlinkDir",
    path,
    type: eventType as FsEventPayload["type"],
  };
}

/**
 * Fold one event into a buffer, collapsing redundant churn per path (last-write-wins, except
 * add+unlink cancels, add+change stays add, and unlink+add becomes a re-add). Returns a new array.
 */
export function coalesceFsEvents(buffer: FsEventPayload[], next: FsEventPayload): FsEventPayload[] {
  const prev = buffer.find((e) => e.path === next.path);
  if (!prev) {
    return [...buffer, next];
  }
  const index = buffer.indexOf(prev);
  const out = [...buffer];
  // A file (or dir) created then removed within the window is a no-op.
  if (
    (prev.type === "add" && next.type === "unlink") ||
    (prev.type === "addDir" && next.type === "unlinkDir")
  ) {
    out.splice(index, 1);
    return out;
  }
  // A content change after a create is still just a create.
  if ((prev.type === "add" || prev.type === "addDir") && next.type === "change") {
    return out;
  }
  // Removed then recreated → treat as a fresh add.
  if (prev.type === "unlink" && next.type === "add") {
    out[index] = next;
    return out;
  }
  out[index] = next;
  return out;
}
