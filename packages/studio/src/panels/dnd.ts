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
import {
  attachInstruction,
  extractInstruction,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item";

import {
  leftPanel,
  getNodeAtPath,
  parentElementPath,
  childIndex,
  isAncestor,
  renderOnly,
} from "../store";
import { transact, transactDoc, mutateMoveNode, mutateInsertNode } from "../tabs/transact";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { componentRegistry, computeRelativePath } from "../files/components";
import { renderComponentPreview } from "./stylebook-panel";
import { defaultDef, unsafeTags } from "./shared";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";

interface DragCanDragArgs {
  element: HTMLElement;
  input: { clientX: number; clientY: number };
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
    if (!container) return;

    (container.querySelectorAll("[data-dnd-row]") as NodeListOf<HTMLElement>).forEach((row) => {
      const rowPath = (row.dataset.path as string)
        .split("/")
        .map((s: string) => (/^\d+$/.test(s) ? parseInt(s) : s)) as JxPath;
      const rowDepth = parseInt(row.dataset.dndDepth as string) || 0;
      const isVoid = row.hasAttribute("data-dnd-void");
      const isExpanded = row.hasAttribute("data-dnd-expanded");

      const cleanup = combine(
        draggable({
          element: row,
          canDrag({ element: _el, input }: DragCanDragArgs) {
            const target = document.elementFromPoint(input.clientX, input.clientY) as HTMLElement;
            if (target?.closest(".layer-actions")) return false;
            return true;
          },
          getInitialData() {
            return { type: "tree-node", path: rowPath };
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
            if (srcPath && isAncestor(srcPath, rowPath)) return false;
            return true;
          },
          getData({ input, element }: any) {
            return attachInstruction(
              { path: rowPath },
              {
                input,
                element,
                currentLevel: rowDepth,
                indentPerLevel: 16,
                mode: isExpanded ? "expanded" : "standard",
                block: isVoid ? ["make-child"] : [],
              },
            ) as Record<string | symbol, unknown>;
          },
          onDragEnter({ self }: DragSelfArgs) {
            showLayerDropGap(row, self.data, container);
          },
          onDrag({ self }: DragSelfArgs) {
            showLayerDropGap(row, self.data, container);
          },
          onDragLeave() {
            clearLayerDropGap(container);
          },
          onDrop() {
            clearLayerDropGap(container);
          },
        }),
      );
      view.dndCleanups.push(cleanup);
    });

    // Global monitor
    const monitorCleanup = monitorForElements({
      onDrop({ source, location }: DragMonitorDropArgs) {
        clearLayerDropGap(container);
        const target = location.current.dropTargets[0];
        if (!target) return;
        const instruction = extractInstruction(target.data);
        if (!instruction || instruction.type === "instruction-blocked") return;
        const srcData = source.data;
        const targetPath = target.data.path as JxPath;

        // If the source had children, persist collapse at the new location
        const srcRow = srcData.type === "tree-node" && source.element;
        const wasExpanded = srcRow && srcRow.hasAttribute("data-dnd-expanded");

        applyDropInstruction(instruction, srcData, targetPath);

        if (wasExpanded) {
          const tab = activeTab.value;
          const newPath = tab?.session.selection;
          if (newPath) {
            const collapsed = view._layersCollapsed || (view._layersCollapsed = new Set());
            collapsed.add(newPath.join("/"));
          }
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
    if (!container) return;

    (container.querySelectorAll("[data-component-tag]") as NodeListOf<HTMLElement>).forEach(
      (row) => {
        const tagName = row.dataset.componentTag;
        if (!tagName) return;
        const comp = componentRegistry.find(
          (c: import("../files/components.js").ComponentEntry) => c.tagName === tagName,
        );
        if (!comp) return;

        // Fill preview with live rendered component
        const preview = row.querySelector(".element-card-preview");
        if (preview && !preview.querySelector(tagName)) {
          renderComponentPreview(comp).then((el: HTMLElement) => {
            preview.textContent = "";
            preview.appendChild(el);
          });
        }

        const instanceDef = {
          tagName: comp.tagName,
          $props: comp.props
            ? Object.fromEntries(
                comp.props.map(
                  (/** @type {{ name: string; default?: unknown; [k: string]: unknown }} */ p) => [
                    p.name,
                    p.default !== undefined ? p.default : "",
                  ],
                ),
              )
            : {},
        };
        const cleanup = draggable({
          element: row,
          getInitialData() {
            return { type: "block", fragment: structuredClone(instanceDef) };
          },
        });
        view.dndCleanups.push(cleanup);
      },
    );
  });
}

/** Register DnD on element (HTML block) rows */
export function registerElementsDnD() {
  requestAnimationFrame(() => {
    const container = leftPanel?.querySelector(".panel-body") as HTMLElement | null;
    if (!container) return;
    (container.querySelectorAll("[data-block-tag]") as NodeListOf<HTMLElement>).forEach((row) => {
      const tag = row.dataset.blockTag as string;
      const preview = row.querySelector(".element-card-preview");
      if (preview && !preview.firstChild) {
        const el = document.createElement(unsafeTags.has(tag) ? "span" : tag);
        el.textContent = tag;
        preview.appendChild(el);
      }
      const def = defaultDef(tag);
      const cleanup = draggable({
        element: row,
        getInitialData() {
          return { type: "block", fragment: structuredClone(def) };
        },
      });
      view.dndCleanups.push(cleanup);
    });
  });
}

/**
 * Hide descendant rows of the dragged item so it appears collapsed during drag.
 *
 * @param {HTMLElement} parentRow
 * @param {HTMLElement} container
 */
function hideDescendantRows(parentRow: HTMLElement, container: HTMLElement) {
  const prefix = parentRow.dataset.path + "/";
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
  const rows = Array.from(container.querySelectorAll(".layers-tree .layer-row"));
  const targetIdx = rows.indexOf(rowEl);
  const gap = view.layerDragSourceHeight;

  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] as HTMLElement).classList.contains("dragging")) continue;
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
  for (const r of rows) (r as HTMLElement).style.transform = "";
}

/**
 * Apply a DnD instruction to the state
 *
 * @param {{ type: string }} instruction
 * @param {Record<string, unknown>} srcData
 * @param {JxPath} targetPath
 */
export function applyDropInstruction(
  instruction: { type: string },
  srcData: Record<string, unknown>,
  targetPath: JxPath,
) {
  const doc = activeTab.value?.doc.document as JxMutableNode;
  if (srcData.type === "tree-node") {
    const fromPath = srcData.path as JxPath;
    const targetParent = parentElementPath(targetPath) as JxPath;
    const targetIdx = childIndex(targetPath) as number;

    switch (instruction.type) {
      case "reorder-above":
        transactDoc(activeTab.value, (t) => mutateMoveNode(t, fromPath, targetParent, targetIdx));
        break;
      case "reorder-below":
        transactDoc(activeTab.value, (t) =>
          mutateMoveNode(t, fromPath, targetParent, targetIdx + 1),
        );
        break;
      case "make-child": {
        const target = getNodeAtPath(doc, targetPath);
        const len = target?.children?.length || 0;
        transactDoc(activeTab.value, (t) => mutateMoveNode(t, fromPath, targetPath, len));
        break;
      }
    }
  } else if (srcData.type === "block") {
    const targetParent = parentElementPath(targetPath) as JxPath;
    const targetIdx = childIndex(targetPath) as number;

    switch (instruction.type) {
      case "reorder-above":
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(
            t,
            targetParent,
            targetIdx,
            structuredClone(srcData.fragment as JxMutableNode),
          ),
        );
        break;
      case "reorder-below":
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(
            t,
            targetParent,
            targetIdx + 1,
            structuredClone(srcData.fragment as JxMutableNode),
          ),
        );
        break;
      case "make-child": {
        const target = getNodeAtPath(doc, targetPath);
        const len = target?.children?.length || 0;
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(t, targetPath, len, structuredClone(srcData.fragment as JxMutableNode)),
        );
        break;
      }
    }

    // Auto-import to $elements if the dropped block is a custom component
    const fragment = srcData.fragment as JxMutableNode | undefined;
    const tag = fragment?.tagName;
    if (tag && tag.includes("-")) {
      const comp = componentRegistry.find(
        (c: import("../files/components.js").ComponentEntry) => c.tagName === tag,
      );
      if (comp) {
        const tab = activeTab.value;
        const elements = tab?.doc.document?.$elements || [];
        if (comp.source === "npm") {
          const specifier = comp.modulePath ? `${comp.package}/${comp.modulePath}` : comp.package;
          if (!specifier) return;
          const alreadyImported = elements.some(
            (e: JxMutableNode | string | { $ref: string }) => e === specifier || e === comp.package,
          );
          if (!alreadyImported) {
            transact(activeTab.value, (doc: JxMutableNode) => {
              if (!doc.$elements) doc.$elements = [];
              doc.$elements.push(specifier);
            });
          }
        } else {
          const alreadyImported = elements.some((e: JxMutableNode | string | { $ref: string }) => {
            const ref = typeof e === "object" && e !== null ? e.$ref : undefined;
            return (
              ref &&
              (ref === `./${comp.path}` || ref.endsWith(comp.path.split("/").pop() as string))
            );
          });
          if (!alreadyImported) {
            const relPath = computeRelativePath(tab?.documentPath ?? null, comp.path);
            transact(activeTab.value, (doc: JxMutableNode) => {
              if (!doc.$elements) doc.$elements = [];
              doc.$elements.push({ $ref: relPath });
            });
          }
        }
      }
    }
  }
}
