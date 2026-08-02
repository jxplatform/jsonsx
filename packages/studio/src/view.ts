/// <reference lib="dom" />
/**
 * View.js — Transient view state for Jx Studio
 *
 * Holds DOM references, editor instances, cleanup functions, and other mutable state that is the
 * OUTPUT of renderers (not the input). Separating this from persistent app state (in S via
 * store.js) makes renderer dependencies explicit.
 *
 * Deliberately NOT reactive, and deliberately narrow: a Monaco instance, a live `ResizeObserver`
 * and detached DOM nodes must never be wrapped in a reactive proxy. UI _inputs_ — which panel a
 * dock shows, whether a dock is open, the layout selection — live on the reactive `shell` record in
 * `./shell`, where a renderer can track them by reading them.
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

  // Layers panel collapsed state
  _layersCollapsed: null,
};
