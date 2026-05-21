/**
 * Panel events — extracted from studio.js (Phase 4m). Unified event handler system for canvas
 * panels: click-to-select, double-click inline edit, context menu, hover tracking, insertion
 * helper.
 */

import {
  updateUi,
  hoverNode,
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

/** @type {any} */
let _ctx = null;

/**
 * Initialize the panel events module.
 *
 * @param {{
 *   getState: () => any;
 *   setState: (s: any) => void;
 *   getCanvasMode: () => string;
 *   enterInlineEdit: (el: any, path: any) => void;
 *   navigateToComponent: (path: any) => void;
 * }} ctx
 */
export function initPanelEvents(ctx) {
  _ctx = ctx;
}

/** @param {any} panel */
export function registerPanelEvents(panel) {
  const { canvas, overlayClk, mediaName } = panel;
  const ac = new AbortController();
  const opts = { signal: ac.signal };
  view.canvasEventCleanups.push(() => ac.abort());

  /** @param {any} fn */
  function withPanelPointerEvents(fn) {
    const els = canvas.querySelectorAll("*");
    for (const el of els) el.style.pointerEvents = "auto";
    overlayClk.style.display = "none";
    const result = fn();
    overlayClk.style.display = "";
    for (const el of els) el.style.pointerEvents = "none";
    return result;
  }

  overlayClk.addEventListener(
    "click",
    (/** @type {any} */ e) => {
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

      const S = _ctx.getState();
      const canvasMode = _ctx.getCanvasMode();

      const elements = withPanelPointerEvents(() =>
        document.elementsFromPoint(e.clientX, e.clientY),
      );

      for (const el of elements) {
        if (canvas.contains(el) && el !== canvas) {
          // Layout element clicked — show layout info instead of selecting in page doc
          if (layoutElements.has(el)) {
            view.layoutSelection = { el, layoutPath: activeLayoutPath };
            activeTab.value.session.selection = null;
            renderOnly("rightPanel");
            return;
          }
          view.layoutSelection = null;

          const originalPath = elToPath.get(el);
          if (originalPath) {
            let path = bubbleInlinePath(S.document, originalPath);
            const newMedia = mediaName === "base" ? null : (mediaName ?? null);
            const withMedia = { ...S, ui: { ...S.ui, activeMedia: newMedia } };

            const resolvedEl = path === originalPath ? el : findCanvasElement(path, canvas) || el;

            if (
              pathsEqual(path, S.selection) &&
              isEditableBlock(resolvedEl) &&
              (canvasMode === "edit" || S.mode === "content")
            ) {
              _ctx.setState(withMedia);
              _ctx.enterInlineEdit(resolvedEl, path);
              return;
            }

            if (canvasMode === "design" && S.mode !== "content") {
              updateUi("pendingInlineEdit", { path, mediaName });
              activeTab.value.session.ui.activeMedia = newMedia;
              activeTab.value.session.selection = path;
              return;
            }

            activeTab.value.session.ui.activeMedia = newMedia;
            activeTab.value.session.selection = path;
            return;
          }
        }
      }
      activeTab.value.session.selection = null;
    },
    opts,
  );

  overlayClk.addEventListener(
    "dblclick",
    (/** @type {any} */ e) => {
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
      const canvasMode = _ctx.getCanvasMode();
      if (canvasMode !== "edit" && canvasMode !== "design") return;

      const S = _ctx.getState();
      const elements = withPanelPointerEvents(() =>
        document.elementsFromPoint(e.clientX, e.clientY),
      );

      for (const el of elements) {
        if (canvas.contains(el) && el !== canvas) {
          const originalPath = elToPath.get(el);
          if (originalPath) {
            const path = bubbleInlinePath(S.document, originalPath);
            const resolvedEl = path === originalPath ? el : findCanvasElement(path, canvas) || el;
            if (isEditableBlock(resolvedEl)) {
              const newMedia = mediaName === "base" ? null : (mediaName ?? null);
              activeTab.value.session.ui.activeMedia = newMedia;
              activeTab.value.session.selection = path;
              _ctx.enterInlineEdit(resolvedEl, path);
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
    (/** @type {any} */ e) => {
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
      const S = _ctx.getState();
      const elements = withPanelPointerEvents(() =>
        document.elementsFromPoint(e.clientX, e.clientY),
      );
      for (const el of elements) {
        if (canvas.contains(el) && el !== canvas) {
          let path = elToPath.get(el);
          if (path) {
            path = bubbleInlinePath(S.document, path);
            showContextMenu(e, path, S, { onEditComponent: _ctx.navigateToComponent });
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
    (/** @type {any} */ e) => {
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
      let S = _ctx.getState();
      const el = withPanelPointerEvents(() => document.elementFromPoint(e.clientX, e.clientY));
      if (el && canvas.contains(el) && el !== canvas) {
        let path = elToPath.get(el);
        if (path) {
          path = bubbleInlinePath(S.document, path);
          if (!pathsEqual(path, S.hover)) {
            _ctx.setState(hoverNode(S, path));
            renderOnly("overlays");
          }
        }
      } else if (S.hover) {
        _ctx.setState(hoverNode(S, null));
        renderOnly("overlays");
      }
    },
    opts,
  );

  overlayClk.addEventListener(
    "mouseleave",
    () => {
      const S = _ctx.getState();
      if (S.hover) {
        _ctx.setState(hoverNode(S, null));
        renderOnly("overlays");
      }
    },
    opts,
  );

  insertionHelper.mount({
    getState: _ctx.getState,
    getCanvasMode: _ctx.getCanvasMode,
    withPanelPointerEvents,
    effectiveZoom: effectiveZoom,
    defaultDef,
    parentElementPath,
    childIndex,
    getNodeAtPath,
    elToPath,
    panel,
  });
  view.canvasEventCleanups.push(() => insertionHelper.unmount());
}
