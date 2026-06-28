/// <reference lib="dom" />
import { canvasPanels, renderOnly } from "../store";
import { view } from "../view";
import { isEditableBlock, startEditing } from "./inline-edit";
import { applyInlineCommit, applyInlineInsert, applyInlineSplit } from "./inline-edit-apply";
import { restoreTemplateExpressions } from "../utils/edit-display";
import { renderBlockActionBar } from "../panels/block-action-bar";
import { findCanvasElement, getActivePanel } from "../canvas/canvas-helpers";

import type { JxPath } from "../state";

/**
 * Enter rich-text inline editing on a canvas element (edit/content mode).
 *
 * @param {HTMLElement} el
 * @param {JxPath} path
 */
export function enterInlineEdit(el: HTMLElement, path: JxPath) {
  // Restore raw template expressions before editing.
  // PrepareForEditMode renders ${expr} as ❪ expr ❫ for display;
  // Revert so the user edits the real syntax and commits it back intact.
  restoreTemplateExpressions(el);

  // Hide overlays while editing
  for (const p of canvasPanels) {
    p.overlay.style.display = "none";
    p.overlayClk.style.pointerEvents = "none";
  }

  startEditing(el, path, {
    onCommit(commitPath, children, textContent) {
      applyInlineCommit(commitPath, children, textContent);
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

    onInsert(afterPath, cmd, commitData) {
      reenterAfterRender(applyInlineInsert(afterPath, cmd, commitData));
    },

    onSplit(splitPath, before, after) {
      reenterAfterRender(applyInlineSplit(splitPath, before, after), true);
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

/**
 * After a split/insert re-renders the canvas, find the new element and re-enter inline editing on
 * it (optionally placing the cursor at its start). Legacy in-realm re-entry; the iframe host
 * re-enters by posting `enterEdit` instead.
 *
 * @param {JxPath} newPath
 * @param {boolean} [atStart]
 */
function reenterAfterRender(newPath: JxPath, atStart = false) {
  requestAnimationFrame(() => {
    const activePanel = getActivePanel();
    if (!activePanel) {
      return;
    }
    const newEl = findCanvasElement(newPath, activePanel.canvas);
    if (!newEl || !isEditableBlock(newEl)) {
      return;
    }
    enterInlineEdit(newEl, newPath);
    if (atStart) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(newEl);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });
}
