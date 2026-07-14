/// <reference lib="dom" />
/**
 * View.js — Transient view state for Jx Studio
 *
 * Holds DOM references, editor instances, cleanup functions, and other mutable state that is the
 * OUTPUT of renderers (not the input). Separating this from persistent app state (in S via
 * store.js) makes renderer dependencies explicit.
 */

import type { editor } from "monaco-editor";

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
  layoutSelection: unknown;
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
  chatPanelCollapsed: false,

  // Layers panel collapsed state
  _layersCollapsed: null,
};

const COLLAPSE_STORAGE_KEY = "jx-studio-panel-widths";

export function applyPanelCollapse() {
  const app = document.querySelector("#app");
  if (!app) {
    return;
  }
  app.classList.toggle("left-collapsed", view.leftPanelCollapsed);
  app.classList.toggle("right-collapsed", view.rightPanelCollapsed);
  app.classList.toggle("chat-collapsed", view.chatPanelCollapsed);
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) || "{}") as Record<
      string,
      unknown
    >;
    saved.leftCollapsed = view.leftPanelCollapsed;
    saved.rightCollapsed = view.rightPanelCollapsed;
    saved.chatCollapsed = view.chatPanelCollapsed;
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage unavailable
  }
}
