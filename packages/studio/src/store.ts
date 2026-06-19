/// <reference lib="dom" />
/**
 * Store.js — Shared state hub for Jx Studio
 *
 * Every other studio module imports from this file for shared state, DOM refs, render
 * orchestration, and state.js re-exports. This prevents circular dependencies by keeping store.js
 * free of domain-specific imports.
 */

// ─── Re-exports from state.js ────────────────────────────────────────────────

import { activeTab } from "./workspace/workspace";
import { isEventBinding } from "@jxsuite/schema/guards";
import type { JxPath } from "./state";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { CanvasPanel } from "./panels/canvas-dnd.js";

export {
  createState,
  getNodeAtPath,
  childList,
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
} from "./state";

// ─── Shell element refs (populated by initShellRefs) ─────────────────────────

export let canvasWrap = null as unknown as HTMLElement;
export let activityBar = null as unknown as HTMLElement;
export let leftPanel = null as unknown as HTMLElement;
export let rightPanel = null as unknown as HTMLElement;
export let toolbarEl = null as unknown as HTMLElement;
export let statusbarEl = null as unknown as HTMLElement;

export function initShellRefs() {
  canvasWrap = document.querySelector("#canvas-wrap") as HTMLElement;
  activityBar = document.querySelector("#activity-bar") as HTMLElement;
  leftPanel = document.querySelector("#left-panel") as HTMLElement;
  rightPanel = document.querySelector("#right-panel") as HTMLElement;
  toolbarEl = document.querySelector("#toolbar") as HTMLElement;
  statusbarEl = document.querySelector("#statusbar") as HTMLElement;
}

// ─── Shared containers (mutated in place by owner modules) ───────────────────

export const elToPath = new WeakMap<Element, JxPath>();

/**
 * Canvas element → the runtime scope its children render with. Captured during live renders so the
 * canvas patcher can re-render a subtree in isolation with the same prototype-chained scope.
 */
export const elToScope = new WeakMap<Element, Record<string, unknown>>();

/**
 * Subtree root element → the effect scope created for its surgical render. Stopped when the subtree
 * is replaced or removed so render-time reactive effects don't accumulate.
 */
export const elToRenderScope = new WeakMap<Element, { stop: () => void }>();

export const canvasPanels: CanvasPanel[] = [];

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
export function isNestedSelector(k: string) {
  return k.startsWith(":") || k.startsWith(".") || k.startsWith("&") || k.startsWith("[");
}

// ─── Shared utilities ────────────────────────────────────────────────────────

const _styleDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * @param {string} prop
 * @param {number} ms
 * @param {(...args: unknown[]) => void} fn
 */
export function debouncedStyleCommit<A extends unknown[]>(
  prop: string,
  ms: number,
  fn: (...args: A) => void,
) {
  return (...args: A) => {
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
export function cancelStyleDebounce(prop: string) {
  clearTimeout(_styleDebounceTimers.get(prop));
  _styleDebounceTimers.delete(prop);
}

/**
 * Strip all on* event handler properties from a Jx document tree (deep clone).
 *
 * @param {JxMutableNode} node
 * @returns {JxMutableNode}
 */
export function stripEventHandlers(node: JxMutableNode): JxMutableNode {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    // Arrays of nodes round-trip element-wise; the array itself is not a node.
    return node.map((n: JxMutableNode) => stripEventHandlers(n)) as unknown as JxMutableNode;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("on") && isEventBinding(v)) {
      continue;
    }
    if (k === "children") {
      out.children = Array.isArray(v)
        ? v.map((c: JxMutableNode) => stripEventHandlers(c))
        : stripEventHandlers(v as JxMutableNode);
    } else if (k === "cases" && typeof v === "object") {
      const cases: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        cases[ck] = stripEventHandlers(cv as JxMutableNode);
      }
      out.cases = cases;
    } else if (k === "state" && typeof v === "object" && v !== null) {
      const state: Record<string, unknown> = {};
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv && typeof sv === "object" && (sv as Record<string, unknown>).timing === "server") {
          continue;
        }
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

const _renderers = new Map<string, () => void>();

/**
 * Register a named renderer. Called at module import time by each module.
 *
 * @param {string} name
 * @param {() => void} fn
 */
export function registerRenderer(name: string, fn: () => void) {
  _renderers.set(name, fn);
}

/** Call all registered renderers (full repaint). */
export function render() {
  for (const [name, fn] of _renderers.entries()) {
    try {
      fn();
    } catch (error) {
      console.error(`Renderer "${name}" failed:`, error);
    }
  }
}

/**
 * Call specific renderers by name.
 *
 * @param {...string} names
 */
export function renderOnly(...names: string[]) {
  for (const name of names) {
    const fn = _renderers.get(name);
    if (!fn) {
      continue;
    }
    try {
      fn();
    } catch (error) {
      console.error(`Renderer "${name}" failed:`, error);
    }
  }
}

// ─── Session dispatch ──────────────────────────────────────────────────────

/**
 * Dispatch a session-only state update (selection, hover, ui). Writes directly to reactive tab.
 *
 * @param {object} patch — partial session object, e.g. { ui: { zoom: 2 } }
 */
export function updateSession(patch: {
  selection?: JxPath | null;
  hover?: JxPath | null;
  clipboard?: JxMutableNode | null;
  ui?: Record<string, unknown>;
  canvas?: Record<string, unknown>;
}) {
  const tab = activeTab.value;
  if (tab) {
    if (patch.selection !== undefined) {
      tab.session.selection = patch.selection as JxPath | null;
    }
    if (patch.hover !== undefined) {
      tab.session.hover = patch.hover as JxPath | null;
    }
    if (patch.clipboard !== undefined) {
      tab.session.clipboard = patch.clipboard!;
    }
    if (patch.ui) {
      for (const [k, v] of Object.entries(patch.ui)) {
        (tab.session.ui as unknown as Record<string, unknown>)[k] = v;
      }
    }
    if (patch.canvas) {
      for (const [k, v] of Object.entries(patch.canvas)) {
        (tab.session.canvas as unknown as Record<string, unknown>)[k] = v;
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
export function updateUi(field: string, value: unknown) {
  const tab = activeTab.value;
  if (tab) {
    (tab.session.ui as unknown as Record<string, unknown>)[field] = value;
  }
}

/**
 * Update the canvas async state (status, scope, error).
 *
 * @param {object} patch
 */
export function updateCanvas(patch: Record<string, unknown>) {
  const tab = activeTab.value;
  if (tab) {
    for (const [k, v] of Object.entries(patch)) {
      (tab.session.canvas as Record<string, unknown>)[k] = v;
    }
  }
}
