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
import type { BufferWrites } from "./services/monaco-buffer";
import type { Tab } from "./tabs/tab";

/**
 * What both of Studio's Monaco surfaces hang off their editor instance.
 *
 * ONE shape, because there is one rule. The source view and the function editor are mounted by
 * different modules, torn down by different events and written into by different continuations —
 * and each of those differences used to justify its own spelling of the same two ideas ("ignore the
 * change my own `setValue` is about to fire" and "cancel the work armed over this buffer"). The
 * function editor got a canceller in P8 and the source view did not, which is exactly how a 600ms
 * timer survived three disposal sites and stayed able to replace a page with an empty parse.
 * `services/monaco-buffer.ts` owns the rule; this is the storage it needs.
 */
type MonacoSurface = editor.IStandaloneCodeEditor & {
  _ignoreNextChange?: boolean;
  /** The debounced work armed over this buffer, with this editor's exact lifetime. */
  _writes?: BufferWrites;
  /**
   * The tab this buffer was mounted for. ONE spelling for both surfaces, because "whose buffer is
   * this?" is a question the close path asks of a tab, not of an editor it happens to know about.
   *
   * It was the function editor's alone, and the source view kept the same fact in a closure inside
   * `mountSourceEditor` — reachable from nowhere. `services/monaco-buffer.ts`'s `commitTabBuffers`
   * and `tabBufferUnsaved` have to ask both, and a question only one surface can answer is the
   * reason ⌘W could close a source tab over the last 600ms of typing without a word.
   */
  _editingTab?: Tab | null;
};

interface ViewState {
  panzoomWrap: HTMLElement | null;
  renderGeneration: number;
  centerObserver: ResizeObserver | null;
  needsCenter: boolean;
  panX: number;
  panY: number;
  monacoEditor: MonacoSurface | null;
  /**
   * The dock's code editor, plus what it was mounted FOR.
   *
   * The target string alone was not an answer. `{"eventKey":"onclick","path":["children",0],"type":
   * "event"}` is the SAME string for the first button on any two pages, so a re-sync could match
   * across a tab switch and hand one document's buffer to another. `_editingTab` (on every Monaco
   * surface, above) is the missing half, held by identity rather than by id so a commit can ask
   * `tabIsLive` whether the document it was promised to still exists.
   *
   * `_commitBody` is the one writer for both of them: a closure built at mount over that tab and
   * that target, so the debounce and the Close cannot disagree about where a body goes — and
   * neither can resolve it through whichever tab happens to be focused when they run.
   *
   * **It answers whether the body LANDED.** `transactDoc` can refuse a write outright (the collab
   * source-canonical freeze pauses structural edits for everyone, the lock holder included), and a
   * writer that reported nothing let the Close dispose an editor whose text had gone nowhere. The
   * boolean is what lets the caller keep the surface up instead.
   */
  functionEditor:
    | (MonacoSurface & {
        _editingTarget?: string | null;
        _commitBody?: (body: string) => boolean;
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

  // Layers panel collapsed state
  _layersCollapsed: null,
};
