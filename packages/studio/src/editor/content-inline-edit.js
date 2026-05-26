/**
 * Content inline edit bridge — extracted from studio.js (Phase 4k). Rich-text editing entry point
 * for edit/content mode. Bridges startEditing() with Jx document state mutations.
 *
 * @typedef {import("./inline-edit.js").JxContentResult} JxContentResult
 *
 * @typedef {import("./inline-edit.js").SlashCommand} SlashCommand
 */

import {
  renderOnly,
  getNodeAtPath,
  parentElementPath,
  childIndex,
  canvasPanels,
} from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc, mutateInsertNode, mutateUpdateProperty } from "../tabs/transact.js";
import { view } from "../view.js";
import { startEditing, isEditableBlock } from "./inline-edit.js";
import { restoreTemplateExpressions } from "../utils/edit-display.js";
import { renderBlockActionBar } from "../panels/block-action-bar.js";
import { defaultDef } from "../panels/shared.js";
import { findCanvasElement, getActivePanel } from "../canvas/canvas-helpers.js";

/**
 * Enter rich-text inline editing on a canvas element (edit/content mode).
 *
 * @param {HTMLElement} el
 * @param {JxPath} path
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
      /** @type {JxPath} */ commitPath,
      /** @type {(JxMutableNode | string)[] | null} */ children,
      /** @type {string | null} */ textContent,
    ) {
      const node = getNodeAtPath(activeTab.value?.doc.document, commitPath);
      if (children) {
        if (node && JSON.stringify(node.children) === JSON.stringify(children)) return;
        transactDoc(activeTab.value, (t) => {
          mutateUpdateProperty(t, commitPath, "textContent", undefined);
          mutateUpdateProperty(t, commitPath, "children", children);
        });
      } else if (textContent != null) {
        if (node && node.textContent === textContent && !node.children) return;
        transactDoc(activeTab.value, (t) => {
          mutateUpdateProperty(t, commitPath, "children", undefined);
          mutateUpdateProperty(t, commitPath, "textContent", textContent);
        });
      }
    },

    onSplit(
      /** @type {JxPath} */ splitPath,
      /** @type {JxContentResult} */ before,
      /** @type {JxContentResult} */ after,
    ) {
      const tag = "p";

      // Insert new element after with "after" content
      const parentPath = /** @type {JxPath} */ (parentElementPath(splitPath));
      const idx = /** @type {number} */ (childIndex(splitPath));
      /** @type {JxMutableNode} */
      const newNode = { tagName: tag };
      if (after.textContent != null) {
        newNode.textContent = after.textContent;
      } else if (after.children) {
        newNode.children = after.children;
      } else {
        newNode.textContent = "";
      }

      const newPath = [...parentPath, "children", idx + 1];

      transactDoc(activeTab.value, (t) => {
        if (before.textContent != null) {
          mutateUpdateProperty(t, splitPath, "children", undefined);
          mutateUpdateProperty(t, splitPath, "textContent", before.textContent);
        } else if (before.children) {
          mutateUpdateProperty(t, splitPath, "textContent", undefined);
          mutateUpdateProperty(t, splitPath, "children", before.children);
        }
        mutateInsertNode(t, parentPath, idx + 1, newNode);
        t.session.selection = newPath;
      });

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

    onInsert(
      /** @type {JxPath} */ afterPath,
      /** @type {SlashCommand} */ cmd,
      /** @type {JxContentResult | undefined} */ commitData,
    ) {
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
        transactDoc(activeTab.value, (t) => {
          mutateUpdateProperty(t, afterPath, "tagName", cmd.tag);
          mutateUpdateProperty(t, afterPath, "children", undefined);
          const def = defaultDef(cmd.tag);
          if (def.textContent && def.textContent !== "Paragraph text") {
            mutateUpdateProperty(t, afterPath, "textContent", def.textContent);
          } else {
            mutateUpdateProperty(t, afterPath, "textContent", undefined);
          }
          t.session.selection = afterPath;
        });

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
      const parentPath = /** @type {JxPath} */ (parentElementPath(afterPath));
      const idx = /** @type {number} */ (childIndex(afterPath));
      const newPath = [...parentPath, "children", idx + 1];

      // Apply pending commit from inline edit first (batched to avoid double render)
      transactDoc(activeTab.value, (t) => {
        if (commitData) {
          if (commitData.children) {
            mutateUpdateProperty(t, afterPath, "textContent", undefined);
            mutateUpdateProperty(t, afterPath, "children", commitData.children);
          } else if (commitData.textContent != null) {
            mutateUpdateProperty(t, afterPath, "children", undefined);
            mutateUpdateProperty(t, afterPath, "textContent", commitData.textContent);
          }
        }
        mutateInsertNode(t, parentPath, idx + 1, structuredClone(elementDef));
        t.session.selection = newPath;
      });

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
