/**
 * Canvas helpers — extracted from studio.js (Phase 4n). Shared query/utility functions used by
 * multiple canvas-related modules: element lookup, zoom, panel resolution, inline bubbling.
 */

import { canvasPanels, elToPath, pathsEqual, getNodeAtPath, parentElementPath } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { isInlineInContext } from "../editor/inline-edit.js";

/** @type {any} */
let _ctx = null;

/**
 * Initialize the canvas helpers module.
 *
 * @param {{ getCanvasMode: () => string }} ctx
 */
export function initCanvasHelpers(ctx) {
  _ctx = ctx;
}

/** Effective zoom scale — always 1 in edit (content) mode, S.ui.zoom otherwise. */
export function effectiveZoom() {
  return _ctx.getCanvasMode() === "edit" ? 1 : (activeTab.value?.session.ui.zoom ?? 1);
}

/** Return the active canvas panel based on the current activeMedia setting. */
export function getActivePanel() {
  if (canvasPanels.length === 0) return null;
  if (canvasPanels.length === 1) return canvasPanels[0];
  const activeMedia = activeTab.value?.session.ui.activeMedia ?? null;
  for (const p of canvasPanels) {
    if (activeMedia === null && (p.mediaName === "base" || p.mediaName === null)) return p;
    if (p.mediaName === activeMedia) return p;
  }
  return canvasPanels[0];
}

/**
 * Walk up the tree from a path, bubbling past inline elements until we find the nearest non-inline
 * ancestor. Returns the original path if already non-inline.
 *
 * @param {any} doc
 * @param {any} path
 */
export function bubbleInlinePath(doc, path) {
  let currentPath = path;
  while (currentPath.length >= 2) {
    const node = getNodeAtPath(doc, currentPath);
    const pPath = parentElementPath(currentPath);
    const parentNode = pPath ? getNodeAtPath(doc, pPath) : null;
    if (!node || !parentNode) break;
    const childTag = (node.tagName ?? "div").toLowerCase();
    const parentTag = (parentNode.tagName ?? "div").toLowerCase();
    if (!isInlineInContext(childTag, parentTag)) break;
    currentPath = pPath;
  }
  return currentPath;
}

/**
 * Find a canvas DOM element by its document path.
 *
 * @param {any} path
 * @param {any} canvasEl
 */
export function findCanvasElement(path, canvasEl) {
  let el = canvasEl.firstElementChild;
  if (!el) return null;
  if (path.length === 0) return el;

  for (let i = 0; i < path.length; i += 2) {
    if (path[i] !== "children" && path[i] !== "cases") return null;
    const idx = path[i + 1];
    if (idx === undefined) {
      el = el.children[0];
    } else if (idx === "map") {
      el = el.children[0]?.children[0];
    } else {
      el = el.children[idx];
    }
    if (!el) break;
  }

  if (el) {
    const elPath = elToPath.get(el);
    if (elPath && pathsEqual(elPath, path)) return el;
  }

  for (const candidate of canvasEl.querySelectorAll("*")) {
    const p = elToPath.get(candidate);
    if (p && pathsEqual(p, path)) return candidate;
  }
  return null;
}

/**
 * Build an overlay box descriptor (no DOM creation).
 *
 * @param {any} el
 * @param {any} type
 * @param {any} panel
 */
export function overlayBoxDescriptor(el, type, panel) {
  const vpRect = panel.viewport.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const scale = effectiveZoom();
  return {
    cls: `overlay-box overlay-${type}`,
    top: `${(elRect.top - vpRect.top + panel.viewport.scrollTop) / scale}px`,
    left: `${(elRect.left - vpRect.left + panel.viewport.scrollLeft) / scale}px`,
    width: `${elRect.width / scale}px`,
    height: `${elRect.height / scale}px`,
  };
}
