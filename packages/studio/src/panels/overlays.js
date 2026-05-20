/**
 * Overlays panel — renders hover/selection overlay boxes on canvas panels. Delegates block action
 * bar rendering to studio.js via ctx callback.
 */

import { html, render as litRender, nothing } from "lit-html";
import { getState, canvasPanels, pathsEqual, subscribe } from "../store.js";
import { view } from "../view.js";
import {
  findCanvasElement,
  getActivePanel,
  overlayBoxDescriptor,
} from "../canvas/canvas-helpers.js";
import { layoutElements } from "../canvas/canvas-live-render.js";

/** @type {any} */
let _ctx = null;

/** @type {(() => void) | null} */
let _unsub = null;

/**
 * Mount the overlays panel.
 *
 * @param {any} ctx — { getCanvasMode, isEditing, renderBlockActionBar }
 */
export function mount(ctx) {
  _ctx = ctx;
  _unsub = subscribe((change) => {
    if (change.selection || change.hover || change.mode || change.ui || change.doc) render();
  });
}

export function unmount() {
  _unsub?.();
  _unsub = null;
  _ctx = null;
}

export function render() {
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
    /**
     * @type {{
     *   cls: string;
     *   top: string;
     *   left: string;
     *   width: string;
     *   height: string;
     *   border?: string;
     * }[]}
     */
    const boxes = [];

    if (S.hover && !pathsEqual(S.hover, S.selection)) {
      const el = findCanvasElement(S.hover, p.canvas);
      if (el) {
        const desc = overlayBoxDescriptor(el, "hover", p);
        if (layoutElements.has(el)) /** @type {any} */ (desc).isLayout = true;
        boxes.push(desc);
      }
    }

    if (S.selection && p === getActivePanel()) {
      const el = findCanvasElement(S.selection, p.canvas);
      if (el) {
        const desc = overlayBoxDescriptor(el, "selection", p);
        if (view.componentInlineEdit || _ctx.isEditing()) /** @type {any} */ (desc).border = "none";
        if (layoutElements.has(el)) /** @type {any} */ (desc).isLayout = true;
        boxes.push(desc);
      }
    }

    litRender(
      html`
        ${p.dropLine}
        ${boxes.map(
          (b) => html`
            <div
              class="${b.cls}${/** @type {any} */ (b).isLayout ? " overlay-layout" : ""}"
              style="top:${b.top};left:${b.left};width:${b.width};height:${b.height}${b.border
                ? `;border:${b.border}`
                : ""}"
            >
              ${
                /** @type {any} */ (b).isLayout
                  ? html`<span class="overlay-layout-badge">Layout</span>`
                  : nothing
              }
            </div>
          `,
        )}
      `,
      p.overlay,
    );
  }

  _ctx.renderBlockActionBar();
}
