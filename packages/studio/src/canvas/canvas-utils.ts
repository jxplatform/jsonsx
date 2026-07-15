/// <reference lib="dom" />
/**
 * Canvas panel utilities — extracted from studio.js (Phase 4l). Panzoom infrastructure: panel DOM
 * template creation, centering, transform application, zoom indicator, and fit-to-screen.
 */

import { html, nothing } from "lit-html";
import type { CanvasPanel } from "../types";
import { ref } from "lit-html/directives/ref.js";
import { classMap } from "lit-html/directives/class-map.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";

import { canvasPanels, canvasWrap, renderOnly, updateUi } from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { findCanvasElement, getActivePanel, panelMediaToActiveMedia } from "./canvas-helpers";
import { rectOf } from "../utils/geometry";
import type { TemplateResult } from "lit-html";

let _ctx: {
  getCanvasMode: () => string;
  getZoom: () => number;
  setZoomDirect: (zoom: number) => void;
};

/**
 * Initialize the canvas utils module.
 *
 * @param {{
 *   getCanvasMode: () => string;
 *   getZoom: () => number;
 *   setZoomDirect: (zoom: number) => void;
 * }} ctx
 */
export function initCanvasUtils(ctx: {
  getCanvasMode: () => string;
  getZoom: () => number;
  setZoomDirect: (zoom: number) => void;
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
    element: null,
    mediaName: mediaName || "",
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
  // Overlays live INSIDE the scaled panzoom-wrap (iframe hosts draw there), so no per-mode redraw
  // Is needed here — the flush only re-anchors the fixed block-action-bar. The tab-bar zoom widget
  // Tracks `ui.zoom` reactively, so no explicit indicator refresh is needed either.
  renderOnly("overlays");
}

// ─── Edit-mode content zoom ──────────────────────────────────────────────────
// Browser-page-zoom semantics: the canvas footprint stays fixed while the CONTENT reflows at the
// Zoomed effective width — unlike design mode's panzoom, which visually scales a fixed layout.

export const EDIT_ZOOM_MIN = 0.25;

export const EDIT_ZOOM_MAX = 3;

/** Clamp an edit-zoom value to the supported range. */
export function clampEditZoom(zoom: number): number {
  return Math.min(EDIT_ZOOM_MAX, Math.max(EDIT_ZOOM_MIN, zoom));
}

/**
 * Apply the active tab's edit-mode content zoom to the single edit panel.
 *
 * Mechanism: a parent-side transform on the iframe never reflows the iframe's internal document (it
 * is its own layout viewport), so genuine reflow requires resizing the iframe's REAL CSS width to
 * `renderWidth / editZoom` — and a compensating `scale(editZoom)` on the canvas element brings the
 * rendered footprint back to exactly `renderWidth`. The overlay layer (the iframe's DOM sibling
 * inside the canvas element) inherits the transform, so overlay boxes stay drawn at scale 1 (D-2),
 * and `hostDragGeometry`'s empirical `rect.width / clientWidth` evaluates to exactly `editZoom`
 * with no bridge changes.
 *
 * `renderWidth` is measured live from `.content-edit-column` (already `min(baseWidth, available)`
 * via normal block layout) — the nominal `$media["--"]` width would overflow a narrow studio
 * window.
 *
 * HARD INVARIANT: never trigger a canvas re-render from here (`renderCanvas`/`mountIframeCanvas`) —
 * a re-render rebuilds the iframe DOM and would destroy a live inline-edit session. Live zoom is
 * bare style writes only; the iframe's own ResizeObserver re-posts `contentHeight` after the
 * reflow, which also finalizes the viewport height.
 */
export function applyEditZoom() {
  if (_ctx.getCanvasMode() !== "edit") {
    return;
  }
  const [panel] = canvasPanels;
  if (!panel?.canvas || !panel.viewport) {
    return;
  }
  const canvasEl = panel.canvas;
  const iframe = canvasEl.querySelector("iframe");
  const editZoom = activeTab.value?.session.ui.editZoom ?? 1;
  if (editZoom === 1) {
    // Exactly today's fluid behavior — no inline width, no transform, auto viewport height.
    panel._width = null;
    canvasEl.style.width = "";
    canvasEl.style.transform = "";
    canvasEl.style.transformOrigin = "";
    if (iframe) {
      iframe.style.width = "100%";
    }
    panel.viewport.style.height = "";
  } else {
    const column = canvasWrap.querySelector<HTMLElement>(".content-edit-column");
    if (!column) {
      return;
    }
    // The column width is parent-driven (width:100%, max-width:baseWidth), so it is independent of
    // The canvas content — measuring it mid-zoom is stable. No rounding: layoutWidth * editZoom
    // Must equal renderWidth exactly.
    const renderWidth = rectOf(column).width;
    if (renderWidth <= 0) {
      return;
    }
    const layoutWidth = renderWidth / editZoom;
    panel._width = layoutWidth;
    canvasEl.style.width = `${layoutWidth}px`;
    canvasEl.style.transform = `scale(${editZoom})`;
    canvasEl.style.transformOrigin = "top left";
    if (iframe) {
      iframe.style.width = `${layoutWidth}px`;
      // Transforms don't affect an ancestor's auto-height, so the viewport (the white "page"
      // Surface) needs its height pinned to the SCALED content height. offsetHeight is the
      // Pre-measurement approximation; the next contentHeight message writes the exact value.
      panel.viewport.style.height = `${iframe.offsetHeight * editZoom}px`;
    }
  }
  // Re-anchor the fixed block-action-bar over the rescaled canvas.
  renderOnly("overlays");
}

/** Set the active tab's edit zoom (clamped) and apply it synchronously. */
export function setEditZoom(zoom: number) {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  tab.session.ui.editZoom = clampEditZoom(zoom);
  applyEditZoom();
}

let _editZoomRaf = 0;

/**
 * Wheel-rate edit-zoom setter: the reactive `editZoom` write lands immediately (the tab-bar label
 * tracks it), but the DOM work — an iframe width resize, i.e. a real reflow — is coalesced to one
 * `applyEditZoom()` per animation frame so a fast ctrl+scroll burst doesn't thrash layout.
 */
export function requestEditZoom(zoom: number) {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  tab.session.ui.editZoom = clampEditZoom(zoom);
  if (_editZoomRaf) {
    return;
  }
  _editZoomRaf = requestAnimationFrame(() => {
    _editZoomRaf = 0;
    applyEditZoom();
  });
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
    animatePanBy(offsetY);
  }
}

/**
 * Pan the panzoom canvas vertically so a PARENT-VIEWPORT rect is centered — for callers whose
 * target lives inside an iframe (no parent DOM element to measure; the host converts the measured
 * iframe rect and passes it here).
 */
export function panToParentRect(rect: { top: number; height: number }) {
  const wrapRect = rectOf(canvasWrap);
  const elCenterY = rect.top + rect.height / 2 - wrapRect.top;
  animatePanBy(wrapRect.height / 2 - elCenterY);
}

/** Animate `view.panY` by `offsetY` with the shared 250ms ease-out. */
function animatePanBy(offsetY: number) {
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
