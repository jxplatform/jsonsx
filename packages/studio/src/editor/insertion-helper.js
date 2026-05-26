/**
 * Insertion-helper.js — Single floating "+" button for element insertion on the canvas.
 *
 * Uses CSS Anchor Positioning to attach to sibling boundaries and empty containers. Uses Native
 * Observables (Chrome 135+) for declarative event handling.
 */

import { showSlashMenu } from "./slash-menu.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc, mutateInsertNode } from "../tabs/transact.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ObservableSubscription
 * @property {(obj: { next: Function }) => void} subscribe - Subscribes to the observable stream.
 */

/**
 * @typedef {Object} ObservableElement
 * @property {(event: string, options?: Object) => ObservableSubscription} on - Creates an
 *   observable for the given event.
 */

/**
 * @typedef {Object} CanvasPanel
 * @property {HTMLElement} canvas - The canvas content element.
 * @property {HTMLElement & ObservableElement} overlayClk - The overlay click-capture layer.
 * @property {HTMLElement} overlay - The overlay rendering layer.
 * @property {HTMLElement} viewport - The viewport container (containing block for anchor
 *   positioning).
 */

/**
 * @typedef {Object} InsertionHelperContext
 * @property {() => string} getCanvasMode - Returns the active canvas mode.
 * @property {(fn: Function) => unknown} withPanelPointerEvents - Executes fn with pointer-events
 *   temporarily enabled on the canvas.
 * @property {() => number} effectiveZoom - Returns the current zoom scale factor.
 * @property {(tag: string) => Object} defaultDef - Creates a default element definition for a tag.
 * @property {(path: JxPath) => JxPath | null} parentElementPath - Returns the parent element path,
 *   or null for root.
 * @property {(path: JxPath) => string | number} childIndex - Returns the child index within the
 *   parent.
 * @property {(doc: JxMutableNode, path: JxPath) => JxMutableNode | null} getNodeAtPath - Retrieves
 *   the node at a document path.
 * @property {WeakMap<Element, JxPath>} elToPath - Maps rendered DOM elements to their document
 *   paths.
 * @property {CanvasPanel} panel - The active canvas panel.
 */

// ─── State ───────────────────────────────────────────────────────────────────

/** @type {InsertionHelperContext | null} */
let _ctx = null;

/** @type {HTMLElement | null} */
let _helper = null;

/** @type {HTMLElement | null} */
let _currentAnchor = null;

/** @type {{ edge: string; path: JxPath; parentPath: JxPath; idx: number } | null} */
let _insertionPoint = null;

/** @type {AbortController | null} */
let _abort = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let _hideTimer = null;

// Edge detection threshold in pixels
const EDGE_THRESHOLD = 14;

// Delay before hiding to allow cursor to reach the button
const HIDE_DELAY = 300;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Mount the insertion helper system.
 *
 * @param {InsertionHelperContext} ctx
 */
export function mount(ctx) {
  _ctx = ctx;
  const { panel } = ctx;

  _helper = document.createElement("button");
  _helper.className = "insertion-helper";
  _helper.textContent = "+";
  _helper.addEventListener("click", onHelperClick);
  _helper.addEventListener("mouseenter", () => {
    cancelHide();
  });
  _helper.addEventListener("mouseleave", () => {
    scheduleHide();
  });
  panel.viewport.appendChild(_helper);

  _abort = new AbortController();

  // Listen on viewport — overlayClk gets pointer-events:none during editing/selection
  const viewport = /** @type {HTMLElement & ObservableElement} */ (panel.viewport);
  if (typeof viewport.on === "function") {
    viewport.on("mousemove", { signal: _abort.signal }).subscribe({ next: onMouseMove });
    viewport.on("mouseleave", { signal: _abort.signal }).subscribe({ next: hide });
  } else {
    panel.viewport.addEventListener("mousemove", onMouseMove, { signal: _abort.signal });
    panel.viewport.addEventListener("mouseleave", hide, { signal: _abort.signal });
  }
}

export function unmount() {
  _abort?.abort();
  _abort = null;
  cancelHide();
  if (_helper?.parentElement) _helper.remove();
  clearAnchor();
  _helper = null;
  _ctx = null;
  _insertionPoint = null;
}

// ─── Detection ───────────────────────────────────────────────────────────────

/** @param {MouseEvent} e */
function onMouseMove(e) {
  if (!_ctx || !_helper) return;

  const { getCanvasMode } = _ctx;
  if (getCanvasMode() !== "design") {
    hide();
    return;
  }

  const { panel, withPanelPointerEvents, elToPath } = _ctx;
  const el = /** @type {HTMLElement | null} */ (
    withPanelPointerEvents(() => document.elementFromPoint(e.clientX, e.clientY))
  );

  if (!el || !panel.canvas.contains(el)) {
    hide();
    return;
  }

  const path = elToPath.get(el);
  if (!path) {
    hide();
    return;
  }

  // Empty container: show centered "+"
  if (el.classList.contains("empty-container-placeholder")) {
    showAt(el, "center", path, path, 0);
    return;
  }

  // Root element — can't insert siblings above/below root
  if (path.length === 0) {
    hide();
    return;
  }

  // Determine layout direction of parent container
  const parent = el.parentElement;
  if (!parent) {
    hide();
    return;
  }

  const parentStyle = getComputedStyle(parent);
  const display = parentStyle.display;
  const isFlex = display === "flex" || display === "inline-flex";
  const isGrid = display === "grid" || display === "inline-grid";
  const isRow =
    (isFlex && parentStyle.flexDirection.startsWith("row")) ||
    (isGrid && parentStyle.gridAutoFlow?.startsWith("column"));

  // Calculate relative position within element
  const rect = el.getBoundingClientRect();
  const parentPath = _ctx.parentElementPath(path);
  if (!parentPath) {
    hide();
    return;
  }
  const childIdx = /** @type {number} */ (_ctx.childIndex(path));

  if (isRow) {
    const relX = e.clientX - rect.left;
    if (relX < EDGE_THRESHOLD) {
      showAt(el, "left", path, parentPath, childIdx);
    } else if (rect.width - relX < EDGE_THRESHOLD) {
      showAt(el, "right", path, parentPath, childIdx + 1);
    } else {
      hide();
    }
  } else {
    const relY = e.clientY - rect.top;
    if (relY < EDGE_THRESHOLD) {
      showAt(el, "top", path, parentPath, childIdx);
    } else if (rect.height - relY < EDGE_THRESHOLD) {
      showAt(el, "bottom", path, parentPath, childIdx + 1);
    } else {
      hide();
    }
  }
}

// ─── Show / Hide ─────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} el
 * @param {string} edge
 * @param {JxPath} path
 * @param {JxPath} parentPath
 * @param {number} idx
 */
function showAt(el, edge, path, parentPath, idx) {
  if (!_helper) return;

  // Set CSS anchor on target element
  if (_currentAnchor !== el) {
    clearAnchor();
    el.style.anchorName = "--jx-insert";
    _currentAnchor = el;
  }

  _helper.dataset.edge = edge;
  _helper.classList.add("visible");
  _insertionPoint = { edge, path, parentPath, idx };
  cancelHide();
}

function scheduleHide() {
  cancelHide();
  _hideTimer = setTimeout(hideNow, HIDE_DELAY);
}

function cancelHide() {
  if (_hideTimer !== null) {
    clearTimeout(_hideTimer);
    _hideTimer = null;
  }
}

function hide() {
  scheduleHide();
}

function hideNow() {
  _hideTimer = null;
  if (!_helper) return;
  _helper.classList.remove("visible");
  clearAnchor();
  _insertionPoint = null;
}

function clearAnchor() {
  if (_currentAnchor) {
    _currentAnchor.style.anchorName = "";
    _currentAnchor = null;
  }
}

// ─── Insertion ───────────────────────────────────────────────────────────────

function onHelperClick(/** @type {MouseEvent} */ e) {
  e.stopPropagation();
  e.preventDefault();

  if (!_ctx || !_helper || !_insertionPoint) return;

  const captured = _insertionPoint;
  showSlashMenu(_helper, "", {
    showFilter: true,
    onSelect: (cmd) => onSlashSelect(cmd, captured),
  });
}

/**
 * @param {{ label: string; tag: string; description?: string }} cmd
 * @param {{ edge: string; path: JxPath; parentPath: JxPath; idx: number }} point
 */
function onSlashSelect(cmd, point) {
  if (!_ctx) return;

  const { defaultDef } = _ctx;
  const { parentPath, idx, edge } = point;

  const newDef = defaultDef(cmd.tag);
  const insertPath = edge === "center" ? point.path : parentPath;
  const insertIdx = edge === "center" ? 0 : idx;
  const newPath = [...insertPath, "children", insertIdx];

  transactDoc(activeTab.value, (t) => {
    mutateInsertNode(t, insertPath, insertIdx, newDef);
    t.session.selection = newPath;
  });

  hide();
}
