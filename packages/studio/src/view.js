/**
 * View.js — Transient view state for Jx Studio
 *
 * Holds DOM references, editor instances, cleanup functions, and other mutable state that is the
 * OUTPUT of renderers (not the input). Separating this from persistent app state (in S via
 * store.js) makes renderer dependencies explicit.
 */

/** @type {any} */
export const view = {
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

  // Inline editing
  componentInlineEdit: null,
  inlineEditCleanup: null,

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
  lastDragInput: null,
  _currentDropTargetRow: null,
  layerDragSourceHeight: 0,

  // Editor state
  savedRange: null,
  _completionRegistered: false,

  // Canvas / stylebook
  stylebookElToTag: new WeakMap(),

  // Responsive breakpoints UI
  showAddBreakpointForm: false,
  addBreakpointPreview: "",

  // Layout selection (when user clicks a layout element)
  layoutSelection: null,

  // Global UI state (persists across tab switches)
  leftTab: "layers",
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,

  // Autosave
  autosaveTimer: null,
};

const COLLAPSE_STORAGE_KEY = "jx-studio-panel-widths";

export function applyPanelCollapse() {
  const app = document.getElementById("app");
  if (!app) return;
  app.classList.toggle("left-collapsed", view.leftPanelCollapsed);
  app.classList.toggle("right-collapsed", view.rightPanelCollapsed);
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) || "{}");
    saved.leftCollapsed = view.leftPanelCollapsed;
    saved.rightCollapsed = view.rightPanelCollapsed;
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // storage unavailable
  }
}
