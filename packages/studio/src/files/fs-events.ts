/// <reference lib="dom" />
/**
 * Fs-events.ts — reconcile backend filesystem events into the cached sidebar tree.
 *
 * `applyFsEvents` is a pure, in-place reducer over `projectState.dirs`/`expanded` (unit-testable
 * without a DOM). `startFsSync` is the only impure part: it feature-detects the platform's
 * `subscribeFileEvents`, debounces bursts, drops the echoes of the user's own local mutations, and
 * triggers a single re-render through the existing left-panel render path (no imperative DOM).
 */

import { getPlatform } from "../platform";
import { invalidateUsages } from "../services/references";
import { projectState } from "../store";
import type { DirEntry, FsEvent } from "../types";

const RECENT_MS = 1500;
const recentLocal = new Map<string, number>();

const norm = (p: string) => p.replaceAll("\\", "/");

/** Mark paths the user just mutated locally so the watcher's echo of them is ignored briefly. */
export function markLocalMutation(...paths: string[]): void {
  const expiry = Date.now() + RECENT_MS;
  for (const p of paths) {
    if (p) {
      recentLocal.set(norm(p), expiry);
    }
  }
}

/** True while a path is within the recent-local-mutation window (self-cleans on expiry). */
export function isRecentLocal(path: string): boolean {
  const key = norm(path);
  const expiry = recentLocal.get(key);
  if (expiry === undefined) {
    return false;
  }
  if (Date.now() > expiry) {
    recentLocal.delete(key);
    return false;
  }
  return true;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Apply backend FS events to the cached directory tree in place, returning the set of directories
 * whose contents changed. Idempotent — re-adding an existing entry or removing an absent one is a
 * no-op, which absorbs watcher echoes. `change` events touch no tree state (name/type are stable).
 */
export function applyFsEvents(
  dirs: Map<string, DirEntry[]>,
  expanded: Set<string>,
  events: FsEvent[],
): Set<string> {
  const changedDirs = new Set<string>();
  for (const ev of events) {
    const parent = parentDir(ev.path);
    if (ev.type === "add" || ev.type === "addDir") {
      const entries = dirs.get(parent);
      if (entries && !entries.some((e) => e.path === ev.path)) {
        entries.push({
          name: baseName(ev.path),
          path: ev.path,
          type: ev.isDir ? "directory" : "file",
        });
        changedDirs.add(parent);
      }
      if (ev.type === "addDir" && !dirs.has(ev.path)) {
        dirs.set(ev.path, []);
      }
    } else if (ev.type === "unlink" || ev.type === "unlinkDir") {
      const entries = dirs.get(parent);
      if (entries) {
        const idx = entries.findIndex((e) => e.path === ev.path);
        if (idx !== -1) {
          entries.splice(idx, 1);
          changedDirs.add(parent);
        }
      }
      if (ev.type === "unlinkDir") {
        dirs.delete(ev.path);
        const nestedDirs: string[] = [];
        for (const key of dirs.keys()) {
          if (key.startsWith(`${ev.path}/`)) {
            nestedDirs.push(key);
          }
        }
        for (const key of nestedDirs) {
          dirs.delete(key);
        }
        const staleExpanded: string[] = [];
        for (const key of expanded) {
          if (key === ev.path || key.startsWith(`${ev.path}/`)) {
            staleExpanded.push(key);
          }
        }
        for (const key of staleExpanded) {
          expanded.delete(key);
        }
      }
    }
  }
  return changedDirs;
}

export interface FsSyncContext {
  renderLeftPanel: () => void;
  /** Optional hook for an external content change to an open file (e.g. reload a clean tab). */
  onContentChange?: (path: string) => void;
  /**
   * Drop every cache keyed on "what files the project contains".
   *
   * Passed in rather than imported, for the reason `renderLeftPanel` is: the caches live in panels,
   * and this module is imported BY the file layer those panels sit on top of — reaching up would be
   * a cycle. The bootstrap owns the list because the bootstrap is where the panels are already in
   * scope.
   */
  invalidateDerivedCaches?: () => void;
}

/**
 * Subscribe the sidebar to backend filesystem events. Returns an unsubscribe function; a no-op when
 * the platform has no watcher (desktop without one, or tests). Bursts are debounced into one
 * render.
 */
export function startFsSync(ctx: FsSyncContext): () => void {
  const platform = getPlatform();
  if (!platform.subscribeFileEvents) {
    return () => {};
  }
  let pending: FsEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const state = projectState;
    const batch = pending.filter((e) => !isRecentLocal(e.path));
    pending = [];
    if (!state || batch.length === 0) {
      return;
    }
    const changedDirs = applyFsEvents(state.dirs, state.expanded, batch);
    if (ctx.onContentChange) {
      for (const ev of batch) {
        if (ev.type === "change") {
          ctx.onContentChange(ev.path);
        }
      }
    }
    if (changedDirs.size > 0) {
      ctx.renderLeftPanel();
    }
  };

  return platform.subscribeFileEvents((events) => {
    // Before the echo filter, deliberately. `isRecentLocal` drops the events Studio caused, which
    // Is right for the tree (it already repainted) and wrong for a DERIVED cache — Studio's own
    // Write changes what the project contains exactly as much as anyone else's does.
    //
    // Every cache keyed on "what files exist" is dropped here, in one place, because they answer
    // One event. Each one had an invalidator and no caller, and each stale answer is visible: the
    // Link-target picker offering a route whose page was deleted, the layout picker attributing a
    // Removed layout's `$head` to the open page, a `$paths` enumeration listing entries that are
    // Gone.
    invalidateUsages();
    ctx.invalidateDerivedCaches?.();
    pending.push(...events);
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, 50);
  });
}
