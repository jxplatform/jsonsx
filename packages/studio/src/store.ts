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
import { INPUT_DEBOUNCE } from "./ui/timing";
import type { JxPath } from "./state";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { CanvasPanel } from "./types";

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
 * @param {number | undefined} ms Debounce delay; `undefined` takes the standard input debounce.
 * @param {(...args: unknown[]) => void} fn
 */
export function debouncedStyleCommit<A extends unknown[]>(
  prop: string,
  ms: number | undefined,
  fn: (...args: A) => void,
) {
  const delay = ms ?? INPUT_DEBOUNCE;
  return (...args: A) => {
    clearTimeout(_styleDebounceTimers.get(prop));
    _styleDebounceTimers.set(
      prop,
      setTimeout(() => {
        _styleDebounceTimers.delete(prop);
        fn(...args);
      }, delay),
    );
  };
}

/** Cancel a pending debounced commit for the given prop key. */
export function cancelStyleDebounce(prop: string) {
  clearTimeout(_styleDebounceTimers.get(prop));
  _styleDebounceTimers.delete(prop);
}

// `stripEventHandlers` moved to ./utils/strip-events (dependency-light, shared with the iframe
// Subtree renderer); re-exported here so existing `from "../store"` imports keep working.
export { stripEventHandlers } from "./utils/strip-events";

// ─── Render orchestration ────────────────────────────────────────────────────

const _renderers = new Map<string, () => void>();

/**
 * How many registered renderers are mid-paint right now.
 *
 * Condition 1 of the `probe.idle()` predicate (`services/idle.ts`, spec §13.5). A renderer is
 * declared `() => void`, but TypeScript happily assigns an `async` function to that type, so a
 * renderer that awaits keeps repainting long after `render()` returned. Counting the returned
 * thenable is what makes "no queued lit render" an answerable question instead of an assumption —
 * the alternative is a sleep, and a sleep cannot name what it is waiting for.
 */
let _rendersInFlight = 0;

/** Renderers currently mid-paint — zero when the shell's DOM has caught up with its state. */
export function rendersInFlight(): number {
  return _rendersInFlight;
}

/** Run one renderer, counting it as in-flight until it returns (or its promise settles). */
function runRenderer(name: string, fn: () => void) {
  _rendersInFlight += 1;
  const done = () => {
    _rendersInFlight -= 1;
  };
  let pending: PromiseLike<unknown> | null = null;
  try {
    const result = fn() as unknown;
    if (typeof (result as PromiseLike<unknown> | null)?.then === "function") {
      pending = result as PromiseLike<unknown>;
    }
  } catch (error) {
    console.error(`Renderer "${name}" failed:`, error);
  }
  if (!pending) {
    done();
    return;
  }
  pending.then(done, (error: unknown) => {
    console.error(`Renderer "${name}" failed:`, error);
    done();
  });
}

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
    runRenderer(name, fn);
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
    runRenderer(name, fn);
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
