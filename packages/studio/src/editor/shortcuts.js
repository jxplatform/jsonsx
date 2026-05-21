/**
 * Shortcuts.js — Keyboard shortcuts for Jx Studio
 *
 * Extracted from studio.js. Registers wheel-zoom, middle-mouse pan, resize listener, and keydown
 * shortcuts on the canvas / document.
 */

import { getNodeAtPath, parentElementPath, childIndex, canvasWrap } from "../store.js";
import { activeTab, workspace, closeTab } from "../workspace/workspace.js";
import {
  transactDoc,
  mutateInsertNode,
  mutateRemoveNode,
  mutateDuplicateNode,
  undo as tabUndo,
  redo as tabRedo,
} from "../tabs/transact.js";
import { isEditing } from "./inline-edit.js";
import { copyNode, cutNode, pasteNode } from "./context-menu.js";

/**
 * @typedef {import("../state.js").StudioState} StudioState
 *
 * @typedef {import("../state.js").JxPath} JxPath
 */

/**
 * Initialise all keyboard (and wheel/pointer) shortcuts.
 *
 * @param {() => {
 *   S: StudioState;
 *   setS: (s: StudioState) => void;
 *   canvasMode: string;
 *   panX: number;
 *   panY: number;
 *   setPan: (x: number, y: number) => void;
 *   applyTransform: () => void;
 *   positionZoomIndicator: () => void;
 *   componentInlineEdit: object | null;
 *   saveFile: () => void;
 *   openProject: () => void;
 *   enterEditOnPath: (path: JxPath) => void;
 * }} getContext
 */
export function initShortcuts(getContext) {
  // Wheel handler: Ctrl+Scroll = zoom (cursor-centered), plain scroll = pan
  canvasWrap.addEventListener(
    "wheel",
    (/** @type {WheelEvent} */ e) => {
      const { S, setS, canvasMode, panX, panY, setPan, applyTransform } = getContext();
      // Edit (content) mode: let the scroll container handle scrolling natively
      if (canvasMode === "edit") return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Zoom towards cursor
        const rect = canvasWrap.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        const oldZoom = S.ui.zoom;
        const delta = -e.deltaY * 0.005;
        const newZoom = Math.min(5.0, Math.max(0.05, oldZoom * (1 + delta)));
        const ratio = newZoom / oldZoom;
        // Adjust pan so the point under cursor stays stationary
        setPan(cursorX - (cursorX - panX) * ratio, cursorY - (cursorY - panY) * ratio);
        setS({ ...S, ui: { ...S.ui, zoom: newZoom } });
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
  canvasWrap.addEventListener("pointerdown", (/** @type {PointerEvent} */ e) => {
    const ctx = getContext();
    if (ctx.canvasMode === "edit") return; // no panning in edit mode
    if (e.button !== 1) return; // middle button only
    e.preventDefault();
    canvasWrap.setPointerCapture(e.pointerId);
    let lastX = e.clientX,
      lastY = e.clientY;
    const onMove = (/** @type {PointerEvent} */ ev) => {
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

  // Reposition zoom indicator on resize
  window.addEventListener("resize", () => getContext().positionZoomIndicator());

  document.addEventListener("keydown", (e) => {
    const {
      S,
      setS,
      canvasMode,
      setPan,
      applyTransform,
      componentInlineEdit,
      saveFile,
      openProject,
      enterEditOnPath,
    } = getContext();
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
        saveFile();
      }
      if (mod && e.key === "w") {
        e.preventDefault();
      }
      return;
    }
    if (componentInlineEdit) {
      if (mod && e.key === "s") {
        e.preventDefault();
        saveFile();
      }
      if (mod && e.key === "w") {
        e.preventDefault();
      }
      return;
    }

    if (mod) {
      switch (e.key) {
        case "w":
          e.preventDefault();
          if (workspace.activeTabId && workspace.tabOrder.length > 1) {
            const tab = workspace.tabs.get(workspace.activeTabId);
            if (tab?.doc.dirty) {
              const name = tab.documentPath?.split("/").pop() || "Untitled";
              if (!window.confirm(`"${name}" has unsaved changes. Close without saving?`)) break;
            }
            closeTab(workspace.activeTabId);
          }
          break;
        case "o":
          e.preventDefault();
          openProject();
          break;
        case "s":
          e.preventDefault();
          saveFile();
          break;
        case "z":
          e.preventDefault();
          if (e.shiftKey) tabRedo(activeTab.value);
          else tabUndo(activeTab.value);
          break;
        case "d":
          e.preventDefault();
          if (S.selection) {
            const sel = S.selection;
            transactDoc(activeTab.value, (t) => mutateDuplicateNode(t, sel));
          }
          break;
        case "c":
          e.preventDefault();
          copyNode(S);
          break;
        case "x":
          e.preventDefault();
          cutNode(S);
          break;
        case "v":
          e.preventDefault();
          pasteNode(S);
          break;
        case "0":
          if (canvasMode === "edit") break;
          e.preventDefault();
          setS({ ...S, ui: { ...S.ui, zoom: 1 } });
          setPan(16, 16);
          applyTransform();
          break;
        case "=":
        case "+":
          if (canvasMode === "edit") break;
          e.preventDefault();
          setS({ ...S, ui: { ...S.ui, zoom: Math.min(5.0, S.ui.zoom * 1.2) } });
          applyTransform();
          break;
        case "-":
          if (canvasMode === "edit") break;
          e.preventDefault();
          setS({ ...S, ui: { ...S.ui, zoom: Math.max(0.05, S.ui.zoom / 1.2) } });
          applyTransform();
          break;
      }
      return;
    }

    switch (e.key) {
      case "Delete":
      case "Backspace":
        if (S.selection && S.selection.length >= 2) {
          e.preventDefault();
          const sel = S.selection;
          transactDoc(activeTab.value, (t) => mutateRemoveNode(t, sel));
        }
        break;
      case "Escape":
        activeTab.value.session.selection = null;
        break;
      case "Enter":
        if (S.selection && S.selection.length >= 2) {
          e.preventDefault();
          const pp = /** @type {JxPath} */ (parentElementPath(S.selection));
          const idx = /** @type {number} */ (childIndex(S.selection));
          const newPath = [...pp, "children", idx + 1];
          transactDoc(activeTab.value, (t) => {
            mutateInsertNode(t, pp, idx + 1, { tagName: "p", textContent: "" });
            t.session.selection = newPath;
          });
          enterEditOnPath(newPath);
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        navigateSelection(S);
        break;
      case "ArrowDown":
        e.preventDefault();
        navigateSelection(S, 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (S.selection && S.selection.length >= 2) {
          activeTab.value.session.selection = parentElementPath(S.selection);
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (S.selection) {
          const node = getNodeAtPath(S.document, S.selection);
          if (node?.children?.length > 0) {
            activeTab.value.session.selection = [...S.selection, "children", 0];
          }
        }
        break;
    }
  });

  // Block ctrl+scroll (browser zoom) on all non-canvas areas
  document.addEventListener(
    "wheel",
    (/** @type {WheelEvent} */ e) => {
      if ((e.ctrlKey || e.metaKey) && !canvasWrap.contains(/** @type {Node} */ (e.target))) {
        e.preventDefault();
      }
    },
    { passive: false },
  );
}

/**
 * @param {StudioState} S
 * @param {number} [direction]
 */
function navigateSelection(S, direction = -1) {
  if (!S.selection) {
    activeTab.value.session.selection = [];
    return;
  }
  if (S.selection.length < 2) return;

  const parent = getNodeAtPath(S.document, /** @type {JxPath} */ (parentElementPath(S.selection)));
  const idx = /** @type {number} */ (childIndex(S.selection));
  const newIdx = idx + direction;
  if (parent?.children && newIdx >= 0 && newIdx < parent.children.length) {
    activeTab.value.session.selection = [
      .../** @type {JxPath} */ (parentElementPath(S.selection)),
      "children",
      newIdx,
    ];
  }
}
