/**
 * Session.ts — what a project looked like when you left it, and how it looks that way again.
 *
 * Plan §4.4: "Session state persists **per project root** … open tabs and order per pane, active
 * tab, per-tab editor kind / view / zoom / rendering context." P3's "Newly possible" states the
 * consequence plainly: **the session survives a relaunch.** Neither shipped. The per-project record
 * held `layouts` and `activeLayout` and nothing else, its interface said "Session state (§4.4)
 * grows into this shape", and reopening a project landed on the home page with an empty strip — so
 * nine open documents, a split, and the breakpoint you were checking were lost every time.
 *
 * **Paths, not tab ids.** A tab id is minted per open and means nothing across a reload; the
 * document's path is the identity the workspace already dedupes on (`openFileInTab` scans
 * `tab.documentPath`). A stored path that no longer resolves is skipped on restore rather than
 * failing the whole session — files move, and losing the other eight tabs because one was renamed
 * would be worse than the problem this solves.
 *
 * **Only what the author chose.** Per tab it records the canvas mode, the preview flag, the zooms
 * and the rendering context — the settings a person deliberately put a document into. Selection,
 * hover, clipboard, undo history and the live canvas scope are all derived or transient, and
 * restoring a selection into a document that has since changed on disk would point at a node that
 * may not exist.
 *
 * **Untrusted input.** Everything read back is `localStorage`, which is hand-editable and survives
 * across versions. Every field is validated on the way in and a bad record restores nothing.
 */

import { PRIMARY_PANE, SECONDARY_PANE, focusPane, workspace } from "./workspace";
import type { Tab } from "../tabs/tab";

/** One pane's share of a session. */
export interface PersistedPane {
  /** `PRIMARY_PANE` or `SECONDARY_PANE` — the two ids the grid has (§18.1). */
  id: string;
  /** Document paths in strip order. Untitled tabs are absent: they have no path to restore from. */
  files: string[];
  /** Which of `files` was active, or `null`. */
  activeFile: string | null;
}

/** What a document was showing when the project was last closed. */
export interface PersistedTabUi {
  canvasMode?: string;
  preview?: boolean;
  zoom?: number;
  editZoom?: number;
  activeMedia?: string | null;
  previewColorScheme?: string;
  showLayout?: boolean;
}

/** The whole session, as stored. */
export interface PersistedSession {
  panes: PersistedPane[];
  /** Which pane had the keyboard. */
  focusedPane: string;
  /** Per-document view settings, keyed by path. */
  ui: Record<string, PersistedTabUi>;
}

const PANE_IDS = new Set([PRIMARY_PANE, SECONDARY_PANE]);
const SCHEMES = new Set(["auto", "light", "dark"]);

/** The view settings this tab was left in — the ones a person chose, not the ones derived. */
function uiOf(tab: Tab): PersistedTabUi {
  const { ui } = tab.session;
  return {
    activeMedia: ui.activeMedia,
    canvasMode: ui.canvasMode,
    editZoom: ui.editZoom,
    preview: ui.preview,
    previewColorScheme: ui.previewColorScheme,
    showLayout: ui.showLayout,
    zoom: ui.zoom,
  };
}

/**
 * Snapshot the workspace.
 *
 * A pane with no restorable tab is dropped rather than stored empty — restoring a split whose
 * second half has nothing in it would reopen a pane the author would immediately close.
 */
export function captureSession(): PersistedSession {
  const ui: Record<string, PersistedTabUi> = {};
  const panes: PersistedPane[] = [];
  for (const pane of workspace.panes) {
    // A DERIVED pane owns no tabs — it is a projection of another pane (§18.4) — and re-deriving it
    // Needs the source pane's document to exist first. Not stored; the author re-derives in a
    // Keystroke, and a half-restored derivation pointing at a pane that failed to fill is worse.
    if (pane.derived) {
      continue;
    }
    const files: string[] = [];
    for (const tabId of pane.tabOrder) {
      const tab = workspace.tabs.get(tabId);
      if (!tab?.documentPath) {
        continue;
      }
      files.push(tab.documentPath);
      ui[tab.documentPath] = uiOf(tab);
    }
    if (files.length === 0) {
      continue;
    }
    const activeTab = pane.activeTabId ? workspace.tabs.get(pane.activeTabId) : null;
    panes.push({
      activeFile: activeTab?.documentPath ?? null,
      files,
      id: pane.id,
    });
  }
  return { focusedPane: workspace.activePaneId, panes, ui };
}

/** Whether a parsed value is a usable {@link PersistedTabUi}. Hand-edited storage is input. */
function readTabUi(value: unknown): PersistedTabUi {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const out: PersistedTabUi = {};
  if (typeof raw.canvasMode === "string") {
    out.canvasMode = raw.canvasMode;
  }
  if (typeof raw.preview === "boolean") {
    out.preview = raw.preview;
  }
  if (typeof raw.zoom === "number" && Number.isFinite(raw.zoom)) {
    out.zoom = raw.zoom;
  }
  if (typeof raw.editZoom === "number" && Number.isFinite(raw.editZoom)) {
    out.editZoom = raw.editZoom;
  }
  if (raw.activeMedia === null || typeof raw.activeMedia === "string") {
    out.activeMedia = raw.activeMedia;
  }
  if (typeof raw.previewColorScheme === "string" && SCHEMES.has(raw.previewColorScheme)) {
    out.previewColorScheme = raw.previewColorScheme;
  }
  if (typeof raw.showLayout === "boolean") {
    out.showLayout = raw.showLayout;
  }
  return out;
}

/**
 * Validate a stored session. Returns `null` for anything that is not one — a corrupt record
 * restores nothing rather than restoring half a workspace.
 */
export function readSession(value: unknown): PersistedSession | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Partial<PersistedSession>;
  if (!Array.isArray(raw.panes)) {
    return null;
  }
  const panes: PersistedPane[] = [];
  for (const entry of raw.panes) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const pane = entry as Partial<PersistedPane>;
    if (typeof pane.id !== "string" || !PANE_IDS.has(pane.id)) {
      continue;
    }
    const files = Array.isArray(pane.files)
      ? pane.files.filter((file): file is string => typeof file === "string" && file !== "")
      : [];
    if (files.length === 0) {
      continue;
    }
    panes.push({
      activeFile:
        typeof pane.activeFile === "string" && files.includes(pane.activeFile)
          ? pane.activeFile
          : null,
      files,
      id: pane.id,
    });
  }
  if (panes.length === 0) {
    return null;
  }
  const ui: Record<string, PersistedTabUi> = {};
  if (typeof raw.ui === "object" && raw.ui !== null) {
    for (const [path, entry] of Object.entries(raw.ui as Record<string, unknown>)) {
      ui[path] = readTabUi(entry);
    }
  }
  return {
    focusedPane:
      typeof raw.focusedPane === "string" && PANE_IDS.has(raw.focusedPane)
        ? raw.focusedPane
        : PRIMARY_PANE,
    panes,
    ui,
  };
}

/** What {@link restoreSession} needs from the rest of Studio, so this module opens no files itself. */
export interface RestoreDeps {
  /** Open one path into one pane, without moving the keyboard. Rejects if the file is gone. */
  openFile: (path: string, paneId: string) => Promise<void>;
  /**
   * Make sure the grid HAS a second pane, without moving anything into it.
   *
   * `receivingPane()`, not `splitRight()`: a split moves the focused pane's active tab, and at this
   * point nothing is open — so `splitRight()` returns `null`, the pane is never created, and the
   * second pane's documents all land in the first.
   */
  ensureSecondPane: () => void;
}

/**
 * Reopen what the session describes. Returns how many documents actually landed.
 *
 * A path that no longer resolves is SKIPPED, not fatal: files move, and losing eight tabs because
 * one was renamed would be a worse bug than the one this fixes. `0` means nothing restored, which
 * is the caller's signal to fall back to the home page.
 */
export async function restoreSession(
  session: PersistedSession,
  deps: RestoreDeps,
): Promise<number> {
  let opened = 0;
  if (session.panes.some((pane) => pane.id === SECONDARY_PANE)) {
    deps.ensureSecondPane();
  }
  for (const pane of session.panes) {
    for (const file of pane.files) {
      try {
        await deps.openFile(file, pane.id);
      } catch {
        // Moved, renamed or deleted since. The rest of the session is still worth having.
      }
      /*
       * COUNT WHAT LANDED, not what failed to throw.
       *
       * `openFileInTab` reports a missing file by raising a Problem and returning normally — it is
       * a user action, not an exception — so counting calls made every restore look like a success.
       * A session of three deleted files then reported `3`, the caller skipped its home-page
       * fallback, and the window opened empty. The workspace is the only honest answer to "is it
       * open?", and it is the same field `openFileInTab` dedupes against.
       */
      if ([...workspace.tabs.values()].some((tab) => tab.documentPath === file)) {
        opened += 1;
      }
    }
  }
  if (opened === 0) {
    return 0;
  }
  // The view settings, applied AFTER every tab exists: `canvasMode` is validated against the tab's
  // Own `capabilities.modes` by the setter, and a mode a document does not support is dropped.
  for (const tab of workspace.tabs.values()) {
    const stored = tab.documentPath ? session.ui[tab.documentPath] : undefined;
    if (!stored) {
      continue;
    }
    const { ui } = tab.session;
    if (stored.canvasMode && tab.capabilities.modes.includes(stored.canvasMode)) {
      ui.canvasMode = stored.canvasMode;
    }
    if (stored.preview !== undefined) {
      ui.preview = stored.preview;
    }
    if (stored.zoom !== undefined) {
      ui.zoom = stored.zoom;
    }
    if (stored.editZoom !== undefined) {
      ui.editZoom = stored.editZoom;
    }
    if (stored.activeMedia !== undefined) {
      ui.activeMedia = stored.activeMedia;
    }
    if (stored.previewColorScheme !== undefined) {
      ui.previewColorScheme = stored.previewColorScheme as "auto" | "dark" | "light";
    }
    if (stored.showLayout !== undefined) {
      ui.showLayout = stored.showLayout;
    }
  }
  // Each pane's active tab, then the pane that had the keyboard — in that order, because activating
  // A tab in a pane is what makes that pane's strip meaningful and focusing comes last.
  for (const stored of session.panes) {
    const pane = workspace.panes.find((p) => p.id === stored.id);
    if (!pane || !stored.activeFile) {
      continue;
    }
    const match = pane.tabOrder.find(
      (tabId) => workspace.tabs.get(tabId)?.documentPath === stored.activeFile,
    );
    if (match) {
      pane.activeTabId = match;
    }
  }
  if (workspace.panes.some((pane) => pane.id === session.focusedPane)) {
    focusPane(session.focusedPane);
  }
  return opened;
}
