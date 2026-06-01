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
  requireProjectState,
  updateFrontmatter,
} from "./state.js";

// ─── Shell element refs (populated by initShellRefs) ─────────────────────────

export let canvasWrap = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
export let activityBar = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
export let leftPanel = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
export let rightPanel = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
export let toolbarEl = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
export let statusbarEl = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));

export function initShellRefs() {
  canvasWrap = /** @type {HTMLElement} */ (document.querySelector("#canvas-wrap"));
  activityBar = /** @type {HTMLElement} */ (document.querySelector("#activity-bar"));
  leftPanel = /** @type {HTMLElement} */ (document.querySelector("#left-panel"));
  rightPanel = /** @type {HTMLElement} */ (document.querySelector("#right-panel"));
  toolbarEl = /** @type {HTMLElement} */ (document.querySelector("#toolbar"));
  statusbarEl = /** @type {HTMLElement} */ (document.querySelector("#statusbar"));
}

// ─── Shared containers (mutated in place by owner modules) ───────────────────

/** @type {WeakMap<Element, JxPath>} */
export const elToPath = new WeakMap();

/** @type {import("./panels/canvas-dnd.js").CanvasPanel[]} */
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
 * @param {JxMutableNode} node
 * @returns {JxMutableNode}
 */
export function stripEventHandlers(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(stripEventHandlers);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (
      k.startsWith("on") &&
      typeof v === "object" &&
      (v?.$ref || v?.$prototype === "Function" || v?.$expression)
    )
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

// ─── Session dispatch ──────────────────────────────────────────────────────

/**
 * Dispatch a session-only state update (selection, hover, ui). Writes directly to reactive tab.
 *
 * @param {object} patch — partial session object, e.g. { ui: { zoom: 2 } }
 */
export function updateSession(patch) {
  const tab = activeTab.value;
  if (tab) {
    const p = /**
     * @type {{
     *   selection?: unknown;
     *   hover?: unknown;
     *   clipboard?: unknown;
     *   ui?: Record<string, unknown>;
     *   canvas?: Record<string, unknown>;
     * }}
     */ (patch);
    if (p.selection !== undefined)
      tab.session.selection = /** @type {JxPath | null} */ (p.selection);
    if (p.hover !== undefined) tab.session.hover = /** @type {JxPath | null} */ (p.hover);
    if (p.clipboard !== undefined) tab.session.clipboard = p.clipboard;
    if (p.ui) {
      for (const [k, v] of Object.entries(p.ui)) {
        /** @type {Record<string, unknown>} */ (tab.session.ui)[k] = v;
      }
    }
    if (p.canvas) {
      for (const [k, v] of Object.entries(p.canvas)) {
        /** @type {Record<string, unknown>} */ (tab.session.canvas)[k] = v;
      }
    }
  }
}

/**
 * Update a single UI field.
 *
 * @param {string} field
 * @param {unknown} value
 */
export function updateUi(field, value) {
  const tab = activeTab.value;
  if (tab) {
    /** @type {Record<string, unknown>} */ (tab.session.ui)[field] = value;
  }
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
      /** @type {Record<string, unknown>} */ (tab.session.canvas)[k] = v;
    }
  }
}
