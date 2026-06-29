/// <reference lib="dom" />
/**
 * Canvas panel utilities — extracted from studio.js (Phase 4l). Panzoom infrastructure: panel DOM
 * template creation, centering, transform application, zoom indicator, and fit-to-screen.
 */

import { html, render as litRender, nothing } from "lit-html";
import type { CanvasPanel } from "../types";
import { ref } from "lit-html/directives/ref.js";
import { classMap } from "lit-html/directives/class-map.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";

import { canvasPanels, canvasWrap, renderOnly, updateUi } from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { getLayerSlot } from "../ui/layers";
import { findCanvasElement, getActivePanel, panelMediaToActiveMedia } from "./canvas-helpers";
import { rectOf } from "../utils/geometry";
import type { TemplateResult } from "lit-html";

let _ctx: {
  getCanvasMode: () => string;
  getZoom: () => number;
  setZoomDirect: (zoom: number) => void;
  renderStylebookOverlays: () => void;
};

let _zoomIndicatorEl: HTMLElement | null = null;

/**
 * Initialize the canvas utils module.
 *
 * @param {{
 *   getCanvasMode: () => string;
 *   getZoom: () => number;
 *   setZoomDirect: (zoom: number) => void;
 *   renderStylebookOverlays: () => void;
 * }} ctx
 */
export function initCanvasUtils(ctx: {
  getCanvasMode: () => string;
  getZoom: () => number;
  setZoomDirect: (zoom: number) => void;
  renderStylebookOverlays: () => void;
}) {
  _ctx = ctx;
}

/**
 * Create the DOM structure for a single canvas panel.
 *
 * @param {string | null} mediaName
 * @param {string | null} label
 * @param {boolean} fullWidth
 * @param {number | null} width
 */
export function canvasPanelTemplate(
  mediaName: string | null,
  label: string | null,
  fullWidth: boolean,
  width: number | null = null,
): { tpl: TemplateResult; panel: CanvasPanel } {
  // The DOM fields start null and are wired by the template's ref() directives,
  // Which lit runs synchronously during render — before any consumer reads them.
  const panel = {
    _width: width || null,
    canvas: null,
    dropLine: null,
    element: null,
    mediaName: mediaName || "",
    overlay: null,
    overlayClk: null,
    ready: false,
    renderScope: null,
    scrollContainer: null,
    viewport: null,
  } as unknown as CanvasPanel;
  const tpl = html`
    <div
      class=${classMap({ "canvas-panel": true, "full-width": fullWidth })}
      data-media=${ifDefined(mediaName !== null ? mediaName : undefined)}
      ${ref((el) => {
        if (el) {
          panel.element = el as HTMLElement;
        }
      })}
    >
      ${label
        ? html`
            <div
              class="canvas-panel-header"
              @click=${() => {
                updateUi("activeMedia", panelMediaToActiveMedia(mediaName));
              }}
            >
              ${label}
            </div>
          `
        : nothing}
      <div
        class="canvas-panel-viewport"
        style=${styleMap({ width: width && !fullWidth ? `${width}px` : "" })}
        ${ref((el) => {
          if (el) {
            panel.viewport = el as HTMLElement;
          }
        })}
      >
        <div
          class="canvas-panel-canvas"
          style=${styleMap({ width: width ? `${width}px` : "" })}
          ${ref((el) => {
            if (el) {
              panel.canvas = el as HTMLElement;
            }
          })}
        ></div>
        <div
          class="canvas-panel-overlay"
          ${ref((el) => {
            if (el) {
              panel.overlay = el as HTMLElement;
            }
          })}
        >
          <div
            class="canvas-drop-indicator"
            style="display:none"
            ${ref((el) => {
              if (el) {
                panel.dropLine = el as HTMLElement;
              }
            })}
          ></div>
        </div>
        <div
          class="canvas-panel-click"
          ${ref((el) => {
            if (el) {
              panel.overlayClk = el as HTMLElement;
            }
          })}
        ></div>
      </div>
    </div>
  `;
  return { panel, tpl };
}

/** Center canvas horizontally in viewport, top-aligned vertically. */
export function centerCanvas() {
  if (!view.panzoomWrap) {
    return;
  }
  const wrapWidth = canvasWrap.clientWidth;
  const contentWidth = view.panzoomWrap.scrollWidth;
  const zoom = _ctx.getZoom();
  const scaledWidth = contentWidth * zoom;
  view.panX = Math.max(16, (wrapWidth - scaledWidth) / 2);
  view.panY = 0;
}

/**
 * Attach a ResizeObserver to view.panzoomWrap that re-centers until the user pans. Handles async
 * content (runtime rendering, data fetching) that changes layout after initial paint.
 */
export function observeCenterUntilStable() {
  if (view.centerObserver) {
    view.centerObserver.disconnect();
    view.centerObserver = null;
  }
  if (!view.panzoomWrap) {
    return;
  }
  view.needsCenter = true;
  view.centerObserver = new ResizeObserver(() => {
    if (!view.needsCenter) {
      view.centerObserver?.disconnect();
      view.centerObserver = null;
      return;
    }
    centerCanvas();
    applyTransform();
  });
  view.centerObserver.observe(view.panzoomWrap);
  centerCanvas();
}

/** Apply the current zoom + pan transform to the panzoom wrapper. */
export function applyTransform() {
  if (!view.panzoomWrap) {
    return;
  }
  const zoom = _ctx.getZoom();
  view.panzoomWrap.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${zoom})`;
  renderZoomIndicator();
  renderOnly("overlays");
  if (_ctx.getCanvasMode() === "stylebook") {
    _ctx.renderStylebookOverlays();
  }
}

/** Calculate zoom + pan to fit all panels within the viewport. */
export function fitToScreen() {
  if (!view.panzoomWrap) {
    return;
  }
  const wrapWidth = canvasWrap.clientWidth;
  const wrapHeight = canvasWrap.clientHeight;
  const gap = 24;
  const padding = 32;
  let totalPanelWidth = 0;
  for (const p of canvasPanels) {
    totalPanelWidth += p._width || 800;
  }
  totalPanelWidth += gap * Math.max(0, canvasPanels.length - 1) + padding;

  const zoom = _ctx.getZoom();
  const wrapRect = rectOf(view.panzoomWrap);
  const unscaledHeight = wrapRect.height / zoom;
  const maxPanelHeight = unscaledHeight + padding;

  const fitZoomW = wrapWidth / totalPanelWidth;
  const fitZoomH = wrapHeight / maxPanelHeight;
  const fitZoom = Math.min(5, Math.max(0.05, Math.min(fitZoomW, fitZoomH)));

  _ctx.setZoomDirect(fitZoom);

  const scaledWidth = totalPanelWidth * fitZoom;
  const scaledHeight = maxPanelHeight * fitZoom;
  view.panX = Math.max(0, (wrapWidth - scaledWidth) / 2);
  view.panY = Math.max(0, (wrapHeight - scaledHeight) / 2);
  applyTransform();
}

/** Reset zoom to 100% and re-center horizontally. */
export function resetZoom() {
  if (!view.panzoomWrap) {
    return;
  }
  _ctx.setZoomDirect(1);
  centerCanvas();
  applyTransform();
  renderZoomIndicator();
}

/** Reset the zoom indicator (clear its content). Called when switching to non-panzoom modes. */
export function resetZoomIndicator() {
  litRender(nothing, getLayerSlot("popover", "zoom-indicator"));
}

/**
 * Smoothly pan/scroll the canvas vertically to center the given DOM element.
 *
 * @param {HTMLElement} el
 * @param {{ scrollContainer?: HTMLElement | null }} [panel]
 */
function _panToEl(el: HTMLElement, panel?: { scrollContainer?: HTMLElement | null }) {
  const wrapRect = rectOf(canvasWrap);
  const elRect = rectOf(el);
  const elCenterY = elRect.top + elRect.height / 2 - wrapRect.top;
  const vpCenterY = wrapRect.height / 2;
  const offsetY = vpCenterY - elCenterY;

  if (panel?.scrollContainer) {
    panel.scrollContainer.scrollTo({
      behavior: "smooth",
      top: panel.scrollContainer.scrollTop - offsetY,
    });
  } else {
    const startY = view.panY;
    const targetY = startY + offsetY;
    const start = performance.now();
    const duration = 250;
    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const ease = t * (2 - t);
      view.panY = startY + (targetY - startY) * ease;
      applyTransform();
      if (t < 1) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }
}

/**
 * Pan the canvas vertically so the element at `path` is centered in the viewport.
 *
 * @param {(string | number)[]} path
 */
export function panToElement(path: (string | number)[]) {
  const panel = getActivePanel();
  if (!panel?.canvas) {
    return;
  }
  const el = findCanvasElement(path, panel.canvas);
  if (!el) {
    return;
  }
  _panToEl(el, panel);
}

/**
 * Pan the canvas vertically to center a specific DOM element (e.g. stylebook elements).
 *
 * @param {HTMLElement} el
 */
export function panToCanvasEl(el: HTMLElement) {
  const panel = getActivePanel();
  _panToEl(el, panel ?? undefined);
}

/**
 * Render the floating zoom indicator at the bottom center of canvas-wrap. Uses position: fixed,
 * computed from canvas-wrap bounds.
 */
export function renderZoomIndicator() {
  const zoom = _ctx.getZoom();
  const host = getLayerSlot("popover", "zoom-indicator");
  litRender(
    html`
      <div
        class="zoom-indicator"
        ${ref((el: Element | undefined) => {
          _zoomIndicatorEl = (el as HTMLElement) || null;
        })}
      >
        <span class="zoom-indicator-action" title="Reset to 100%" @click=${resetZoom}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5.5v5M5.5 8h5" />
          </svg>
        </span>
        <span class="zoom-indicator-label">${Math.round(zoom * 100)}%</span>
        <span class="zoom-indicator-action" title="Fit to screen" @click=${fitToScreen}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <rect x="2" y="2" width="12" height="12" rx="1" />
            <path d="M2 6h12M6 2v12" />
          </svg>
        </span>
      </div>
    `,
    host,
  );
  positionZoomIndicator();
}

/** Position the zoom indicator relative to canvas-wrap bounds. */
export function positionZoomIndicator() {
  if (!_zoomIndicatorEl) {
    return;
  }
  const rect = rectOf(canvasWrap);
  _zoomIndicatorEl.style.left = `${rect.left + rect.width / 2}px`;
  _zoomIndicatorEl.style.top = `${rect.bottom - 32}px`;
  _zoomIndicatorEl.style.transform = "translateX(-50%)";
}

/** Toggle "active" class on canvas panel headers based on activeMedia. */
export function updateActivePanelHeaders() {
  const activeMedia = activeTab.value?.session.ui.activeMedia ?? null;
  for (const p of canvasPanels) {
    const header = p.element?.querySelector(".canvas-panel-header");
    if (header) {
      const isActive =
        (activeMedia === null && p.mediaName === "base") ||
        (activeMedia === null && p.mediaName === null) ||
        activeMedia === p.mediaName;
      header.classList.toggle("active", isActive);
    }
  }
}
