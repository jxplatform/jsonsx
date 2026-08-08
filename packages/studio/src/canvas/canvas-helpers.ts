/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Canvas helpers — extracted from studio.js (Phase 4n). Shared query/utility functions used by
 * multiple canvas-related modules: element lookup, zoom, panel resolution, inline bubbling.
 */

import { getNodeAtPath, parentElementPath } from "../store";
import { activeCanvasSurface, activeMediaOfPane } from "./canvas-surface";
import { isInlineInContext } from "../editor/inline-edit";
import type { CanvasSurface } from "./canvas-surface";
import type { CanvasPanel } from "../types";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";

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

/**
 * The active canvas panel of ONE pane's stage, from that pane's own `activeMedia`.
 *
 * The breakpoint a stage is showing is a fact about the tab in it — `session.ui.activeMedia` — so
 * this reads it from `surface.paneId`'s tab and never from the focus. {@link getActivePanel} is this
 * function applied to the focused pane, which is what "the active panel" means when nobody says
 * which one.
 *
 * @param {CanvasSurface} surface
 * @returns {CanvasPanel | null}
 */
export function panelOfSurface(surface: CanvasSurface): CanvasPanel | null {
  const canvasPanels = surface.panels;
  if (canvasPanels.length === 0) {
    return null;
  }
  if (canvasPanels.length === 1) {
    return canvasPanels[0]!;
  }
  const activeMedia = activeMediaOfPane(surface.paneId);
  for (const p of canvasPanels) {
    if (activeMedia === null && (p.mediaName === "base" || p.mediaName === null)) {
      return p;
    }
    if (p.mediaName === activeMedia) {
      return p;
    }
  }
  return canvasPanels[0]!;
}

/**
 * Return the active canvas panel of the FOCUSED pane, based on its activeMedia setting.
 *
 * Panels belong to a pane's stage (`canvas-surface.ts`), so "the active panel" is only answerable
 * relative to one — this is the pane whose artboards the person is looking at.
 */
export function getActivePanel() {
  return panelOfSurface(activeCanvasSurface());
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

  return el ?? null;
}
