/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Canvas DnD — extracted from studio.js (Phase 4m). Registers canvas elements as drag-and-drop
 * targets using @atlaskit/pragmatic-drag-and-drop.
 */

import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";

import { VOID_ELEMENTS, canvasPanels, elToPath, getNodeAtPath, isAncestor } from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { applyDropInstruction } from "../panels/dnd";
import { effectiveZoom } from "../canvas/canvas-helpers";
import { rectOf } from "../utils/geometry";

import type { CanvasPanel } from "../types";

import type { JxPath } from "../state";

export type { CanvasPanel } from "../types";

interface DropInstruction {
  type: "reorder-above" | "reorder-below" | "make-child";
}

interface DropResult {
  instruction: DropInstruction;
  referenceEl: HTMLElement;
  targetPath: JxPath;
}

let _activeDropEl: HTMLElement | null = null;

/**
 * Register all canvas elements in a panel as DnD drop targets.
 *
 * @param {CanvasPanel} panel
 */
export function registerPanelDnD(panel: CanvasPanel) {
  const { canvas, dropLine } = panel;
  const allEls = canvas.querySelectorAll("*");

  // Drop-target callbacks fire on EVERY target in the stack (innermost → outermost),
  // And every canvas element is a drop target — so the indicator and the drop are
  // Driven from the monitor using only the innermost target.
  /** Innermost drop target if it belongs to this panel's canvas, else null */
  const innermostCanvasTarget = (location: {
    current: {
      dropTargets: {
        data: Record<string | symbol, unknown>;
        element: Element;
      }[];
    };
  }) => {
    const [target] = location.current.dropTargets;
    if (!target) {
      return null;
    }
    const tEl = target.element as HTMLElement;
    const tPath = target.data.path;
    if (!canvas.contains(tEl) || !Array.isArray(tPath)) {
      return null;
    }
    return { el: tEl, isLeaf: Boolean(target.data._isVoid), path: tPath as JxPath };
  };

  const monitorCleanup = monitorForElements({
    onDrag({ location }) {
      view.lastDragInput = location.current.input;
      const target = innermostCanvasTarget(location);
      if (target) {
        if (_activeDropEl && _activeDropEl !== target.el) {
          _activeDropEl.classList.remove("canvas-drop-target");
        }
        _activeDropEl = target.el;
        showCanvasDropIndicator(target.el, target.path, target.isLeaf, panel);
      } else if (location.current.dropTargets.length > 0) {
        // Pointer is over a non-canvas target (e.g. a layer row) — hide this panel's
        // Indicator. When over dead space (no targets at all) keep the last indicator
        // Visible so it persists for the whole drag.
        if (_activeDropEl && canvas.contains(_activeDropEl)) {
          _activeDropEl.classList.remove("canvas-drop-target");
          _activeDropEl = null;
        }
        dropLine.style.display = "none";
      }
    },
    onDragStart({ location }) {
      view.lastDragInput = location.current.input;
      for (const el of canvas.querySelectorAll("*")) {
        (el as HTMLElement).style.pointerEvents = "auto";
      }
      for (const p of canvasPanels) {
        p.overlayClk.style.pointerEvents = "none";
      }
    },
    onDrop({ source, location }) {
      const target = innermostCanvasTarget(location);
      if (target) {
        const { instruction, targetPath } = getCanvasDropResult(
          target.el,
          target.path,
          target.isLeaf,
        );
        applyDropInstruction(instruction, source.data, targetPath);
      }
      _activeDropEl?.classList.remove("canvas-drop-target");
      _activeDropEl = null;
      for (const p of canvasPanels) {
        if (p.dropLine) {
          p.dropLine.style.display = "none";
        }
      }
      view.lastDragInput = null;
      for (const el of canvas.querySelectorAll("*")) {
        (el as HTMLElement).style.pointerEvents = "none";
      }
      for (const p of canvasPanels) {
        p.overlayClk.style.pointerEvents = "";
      }
    },
  });
  view.canvasDndCleanups.push(monitorCleanup);

  for (const el of allEls) {
    if (!elToPath.get(el)) {
      continue;
    }
    registerElementDropTarget(el);
  }
}

/**
 * Register one canvas element as a drop target. Path and leaf-ness are read live from elToPath and
 * the current document at drag time, so surgical patches that remap sibling paths never leave stale
 * closures behind.
 *
 * @param {Element} el
 */
function registerElementDropTarget(el: Element) {
  const cleanup = dropTargetForElements({
    canDrop({ source }) {
      const elPath = elToPath.get(el);
      if (!elPath) {
        return false;
      }
      const srcPath = source.data.path as JxPath | undefined;
      if (srcPath && isAncestor(srcPath, elPath)) {
        return false;
      }
      return true;
    },
    element: /** @type {HTMLElement} */ el,
    getData() {
      const elPath = elToPath.get(el) ?? [];
      const document = activeTab.value?.doc.document;
      const node = document ? getNodeAtPath(document, elPath) : undefined;
      const tag = (node?.tagName || "div").toLowerCase();
      const hasElementChildren =
        Array.isArray(node?.children) &&
        node.children.some((c: unknown) => c != null && typeof c === "object");
      return { _isVoid: VOID_ELEMENTS.has(tag) || !hasElementChildren, path: elPath };
    },
  });
  view.canvasDndCleanups.push(cleanup);
}

/**
 * Register drop targets for a freshly patched-in subtree (root plus descendants). Cleanups join
 * view.canvasDndCleanups and are released by the next full render like all canvas DnD handlers.
 *
 * @param {HTMLElement} rootEl
 */
export function registerSubtreeDnD(rootEl: HTMLElement) {
  if (elToPath.get(rootEl)) {
    registerElementDropTarget(rootEl);
  }
  for (const el of rootEl.querySelectorAll("*")) {
    if (elToPath.get(el)) {
      registerElementDropTarget(el);
    }
  }
}

/**
 * @param {HTMLElement} el
 * @param {JxPath} elPath
 * @param {boolean} isLeaf
 * @returns {DropResult}
 */
function getCanvasDropResult(el: HTMLElement, elPath: JxPath, isLeaf: boolean): DropResult {
  if (!view.lastDragInput) {
    return {
      instruction: { type: "make-child" },
      referenceEl: el,
      targetPath: elPath,
    };
  }
  const y = view.lastDragInput.clientY;

  if (elPath.length === 0) {
    const children = [...el.children] as HTMLElement[];
    if (children.length === 0) {
      return {
        instruction: { type: "make-child" },
        referenceEl: el,
        targetPath: elPath,
      };
    }
    return nearestChildEdge(children, y, elPath);
  }

  const rect = rectOf(el);
  const relY = (y - rect.top) / rect.height;

  if (isLeaf) {
    const instruction =
      relY < 0.5 ? { type: "reorder-above" as const } : { type: "reorder-below" as const };
    return { instruction, referenceEl: el, targetPath: elPath };
  }

  if (relY < 0.25) {
    return {
      instruction: { type: "reorder-above" },
      referenceEl: el,
      targetPath: elPath,
    };
  }
  if (relY > 0.75) {
    return {
      instruction: { type: "reorder-below" },
      referenceEl: el,
      targetPath: elPath,
    };
  }
  return {
    instruction: { type: "make-child" },
    referenceEl: el,
    targetPath: elPath,
  };
}

/**
 * Find the nearest child edge to the cursor and return the appropriate instruction along with the
 * reference child element and its path.
 *
 * @param {HTMLElement[]} children
 * @param {number} cursorY
 * @param {JxPath} parentPath
 * @returns {DropResult}
 */
function nearestChildEdge(children: HTMLElement[], cursorY: number, parentPath: JxPath) {
  let closestDist = Infinity;
  let instruction = { type: "reorder-below" } as DropInstruction;
  let closestIdx = children.length - 1;

  for (let i = 0; i < children.length; i++) {
    const rect = rectOf(children[i]!);
    const topDist = Math.abs(cursorY - rect.top);
    const bottomDist = Math.abs(cursorY - rect.bottom);

    if (topDist < closestDist) {
      closestDist = topDist;
      instruction = { type: "reorder-above" };
      closestIdx = i;
    }
    if (bottomDist < closestDist) {
      closestDist = bottomDist;
      instruction = { type: "reorder-below" };
      closestIdx = i;
    }
  }

  const childPath = [...parentPath, "children", closestIdx];
  return {
    instruction,
    referenceEl: children[closestIdx]!,
    targetPath: childPath,
  };
}

/**
 * @param {HTMLElement} el
 * @param {JxPath} elPath
 * @param {boolean} isLeaf
 * @param {CanvasPanel} panel
 */
function showCanvasDropIndicator(
  el: HTMLElement,
  elPath: JxPath,
  isLeaf: boolean,
  panel: CanvasPanel,
) {
  const { instruction, referenceEl } = getCanvasDropResult(el, elPath, isLeaf);
  const { dropLine, viewport } = panel;

  const scale = effectiveZoom();
  const wrapRect = rectOf(viewport);
  const refRect = rectOf(referenceEl);
  const left = (refRect.left - wrapRect.left + viewport.scrollLeft) / scale;
  const width = refRect.width / scale;

  if (instruction.type === "make-child") {
    dropLine.style.display = "block";
    dropLine.style.top = `${(refRect.top - wrapRect.top + viewport.scrollTop) / scale}px`;
    dropLine.style.left = `${left}px`;
    dropLine.style.width = `${width}px`;
    dropLine.style.height = `${refRect.height / scale}px`;
    dropLine.className = "canvas-drop-indicator inside";
    el.classList.add("canvas-drop-target");
    return;
  }

  el.classList.remove("canvas-drop-target");
  const top =
    instruction.type === "reorder-above"
      ? (refRect.top - wrapRect.top + viewport.scrollTop) / scale
      : (refRect.bottom - wrapRect.top + viewport.scrollTop) / scale;

  dropLine.style.display = "block";
  dropLine.style.top = `${top}px`;
  dropLine.style.left = `${left}px`;
  dropLine.style.width = `${width}px`;
  dropLine.style.height = "";
  dropLine.className = "canvas-drop-indicator line";
}
