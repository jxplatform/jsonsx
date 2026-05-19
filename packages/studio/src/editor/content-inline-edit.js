/**
 * Content inline edit bridge — extracted from studio.js (Phase 4k). Rich-text editing entry point
 * for edit/content mode. Bridges startEditing() with Jx document state mutations.
 */

import {
  getState,
  update,
  renderOnly,
  selectNode,
  insertNode,
  updateProperty,
  getNodeAtPath,
  parentElementPath,
  childIndex,
  canvasPanels,
} from "../store.js";
import { view } from "../view.js";
import { startEditing, isEditableBlock } from "./inline-edit.js";
import { restoreTemplateExpressions } from "../utils/edit-display.js";
import { renderBlockActionBar } from "../panels/block-action-bar.js";
import { defaultDef } from "../panels/shared.js";
import { findCanvasElement, getActivePanel } from "../canvas/canvas-helpers.js";

/**
 * Enter rich-text inline editing on a canvas element (edit/content mode).
 *
 * @param {any} el
 * @param {any} path
 */
export function enterInlineEdit(el, path) {
  // Restore raw template expressions before editing.
  // prepareForEditMode renders ${expr} as ❪ expr ❫ for display;
  // revert so the user edits the real syntax and commits it back intact.
  restoreTemplateExpressions(el);

  // Hide overlays while editing
  for (const p of canvasPanels) {
    p.overlay.style.display = "none";
    p.overlayClk.style.pointerEvents = "none";
  }

  startEditing(el, path, {
    onCommit(
      /** @type {any} */ commitPath,
      /** @type {any} */ children,
      /** @type {any} */ textContent,
    ) {
      const S = getState();
      const node = getNodeAtPath(S.document, commitPath);
      if (children) {
        if (node && JSON.stringify(node.children) === JSON.stringify(children)) return;
        let s = updateProperty(S, commitPath, "textContent", undefined);
        s = updateProperty(s, commitPath, "children", children);
        update(s);
      } else if (textContent != null) {
        if (node && node.textContent === textContent && !node.children) return;
        let s = updateProperty(S, commitPath, "children", undefined);
        s = updateProperty(s, commitPath, "textContent", textContent);
        update(s);
      }
    },

    onSplit(/** @type {any} */ splitPath, /** @type {any} */ before, /** @type {any} */ after) {
      const tag = "p";
      let s = getState();

      if (before.textContent != null) {
        s = updateProperty(s, splitPath, "children", undefined);
        s = updateProperty(s, splitPath, "textContent", before.textContent);
      } else if (before.children) {
        s = updateProperty(s, splitPath, "textContent", undefined);
        s = updateProperty(s, splitPath, "children", before.children);
      }

      // Insert new element after with "after" content
      const parentPath = /** @type {any} */ (parentElementPath(splitPath));
      const idx = /** @type {number} */ (childIndex(splitPath));
      /** @type {any} */
      const newNode = { tagName: tag };
      if (after.textContent != null) {
        newNode.textContent = after.textContent;
      } else if (after.children) {
        newNode.children = after.children;
      } else {
        newNode.textContent = "";
      }

      s = insertNode(s, parentPath, idx + 1, newNode);
      const newPath = [...parentPath, "children", idx + 1];
      s = selectNode(s, newPath);
      update(s);

      // Re-enter editing on the new element after render
      requestAnimationFrame(() => {
        const activePanel = getActivePanel();
        if (activePanel) {
          const newEl = findCanvasElement(newPath, activePanel.canvas);
          if (newEl && isEditableBlock(newEl)) {
            enterInlineEdit(newEl, newPath);
            // Place cursor at start of new element
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(newEl);
            range.collapse(true);
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
        }
      });
    },

    onInsert(/** @type {any} */ afterPath, /** @type {any} */ cmd, /** @type {any} */ commitData) {
      const isEmpty =
        !commitData ||
        (commitData.textContent != null && commitData.textContent.trim() === "") ||
        (commitData.children &&
          (commitData.children.length === 0 ||
            (commitData.children.length === 1 &&
              typeof commitData.children[0] === "string" &&
              commitData.children[0].trim() === "") ||
            (commitData.children.length === 1 &&
              typeof commitData.children[0] === "object" &&
              commitData.children[0]?.tagName === "br")));

      // If the element is empty, swap its tagName instead of inserting after
      if (isEmpty) {
        let s = getState();
        s = updateProperty(s, afterPath, "tagName", cmd.tag);
        s = updateProperty(s, afterPath, "children", undefined);
        const def = defaultDef(cmd.tag);
        if (def.textContent && def.textContent !== "Paragraph text") {
          s = updateProperty(s, afterPath, "textContent", def.textContent);
        } else {
          s = updateProperty(s, afterPath, "textContent", undefined);
        }
        s = selectNode(s, afterPath);
        update(s);

        requestAnimationFrame(() => {
          const activePanel = getActivePanel();
          if (activePanel) {
            const el = findCanvasElement(afterPath, activePanel.canvas);
            if (el && isEditableBlock(el)) {
              enterInlineEdit(el, afterPath);
            }
          }
        });
        return;
      }

      const elementDef = defaultDef(cmd.tag);
      const parentPath = /** @type {any} */ (parentElementPath(afterPath));
      const idx = /** @type {number} */ (childIndex(afterPath));

      // Apply pending commit from inline edit first (batched to avoid double render)
      let s = getState();
      if (commitData) {
        if (commitData.children) {
          s = updateProperty(s, afterPath, "textContent", undefined);
          s = updateProperty(s, afterPath, "children", commitData.children);
        } else if (commitData.textContent != null) {
          s = updateProperty(s, afterPath, "children", undefined);
          s = updateProperty(s, afterPath, "textContent", commitData.textContent);
        }
      }

      s = insertNode(s, parentPath, idx + 1, structuredClone(elementDef));
      const newPath = [...parentPath, "children", idx + 1];
      s = selectNode(s, newPath);
      update(s);

      // If the inserted element is editable, enter editing
      requestAnimationFrame(() => {
        const activePanel = getActivePanel();
        if (activePanel) {
          const newEl = findCanvasElement(newPath, activePanel.canvas);
          if (newEl && isEditableBlock(newEl)) {
            enterInlineEdit(newEl, newPath);
          }
        }
      });
    },

    onEnd() {
      if (view.inlineEditCleanup) {
        view.inlineEditCleanup();
        view.inlineEditCleanup = null;
      }
      for (const p of canvasPanels) {
        p.overlay.style.display = "";
        p.overlayClk.style.pointerEvents = "";
      }
      renderOnly("overlays");
    },
  });

  // Show the block action bar (with inline formatting buttons) on the viewport
  requestAnimationFrame(() => renderBlockActionBar());

  // Re-render action bar when selection changes inside contenteditable
  const selectionHandler = () => renderBlockActionBar();
  document.addEventListener("selectionchange", selectionHandler);
  el.addEventListener("mouseup", selectionHandler);
  el.addEventListener("keyup", selectionHandler);

  const inlineEditCleanup = () => {
    document.removeEventListener("selectionchange", selectionHandler);
    el.removeEventListener("mouseup", selectionHandler);
    el.removeEventListener("keyup", selectionHandler);
  };
  view.inlineEditCleanup = inlineEditCleanup;
}
