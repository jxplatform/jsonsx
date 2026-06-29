/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Canvas helpers — extracted from studio.js (Phase 4n). Shared query/utility functions used by
 * multiple canvas-related modules: element lookup, zoom, panel resolution, inline bubbling.
 */

import { canvasPanels, elToPath, getNodeAtPath, parentElementPath, pathsEqual } from "../store";
import { rectOf } from "../utils/geometry";
import { activeTab } from "../workspace/workspace";
import { isInlineInContext } from "../editor/inline-edit";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { CanvasPanel } from "../types";

let _ctx: { getCanvasMode: () => string; getZoom: () => number } | null = null;

/**
 * Initialize the canvas helpers module.
 *
 * @param {{ getCanvasMode: () => string; getZoom: () => number }} ctx
 */
export function initCanvasHelpers(ctx: { getCanvasMode: () => string; getZoom: () => number }) {
  _ctx = ctx;
}

/** Effective zoom scale — always 1 in edit (content) mode, actual zoom otherwise. */
export function effectiveZoom() {
  const ctx = _ctx!;
  return ctx.getCanvasMode() === "edit"
    ? 1
    : (ctx.getZoom?.() ?? activeTab.value?.session.ui.zoom ?? 1);
}

/**
 * Convert a canvas panel's mediaName to an activeMedia value. Panels without a breakpoint (content
 * mode, single-panel docs) carry "" or "base" — both mean the base style context (null).
 *
 * @param {string | null | undefined} mediaName
 * @returns {string | null}
 */
export function panelMediaToActiveMedia(mediaName: string | null | undefined) {
  return !mediaName || mediaName === "base" ? null : mediaName;
}

/** Return the active canvas panel based on the current activeMedia setting. */
export function getActivePanel() {
  if (canvasPanels.length === 0) {
    return null;
  }
  if (canvasPanels.length === 1) {
    return canvasPanels[0];
  }
  const activeMedia = activeTab.value?.session.ui.activeMedia ?? null;
  for (const p of canvasPanels) {
    if (activeMedia === null && (p.mediaName === "base" || p.mediaName === null)) {
      return p;
    }
    if (p.mediaName === activeMedia) {
      return p;
    }
  }
  return canvasPanels[0];
}

/**
 * Walk up the tree from a path, bubbling past inline elements until we find the nearest non-inline
 * ancestor. Returns the original path if already non-inline.
 *
 * @param {JxMutableNode | undefined} doc
 * @param {JxPath} path
 */
export function bubbleInlinePath(doc: JxMutableNode | undefined, path: JxPath) {
  if (!doc) {
    return path;
  }
  let currentPath = path;
  while (currentPath.length >= 2) {
    const node = getNodeAtPath(doc, currentPath);
    const pPath = parentElementPath(currentPath);
    const parentNode = pPath ? getNodeAtPath(doc, pPath) : null;
    if (!node || !parentNode) {
      break;
    }
    const childTag = (node.tagName ?? "div").toLowerCase();
    const parentTag = (parentNode.tagName ?? "div").toLowerCase();
    if (!isInlineInContext(childTag, parentTag)) {
      break;
    }
    currentPath = pPath as JxPath;
  }
  return currentPath;
}

/**
 * Find a canvas DOM element by its document path.
 *
 * @param {JxPath} path
 * @param {HTMLElement} canvasEl
 * @returns {HTMLElement | null}
 */
export function findCanvasElement(path: JxPath, canvasEl: HTMLElement) {
  let el: HTMLElement | null | undefined = canvasEl.firstElementChild as HTMLElement | null;
  if (!el) {
    return null;
  }
  if (path.length === 0) {
    return el;
  }

  let i = 0;
  while (i < path.length) {
    const seg = path[i];
    // A lone "map" segment steps into a repeater perimeter's single template child.
    if (seg === "map") {
      el = el.children[0] as HTMLElement | undefined;
      i += 1;
      if (!el) {
        break;
      }
      continue;
    }
    if (seg !== "children" && seg !== "cases") {
      return null;
    }
    const idx = path[i + 1];
    if (idx === undefined) {
      el = el.children[0] as HTMLElement | undefined;
    } else if (idx === "map") {
      // Legacy whole-children template `[..., "children", "map"]`: perimeter at child[0].
      el = el.children[0]?.children[0] as HTMLElement | undefined;
    } else {
      el = el.children[idx as number] as HTMLElement | undefined;
    }
    if (!el) {
      break;
    }
    i += 2;
  }

  if (el) {
    const elPath = elToPath.get(el);
    if (elPath && pathsEqual(elPath, path)) {
      return el;
    }
  }

  for (const candidate of canvasEl.querySelectorAll("*")) {
    const p = elToPath.get(candidate);
    if (p && pathsEqual(p, path)) {
      return candidate as HTMLElement;
    }
  }
  return null;
}

/**
 * Build an overlay box descriptor (no DOM creation).
 *
 * @param {Element} el
 * @param {string} type
 * @param {import("../types").CanvasPanel} panel
 */
export function overlayBoxDescriptor(el: Element, type: string, panel: CanvasPanel) {
  const viewport = panel.viewport as HTMLElement;
  const vpRect = rectOf(viewport);
  const elRect = rectOf(el);
  const scale = effectiveZoom();
  return {
    cls: `overlay-box overlay-${type}`,
    height: `${elRect.height / scale}px`,
    left: `${(elRect.left - vpRect.left + viewport.scrollLeft) / scale}px`,
    top: `${(elRect.top - vpRect.top + viewport.scrollTop) / scale}px`,
    width: `${elRect.width / scale}px`,
  };
}
