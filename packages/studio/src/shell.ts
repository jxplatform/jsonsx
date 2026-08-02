/// <reference lib="dom" />
/**
 * Shell — the reactive record of Jx Studio's UI _inputs_.
 *
 * Companion to `view.ts`, and the other half of the split that `view.ts` used to straddle:
 *
 * - `view` holds render **outputs** — Monaco instances, the panzoom wrap, observers, DOM refs and the
 *   per-render cleanup arrays. It stays a plain object, because wrapping a live editor instance and
 *   detached DOM nodes in a reactive proxy is an active hazard.
 * - `shell` (here) holds UI **inputs** — which panel each dock shows, whether each dock is open and
 *   how wide, the focused region, the layout preset, and the project-level state (source control,
 *   the stylebook selection, the settings tab) that a _document_ must not own.
 *
 * Because this record is reactive, a surface tracks it by reading it: the rail, the left panel and
 * the toolbar all repaint from the effects they already run. The stand-in that preceded this —
 * `onPanelCollapse(fn)` plus an explicit `render()` in every toggle handler — is deleted.
 *
 * **Project-level state does not live on the focused tab.** Git status is a property of the
 * project, not of whichever document happens to be open: sourcing it from `activeTab` meant the
 * rail's Source Control badge vanished when the last tab closed, and two tabs could disagree about
 * the branch. See specs/studio.md and the level × placement matrix.
 */

import { effect, effectScope, reactive } from "./reactivity";
import type { EffectScope } from "@vue/reactivity";
import type { LayoutHit } from "./canvas/iframe-protocol";
import type { GitBranchesResult, GitDiffState, GitStatusResult } from "./types";

/**
 * The canvas selection when the author clicked LAYOUT chrome rather than page content — a header, a
 * footer, anything contributed by the layout file. It is deliberately NOT a document selection: the
 * node is not in the open page at all, so the properties panel shows the read-only layout panel
 * (with "Open Layout →") instead of the element inspector. See {@link setLayoutSelection}.
 */
export type LayoutSelection = LayoutHit;

/** The three resizable docks flanking the pane grid. */
export type DockId = "left" | "right" | "chat";

/** Which shell region currently owns keyboard focus (`focus.region` in the command context). */
export type FocusRegion = "rail" | "navigator" | "pane" | "inspector" | "dock" | "status";

/** Open/closed plus width, per dock. Persisted together under one storage key. */
export interface DockState {
  collapsed: boolean;
  width: number;
}

/** One row of `git log`, as the Source Control panel's History tab renders it. */
export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/** Source control — project level, one copy, independent of which document is focused. */
export interface ShellGit {
  status: GitStatusResult | null;
  branches: GitBranchesResult | null;
  commitMessage: string;
  loading: boolean;
  error: string | null;
  diffState: GitDiffState | null;
  logEntries: GitLogEntry[] | null;
  /** "changes" | "history" — the panel's sub-tab. */
  subTab: string;
  /** Epoch ms of the last successful refresh, or null when never refreshed. */
  lastUpdated: number | null;
}

/** The stylebook catalogue's selection and filters — project level, like the styles they edit. */
export interface ShellStylebook {
  selection: string | null;
  /** "elements" | "variables" */
  tab: string;
  filter: string;
  customizedOnly: boolean;
}

export interface ShellState {
  /** Which panel the Navigator dock shows. */
  leftTab: string;
  docks: Record<DockId, DockState>;
  focusRegion: FocusRegion;
  /** Named layout preset (Write · Design · Build · Ship). */
  layout: string;
  layoutSelection: LayoutSelection | null;
  /** Which section Project Settings opens on. */
  settingsTab: string;
  stylebook: ShellStylebook;
  git: ShellGit;
}

const DOCK_STORAGE_KEY = "jx-studio-panel-widths";

export const DOCK_IDS: DockId[] = ["left", "right", "chat"];

/**
 * First-run docks. The assistant starts CLOSED: it is a ~300px fifth grid column, and an editor
 * that opens with a third of the window spent on a chat nobody asked for is the single most
 * consistently wasted space in the product. It opens on demand and is then remembered.
 */
const DOCK_DEFAULTS: Record<DockId, DockState> = {
  chat: { collapsed: true, width: 320 },
  left: { collapsed: false, width: 240 },
  right: { collapsed: false, width: 280 },
};

/** The width a dock returns to when its handle is double-clicked. */
export const DOCK_DEFAULT_WIDTHS: Record<DockId, number> = {
  chat: DOCK_DEFAULTS.chat.width,
  left: DOCK_DEFAULTS.left.width,
  right: DOCK_DEFAULTS.right.width,
};

const DOCK_CSS_VAR: Record<DockId, string> = {
  chat: "--panel-w-chat",
  left: "--panel-w-left",
  right: "--panel-w-right",
};

const DOCK_CLASS: Record<DockId, string> = {
  chat: "chat-collapsed",
  left: "left-collapsed",
  right: "right-collapsed",
};

/** The persisted dock record. Absent keys keep the declared default. */
interface PersistedDocks {
  left?: number;
  right?: number;
  chat?: number;
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  chatCollapsed?: boolean;
}

/** Read the persisted dock record, tolerating absent/corrupt storage. */
function readPersistedDocks(): PersistedDocks {
  try {
    return JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) || "{}") as PersistedDocks;
  } catch {
    return {};
  }
}

function freshGit(): ShellGit {
  return {
    branches: null,
    commitMessage: "",
    diffState: null,
    error: null,
    lastUpdated: null,
    loading: false,
    logEntries: null,
    status: null,
    subTab: "changes",
  };
}

function freshStylebook(): ShellStylebook {
  return { customizedOnly: false, filter: "", selection: null, tab: "elements" };
}

/**
 * Build the whole record — nested collections complete — before it is handed to `reactive()`.
 *
 * Assembling it this way is not style: writing into a nested plain object AFTER the proxy exists
 * goes through the raw target and skips every effect depending on it.
 */
function createShellState(): ShellState {
  const saved = readPersistedDocks();
  const docks = {} as Record<DockId, DockState>;
  for (const id of DOCK_IDS) {
    const width = saved[id];
    const collapsed = saved[`${id}Collapsed` as const];
    docks[id] = {
      // A stored `false` has to REOPEN a dock that defaults closed, so this cannot be the usual
      // `if (saved.x) { collapse() }` shape — that silently pins the assistant shut forever for
      // Everyone who ever opened it.
      collapsed: typeof collapsed === "boolean" ? collapsed : DOCK_DEFAULTS[id].collapsed,
      width: typeof width === "number" && width > 0 ? width : DOCK_DEFAULTS[id].width,
    };
  }
  return {
    docks,
    focusRegion: "pane",
    git: freshGit(),
    layout: "design",
    layoutSelection: null,
    leftTab: "layers",
    settingsTab: "stylebook",
    stylebook: freshStylebook(),
  };
}

/*
 * The input is widened before `reactive()` sees it: `UnwrapNestedRefs<ShellState>` recurses through
 * `LayoutHit` and the git result shapes deeply enough for tsc to give up (TS2589). The proxy is
 * deep either way — only the type computation is short-circuited — and the declared annotation is
 * what every consumer sees. Same reason `tabs/tab.ts` casts its own reactive tree.
 */
export const shell: ShellState = reactive(
  createShellState() as unknown as Record<string, unknown>,
) as unknown as ShellState;

/**
 * Write the whole dock record in one shot.
 *
 * One writer, one shape. The predecessor had two: `persistWidths()` wrote a fresh
 * `{chat,left,right}` to this key while `applyPanelCollapse()` read-merge-wrote the three collapse
 * booleans into it, so dragging any handle wiped all three flags.
 */
export function persistDocks(): void {
  try {
    localStorage.setItem(
      DOCK_STORAGE_KEY,
      JSON.stringify({
        chat: shell.docks.chat.width,
        chatCollapsed: shell.docks.chat.collapsed,
        left: shell.docks.left.width,
        leftCollapsed: shell.docks.left.collapsed,
        right: shell.docks.right.width,
        rightCollapsed: shell.docks.right.collapsed,
      } satisfies PersistedDocks),
    );
  } catch {
    // Storage full or unavailable — the layout is still applied, just not remembered.
  }
}

/** Project the dock record onto the shell grid: collapse classes on #app, widths as CSS vars. */
export function applyDockLayout(): void {
  const root = document.documentElement;
  for (const id of DOCK_IDS) {
    root.style.setProperty(DOCK_CSS_VAR[id], `${shell.docks[id].width}px`);
  }
  const app = document.querySelector("#app");
  if (!app) {
    return;
  }
  for (const id of DOCK_IDS) {
    app.classList.toggle(DOCK_CLASS[id], shell.docks[id].collapsed);
  }
}

let _scope: EffectScope | null = null;

/**
 * Start the one effect that keeps the DOM in step with the dock record. Idempotent.
 *
 * Nothing else applies the grid: a caller flips `shell.docks.right.collapsed` and the layout
 * follows, whether the flip came from a click, the automation runner or the boot-time restore.
 */
export function mountShell(): void {
  if (_scope) {
    return;
  }
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      applyDockLayout();
    });
  });
}

export function unmountShell(): void {
  _scope?.stop();
  _scope = null;
}

/** Open or close a dock, and remember it. */
export function setDockCollapsed(dock: DockId, collapsed: boolean): void {
  if (shell.docks[dock].collapsed === collapsed) {
    return;
  }
  shell.docks[dock].collapsed = collapsed;
  persistDocks();
}

/** Flip a dock's open state, and remember it. */
export function toggleDock(dock: DockId): void {
  setDockCollapsed(dock, !shell.docks[dock].collapsed);
}

/** Resize a dock. Persisting is the caller's call — a drag persists once, on release. */
export function setDockWidth(dock: DockId, width: number): void {
  shell.docks[dock].width = width;
}

/** Reveal a Navigator panel: select it and make sure the dock is open. */
export function setActivityTab(tab: string): void {
  shell.leftTab = tab;
  setDockCollapsed("left", false);
}

/**
 * Toggle-focus semantics for the rail: re-picking the panel that is already showing closes the dock
 * instead of reselecting it.
 */
export function toggleActivityTab(tab: string): void {
  if (tab === shell.leftTab && !shell.docks.left.collapsed) {
    setDockCollapsed("left", true);
    return;
  }
  setActivityTab(tab);
}

/**
 * Adopt (or clear) a layout-chrome selection reported by the canvas.
 *
 * The canvas host calls this on a `layoutHit`, and clears it (`null`) whenever an ordinary document
 * node is selected — the two are mutually exclusive, and only one panel can be right at a time. It
 * exists as a function rather than a bare assignment so the one writer has a name: the field spent
 * a long release cycle with a reader (the properties panel's layout panel) and no writer at all,
 * which is why clicking a header did nothing.
 */
export function setLayoutSelection(selection: LayoutSelection | null): void {
  shell.layoutSelection = selection;
}

/**
 * Drop everything scoped to the project being closed.
 *
 * Source control, the stylebook selection and the settings tab all describe _a_ project; carrying
 * them into the next one showed the previous repository's branch, file count and "last updated"
 * time under the new project's name. Docks, the layout preset and the active rail panel are
 * deliberately kept — they describe the workspace, not the project.
 */
export function resetProjectShell(): void {
  Object.assign(shell.git, freshGit());
  Object.assign(shell.stylebook, freshStylebook());
  shell.settingsTab = "stylebook";
  shell.layoutSelection = null;
}
