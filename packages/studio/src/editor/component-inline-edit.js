/**
 * Component inline edit — extracted from studio.js (Phase 4j). Manages plaintext-only editing on
 * canvas elements in design mode, with slash menu delegation for block insertion.
 */

import {
  getState,
  updateUi,
  renderOnly,
  getNodeAtPath,
  parentElementPath,
  childIndex,
  canvasPanels,
  elToPath,
} from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import {
  transactDoc,
  mutateRemoveNode,
  mutateInsertNode,
  mutateUpdateProperty,
} from "../tabs/transact.js";
import { view } from "../view.js";
import { isSlashMenuOpen, showSlashMenu, dismissSlashMenu } from "./slash-menu.js";
import { renderBlockActionBar } from "../panels/block-action-bar.js";
import { defaultDef } from "../panels/shared.js";

/** @type {any} */
let _ctx = null;

/**
 * Initialize the component inline edit module.
 *
 * @param {{ findCanvasElement: Function }} ctx
 */
export function initComponentInlineEdit(ctx) {
  _ctx = ctx;
}

/**
 * Enter plaintext inline editing on a canvas element.
 *
 * @param {any} el
 * @param {any} path
 */
export function enterComponentInlineEdit(el, path) {
  if (view.componentInlineEdit && view.componentInlineEdit.el === el) {
    return;
  }

  const S = getState();
  const node = getNodeAtPath(S.document, path);
  if (!node) return;

  const tc = node.textContent;
  if (node.$props && (node.tagName || "").includes("-")) return;
  if (Array.isArray(node.children) && node.children.length > 0) return;
  if (node.children && typeof node.children === "object") return;
  if (tc && typeof tc === "object") return;
  const voids = new Set(["img", "input", "br", "hr", "video", "audio", "source", "embed", "slot"]);
  if (voids.has(node.tagName)) return;

  for (const p of canvasPanels) {
    const boxes = /** @type {NodeListOf<HTMLElement>} */ (
      p.overlay.querySelectorAll(".overlay-box")
    );
    for (const box of boxes) {
      box.style.border = "none";
    }
    p.overlayClk.style.pointerEvents = "none";
  }

  el.contentEditable = "plaintext-only";
  el.style.pointerEvents = "auto";
  el.style.cursor = "text";
  el.style.outline = "1px solid var(--accent, #4f8bc7)";
  el.style.outlineOffset = "-1px";
  el.style.minHeight = "1em";

  const rawText = typeof tc === "string" ? tc : "";
  el.textContent = rawText;

  view.componentInlineEdit = {
    el,
    path,
    originalText: rawText,
    mediaName: canvasPanels.find((p) => p.canvas.contains(el))?.mediaName || null,
  };

  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);

  el.addEventListener("keydown", componentInlineKeydown);
  el.addEventListener("input", componentInlineInput);

  const outsideHandler = (/** @type {any} */ evt) => {
    if (!view.componentInlineEdit) {
      document.removeEventListener("mousedown", outsideHandler, true);
      return;
    }
    if (view.componentInlineEdit.el.contains(evt.target)) return;
    if (isSlashMenuOpen()) return;
    if (view.blockActionBarEl && view.blockActionBarEl.contains(evt.target)) return;
    document.removeEventListener("mousedown", outsideHandler, true);

    /** @type {(string | number)[] | null} */
    let hitPath = null,
      hitMedia = null;
    for (const p of canvasPanels) {
      const els = /** @type {NodeListOf<HTMLElement>} */ (p.canvas.querySelectorAll("*"));
      for (const el of els) el.style.pointerEvents = "auto";
      p.overlayClk.style.display = "none";
      const found = document.elementsFromPoint(evt.clientX, evt.clientY);
      p.overlayClk.style.display = "";
      for (const el of els) el.style.pointerEvents = "none";
      for (const hit of found) {
        if (p.canvas.contains(hit) && hit !== p.canvas) {
          const path = elToPath.get(hit);
          if (path) {
            hitPath = path;
            hitMedia = p.mediaName;
            break;
          }
        }
      }
      if (hitPath) break;
    }

    const { el: editEl, path: editPath, originalText } = view.componentInlineEdit;
    const newText = (editEl.textContent ?? "").trim();
    cleanupComponentInlineEdit(editEl);

    const isEmpty = !newText;
    const pPath = parentElementPath(editPath);

    if (hitPath) {
      let hp = hitPath;
      const media = hitMedia === "base" ? null : (hitMedia ?? null);
      updateUi("pendingInlineEdit", { path: hp, mediaName: hitMedia });
      activeTab.value.session.ui.activeMedia = media;
      if (isEmpty && pPath) {
        transactDoc(activeTab.value, (t) => {
          mutateRemoveNode(t, editPath);
          const removedIdx = /** @type {number} */ (childIndex(editPath));
          const hitIdx = /** @type {number} */ (childIndex(hp));
          const hitParent = parentElementPath(hp);
          if (
            hitParent &&
            pPath &&
            hitParent.join("/") === pPath.join("/") &&
            hitIdx > removedIdx
          ) {
            hp = [...pPath, "children", hitIdx - 1];
            updateUi("pendingInlineEdit", { path: hp, mediaName: hitMedia });
          }
          t.session.selection = hp;
        });
      } else if (newText !== originalText) {
        transactDoc(activeTab.value, (t) => {
          mutateUpdateProperty(t, editPath, "textContent", newText || undefined);
          t.session.selection = hp;
        });
      } else {
        activeTab.value.session.selection = hp;
      }
    } else {
      if (isEmpty && pPath) {
        transactDoc(activeTab.value, (t) => mutateRemoveNode(t, editPath));
      } else if (newText !== originalText) {
        transactDoc(activeTab.value, (t) =>
          mutateUpdateProperty(t, editPath, "textContent", newText || undefined),
        );
      } else {
        renderOnly("canvas");
        renderOnly("overlays");
      }
    }
  };
  document.addEventListener("mousedown", outsideHandler, true);
  view.componentInlineEdit._outsideHandler = outsideHandler;

  renderBlockActionBar();
}

/** @param {any} e */
function componentInlineKeydown(e) {
  if (isSlashMenuOpen()) {
    if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    splitParagraph();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelComponentInlineEdit();
  }
  e.stopPropagation();
}

function splitParagraph() {
  if (!view.componentInlineEdit) return;
  const { el, path, mediaName } = view.componentInlineEdit;

  const sel = /** @type {any} */ (el.ownerDocument.defaultView?.getSelection());
  const fullText = el.textContent || "";
  let offset = fullText.length;
  if (sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    offset = preRange.toString().length;
  }

  const textBefore = fullText.slice(0, offset);
  const textAfter = fullText.slice(offset);

  const tag = "p";
  const pPath = /** @type {any} */ (parentElementPath(path));
  const idx = /** @type {number} */ (childIndex(path));
  if (!pPath) return;

  const newDef = { tagName: tag, textContent: textAfter };
  const newPath = [...pPath, "children", idx + 1];

  cleanupComponentInlineEdit(el);

  transactDoc(activeTab.value, (t) => {
    mutateUpdateProperty(t, path, "textContent", textBefore || undefined);
    mutateInsertNode(t, pPath, idx + 1, newDef);
    t.session.selection = newPath;
  });

  updateUi("pendingInlineEdit", { path: newPath, mediaName });
}

function _commitComponentInlineEdit() {
  if (!view.componentInlineEdit) return;
  const { el, path, originalText } = view.componentInlineEdit;
  const newText = (el.textContent ?? "").trim();

  cleanupComponentInlineEdit(el);

  const pPath = parentElementPath(path);
  if (!newText && pPath) {
    transactDoc(activeTab.value, (t) => mutateRemoveNode(t, path));
  } else if (newText !== originalText) {
    transactDoc(activeTab.value, (t) =>
      mutateUpdateProperty(t, path, "textContent", newText || undefined),
    );
  } else {
    renderOnly("canvas");
    renderOnly("overlays");
  }
}

function cancelComponentInlineEdit() {
  if (!view.componentInlineEdit) return;
  const { el } = view.componentInlineEdit;
  cleanupComponentInlineEdit(el);
  renderOnly("canvas");
  renderOnly("overlays");
}

/** @param {any} el */
function cleanupComponentInlineEdit(el) {
  el.removeEventListener("keydown", componentInlineKeydown);
  el.removeEventListener("input", componentInlineInput);
  dismissSlashMenu();
  el.removeAttribute("contenteditable");
  el.style.cursor = "";
  el.style.outline = "";
  el.style.outlineOffset = "";
  el.style.minHeight = "";
  el.style.pointerEvents = "";

  if (view.componentInlineEdit?._outsideHandler) {
    document.removeEventListener("mousedown", view.componentInlineEdit._outsideHandler, true);
  }
  view.componentInlineEdit = null;

  for (const p of canvasPanels) {
    p.overlay.style.display = "";
    p.overlayClk.style.pointerEvents = "";
  }
}

// ─── Component-mode slash commands ──────────────────────────────────────────

function componentInlineInput() {
  if (!view.componentInlineEdit) return;
  const { el, originalText } = view.componentInlineEdit;
  const text = el.textContent || "";

  if (originalText === "" && text.startsWith("/")) {
    const filter = text.slice(1).toLowerCase();
    showSlashMenu(el, filter, { onSelect: handleComponentSlashSelect });
  } else {
    dismissSlashMenu();
  }
}

/** @param {any} cmd */
function handleComponentSlashSelect(cmd) {
  if (!view.componentInlineEdit) return;
  const { el, path, mediaName } = view.componentInlineEdit;
  const pPath = parentElementPath(path);
  const idx = /** @type {number} */ (childIndex(path));
  if (!pPath) return;

  cleanupComponentInlineEdit(el);

  const newDef = defaultDef(cmd.tag);
  const newPath = [...pPath, "children", idx];

  transactDoc(activeTab.value, (t) => {
    mutateRemoveNode(t, path);
    mutateInsertNode(t, pPath, idx, newDef);
    t.session.selection = newPath;
  });

  const hasText = newDef.textContent != null;
  if (hasText) updateUi("pendingInlineEdit", { path: newPath, mediaName });
}
