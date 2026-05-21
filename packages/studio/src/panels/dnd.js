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

import { leftPanel, getNodeAtPath, parentElementPath, childIndex, isAncestor } from "../store.js";
import { transact, transactDoc, mutateMoveNode, mutateInsertNode } from "../tabs/transact.js";
import { activeTab } from "../workspace/workspace.js";
import { view } from "../view.js";
import { componentRegistry, computeRelativePath } from "../files/components.js";
import { renderComponentPreview } from "./stylebook-panel.js";
import { defaultDef, unsafeTags } from "./shared.js";

/** Register DnD on layer rows — called from left-panel.js after render */
export function registerLayersDnD() {
  requestAnimationFrame(() => {
    const container = /** @type {any} */ (leftPanel)?.querySelector(".layers-container");
    if (!container) return;

    container.querySelectorAll("[data-dnd-row]").forEach(
      /** @param {any} row */ (row) => {
        const rowPath = /** @type {string} */ (row.dataset.path)
          .split("/")
          .map((/** @type {any} */ s) => (/^\d+$/.test(s) ? parseInt(s) : s));
        const rowDepth = parseInt(/** @type {string} */ (row.dataset.dndDepth)) || 0;
        const isVoid = row.hasAttribute("data-dnd-void");

        const cleanup = combine(
          draggable({
            element: row,
            canDrag(/** @type {any} */ { element: _el, input }) {
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
            },
            onDrop() {
              row.classList.remove("dragging");
            },
          }),
          dropTargetForElements({
            element: row,
            canDrop(/** @type {any} */ { source }) {
              const srcPath = source.data.path;
              if (srcPath && isAncestor(srcPath, rowPath)) return false;
              return true;
            },
            getData(/** @type {any} */ { input, element }) {
              return attachInstruction(
                { path: rowPath },
                /** @type {any} */ ({
                  input,
                  element,
                  currentLevel: rowDepth,
                  indentPerLevel: 16,
                  block: isVoid ? ["make-child"] : [],
                }),
              );
            },
            onDragEnter(/** @type {any} */ { self }) {
              showLayerDropGap(row, self.data, container);
            },
            onDrag(/** @type {any} */ { self }) {
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
      onDrop(/** @type {any} */ { source, location }) {
        clearLayerDropGap(container);
        const target = location.current.dropTargets[0];
        if (!target) return;
        const instruction = extractInstruction(target.data);
        if (!instruction || instruction.type === "instruction-blocked") return;
        const srcData = source.data;
        const targetPath = target.data.path;
        applyDropInstruction(instruction, srcData, targetPath);
      },
    });
    view.dndCleanups.push(monitorCleanup);
  });
}

/** Register DnD on component rows — called from renderLeftPanel when tab=components */
export function registerComponentsDnD() {
  requestAnimationFrame(() => {
    const container = /** @type {any} */ (leftPanel)?.querySelector(".components-section");
    if (!container) return;

    container.querySelectorAll("[data-component-tag]").forEach(
      /** @param {any} row */ (row) => {
        const tagName = row.dataset.componentTag;
        if (!tagName) return;
        const comp = componentRegistry.find(/** @param {any} c */ (c) => c.tagName === tagName);
        if (!comp) return;

        // Fill preview with live rendered component
        const preview = row.querySelector(".element-card-preview");
        if (preview && !preview.querySelector(tagName)) {
          renderComponentPreview(comp).then((/** @type {any} */ el) => {
            preview.textContent = "";
            preview.appendChild(el);
          });
        }

        const instanceDef = {
          tagName: comp.tagName,
          $props: comp.props
            ? Object.fromEntries(
                comp.props.map((/** @type {any} */ p) => [
                  p.name,
                  p.default !== undefined ? p.default : "",
                ]),
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
    const container = /** @type {any} */ (leftPanel)?.querySelector(".panel-body");
    if (!container) return;
    container.querySelectorAll("[data-block-tag]").forEach(
      /** @param {any} row */ (row) => {
        const tag = row.dataset.blockTag;
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
 * @param {any} rowEl
 * @param {any} data
 * @param {any} container
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
    if (/** @type {any} */ (rows[i]).classList.contains("dragging")) continue;
    if (instruction.type === "reorder-above") {
      /** @type {any} */ (rows[i]).style.transform = i >= targetIdx ? `translateY(${gap}px)` : "";
    } else {
      /** @type {any} */ (rows[i]).style.transform = i > targetIdx ? `translateY(${gap}px)` : "";
    }
  }
}

/** @param {any} container */
export function clearLayerDropGap(container) {
  if (view._currentDropTargetRow) {
    view._currentDropTargetRow.classList.remove("drop-target");
    view._currentDropTargetRow = null;
  }
  const rows = container.querySelectorAll(".layers-tree .layer-row");
  for (const r of rows) /** @type {any} */ (r).style.transform = "";
}

/**
 * Apply a DnD instruction to the state
 *
 * @param {any} instruction
 * @param {any} srcData
 * @param {any} targetPath
 */
export function applyDropInstruction(instruction, srcData, targetPath) {
  const document = activeTab.value?.doc.document;
  if (srcData.type === "tree-node") {
    const fromPath = srcData.path;
    const targetParent = /** @type {any} */ (parentElementPath(targetPath));
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
        const target = getNodeAtPath(document, targetPath);
        const len = target?.children?.length || 0;
        transactDoc(activeTab.value, (t) => mutateMoveNode(t, fromPath, targetPath, len));
        break;
      }
    }
  } else if (srcData.type === "block") {
    const targetParent = /** @type {any} */ (parentElementPath(targetPath));
    const targetIdx = /** @type {number} */ (childIndex(targetPath));

    switch (instruction.type) {
      case "reorder-above":
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(t, targetParent, targetIdx, structuredClone(srcData.fragment)),
        );
        break;
      case "reorder-below":
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(t, targetParent, targetIdx + 1, structuredClone(srcData.fragment)),
        );
        break;
      case "make-child": {
        const target = getNodeAtPath(document, targetPath);
        const len = target?.children?.length || 0;
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(t, targetPath, len, structuredClone(srcData.fragment)),
        );
        break;
      }
    }

    // Auto-import to $elements if the dropped block is a custom component
    const tag = srcData.fragment?.tagName;
    if (tag && tag.includes("-")) {
      const comp = componentRegistry.find((/** @type {any} */ c) => c.tagName === tag);
      if (comp) {
        const tab = activeTab.value;
        const elements = tab?.doc.document?.$elements || [];
        if (comp.source === "npm") {
          const specifier = comp.modulePath ? `${comp.package}/${comp.modulePath}` : comp.package;
          const alreadyImported = elements.some(
            (/** @type {any} */ e) => e === specifier || e === comp.package,
          );
          if (!alreadyImported) {
            transact(activeTab.value, (/** @type {any} */ doc) => {
              if (!doc.$elements) doc.$elements = [];
              doc.$elements.push(specifier);
            });
          }
        } else {
          const alreadyImported = elements.some(
            (/** @type {any} */ e) =>
              e.$ref &&
              (e.$ref === `./${comp.path}` || e.$ref.endsWith(comp.path.split("/").pop())),
          );
          if (!alreadyImported) {
            const relPath = computeRelativePath(tab?.documentPath, comp.path);
            transact(activeTab.value, (/** @type {any} */ doc) => {
              if (!doc.$elements) doc.$elements = [];
              doc.$elements.push({ $ref: relPath });
            });
          }
        }
      }
    }
  }
}
