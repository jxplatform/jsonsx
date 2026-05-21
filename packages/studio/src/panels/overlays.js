/**
 * Overlays panel — renders hover/selection overlay boxes on canvas panels. Delegates block action
 * bar rendering to studio.js via ctx callback.
 */

import { html, render as litRender, nothing } from "lit-html";
import { getState, canvasPanels, pathsEqual, subscribe } from "../store.js";
import { view } from "../view.js";
import { findCanvasElement, getActivePanel, effectiveZoom } from "../canvas/canvas-helpers.js";
import { layoutElements } from "../canvas/canvas-live-render.js";

/**
 * @typedef {{
 *   cls: string;
 *   top: string;
 *   left: string;
 *   width: string;
 *   height: string;
 *   border?: string;
 *   isLayout?: boolean;
 * }} OverlayBox
 */

/**
 * @typedef {{
 *   getCanvasMode: () => string;
 *   isEditing: () => boolean;
 *   renderBlockActionBar: () => void;
 * }} OverlaysCtx
 */

/** @type {OverlaysCtx | null} */
let _ctx = null;

/** @type {(() => void) | null} */
let _unsub = null;

let _scheduled = false;

/**
 * Mount the overlays panel.
 *
 * @param {OverlaysCtx} ctx
 */
export function mount(ctx) {
  _ctx = ctx;
  _unsub = subscribe((change) => {
    if (change.selection || change.hover || change.mode) render();
  });
}

export function unmount() {
  _unsub?.();
  _unsub = null;
  _ctx = null;
}

export function render() {
  if (!_ctx) return;
  if (!_scheduled) {
    _scheduled = true;
    queueMicrotask(_flush);
  }
}

function _flush() {
  _scheduled = false;
  if (!_ctx) return;
  const S = getState();
  const canvasMode = _ctx.getCanvasMode();

  if (canvasMode !== "design" && canvasMode !== "edit" && canvasMode !== "settings") {
    for (const p of canvasPanels) {
      litRender(nothing, p.overlay);
      p.overlayClk.style.pointerEvents = "none";
    }
    if (view.selDragCleanup) {
      view.selDragCleanup();
      view.selDragCleanup = null;
    }
    return;
  }

  if (canvasMode === "settings") {
    const enable = S.ui.stylebookTab === "elements";
    for (const p of canvasPanels) {
      p.overlayClk.style.pointerEvents = enable ? "" : "none";
    }
    return;
  }

  for (const p of canvasPanels) {
    p.overlayClk.style.pointerEvents = view.componentInlineEdit || _ctx.isEditing() ? "none" : "";
  }

  if (view.selDragCleanup) {
    view.selDragCleanup();
    view.selDragCleanup = null;
  }

  for (const p of canvasPanels) {
    /** @type {OverlayBox[]} */
    const boxes = [];

    // Batch layout reads: read viewport geometry once per panel
    const vpRect = p.viewport.getBoundingClientRect();
    const scrollTop = p.viewport.scrollTop;
    const scrollLeft = p.viewport.scrollLeft;
    const scale = effectiveZoom();

    if (S.hover && !pathsEqual(S.hover, S.selection)) {
      const el = findCanvasElement(S.hover, p.canvas);
      if (el) {
        const elRect = el.getBoundingClientRect();
        /** @type {OverlayBox} */
        const desc = {
          cls: "overlay-box overlay-hover",
          top: `${(elRect.top - vpRect.top + scrollTop) / scale}px`,
          left: `${(elRect.left - vpRect.left + scrollLeft) / scale}px`,
          width: `${elRect.width / scale}px`,
          height: `${elRect.height / scale}px`,
        };
        if (layoutElements.has(el)) desc.isLayout = true;
        boxes.push(desc);
      }
    }

    if (S.selection && p === getActivePanel()) {
      const el = findCanvasElement(S.selection, p.canvas);
      if (el) {
        const elRect = el.getBoundingClientRect();
        /** @type {OverlayBox} */
        const desc = {
          cls: "overlay-box overlay-selection",
          top: `${(elRect.top - vpRect.top + scrollTop) / scale}px`,
          left: `${(elRect.left - vpRect.left + scrollLeft) / scale}px`,
          width: `${elRect.width / scale}px`,
          height: `${elRect.height / scale}px`,
        };
        if (view.componentInlineEdit || _ctx.isEditing()) desc.border = "none";
        if (layoutElements.has(el)) desc.isLayout = true;
        boxes.push(desc);
      }
    }

    litRender(
      html`
        ${p.dropLine}
        ${boxes.map(
          (b) => html`
            <div
              class="${b.cls}${b.isLayout ? " overlay-layout" : ""}"
              style="top:${b.top};left:${b.left};width:${b.width};height:${b.height}${b.border
                ? `;border:${b.border}`
                : ""}"
            >
              ${b.isLayout ? html`<span class="overlay-layout-badge">Layout</span>` : nothing}
            </div>
          `,
        )}
      `,
      p.overlay,
    );
  }

  _ctx.renderBlockActionBar();
}
