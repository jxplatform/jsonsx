/// <reference lib="dom" />
/**
 * View.js — Transient view state for Jx Studio
 *
 * Holds DOM references, editor instances, cleanup functions, and other mutable state that is the
 * OUTPUT of renderers (not the input). Separating this from persistent app state (in S via
 * store.js) makes renderer dependencies explicit.
 */

import type { editor } from "monaco-editor";
import type { LayoutHit } from "./canvas/iframe-protocol";

/**
 * The canvas selection when the author clicked LAYOUT chrome rather than page content — a header, a
 * footer, anything contributed by the layout file. It is deliberately NOT a document selection: the
 * node is not in the open page at all, so the properties panel shows the read-only layout panel
 * (with "Open Layout →") instead of the element inspector. See {@link setLayoutSelection}.
 */
export type LayoutSelection = LayoutHit;

interface ViewState {
  panzoomWrap: HTMLElement | null;
  renderGeneration: number;
  centerObserver: ResizeObserver | null;
  needsCenter: boolean;
  panX: number;
  panY: number;
  prevCanvasMode: string | null;
  monacoEditor:
    | (editor.IStandaloneCodeEditor & {
        _ignoreNextChange?: boolean;
      })
    | null;
  functionEditor:
    | (editor.IStandaloneCodeEditor & {
        _ignoreNextChange?: boolean;
        _editingTarget?: string | null;
      })
    | null;
  blockActionBarEl: HTMLElement | null;
  selDragCleanup: (() => void) | null;
  dndCleanups: (() => void)[];
  canvasDndCleanups: (() => void)[];
  canvasEventCleanups: (() => void)[];
  forcedStyleTag: HTMLStyleElement | null;
  forcedAttrEl: HTMLElement | null;
  elementsCollapsed: Set<string>;
  elementsFilter: string;
  _currentDropTargetRow: HTMLElement | null;
  layerDragSourceHeight: number;
  _completionRegistered: boolean;
  showAddBreakpointForm: boolean;
  addBreakpointPreview: string;
  layoutSelection: LayoutSelection | null;
  leftTab: string;
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  chatPanelCollapsed: boolean;
  _layersCollapsed: Set<string> | null;
  [key: string]: unknown;
}

export const view: ViewState = {
  // Canvas infrastructure
  panzoomWrap: null,
  renderGeneration: 0,
  centerObserver: null,
  needsCenter: true,
  panX: 0,
  panY: 0,
  prevCanvasMode: null,

  // Editor instances
  monacoEditor: null,
  functionEditor: null,

  // Floating UI containers
  blockActionBarEl: null,

  // Selection & drag
  selDragCleanup: null,

  // Cleanup arrays (reset on each render cycle)
  dndCleanups: [],
  canvasDndCleanups: [],
  canvasEventCleanups: [],

  // Pseudo-state preview
  forcedStyleTag: null,
  forcedAttrEl: null,

  // Left panel / elements UI
  elementsCollapsed: new Set(),
  elementsFilter: "",

  // Drag interaction
  _currentDropTargetRow: null,
  layerDragSourceHeight: 0,

  // Editor state
  _completionRegistered: false,

  // Canvas / stylebook

  // Responsive breakpoints UI
  showAddBreakpointForm: false,
  addBreakpointPreview: "",

  // Layout selection (when user clicks a layout element)
  layoutSelection: null,

  // Global UI state (persists across tab switches)
  leftTab: "layers",
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,
  /* Closed on first run. The assistant is a ~300px fifth grid column, and an editor that opens
     with a third of the window spent on a chat nobody asked for is the single most consistently
     wasted space in the product. It opens on demand (the toolbar's Toggle Assistant, the New
     Project flow's agent hand-off) and its state is then remembered — see restoreCollapseState. */
  chatPanelCollapsed: true,

  // Layers panel collapsed state
  _layersCollapsed: null,
};

/**
 * Adopt (or clear) a layout-chrome selection reported by the canvas.
 *
 * The canvas host calls this on a `layoutHit`, and clears it (`null`) whenever an ordinary document
 * node is selected — the two are mutually exclusive, and only one panel can be right at a time. It
 * exists as a function rather than a bare assignment so the one writer of `view.layoutSelection`
 * has a name: the field spent a long release cycle with a reader (the properties panel's layout
 * panel) and no writer at all, which is why clicking a header did nothing.
 */
export function setLayoutSelection(selection: LayoutSelection | null): void {
  view.layoutSelection = selection;
}

const COLLAPSE_STORAGE_KEY = "jx-studio-panel-widths";

/** The three persisted collapse booleans, absent when never written or unreadable. */
interface PersistedCollapse {
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  chatCollapsed?: boolean;
}

/** Read the persisted panel record, tolerating absent/corrupt storage. */
function readPersisted(): PersistedCollapse & Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) || "{}") as PersistedCollapse &
      Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Adopt the persisted collapse state, in BOTH directions.
 *
 * A stored `false` has to reopen a panel that defaults closed, so this cannot be the usual `if
 * (saved.x) { collapse() }` — that shape silently pins the assistant shut for everyone who ever
 * opened it. Absent keys keep the declared default, which is how a first run gets the closed
 * assistant column.
 */
function restoreCollapseState() {
  const saved = readPersisted();
  if (typeof saved.leftCollapsed === "boolean") {
    view.leftPanelCollapsed = saved.leftCollapsed;
  }
  if (typeof saved.rightCollapsed === "boolean") {
    view.rightPanelCollapsed = saved.rightCollapsed;
  }
  if (typeof saved.chatCollapsed === "boolean") {
    view.chatPanelCollapsed = saved.chatCollapsed;
  }
}

restoreCollapseState();

/**
 * Listeners notified after every {@link applyPanelCollapse}.
 *
 * `view` is a plain object, not a reactive store, so a renderer cannot track `chatPanelCollapsed`
 * by reading it — the toolbar's own rail/chat icons went stale whenever anything but its click
 * handler flipped a panel (the automation runner, the New Project agent hand-off, the boot-time
 * restore above). This is the minimal stand-in until P2's reactive `shell.ts` record owns dock
 * visibility and every dependent surface tracks it for free.
 */
const collapseListeners = new Set<() => void>();

/** Subscribe to panel collapse changes. Returns an unsubscribe function. */
export function onPanelCollapse(fn: () => void): () => void {
  collapseListeners.add(fn);
  return () => collapseListeners.delete(fn);
}

export function applyPanelCollapse() {
  const app = document.querySelector("#app");
  if (!app) {
    return;
  }
  app.classList.toggle("left-collapsed", view.leftPanelCollapsed);
  app.classList.toggle("right-collapsed", view.rightPanelCollapsed);
  app.classList.toggle("chat-collapsed", view.chatPanelCollapsed);
  try {
    const saved = readPersisted();
    saved.leftCollapsed = view.leftPanelCollapsed;
    saved.rightCollapsed = view.rightPanelCollapsed;
    saved.chatCollapsed = view.chatPanelCollapsed;
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage unavailable
  }
  for (const fn of collapseListeners) {
    fn();
  }
}
