/**
 * Store.js — Shared state hub for Jx Studio
 *
 * Every other studio module imports from this file for shared state, DOM refs, render
 * orchestration, and state.js re-exports. This prevents circular dependencies by keeping store.js
 * free of domain-specific imports.
 */

// ─── Re-exports from state.js ────────────────────────────────────────────────

import { activeTab } from "./workspace/workspace.js";

export {
  createState,
  selectNode,
  hoverNode,
  pushDocument,
  popDocument,
  getNodeAtPath,
  flattenTree,
  nodeLabel,
  pathKey,
  pathsEqual,
  parentElementPath,
  childIndex,
  isAncestor,
  projectState,
  setProjectState,
  updateFrontmatter,
  toFlat,
  fromFlat,
} from "./state.js";

// ─── DOM shortcuts & element refs ────────────────────────────────────────────

export const $ = (/** @type {string} */ sel) => document.querySelector(sel);
export const _$$ = (/** @type {string} */ sel) => document.querySelectorAll(sel);

export const canvasWrap = /** @type {HTMLElement} */ (document.querySelector("#canvas-wrap"));
export const activityBar = /** @type {HTMLElement} */ (document.querySelector("#activity-bar"));
export const leftPanel = /** @type {HTMLElement} */ (document.querySelector("#left-panel"));
export const rightPanel = /** @type {HTMLElement} */ (document.querySelector("#right-panel"));
export const toolbarEl = /** @type {HTMLElement} */ (document.querySelector("#toolbar"));
export const statusbarEl = /** @type {HTMLElement} */ (document.querySelector("#statusbar"));

// ─── Shared containers (mutated in place by owner modules) ───────────────────

/** WeakMap<HTMLElement, Array> — maps rendered DOM elements to their JSON paths */
export const elToPath = new WeakMap();

/**
 * Canvas panels: Array<{ mediaName, canvas, overlay, overlayClk, viewport, dropLine, element,
 * _width }>
 *
 * @type {{
 *   mediaName: string;
 *   canvas: HTMLElement;
 *   overlay: HTMLElement;
 *   overlayClk: HTMLElement;
 *   viewport: HTMLElement;
 *   dropLine: HTMLElement;
 *   element?: HTMLElement | null;
 *   _width?: number | null;
 * }[]}
 */
export const canvasPanels = [];

// ─── Shared constants ────────────────────────────────────────────────────────

/** Void elements that cannot accept children */
export const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export const COMMON_SELECTORS = [
  ":hover",
  ":focus",
  ":active",
  ":focus-within",
  ":focus-visible",
  ":disabled",
  ":first-child",
  ":last-child",
  "::before",
  "::after",
  "::placeholder",
];

/** @param {string} k */
export function isNestedSelector(k) {
  return k.startsWith(":") || k.startsWith(".") || k.startsWith("&") || k.startsWith("[");
}

// ─── Shared utilities ────────────────────────────────────────────────────────

const _styleDebounceTimers = new Map();

/**
 * @param {string} prop
 * @param {number} ms
 * @param {Function} fn
 */
export function debouncedStyleCommit(prop, ms, fn) {
  return (/** @type {unknown[]} */ ...args) => {
    clearTimeout(_styleDebounceTimers.get(prop));
    _styleDebounceTimers.set(
      prop,
      setTimeout(() => {
        _styleDebounceTimers.delete(prop);
        fn(...args);
      }, ms),
    );
  };
}

/** Cancel a pending debounced commit for the given prop key. */
export function cancelStyleDebounce(/** @type {string} */ prop) {
  clearTimeout(_styleDebounceTimers.get(prop));
  _styleDebounceTimers.delete(prop);
}

/**
 * Strip all on* event handler properties from a Jx document tree (deep clone).
 *
 * @param {import("./state.js").JxNode | unknown} node
 * @returns {import("./state.js").JxNode | unknown}
 */
export function stripEventHandlers(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(stripEventHandlers);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("on") && typeof v === "object" && (v?.$ref || v?.$prototype === "Function"))
      continue;
    if (k === "children") {
      out.children = Array.isArray(v) ? v.map(stripEventHandlers) : stripEventHandlers(v);
    } else if (k === "cases" && typeof v === "object") {
      /** @type {Record<string, unknown>} */
      const cases = {};
      for (const [ck, cv] of Object.entries(v)) cases[ck] = stripEventHandlers(cv);
      out.cases = cases;
    } else if (k === "state" && typeof v === "object" && v !== null) {
      /** @type {Record<string, unknown>} */
      const state = {};
      for (const [sk, sv] of Object.entries(v)) {
        if (sv && typeof sv === "object" && sv.timing === "server") continue;
        state[sk] = sv;
      }
      out.state = state;
    } else if (k === "style" || k === "attributes" || k === "$media") {
      out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── Render orchestration ────────────────────────────────────────────────────

/** @type {Map<string, Function>} */
const _renderers = new Map();

/**
 * Register a named renderer. Called at module import time by each module.
 *
 * @param {string} name
 * @param {Function} fn
 */
export function registerRenderer(name, fn) {
  _renderers.set(name, fn);
}

/** Call all registered renderers (full repaint). */
export function render() {
  for (const [name, fn] of _renderers.entries()) {
    try {
      fn();
    } catch (e) {
      console.error(`Renderer "${name}" failed:`, e);
    }
  }
}

/**
 * Call specific renderers by name.
 *
 * @param {...string} names
 */
export function renderOnly(...names) {
  for (const name of names) {
    const fn = _renderers.get(name);
    if (!fn) continue;
    try {
      fn();
    } catch (e) {
      console.error(`Renderer "${name}" failed:`, e);
    }
  }
}

// ─── Update dispatch (late-bound) ────────────────────────────────────────────
// studio.js registers the real update implementation via setUpdateFn() during bootstrap.
// This allows extracted modules to import `update` from store.js without circular deps.

/** @type {(state: import("./state.js").StudioState) => void} */
let _updateFn = () => {
  throw new Error("update() called before setUpdateFn() — bootstrap not complete");
};

/** @type {() => import("./state.js").StudioState | null} */
let _getStateFn = () => null;

/**
 * Register the update implementation. Called by studio.js at module load time.
 *
 * @param {(state: import("./state.js").StudioState) => void} fn
 */
export function setUpdateFn(fn) {
  _updateFn = fn;
}

/**
 * Register the state getter. Called by studio.js at module load time.
 *
 * @param {() => import("./state.js").StudioState} fn — returns current S
 */
export function setGetStateFn(fn) {
  _getStateFn = fn;
}

/**
 * Get the current state (live, not stale). Synthesized from the active tab's reactive state.
 *
 * @returns {import("./state.js").StudioState}
 */
export function getState() {
  const tab = activeTab.value;
  if (tab) {
    return /** @type {any} */ ({
      document: tab.doc.document,
      mode: tab.doc.mode,
      dirty: tab.doc.dirty,
      handlersSource: tab.doc.handlersSource,
      content: tab.doc.content,
      documentPath: tab.documentPath,
      fileHandle: tab.fileHandle,
      selection: tab.session.selection,
      hover: tab.session.hover,
      clipboard: tab.session.clipboard,
      ui: tab.session.ui,
      canvas: tab.session.canvas,
      documentStack: tab.session.documentStack,
    });
  }
  return /** @type {any} */ (_getStateFn());
}

/**
 * Dispatch a state update + selective re-render.
 *
 * @param {import("./state.js").StudioState} newState
 */
export function update(newState) {
  _updateFn(newState);
}

// ─── Session dispatch (late-bound) ──────────────────────────────────────────
// Lightweight dispatcher for session-only changes (selection, hover, ui).
// Does NOT trigger autosave middleware or push history.

/** @type {(patch: object) => void} */
let _updateSessionFn = () => {
  throw new Error("updateSession() called before setUpdateSessionFn() — bootstrap not complete");
};

/** @param {(patch: object) => void} fn */
export function setUpdateSessionFn(fn) {
  _updateSessionFn = fn;
}

/**
 * Dispatch a session-only state update (selection, hover, ui). Writes directly to reactive tab.
 *
 * @param {object} patch — partial session object, e.g. { ui: { zoom: 2 } }
 */
export function updateSession(patch) {
  const tab = activeTab.value;
  if (tab) {
    const p = /** @type {any} */ (patch);
    if (p.selection !== undefined) tab.session.selection = p.selection;
    if (p.hover !== undefined) tab.session.hover = p.hover;
    if (p.clipboard !== undefined) tab.session.clipboard = p.clipboard;
    if (p.ui) {
      for (const [k, v] of Object.entries(p.ui)) {
        /** @type {any} */ (tab.session.ui)[k] = v;
      }
    }
    if (p.canvas) {
      for (const [k, v] of Object.entries(p.canvas)) {
        /** @type {any} */ (tab.session.canvas)[k] = v;
      }
    }
  }
  _updateSessionFn(patch);
}

/**
 * Update a single UI field. Routes through session dispatch.
 *
 * @param {string} field
 * @param {unknown} value
 */
export function updateUi(field, value) {
  const tab = activeTab.value;
  if (tab) {
    /** @type {any} */ (tab.session.ui)[field] = value;
  }
  _updateSessionFn({ ui: { [field]: value } });
}

/**
 * Update the canvas async state (status, scope, error).
 *
 * @param {object} patch
 */
export function updateCanvas(patch) {
  const tab = activeTab.value;
  if (tab) {
    for (const [k, v] of Object.entries(patch)) {
      /** @type {any} */ (tab.session.canvas)[k] = v;
    }
  }
  _updateSessionFn({ canvas: patch });
}

/** @type {((state: import("./state.js").StudioState) => void)[]} */
const _updateMiddleware = [];

/**
 * Register middleware that runs after every update().
 *
 * @param {(state: import("./state.js").StudioState) => void} fn — receives (state) after core
 *   update
 */
export function addUpdateMiddleware(fn) {
  _updateMiddleware.push(fn);
}

/**
 * Run all registered update middleware.
 *
 * @param {import("./state.js").StudioState} state
 */
export function runUpdateMiddleware(state) {
  for (const mw of _updateMiddleware) mw(state);
}

/** @type {((prevDoc: object, prevSel: import("./state.js").JxPath | null) => void)[]} */
const _postRenderHooks = [];

/**
 * Register a hook that runs after renders in update().
 *
 * @param {(prevDoc: object, prevSel: import("./state.js").JxPath | null) => void} fn
 */
export function addPostRenderHook(fn) {
  _postRenderHooks.push(fn);
}

/**
 * Run all registered post-render hooks.
 *
 * @param {object} prevDoc
 * @param {import("./state.js").JxPath | null} prevSel
 */
export function runPostRenderHooks(prevDoc, prevSel) {
  for (const hook of _postRenderHooks) hook(prevDoc, prevSel);
}
