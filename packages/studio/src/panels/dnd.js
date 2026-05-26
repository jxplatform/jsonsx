/**
 * DnD registration functions — extracted from studio.js (Phase 4). Registers drag-and-drop behavior
 * on layer rows, component cards, and element cards.
 */

/**
 * @typedef {{ element: HTMLElement; input: { clientX: number; clientY: number } }} DragCanDragArgs
 *
 * @typedef {{ source: { data: Record<string, unknown>; element: HTMLElement } }} DragDropSourceArgs
 *
 * @typedef {{ self: { data: Record<string, unknown> } }} DragSelfArgs
 *
 * @typedef {{
 *   source: { data: Record<string, unknown>; element: HTMLElement };
 *   location: { current: { dropTargets: { data: Record<string, unknown> }[] } };
 * }} DragMonitorDropArgs
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
} from "../store.js";
import { transact, transactDoc, mutateMoveNode, mutateInsertNode } from "../tabs/transact.js";
import { activeTab } from "../workspace/workspace.js";
import { view } from "../view.js";
import { componentRegistry, computeRelativePath } from "../files/components.js";
import { renderComponentPreview } from "./stylebook-panel.js";
import { defaultDef, unsafeTags } from "./shared.js";

/** Register DnD on layer rows — called from left-panel.js after render */
export function registerLayersDnD() {
  requestAnimationFrame(() => {
    const container = /** @type {HTMLElement | null} */ (
      leftPanel?.querySelector(".layers-container")
    );
    if (!container) return;

    /** @type {NodeListOf<HTMLElement>} */ (container.querySelectorAll("[data-dnd-row]")).forEach(
      (row) => {
        const rowPath = /** @type {JxPath} */ (
          /** @type {string} */ (row.dataset.path)
            .split("/")
            .map((/** @type {string} */ s) => (/^\d+$/.test(s) ? parseInt(s) : s))
        );
        const rowDepth = parseInt(/** @type {string} */ (row.dataset.dndDepth)) || 0;
        const isVoid = row.hasAttribute("data-dnd-void");
        const isExpanded = row.hasAttribute("data-dnd-expanded");

        const cleanup = combine(
          draggable({
            element: row,
            canDrag(/** @type {DragCanDragArgs} */ { element: _el, input }) {
              const target = /** @type {HTMLElement} */ (
                document.elementFromPoint(input.clientX, input.clientY)
              );
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
            canDrop(/** @type {DragDropSourceArgs} */ { source }) {
              const srcPath = /** @type {JxPath | undefined} */ (source.data.path);
              if (srcPath && isAncestor(srcPath, rowPath)) return false;
              return true;
            },
            getData(/** @type {any} */ { input, element }) {
              return /** @type {Record<string | symbol, unknown>} */ (
                attachInstruction(
                  { path: rowPath },
                  {
                    input,
                    element,
                    currentLevel: rowDepth,
                    indentPerLevel: 16,
                    mode: isExpanded ? "expanded" : "standard",
                    block: isVoid ? ["make-child"] : [],
                  },
                )
              );
            },
            onDragEnter(/** @type {DragSelfArgs} */ { self }) {
              showLayerDropGap(row, self.data, container);
            },
            onDrag(/** @type {DragSelfArgs} */ { self }) {
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
      },
    );

    // Global monitor
    const monitorCleanup = monitorForElements({
      onDrop(/** @type {DragMonitorDropArgs} */ { source, location }) {
        clearLayerDropGap(container);
        const target = location.current.dropTargets[0];
        if (!target) return;
        const instruction = extractInstruction(target.data);
        if (!instruction || instruction.type === "instruction-blocked") return;
        const srcData = source.data;
        const targetPath = /** @type {JxPath} */ (target.data.path);

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
    const container = /** @type {HTMLElement | null} */ (
      leftPanel?.querySelector(".components-section")
    );
    if (!container) return;

    /** @type {NodeListOf<HTMLElement>} */ (
      container.querySelectorAll("[data-component-tag]")
    ).forEach((row) => {
      const tagName = row.dataset.componentTag;
      if (!tagName) return;
      const comp = componentRegistry.find(
        (/** @type {import("../files/components.js").ComponentEntry} */ c) => c.tagName === tagName,
      );
      if (!comp) return;

      // Fill preview with live rendered component
      const preview = row.querySelector(".element-card-preview");
      if (preview && !preview.querySelector(tagName)) {
        renderComponentPreview(comp).then((/** @type {HTMLElement} */ el) => {
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
    });
  });
}

/** Register DnD on element (HTML block) rows */
export function registerElementsDnD() {
  requestAnimationFrame(() => {
    const container = /** @type {HTMLElement | null} */ (leftPanel?.querySelector(".panel-body"));
    if (!container) return;
    /** @type {NodeListOf<HTMLElement>} */ (container.querySelectorAll("[data-block-tag]")).forEach(
      (row) => {
        const tag = /** @type {string} */ (row.dataset.blockTag);
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
      },
    );
  });
}

/**
 * Hide descendant rows of the dragged item so it appears collapsed during drag.
 *
 * @param {HTMLElement} parentRow
 * @param {HTMLElement} container
 */
function hideDescendantRows(parentRow, container) {
  const prefix = parentRow.dataset.path + "/";
  const rows = container.querySelectorAll(".layers-tree .layer-row");
  for (const r of rows) {
    if (/** @type {HTMLElement} */ (r).dataset.path?.startsWith(prefix)) {
      /** @type {HTMLElement} */ (r).style.display = "none";
    }
  }
}

/**
 * @param {HTMLElement} rowEl
 * @param {Record<string, unknown>} data
 * @param {HTMLElement} container
 */
export function showLayerDropGap(rowEl, data, container) {
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
    if (/** @type {HTMLElement} */ (rows[i]).classList.contains("dragging")) continue;
    if (instruction.type === "reorder-above") {
      /** @type {HTMLElement} */ (rows[i]).style.transform =
        i >= targetIdx ? `translateY(${gap}px)` : "";
    } else {
      /** @type {HTMLElement} */ (rows[i]).style.transform =
        i > targetIdx ? `translateY(${gap}px)` : "";
    }
  }
}

/** @param {HTMLElement} container */
export function clearLayerDropGap(container) {
  if (view._currentDropTargetRow) {
    view._currentDropTargetRow.classList.remove("drop-target");
    view._currentDropTargetRow = null;
  }
  const rows = container.querySelectorAll(".layers-tree .layer-row");
  for (const r of rows) /** @type {HTMLElement} */ (r).style.transform = "";
}

/**
 * Apply a DnD instruction to the state
 *
 * @param {{ type: string }} instruction
 * @param {Record<string, unknown>} srcData
 * @param {JxPath} targetPath
 */
export function applyDropInstruction(instruction, srcData, targetPath) {
  const doc = /** @type {JxMutableNode} */ (activeTab.value?.doc.document);
  if (srcData.type === "tree-node") {
    const fromPath = /** @type {JxPath} */ (srcData.path);
    const targetParent = /** @type {JxPath} */ (parentElementPath(targetPath));
    const targetIdx = /** @type {number} */ (childIndex(targetPath));

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
    const targetParent = /** @type {JxPath} */ (parentElementPath(targetPath));
    const targetIdx = /** @type {number} */ (childIndex(targetPath));

    switch (instruction.type) {
      case "reorder-above":
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(
            t,
            targetParent,
            targetIdx,
            structuredClone(/** @type {JxMutableNode} */ (srcData.fragment)),
          ),
        );
        break;
      case "reorder-below":
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(
            t,
            targetParent,
            targetIdx + 1,
            structuredClone(/** @type {JxMutableNode} */ (srcData.fragment)),
          ),
        );
        break;
      case "make-child": {
        const target = getNodeAtPath(doc, targetPath);
        const len = target?.children?.length || 0;
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(
            t,
            targetPath,
            len,
            structuredClone(/** @type {JxMutableNode} */ (srcData.fragment)),
          ),
        );
        break;
      }
    }

    // Auto-import to $elements if the dropped block is a custom component
    const fragment = /** @type {JxMutableNode | undefined} */ (srcData.fragment);
    const tag = fragment?.tagName;
    if (tag && tag.includes("-")) {
      const comp = componentRegistry.find(
        (/** @type {import("../files/components.js").ComponentEntry} */ c) => c.tagName === tag,
      );
      if (comp) {
        const tab = activeTab.value;
        const elements = tab?.doc.document?.$elements || [];
        if (comp.source === "npm") {
          const specifier = comp.modulePath ? `${comp.package}/${comp.modulePath}` : comp.package;
          if (!specifier) return;
          const alreadyImported = elements.some(
            (/** @type {JxMutableNode | string | { $ref: string }} */ e) =>
              e === specifier || e === comp.package,
          );
          if (!alreadyImported) {
            transact(activeTab.value, (/** @type {JxMutableNode} */ doc) => {
              if (!doc.$elements) doc.$elements = [];
              doc.$elements.push(specifier);
            });
          }
        } else {
          const alreadyImported = elements.some(
            (/** @type {JxMutableNode | string | { $ref: string }} */ e) => {
              const ref = typeof e === "object" && e !== null ? e.$ref : undefined;
              return (
                ref &&
                (ref === `./${comp.path}` ||
                  ref.endsWith(/** @type {string} */ (comp.path.split("/").pop())))
              );
            },
          );
          if (!alreadyImported) {
            const relPath = computeRelativePath(tab?.documentPath, comp.path);
            transact(activeTab.value, (/** @type {JxMutableNode} */ doc) => {
              if (!doc.$elements) doc.$elements = [];
              doc.$elements.push({ $ref: relPath });
            });
          }
        }
      }
    }
  }
}
