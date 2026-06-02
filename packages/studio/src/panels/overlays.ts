/// <reference lib="dom" />
/**
 * Overlays panel — renders hover/selection overlay boxes on canvas panels. Delegates block action
 * bar rendering to studio.js via ctx callback.
 */

import { html, render as litRender, nothing } from "lit-html";
import { styleMap } from "lit-html/directives/style-map.js";
import { canvasPanels, pathsEqual } from "../store";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { findCanvasElement, getActivePanel, effectiveZoom } from "../canvas/canvas-helpers";
import { layoutElements } from "../canvas/canvas-live-render";

interface OverlayBox {
  cls: string;
  top: string;
  left: string;
  width: string;
  height: string;
  border?: string;
  isLayout?: boolean;
}

interface OverlaysCtx {
  getCanvasMode: () => string;
  isEditing: () => boolean;
  renderBlockActionBar: () => void;
}

let _ctx: OverlaysCtx | null = null;

let _scope: import("@vue/reactivity").EffectScope | null = null;

let _scheduled = false;

/**
 * Mount the overlays panel.
 *
 * @param {OverlaysCtx} ctx
 */
export function mount(ctx: OverlaysCtx) {
  _ctx = ctx;
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (!tab) return;
      // Track selection, hover, and mode
      void tab.session.selection;
      void tab.session.hover;
      void tab.doc.mode;
      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
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
  const tab = activeTab.value;
  if (!tab) return;
  const { selection, hover } = tab.session;
  const { stylebookTab } = tab.session.ui;
  const canvasMode = _ctx.getCanvasMode();

  if (canvasMode !== "design" && canvasMode !== "edit" && canvasMode !== "stylebook") {
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

  if (canvasMode === "stylebook") {
    const enable = stylebookTab === "elements";
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
    const boxes: OverlayBox[] = [];

    // Batch layout reads: read viewport geometry once per panel
    if (!p.viewport) continue;
    const vpRect = p.viewport.getBoundingClientRect();
    const scrollTop = p.viewport.scrollTop;
    const scrollLeft = p.viewport.scrollLeft;
    const scale = effectiveZoom();

    if (hover && !pathsEqual(hover, selection)) {
      const el = findCanvasElement(hover, p.canvas);
      if (el) {
        const elRect = el.getBoundingClientRect();
        const desc: OverlayBox = {
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

    if (selection && p === getActivePanel()) {
      const el = findCanvasElement(selection, p.canvas);
      if (el) {
        const elRect = el.getBoundingClientRect();
        const desc: OverlayBox = {
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
              style=${styleMap({
                top: b.top,
                left: b.left,
                width: b.width,
                height: b.height,
                border: b.border,
              })}
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
