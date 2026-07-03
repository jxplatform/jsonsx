/// <reference lib="dom" />
/**
 * DnD registration functions — extracted from studio.js (Phase 4). Registers drag-and-drop behavior
 * on layer rows, component cards, and element cards.
 */

import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { disableNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview";
import {
  attachInstruction,
  extractInstruction,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item";

import {
  childIndex,
  childList,
  getNodeAtPath,
  isAncestor,
  leftPanel,
  parentElementPath,
  renderOnly,
} from "../store";
import { mutateInsertNode, mutateMoveNode, transact, transactDoc } from "../tabs/transact";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import {
  buildComponentInstance,
  componentRegistry,
  computeRelativePath,
} from "../files/components";
import { renderComponentPreview } from "./component-preview";
import { defaultDef, unsafeTags } from "./shared";
import { elementAtPoint } from "../utils/geometry";
import type { JxPath } from "../state";
import type { Tab } from "../tabs/tab";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { ComponentEntry } from "../files/components.js";

interface DragCanDragArgs {
  element: HTMLElement;
  input: { clientX: number; clientY: number };
}

/** The `onGenerateDragPreview` argument subset we forward to {@link disableNativeDragPreview}. */
interface DragPreviewArgs {
  nativeSetDragImage: ((image: Element, x: number, y: number) => void) | null;
}

interface DragDropSourceArgs {
  source: { data: Record<string, unknown>; element: HTMLElement };
}

interface DragSelfArgs {
  self: { data: Record<string, unknown> };
}

interface DragMonitorDropArgs {
  source: { data: Record<string, unknown>; element: HTMLElement };
  location: { current: { dropTargets: { data: Record<string, unknown> }[] } };
}

/** Register DnD on layer rows — called from left-panel.js after render */
export function registerLayersDnD() {
  requestAnimationFrame(() => {
    const container = leftPanel?.querySelector(".layers-container") as HTMLElement | null;
    if (!container) {
      return;
    }

    for (const row of container.querySelectorAll("[data-dnd-row]") as NodeListOf<HTMLElement>) {
      const rowPath = (row.dataset.path as string)
        .split("/")
        .map((s: string) => (/^\d+$/.test(s) ? Math.trunc(Number(s)) : s)) as JxPath;
      const rowDepth = Math.trunc(Number(row.dataset.dndDepth as string)) || 0;
      const isVoid = Object.hasOwn(row.dataset, "dndVoid");
      const isExpanded = Object.hasOwn(row.dataset, "dndExpanded");

      const cleanup = combine(
        draggable({
          canDrag({ element: _el, input }: DragCanDragArgs) {
            const target = elementAtPoint(input.clientX, input.clientY) as HTMLElement;
            if (target?.closest(".layer-actions")) {
              return false;
            }
            return true;
          },
          element: row,
          getInitialData() {
            return { path: rowPath, type: "tree-node" };
          },
          onGenerateDragPreview({ nativeSetDragImage }: DragPreviewArgs) {
            // Suppress the browser's native drag image — the cross-frame ghost (Phase 4c) is the
            // Only drag affordance, so a duplicate native preview would double up.
            disableNativeDragPreview({ nativeSetDragImage });
          },
          onDragStart() {
            row.classList.add("dragging");
            view.layerDragSourceHeight = row.offsetHeight;
            if (isExpanded) {
              hideDescendantRows(row, container);
            }
          },
          onDrop() {
            row.classList.remove("dragging");
            if (isExpanded) {
              renderOnly("leftPanel");
            }
          },
        }),
        dropTargetForElements({
          element: row,
          canDrop({ source }: DragDropSourceArgs) {
            const srcPath = source.data.path as JxPath | undefined;
            if (srcPath && isAncestor(srcPath, rowPath)) {
              return false;
            }
            return true;
          },
          getData({
            input,
            element,
          }: {
            input: Parameters<typeof attachInstruction>[1]["input"];
            element: Element;
          }) {
            return attachInstruction(
              { path: rowPath },
              {
                block: isVoid ? ["make-child"] : [],
                currentLevel: rowDepth,
                element,
                indentPerLevel: 16,
                input,
                mode: isExpanded ? "expanded" : "standard",
              },
            ) as Record<string | symbol, unknown>;
          },
          onDragEnter({ self }: DragSelfArgs) {
            showLayerDropGap(row, self.data, container);
          },
          onDrag({ self }: DragSelfArgs) {
            showLayerDropGap(row, self.data, container);
          },
          // No onDragLeave clear — the gap persists while the pointer crosses dead space
          // Between rows; the monitor clears it when the drag moves to a non-tree target.
          onDrop() {
            clearLayerDropGap(container);
          },
        }),
      );
      view.dndCleanups.push(cleanup);
    }

    // Global monitor
    const monitorCleanup = monitorForElements({
      onDrop({ source, location }: DragMonitorDropArgs) {
        clearLayerDropGap(container);
        const [target] = location.current.dropTargets;
        if (!target) {
          return;
        }
        const instruction = extractInstruction(target.data);
        if (!instruction || instruction.type === "instruction-blocked") {
          return;
        }
        const srcData = source.data;
        const targetPath = target.data.path as JxPath;

        // If the source had children, persist collapse at the new location
        const srcRow = srcData.type === "tree-node" && source.element;
        const wasExpanded = srcRow && Object.hasOwn(srcRow.dataset, "dndExpanded");

        // Parent-originated layer drops legitimately target the active tab.
        applyDropInstruction(activeTab.value, instruction, srcData, targetPath);

        if (wasExpanded) {
          const tab = activeTab.value;
          const newPath = tab?.session.selection;
          if (newPath) {
            const collapsed = (view._layersCollapsed ||= new Set());
            collapsed.add(newPath.join("/"));
          }
        }
      },
      onDropTargetChange({ location }: DragMonitorDropArgs) {
        // Clear the layer gap when the drag moves onto a non-tree target (e.g. a canvas
        // Element). When there is no target at all, keep the gap so it persists.
        const [inner] = location.current.dropTargets;
        if (inner && !extractInstruction(inner.data)) {
          clearLayerDropGap(container);
        }
      },
    });
    view.dndCleanups.push(monitorCleanup);
  });
}

/** Register DnD on component rows — called from renderLeftPanel when tab=components */
export function registerComponentsDnD() {
  requestAnimationFrame(() => {
    const container = leftPanel?.querySelector(".components-section") as HTMLElement | null;
    if (!container) {
      return;
    }

    for (const row of container.querySelectorAll(
      "[data-component-tag]",
    ) as NodeListOf<HTMLElement>) {
      const tagName = row.dataset.componentTag;
      if (!tagName) {
        continue;
      }
      const comp = componentRegistry.find((c: ComponentEntry) => c.tagName === tagName);
      if (!comp) {
        continue;
      }

      // Fill preview with live rendered component
      const preview = row.querySelector(".element-card-preview");
      if (preview && !preview.querySelector(tagName)) {
        void renderComponentPreview(comp).then((el: HTMLElement) => {
          preview.textContent = "";
          preview.append(el);
        });
      }

      const instanceDef = buildComponentInstance(comp);
      const cleanup = draggable({
        element: row,
        getInitialData() {
          return { fragment: structuredClone(instanceDef), type: "block" };
        },
        onGenerateDragPreview({ nativeSetDragImage }: DragPreviewArgs) {
          disableNativeDragPreview({ nativeSetDragImage });
        },
      });
      view.dndCleanups.push(cleanup);
    }
  });
}

/** Register DnD on element (HTML block) rows */
export function registerElementsDnD() {
  requestAnimationFrame(() => {
    const container = leftPanel?.querySelector(".panel-body") as HTMLElement | null;
    if (!container) {
      return;
    }
    for (const row of container.querySelectorAll("[data-block-tag]") as NodeListOf<HTMLElement>) {
      const tag = row.dataset.blockTag as string;
      const preview = row.querySelector(".element-card-preview");
      if (preview && !preview.firstChild) {
        const el = document.createElement(unsafeTags.has(tag) ? "span" : tag);
        el.textContent = tag;
        preview.append(el);
      }
      const def = defaultDef(tag);
      const cleanup = draggable({
        element: row,
        getInitialData() {
          return { fragment: structuredClone(def), type: "block" };
        },
        onGenerateDragPreview({ nativeSetDragImage }: DragPreviewArgs) {
          disableNativeDragPreview({ nativeSetDragImage });
        },
      });
      view.dndCleanups.push(cleanup);
    }
  });
}

/**
 * Hide descendant rows of the dragged item so it appears collapsed during drag.
 *
 * @param {HTMLElement} parentRow
 * @param {HTMLElement} container
 */
function hideDescendantRows(parentRow: HTMLElement, container: HTMLElement) {
  const prefix = `${parentRow.dataset.path}/`;
  const rows = container.querySelectorAll(".layers-tree .layer-row");
  for (const r of rows) {
    if ((r as HTMLElement).dataset.path?.startsWith(prefix)) {
      (r as HTMLElement).style.display = "none";
    }
  }
}

/**
 * @param {HTMLElement} rowEl
 * @param {Record<string, unknown>} data
 * @param {HTMLElement} container
 */
export function showLayerDropGap(
  rowEl: HTMLElement,
  data: Record<string, unknown>,
  container: HTMLElement,
) {
  const instruction = extractInstruction(data);

  // Clear previous drop-target highlight
  if (view._currentDropTargetRow && view._currentDropTargetRow !== rowEl) {
    view._currentDropTargetRow.classList.remove("drop-target");
  }

  if (!instruction || instruction.type === "instruction-blocked") {
    clearLayerDropGap(container);
    return;
  }

  if (instruction.type === "make-child") {
    clearLayerDropGap(container);
    rowEl.classList.add("drop-target");
    view._currentDropTargetRow = rowEl;
    return;
  }

  rowEl.classList.remove("drop-target");
  view._currentDropTargetRow = rowEl;

  // Shift rows to create gap
  const rows = [...container.querySelectorAll(".layers-tree .layer-row")];
  const targetIdx = rows.indexOf(rowEl);
  const gap = view.layerDragSourceHeight;

  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] as HTMLElement).classList.contains("dragging")) {
      continue;
    }
    if (instruction.type === "reorder-above") {
      (rows[i] as HTMLElement).style.transform = i >= targetIdx ? `translateY(${gap}px)` : "";
    } else {
      (rows[i] as HTMLElement).style.transform = i > targetIdx ? `translateY(${gap}px)` : "";
    }
  }
}

/** @param {HTMLElement} container */
export function clearLayerDropGap(container: HTMLElement) {
  if (view._currentDropTargetRow) {
    view._currentDropTargetRow.classList.remove("drop-target");
    view._currentDropTargetRow = null;
  }
  const rows = container.querySelectorAll(".layers-tree .layer-row");
  for (const r of rows) {
    (r as HTMLElement).style.transform = "";
    // Also clear `display:none` left by hideDescendantRows. The `.layer-row` div has no `style`
    // Lit binding and rows aren't keyed, so lit reuses these DOM nodes positionally on the
    // Post-drop re-render — a stale `display:none` would otherwise hide whichever row lands on the
    // Reused node (e.g. a sibling of the moved subtree).
    (r as HTMLElement).style.display = "";
  }
}

/**
 * Apply a DnD instruction to `tab`'s document. `tab` is the tab whose canvas the drop resolved in
 * (host-routed for iframe drops — never the active tab at message time, which may have changed
 * while the dropResult was in flight); a null tab is a no-op.
 *
 * @param {Tab | null} tab
 * @param {{ type: string }} instruction
 * @param {Record<string, unknown>} srcData
 * @param {JxPath} targetPath
 */
export function applyDropInstruction(
  tab: Tab | null,
  instruction: { type: string },
  srcData: Record<string, unknown>,
  targetPath: JxPath,
) {
  if (!tab) {
    return;
  }
  const doc = tab.doc.document as JxMutableNode;
  if (srcData.type === "tree-node") {
    const fromPath = srcData.path as JxPath;
    const targetParent = parentElementPath(targetPath) as JxPath;
    const targetIdx = childIndex(targetPath) as number;
    // Reordering requires a parent and a numeric index; root-level paths can't be
    // Reordered around.
    if (instruction.type !== "make-child" && (!targetParent || typeof targetIdx !== "number")) {
      return;
    }

    switch (instruction.type) {
      case "reorder-above": {
        transactDoc(tab, (t) => mutateMoveNode(t, fromPath, targetParent, targetIdx));
        break;
      }
      case "reorder-below": {
        transactDoc(tab, (t) => mutateMoveNode(t, fromPath, targetParent, targetIdx + 1));
        break;
      }
      case "make-child": {
        const target = getNodeAtPath(doc, targetPath);
        const len = childList(target).length;
        transactDoc(tab, (t) => mutateMoveNode(t, fromPath, targetPath, len));
        break;
      }
      default: {
        break;
      }
    }
  } else if (srcData.type === "block") {
    const targetParent = parentElementPath(targetPath) as JxPath;
    const targetIdx = childIndex(targetPath) as number;
    if (instruction.type !== "make-child" && (!targetParent || typeof targetIdx !== "number")) {
      return;
    }

    switch (instruction.type) {
      case "reorder-above": {
        transactDoc(tab, (t) =>
          mutateInsertNode(
            t,
            targetParent,
            targetIdx,
            structuredClone(srcData.fragment as JxMutableNode),
          ),
        );
        break;
      }
      case "reorder-below": {
        transactDoc(tab, (t) =>
          mutateInsertNode(
            t,
            targetParent,
            targetIdx + 1,
            structuredClone(srcData.fragment as JxMutableNode),
          ),
        );
        break;
      }
      case "make-child": {
        const target = getNodeAtPath(doc, targetPath);
        const len = childList(target).length;
        transactDoc(tab, (t) =>
          mutateInsertNode(t, targetPath, len, structuredClone(srcData.fragment as JxMutableNode)),
        );
        break;
      }
      default: {
        break;
      }
    }

    // Auto-import to $elements if the dropped block is a custom component
    const fragment = srcData.fragment as JxMutableNode | undefined;
    const tag = fragment?.tagName;
    if (tag && tag.includes("-")) {
      const comp = componentRegistry.find((c: ComponentEntry) => c.tagName === tag);
      if (comp) {
        const elements = tab.doc.document?.$elements || [];
        if (comp.source === "npm") {
          const specifier = comp.modulePath ? `${comp.package}/${comp.modulePath}` : comp.package;
          if (!specifier) {
            return;
          }
          const alreadyImported = elements.some(
            (e: JxMutableNode | string | { $ref: string }) => e === specifier || e === comp.package,
          );
          if (!alreadyImported) {
            transact(tab, (d: JxMutableNode) => {
              if (!d.$elements) {
                d.$elements = [];
              }
              d.$elements.push(specifier);
            });
          }
        } else {
          const alreadyImported = elements.some((e: JxMutableNode | string | { $ref: string }) => {
            const ref = typeof e === "object" && e !== null ? e.$ref : undefined;
            const compPath = comp.path;
            return (
              ref &&
              compPath &&
              (ref === `./${compPath}` || ref.endsWith(compPath.split("/").pop() as string))
            );
          });
          if (!alreadyImported && comp.path) {
            const relPath = computeRelativePath(tab?.documentPath ?? null, comp.path);
            transact(tab, (d: JxMutableNode) => {
              if (!d.$elements) {
                d.$elements = [];
              }
              d.$elements.push({ $ref: relPath });
            });
          }
        }
      }
    }
  }
}
