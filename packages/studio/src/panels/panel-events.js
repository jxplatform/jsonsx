/**
 * Panel events — extracted from studio.js (Phase 4m). Unified event handler system for canvas
 * panels: click-to-select, double-click inline edit, context menu, hover tracking, insertion
 * helper.
 */

import {
  updateUi,
  elToPath,
  pathsEqual,
  parentElementPath,
  childIndex,
  getNodeAtPath,
  renderOnly,
} from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { view } from "../view.js";
import { stopEditing, isEditing, isEditableBlock } from "../editor/inline-edit.js";
import { showContextMenu } from "../editor/context-menu.js";
import * as insertionHelper from "../editor/insertion-helper.js";
import { defaultDef } from "../panels/shared.js";
import { bubbleInlinePath, findCanvasElement, effectiveZoom } from "../canvas/canvas-helpers.js";
import { layoutElements, activeLayoutPath } from "../canvas/canvas-live-render.js";

/** @type {PanelEventsCtx | null} */
let _ctx = null;

/**
 * @typedef {{
 *   getCanvasMode: () => string;
 *   enterInlineEdit: (el: HTMLElement, path: JxPath) => void;
 *   navigateToComponent: (path: string) => void;
 * }} PanelEventsCtx
 */

/**
 * Initialize the panel events module.
 *
 * @param {PanelEventsCtx} ctx
 */
export function initPanelEvents(ctx) {
  _ctx = ctx;
}

/** @param {import("../canvas/canvas-render.js").CanvasPanel} panel */
export function registerPanelEvents(panel) {
  const ctx = /** @type {PanelEventsCtx} */ (_ctx);
  const canvas = /** @type {HTMLElement} */ (panel.canvas);
  const overlayClk = /** @type {HTMLElement} */ (panel.overlayClk);
  const { mediaName } = panel;
  const ac = new AbortController();
  const opts = { signal: ac.signal };
  view.canvasEventCleanups.push(() => ac.abort());

  /** @param {Function} fn */
  function withPanelPointerEvents(fn) {
    const els = /** @type {NodeListOf<HTMLElement>} */ (canvas.querySelectorAll("*"));
    for (const el of els) el.style.pointerEvents = "auto";
    overlayClk.style.display = "none";
    const result = fn();
    overlayClk.style.display = "";
    for (const el of els) el.style.pointerEvents = "none";
    return result;
  }

  overlayClk.addEventListener(
    "click",
    (/** @type {MouseEvent} */ e) => {
      const barInner = view.blockActionBarEl?.firstElementChild;
      if (barInner) {
        const r = barInner.getBoundingClientRect();
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
          return;
      }
      if (isEditing()) {
        stopEditing();
      }

      const tab = activeTab.value;
      const canvasMode = ctx.getCanvasMode();

      const elements = /** @type {Element[]} */ (
        withPanelPointerEvents(() => document.elementsFromPoint(e.clientX, e.clientY))
      );

      if (!tab) return;

      for (const el of elements) {
        if (canvas.contains(el) && el !== canvas) {
          // Layout element clicked — show layout info instead of selecting in page doc
          if (layoutElements.has(el)) {
            view.layoutSelection = { el, layoutPath: activeLayoutPath };
            tab.session.selection = null;
            renderOnly("rightPanel");
            return;
          }
          view.layoutSelection = null;

          const originalPath = elToPath.get(el);
          if (originalPath) {
            let path = bubbleInlinePath(tab.doc.document, originalPath);
            const newMedia = mediaName === "base" ? null : (mediaName ?? null);

            const resolvedEl = /** @type {HTMLElement} */ (
              path === originalPath ? el : findCanvasElement(path, canvas) || el
            );

            if (
              pathsEqual(path, tab.session.selection) &&
              isEditableBlock(resolvedEl) &&
              (canvasMode === "edit" || tab.doc.mode === "content")
            ) {
              tab.session.ui.activeMedia = newMedia;
              ctx.enterInlineEdit(resolvedEl, path);
              return;
            }

            if (canvasMode === "design" && tab.doc.mode !== "content") {
              updateUi("pendingInlineEdit", { path, mediaName });
              tab.session.ui.activeMedia = newMedia;
              tab.session.selection = path;
              return;
            }

            tab.session.ui.activeMedia = newMedia;
            tab.session.selection = path;
            return;
          }
        }
      }
      tab.session.selection = null;
    },
    opts,
  );

  overlayClk.addEventListener(
    "dblclick",
    (/** @type {MouseEvent} */ e) => {
      const barInner = view.blockActionBarEl?.firstElementChild;
      if (barInner) {
        const r = barInner.getBoundingClientRect();
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
          return;
      }
      const canvasMode = ctx.getCanvasMode();
      if (canvasMode !== "edit" && canvasMode !== "design") return;

      const tab = activeTab.value;
      const elements = /** @type {Element[]} */ (
        withPanelPointerEvents(() => document.elementsFromPoint(e.clientX, e.clientY))
      );

      if (!tab) return;

      for (const el of elements) {
        if (canvas.contains(el) && el !== canvas) {
          const originalPath = elToPath.get(el);
          if (originalPath) {
            const path = bubbleInlinePath(tab.doc.document, originalPath);
            const resolvedEl = /** @type {HTMLElement} */ (
              path === originalPath ? el : findCanvasElement(path, canvas) || el
            );
            if (isEditableBlock(resolvedEl)) {
              const newMedia = mediaName === "base" ? null : (mediaName ?? null);
              tab.session.ui.activeMedia = newMedia;
              tab.session.selection = path;
              ctx.enterInlineEdit(resolvedEl, path);
              return;
            }
          }
        }
      }
    },
    opts,
  );

  overlayClk.addEventListener(
    "contextmenu",
    (/** @type {MouseEvent} */ e) => {
      const barInner = view.blockActionBarEl?.firstElementChild;
      if (barInner) {
        const r = barInner.getBoundingClientRect();
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
          return;
      }
      const tab = activeTab.value;
      const elements = /** @type {Element[]} */ (
        withPanelPointerEvents(() => document.elementsFromPoint(e.clientX, e.clientY))
      );
      for (const el of elements) {
        if (canvas.contains(el) && el !== canvas) {
          let path = elToPath.get(el);
          if (path) {
            path = bubbleInlinePath(tab?.doc.document, path);
            showContextMenu(e, path, { onEditComponent: ctx.navigateToComponent });
            return;
          }
        }
      }
      e.preventDefault();
    },
    opts,
  );

  overlayClk.addEventListener(
    "mousemove",
    (/** @type {MouseEvent} */ e) => {
      const barInner = view.blockActionBarEl?.firstElementChild;
      if (barInner) {
        const r = barInner.getBoundingClientRect();
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
          return;
      }
      const tab = activeTab.value;
      if (!tab) return;
      const el = /** @type {Element | null} */ (
        withPanelPointerEvents(() => document.elementFromPoint(e.clientX, e.clientY))
      );
      if (el && canvas.contains(el) && el !== canvas) {
        let path = elToPath.get(el);
        if (path) {
          path = bubbleInlinePath(tab.doc.document, path);
          if (!pathsEqual(path, tab.session.hover)) {
            tab.session.hover = path;
            renderOnly("overlays");
          }
        }
      } else if (tab.session.hover) {
        tab.session.hover = null;
        renderOnly("overlays");
      }
    },
    opts,
  );

  overlayClk.addEventListener(
    "mouseleave",
    () => {
      if (activeTab.value?.session.hover) {
        activeTab.value.session.hover = null;
        renderOnly("overlays");
      }
    },
    opts,
  );

  insertionHelper.mount({
    getCanvasMode: ctx.getCanvasMode,
    withPanelPointerEvents,
    effectiveZoom: effectiveZoom,
    defaultDef,
    parentElementPath,
    childIndex,
    getNodeAtPath,
    elToPath,
    panel: /** @type {import("../editor/insertion-helper.js").CanvasPanel} */ (
      /** @type {unknown} */ (panel)
    ),
  });
  view.canvasEventCleanups.push(() => insertionHelper.unmount());
}
