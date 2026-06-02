/**
 * Canvas DnD — extracted from studio.js (Phase 4m). Registers canvas elements as drag-and-drop
 * targets using @atlaskit/pragmatic-drag-and-drop.
 */

import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";

import { elToPath, canvasPanels, getNodeAtPath, VOID_ELEMENTS, isAncestor } from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { applyDropInstruction } from "../panels/dnd";
import { effectiveZoom } from "../canvas/canvas-helpers";

import type { CanvasPanel } from "../types";
export type { CanvasPanel };

import type { JxPath } from "../state";

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

  const monitorCleanup = monitorForElements({
    onDragStart({ location }) {
      view.lastDragInput = location.current.input;
      for (const el of canvas.querySelectorAll("*")) {
        (el as HTMLElement).style.pointerEvents = "auto";
      }
      for (const p of canvasPanels) p.overlayClk.style.pointerEvents = "none";
    },
    onDrag({ location }) {
      view.lastDragInput = location.current.input;
    },
    onDrop() {
      _activeDropEl?.classList.remove("canvas-drop-target");
      _activeDropEl = null;
      for (const p of canvasPanels) {
        if (p.dropLine) p.dropLine.style.display = "none";
      }
      view.lastDragInput = null;
      for (const el of canvas.querySelectorAll("*")) {
        (el as HTMLElement).style.pointerEvents = "none";
      }
      for (const p of canvasPanels) p.overlayClk.style.pointerEvents = "";
    },
  });
  view.canvasDndCleanups.push(monitorCleanup);

  const document = activeTab.value?.doc.document;
  for (const el of allEls) {
    const elPath = elToPath.get(el);
    if (!elPath) continue;

    const node = getNodeAtPath(document!, elPath);
    const tag = (node?.tagName || "div").toLowerCase();
    const hasElementChildren =
      Array.isArray(node?.children) &&
      node.children.some((c: unknown) => c != null && typeof c === "object");
    const isLeaf = VOID_ELEMENTS.has(tag) || !hasElementChildren;

    const cleanup = dropTargetForElements({
      element: /** @type {HTMLElement} */ (el),
      canDrop({ source }) {
        const srcPath = source.data.path as JxPath | undefined;
        if (srcPath && isAncestor(srcPath, elPath)) return false;
        return true;
      },
      getData() {
        return { path: elPath, _isVoid: isLeaf };
      },
      onDragEnter({ location }) {
        view.lastDragInput = location.current.input;
        if (_activeDropEl && _activeDropEl !== el) {
          _activeDropEl.classList.remove("canvas-drop-target");
        }
        _activeDropEl = el as HTMLElement;
        showCanvasDropIndicator(el as HTMLElement, elPath, isLeaf, panel);
      },
      onDrag({ location }) {
        view.lastDragInput = location.current.input;
        showCanvasDropIndicator(el as HTMLElement, elPath, isLeaf, panel);
      },
      onDragLeave() {},
      onDrop({ source }) {
        dropLine.style.display = "none";
        (el as HTMLElement).classList.remove("canvas-drop-target");
        _activeDropEl = null;
        const { instruction, targetPath } = getCanvasDropResult(el as HTMLElement, elPath, isLeaf);
        applyDropInstruction(instruction, source.data, targetPath);
      },
    });
    view.canvasDndCleanups.push(cleanup);
  }
}

/**
 * @param {HTMLElement} el
 * @param {JxPath} elPath
 * @param {boolean} isLeaf
 * @returns {DropResult}
 */
function getCanvasDropResult(el: HTMLElement, elPath: JxPath, isLeaf: boolean): DropResult {
  if (!view.lastDragInput)
    return { instruction: { type: "make-child" }, referenceEl: el, targetPath: elPath };
  const y = view.lastDragInput.clientY;

  if (elPath.length === 0) {
    const children = Array.from(el.children) as HTMLElement[];
    if (children.length === 0)
      return { instruction: { type: "make-child" }, referenceEl: el, targetPath: elPath };
    return nearestChildEdge(children, y, elPath);
  }

  const rect = el.getBoundingClientRect();
  const relY = (y - rect.top) / rect.height;

  if (isLeaf) {
    const instruction =
      relY < 0.5 ? { type: "reorder-above" as const } : { type: "reorder-below" as const };
    return { instruction, referenceEl: el, targetPath: elPath };
  }

  if (relY < 0.25)
    return { instruction: { type: "reorder-above" }, referenceEl: el, targetPath: elPath };
  if (relY > 0.75)
    return { instruction: { type: "reorder-below" }, referenceEl: el, targetPath: elPath };
  return { instruction: { type: "make-child" }, referenceEl: el, targetPath: elPath };
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
    const rect = children[i].getBoundingClientRect();
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
  return { instruction, referenceEl: children[closestIdx], targetPath: childPath };
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
  const wrapRect = viewport.getBoundingClientRect();
  const refRect = referenceEl.getBoundingClientRect();
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
