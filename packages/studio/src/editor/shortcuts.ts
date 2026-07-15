/// <reference lib="dom" />
/**
 * Shortcuts.js — Keyboard shortcuts for Jx Studio
 *
 * Extracted from studio.js. Registers wheel-zoom, middle-mouse pan, resize listener, and keydown
 * shortcuts on the canvas / document.
 */

import { canvasWrap, childIndex, childList, getNodeAtPath, parentElementPath } from "../store";
import { activeTab, closeTab, workspace } from "../workspace/workspace";
import {
  mutateDuplicateNode,
  mutateInsertNode,
  mutateRemoveNode,
  redo as tabRedo,
  undo as tabUndo,
  transactDoc,
} from "../tabs/transact";
import { applyEditZoom, requestEditZoom, setEditZoom } from "../canvas/canvas-utils";
import { isEditing, stopEditing } from "./inline-edit";
import { copyNode, cutNode, pasteNode } from "./context-menu";
import { openQuickSearch } from "../panels/quick-search";
import { shouldWarnOnClose } from "../panels/tab-strip";
import { showConfirmDialog } from "../ui/layers";
import { rectOf } from "../utils/geometry";

import type { JxPath } from "../state";

/**
 * Initialise all keyboard (and wheel/pointer) shortcuts.
 *
 * @param {() => {
 *   canvasMode: string;
 *   panX: number;
 *   panY: number;
 *   setPan: (x: number, y: number) => void;
 *   applyTransform: () => void;
 *   saveFile: () => void;
 *   openProject: () => void;
 * }} getContext
 */
export function initShortcuts(
  getContext: () => {
    canvasMode: string;
    panX: number;
    panY: number;
    setPan: (x: number, y: number) => void;
    applyTransform: () => void;
    saveFile: () => void;
    openProject: () => void;
  },
) {
  // Wheel handler: Ctrl+Scroll = zoom (cursor-centered), plain scroll = pan
  canvasWrap.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      const { canvasMode, panX, panY, setPan, applyTransform } = getContext();
      // Edit (content) mode: ctrl/cmd+wheel drives the content zoom (browser-page-zoom semantics —
      // The footprint stays fixed, content reflows); plain wheel scrolls the edit-mode container
      // Ourselves. The canvas iframe is sized to its content (no internal scroll) and a cross-origin
      // OOPIF doesn't bubble wheel to the parent, so the wheel reaches us forwarded (or over the
      // Canvas chrome) but never triggers native scroll.
      if (canvasMode === "edit") {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const editZoom = activeTab.value?.session.ui.editZoom ?? 1;
          requestEditZoom(editZoom * (1 + -e.deltaY * 0.005));
          return;
        }
        const sc = canvasWrap.querySelector<HTMLElement>(".content-edit-canvas");
        if (sc) {
          e.preventDefault();
          sc.scrollTop += e.deltaY;
          sc.scrollLeft += e.deltaX;
        }
        return;
      }
      // Manage mode: browse table handles its own scrolling
      if (canvasMode === "manage") {
        return;
      }
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Zoom towards cursor
        const rect = rectOf(canvasWrap);
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        const oldZoom = activeTab.value?.session.ui.zoom ?? 1;
        const delta = -e.deltaY * 0.005;
        const newZoom = Math.min(5, Math.max(0.05, oldZoom * (1 + delta)));
        const ratio = newZoom / oldZoom;
        // Adjust pan so the point under cursor stays stationary
        setPan(cursorX - (cursorX - panX) * ratio, cursorY - (cursorY - panY) * ratio);
        activeTab.value!.session.ui.zoom = newZoom;
      } else if (e.shiftKey) {
        // Shift+scroll = horizontal pan
        setPan(panX - e.deltaY, panY);
      } else {
        // Pan
        setPan(panX - e.deltaX, panY - e.deltaY);
      }
      applyTransform();
    },
    { passive: false },
  );

  // Middle-mouse drag panning
  canvasWrap.addEventListener("pointerdown", (e: PointerEvent) => {
    const ctx = getContext();
    if (ctx.canvasMode === "edit") {
      return;
    } // No panning in edit mode
    if (e.button !== 1) {
      return;
    } // Middle button only
    e.preventDefault();
    canvasWrap.setPointerCapture(e.pointerId);
    let lastX = e.clientX,
      lastY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const { panX, panY, setPan, applyTransform } = getContext();
      setPan(panX + (ev.clientX - lastX), panY + (ev.clientY - lastY));
      lastX = ev.clientX;
      lastY = ev.clientY;
      applyTransform();
    };
    const onUp = () => {
      canvasWrap.releasePointerCapture(e.pointerId);
      canvasWrap.removeEventListener("pointermove", onMove);
      canvasWrap.removeEventListener("pointerup", onUp);
    };
    canvasWrap.addEventListener("pointermove", onMove);
    canvasWrap.addEventListener("pointerup", onUp);
  });

  // Re-fit the edit-mode content zoom on resize: its layout width derives from the LIVE column
  // Width, which tracks the studio window.
  window.addEventListener("resize", () => {
    if (getContext().canvasMode === "edit") {
      applyEditZoom();
    }
  });

  document.addEventListener("keydown", (e) => {
    const { canvasMode, setPan, applyTransform, saveFile, openProject } = getContext();
    const tab = activeTab.value;
    const mod = e.ctrlKey || e.metaKey;

    // Don't intercept when typing in inputs or contenteditable
    if (
      e.target instanceof HTMLElement &&
      e.target.matches(
        "input, textarea, select, sp-textfield, sp-search, sp-number-field, sp-picker",
      )
    ) {
      if (mod && e.key === "s") {
        e.preventDefault();
        saveFile();
      }
      if (mod && e.key === "w") {
        e.preventDefault();
      }
      return;
    }
    if (isEditing()) {
      if (mod && e.key === "s") {
        e.preventDefault();
        stopEditing();
        saveFile();
      }
      if (mod && e.key === "w") {
        e.preventDefault();
      }
      return;
    }
    if (mod) {
      // Grid mode: copy/paste/duplicate/zoom belong to the grid engine (Tabulator clipboard
      // Needs the native events); only tab/app-level chords pass through.
      if (canvasMode === "grid" && !["o", "p", "s", "w", "z"].includes(e.key)) {
        return;
      }
      switch (e.key) {
        case "w": {
          e.preventDefault();
          if (workspace.activeTabId && workspace.tabOrder.length > 1) {
            const tabToClose = workspace.tabs.get(workspace.activeTabId);
            if (tabToClose && shouldWarnOnClose(tabToClose)) {
              const name = tabToClose.documentPath?.split("/").pop() || "Untitled";
              void showConfirmDialog(
                "Unsaved Changes",
                `"${name}" has unsaved changes. Close without saving?`,
                { confirmLabel: "Close", destructive: true },
              ).then((confirmed) => {
                if (confirmed && workspace.activeTabId) {
                  closeTab(workspace.activeTabId);
                }
              });
            } else {
              closeTab(workspace.activeTabId);
            }
          }
          break;
        }
        case "o": {
          e.preventDefault();
          openProject();
          break;
        }
        case "p": {
          e.preventDefault();
          openQuickSearch();
          break;
        }
        case "s": {
          e.preventDefault();
          saveFile();
          break;
        }
        case "z": {
          e.preventDefault();
          if (e.shiftKey) {
            tabRedo(activeTab.value!);
          } else {
            tabUndo(activeTab.value!);
          }
          break;
        }
        case "d": {
          e.preventDefault();
          if (tab?.session.selection) {
            const sel = tab.session.selection;
            transactDoc(tab, (t) => mutateDuplicateNode(t, sel));
          }
          break;
        }
        case "c": {
          e.preventDefault();
          void copyNode();
          break;
        }
        case "x": {
          e.preventDefault();
          void cutNode();
          break;
        }
        case "v": {
          e.preventDefault();
          void pasteNode();
          break;
        }
        case "0": {
          e.preventDefault();
          if (canvasMode === "edit") {
            setEditZoom(1);
            break;
          }
          activeTab.value!.session.ui.zoom = 1;
          setPan(16, 16);
          applyTransform();
          break;
        }
        case "=":
        case "+": {
          e.preventDefault();
          if (canvasMode === "edit") {
            setEditZoom((tab?.session.ui.editZoom ?? 1) * 1.2);
            break;
          }
          activeTab.value!.session.ui.zoom = Math.min(5, (tab?.session.ui.zoom ?? 1) * 1.2);
          applyTransform();
          break;
        }
        case "-": {
          e.preventDefault();
          if (canvasMode === "edit") {
            setEditZoom((tab?.session.ui.editZoom ?? 1) / 1.2);
            break;
          }
          activeTab.value!.session.ui.zoom = Math.max(0.05, (tab?.session.ui.zoom ?? 1) / 1.2);
          applyTransform();
          break;
        }
        default: {
          break;
        }
      }
      return;
    }

    // Grid mode: Delete/Escape/Enter/arrows drive the grid's own range clearing and cell
    // Navigation — never the canvas document.
    if (canvasMode === "grid") {
      return;
    }

    switch (e.key) {
      case "Delete":
      case "Backspace": {
        if (tab?.session.selection && tab.session.selection.length >= 2) {
          e.preventDefault();
          const sel = tab.session.selection;
          transactDoc(tab, (t) => mutateRemoveNode(t, sel));
        }
        break;
      }
      case "Escape": {
        activeTab.value!.session.selection = null;
        break;
      }
      case "Enter": {
        if (tab?.session.selection && tab.session.selection.length >= 2) {
          e.preventDefault();
          const pp = parentElementPath(tab.session.selection) as JxPath;
          const idx = childIndex(tab.session.selection) as number;
          const newPath = [...pp, "children", idx + 1];
          transactDoc(tab, (t) => {
            mutateInsertNode(t, pp, idx + 1, { tagName: "p", textContent: "" });
            t.session.selection = newPath;
          });
          // The iframe canvas re-enters inline edit for the freshly-selected node via its own
          // Posted enterEdit flow, so no parent-side enterEditOnPath is needed here.
        }
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        navigateSelection(-1);
        break;
      }
      case "ArrowDown": {
        e.preventDefault();
        navigateSelection(1);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (tab?.session.selection && tab.session.selection.length >= 2) {
          activeTab.value!.session.selection = parentElementPath(tab.session.selection);
        }
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        if (tab?.session.selection) {
          const node = getNodeAtPath(tab.doc.document, tab.session.selection);
          if (childList(node).length > 0) {
            activeTab.value!.session.selection = [...tab.session.selection, "children", 0];
          }
        }
        break;
      }
      default: {
        break;
      }
    }
  });

  // Block ctrl+scroll (browser zoom) on all non-canvas areas
  document.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if ((e.ctrlKey || e.metaKey) && !canvasWrap.contains(e.target as Node)) {
        e.preventDefault();
      }
    },
    { passive: false },
  );
}

/** @param {number} [direction] */
function navigateSelection(direction = -1) {
  const tab = activeTab.value;
  if (!tab?.session.selection) {
    activeTab.value!.session.selection = [];
    return;
  }
  if (tab.session.selection.length < 2) {
    return;
  }

  const parent = getNodeAtPath(
    tab.doc.document,
    parentElementPath(tab.session.selection) as JxPath,
  );
  const idx = childIndex(tab.session.selection) as number;
  const newIdx = idx + direction;
  if (newIdx >= 0 && newIdx < childList(parent).length) {
    activeTab.value!.session.selection = [
      ...(parentElementPath(tab.session.selection) as JxPath),
      "children",
      newIdx,
    ];
  }
}
