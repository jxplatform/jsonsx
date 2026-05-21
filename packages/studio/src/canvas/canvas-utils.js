/**
 * Canvas panel utilities — extracted from studio.js (Phase 4l). Panzoom infrastructure: panel DOM
 * template creation, centering, transform application, zoom indicator, and fit-to-screen.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";

import { renderOnly, updateUi, canvasWrap, canvasPanels } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { view } from "../view.js";

/** @type {any} */
let _ctx = null;

let zoomIndicatorHost = document.createElement("div");
zoomIndicatorHost.style.display = "contents";
document.body.appendChild(zoomIndicatorHost);

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
export function initCanvasUtils(ctx) {
  _ctx = ctx;
}

/**
 * Create the DOM structure for a single canvas panel.
 *
 * @param {any} mediaName
 * @param {any} label
 * @param {any} fullWidth
 * @param {any} width
 */
export function canvasPanelTemplate(mediaName, label, fullWidth, width = null) {
  /**
   * @type {{
   *   mediaName: string;
   *   element: HTMLElement | null;
   *   canvas: HTMLElement | null;
   *   overlay: HTMLElement | null;
   *   overlayClk: HTMLElement | null;
   *   viewport: HTMLElement | null;
   *   dropLine: HTMLElement | null;
   *   _width: number | null;
   * }}
   */
  const panel = {
    mediaName,
    element: null,
    canvas: null,
    overlay: null,
    overlayClk: null,
    viewport: null,
    dropLine: null,
    _width: width || null,
  };
  const tpl = html`
    <div
      class=${`canvas-panel${fullWidth ? " full-width" : ""}`}
      data-media=${ifDefined(mediaName !== null ? mediaName : undefined)}
      ${ref((el) => {
        if (el) panel.element = /** @type {HTMLElement} */ (el);
      })}
    >
      ${label
        ? html`
            <div
              class="canvas-panel-header"
              @click=${() => {
                updateUi("activeMedia", mediaName === "base" ? null : mediaName);
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
          if (el) panel.viewport = /** @type {HTMLElement} */ (el);
        })}
      >
        <div
          class="canvas-panel-canvas"
          style=${styleMap({ width: width ? `${width}px` : "" })}
          ${ref((el) => {
            if (el) panel.canvas = /** @type {HTMLElement} */ (el);
          })}
        ></div>
        <div
          class="canvas-panel-overlay"
          ${ref((el) => {
            if (el) panel.overlay = /** @type {HTMLElement} */ (el);
          })}
        >
          <div
            class="canvas-drop-indicator"
            style="display:none"
            ${ref((el) => {
              if (el) panel.dropLine = /** @type {HTMLElement} */ (el);
            })}
          ></div>
        </div>
        <div
          class="canvas-panel-click"
          ${ref((el) => {
            if (el) panel.overlayClk = /** @type {HTMLElement} */ (el);
          })}
        ></div>
      </div>
    </div>
  `;
  return { tpl, panel };
}

/** Center canvas in viewport. */
export function centerCanvas() {
  if (!view.panzoomWrap) return;
  const wrapWidth = canvasWrap.clientWidth;
  const wrapHeight = canvasWrap.clientHeight;
  const contentWidth = view.panzoomWrap.scrollWidth;
  const contentHeight = view.panzoomWrap.scrollHeight;
  const zoom = _ctx.getZoom();
  const scaledWidth = contentWidth * zoom;
  const scaledHeight = contentHeight * zoom;
  view.panX = Math.max(16, (wrapWidth - scaledWidth) / 2);
  const verticalCenter = (wrapHeight - scaledHeight) / 2;
  view.panY = verticalCenter > 16 ? verticalCenter : 16;
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
  if (!view.panzoomWrap) return;
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
  if (!view.panzoomWrap) return;
  const zoom = _ctx.getZoom();
  view.panzoomWrap.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${zoom})`;
  renderZoomIndicator();
  renderOnly("overlays");
  if (_ctx.getCanvasMode() === "settings") _ctx.renderStylebookOverlays();
}

/** Calculate zoom + pan to fit all panels within the viewport. */
export function fitToScreen() {
  if (!view.panzoomWrap) return;
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
  const wrapRect = view.panzoomWrap.getBoundingClientRect();
  const unscaledHeight = wrapRect.height / zoom;
  const maxPanelHeight = unscaledHeight + padding;

  const fitZoomW = wrapWidth / totalPanelWidth;
  const fitZoomH = wrapHeight / maxPanelHeight;
  const fitZoom = Math.min(5.0, Math.max(0.05, Math.min(fitZoomW, fitZoomH)));

  _ctx.setZoomDirect(fitZoom);

  const scaledWidth = totalPanelWidth * fitZoom;
  const scaledHeight = maxPanelHeight * fitZoom;
  view.panX = Math.max(0, (wrapWidth - scaledWidth) / 2);
  view.panY = Math.max(0, (wrapHeight - scaledHeight) / 2);
  applyTransform();
}

/** Reset the zoom indicator (clear its content). Called when switching to non-panzoom modes. */
export function resetZoomIndicator() {
  litRender(nothing, zoomIndicatorHost);
}

/**
 * Render the floating zoom indicator at the bottom center of canvas-wrap. Uses position: fixed,
 * computed from canvas-wrap bounds.
 */
export function renderZoomIndicator() {
  const zoom = _ctx.getZoom();
  if (!zoomIndicatorHost.isConnected) {
    document.body.appendChild(zoomIndicatorHost);
  }
  litRender(
    html`
      <div class="zoom-indicator">
        <span class="zoom-indicator-label">${Math.round(zoom * 100)}%</span>
        <sp-action-button
          quiet
          size="s"
          class="zoom-fit-btn"
          title="Fit to screen"
          @click=${fitToScreen}
        >
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
        </sp-action-button>
      </div>
    `,
    zoomIndicatorHost,
  );
  positionZoomIndicator();
}

/** Position the zoom indicator relative to canvas-wrap bounds. */
export function positionZoomIndicator() {
  const indicator = /** @type {HTMLElement | null} */ (document.querySelector(".zoom-indicator"));
  if (!indicator) return;
  const rect = canvasWrap.getBoundingClientRect();
  indicator.style.left = `${rect.left + rect.width / 2}px`;
  indicator.style.top = `${rect.bottom - 32}px`;
  indicator.style.transform = "translateX(-50%)";
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
