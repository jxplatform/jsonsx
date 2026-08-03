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
import {
  argsSchema,
  boundedNumberArg,
  enumArg,
  enumProperty,
  numberProperty,
} from "../commands/command-args";
import type { TemplateResult } from "lit-html";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

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
      ${
        label
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
          : nothing
      }
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
  // Is needed here — the flush only re-anchors the fixed block-action-bar. The floating zoom pod
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
 * Wheel-rate edit-zoom setter: the reactive `editZoom` write lands immediately (the zoom pod's
 * label tracks it), but the DOM work — an iframe width resize, i.e. a real reflow — is coalesced to
 * one `applyEditZoom()` per animation frame so a fast ctrl+scroll burst doesn't thrash layout.
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

/**
 * Compute and apply a geometric fit. Pure arithmetic — it declares nothing.
 *
 * `axis` is the fit's own meaning: `"page"` fits both axes (the whole artboard, in view), `"width"`
 * fits the horizontal axis and lets the page run off the bottom, which is what you want on a long
 * document you are about to scroll. `maxZoom` caps the result.
 */
function applyGeometricFit(axis: "width" | "page", maxZoom: number): void {
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
  const wanted = axis === "width" ? fitZoomW : Math.min(fitZoomW, fitZoomH);
  const fitZoom = Math.min(maxZoom, Math.max(PAN_ZOOM_MIN, wanted));

  _ctx.setZoomDirect(fitZoom);

  const scaledWidth = totalPanelWidth * fitZoom;
  const scaledHeight = maxPanelHeight * fitZoom;
  view.panX = Math.max(0, (wrapWidth - scaledWidth) / 2);
  view.panY = Math.max(0, (wrapHeight - scaledHeight) / 2);
  applyTransform();
}

/**
 * Fit all panels within the viewport, and declare that as the document's fit.
 *
 * `maxZoom` caps the result. The Fit control passes the full {@link PAN_ZOOM_MAX} (asking to fit is
 * asking to magnify a small artboard too); the automatic fit on entering a panzoom mode passes 1,
 * because arriving at a document should never blow it up past life size.
 */
export function fitToScreen({ maxZoom = PAN_ZOOM_MAX }: { maxZoom?: number } = {}) {
  // Declared before the guard: "frame the whole page" is a preference the author expressed, and it
  // Stays true whether or not there is a laid-out artboard to apply it to this instant.
  declareFit("page");
  applyGeometricFit("page", maxZoom);
}

// ─── Pan-zoom (design / stylebook / git-diff artboards) ──────────────────────

export const PAN_ZOOM_MIN = 0.05;

export const PAN_ZOOM_MAX = 5;

/** Clamp a pan-zoom value to the supported range. */
export function clampPanZoom(zoom: number): number {
  return Math.min(PAN_ZOOM_MAX, Math.max(PAN_ZOOM_MIN, zoom));
}

/**
 * How a document is framed when you arrive at it — **declared state**, per tab + document.
 *
 * - `"page"` — the whole artboard in view (the default: arriving at a document should show it).
 * - `"width"` — fit the horizontal axis; the page runs off the bottom, which is what a long document
 *   you are about to scroll actually wants.
 * - `"none"` — frame nothing; whatever the zoom is, is the zoom.
 * - A number — that exact pan-zoom.
 *
 * This replaces an IMPLICIT fit-on-entry plus a `Set` of "documents the author has zoomed by hand",
 * which had three problems. It could not be read, so the zoom control could not show it. It could
 * not be written, so a preference users expect to persist silently reset. And because entering a
 * mode applied a transform nobody had asked for, anything measuring the canvas from outside had to
 * guess whether a fit had happened — which is precisely how a screen coordinate ends up wrong.
 *
 * "The author chose 84%" is not a special case here: it is the fit `0.84`.
 */
export type FitMode = "width" | "page" | "none" | number;

/**
 * The fit a document gets when it has not declared one.
 *
 * `"page"` because a 1280px artboard used to land clipped mid-word in a ~700px viewport, and
 * arriving at a document should never require a zoom-out before you can read it.
 */
export const DEFAULT_FIT: FitMode = "page";

/** The three named fits, as the `canvas.setFit` schema and its coercion both read them. */
export const FIT_WORDS: readonly string[] = ["width", "page", "none"];

/**
 * Coerce a `canvas.setFit` argument, refusing anything that is neither a named fit nor a scale.
 *
 * Written here rather than in `commands/command-args.ts` because the value space is this module's:
 * {@link FitMode} is declared three lines up, and a second copy of "which words are fits" in the
 * shared helpers is exactly the drift the registry projection exists to prevent.
 */
function fitArg(commandId: string, args: Record<string, unknown>, key: string): FitMode {
  const value = args[key];
  if (typeof value === "string" && FIT_WORDS.includes(value)) {
    return value as FitMode;
  }
  if (typeof value === "number" && value >= PAN_ZOOM_MIN && value <= PAN_ZOOM_MAX) {
    return value;
  }
  throw new RangeError(
    `command "${commandId}" argument "${key}": expected ${FIT_WORDS.map((w) => `"${w}"`).join(" | ")} ` +
      `or a number in [${PAN_ZOOM_MIN}, ${PAN_ZOOM_MAX}], got ${JSON.stringify(value)}`,
  );
}

/** Declared fits, keyed per tab + document. */
const _fits = new Map<string, FitMode>();

/** The registry key for the active tab's document (null when no tab is open). */
function fitKey(): string | null {
  const tab = activeTab.value;
  return tab ? `${tab.id}::${tab.documentPath ?? ""}` : null;
}

/** Write the active document's fit without applying it — the internal half of {@link setFit}. */
function declareFit(fit: FitMode): void {
  const key = fitKey();
  if (key) {
    _fits.set(key, fit);
  }
}

/** The active document's declared fit, or {@link DEFAULT_FIT}. Readable by the zoom control. */
export function getFit(): FitMode {
  const key = fitKey();
  return (key === null ? undefined : _fits.get(key)) ?? DEFAULT_FIT;
}

/** Whether the active document has declared a fit of its own. */
export function hasDeclaredFit(): boolean {
  const key = fitKey();
  return key !== null && _fits.has(key);
}

/** Drop every declared fit — a fresh session, and the tests. */
export function resetFits(): void {
  _fits.clear();
}

/** Honour a fit right now. Defaults to the active document's declared one. */
export function applyFit(fit: FitMode = getFit()): void {
  if (fit === "none") {
    applyTransform();
    return;
  }
  if (typeof fit === "number") {
    _ctx.setZoomDirect(clampPanZoom(fit));
    applyTransform();
    return;
  }
  // Capped at life size: arriving at a document should never blow it up past 100%.
  applyGeometricFit(fit, 1);
}

/** Declare the active document's fit AND honour it. The one writer every control routes through. */
export function setFit(fit: FitMode): void {
  declareFit(fit);
  applyFit(fit);
}

/**
 * Record the active document's CURRENT pan-zoom as its declared fit.
 *
 * For the gesture paths that move the zoom themselves and then have to say so — ctrl+scroll writes
 * `ui.zoom` directly, pinch will too. An author-chosen zoom is a numeric fit, so re-entering the
 * mode restores it instead of re-framing over the top of it.
 */
export function markExplicitZoom(): void {
  declareFit(clampPanZoom(_ctx.getZoom()));
}

/**
 * Set the active tab's pan-zoom on the author's behalf: clamped, declared as this document's fit,
 * and applied. Every author-facing pan-zoom control routes through here.
 */
export function setUserZoom(zoom: number): void {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  // The fit is declared BEFORE the reactive write, not after: `ui.zoom` is tracked, effects run
  // Synchronously on assignment, and the zoom pod reads `getFit()` while it renders — so declaring
  // Second means the control repaints one interaction behind the state it is reporting.
  const next = clampPanZoom(zoom);
  declareFit(next);
  tab.session.ui.zoom = next;
  applyTransform();
}

/**
 * Honour the declared fit when a pane enters a panzoom mode (Design, Stylebook).
 *
 * Called on the mode transition only. At that point the panels exist with their declared widths but
 * the iframes have not painted, which is why the geometry is driven by the panel widths rather than
 * by anything measured from content.
 */
export function fitOnCanvasEntry(): void {
  // An unmeasurable viewport (the pane is hidden, or layout has not run yet) would fit to the 5%
  // Floor, which is worse than the clipping this replaces. Leave the zoom alone.
  if (canvasWrap.clientWidth <= 0) {
    applyTransform();
    return;
  }
  applyFit();
}

/** Reset zoom to 100% and re-center horizontally, declaring 100% as this document's fit. */
export function resetZoom() {
  declareFit(1);
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

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * Every canvas mode a pane can render, in the order the mode switcher lists them.
 *
 * `"preview"` is in the set even though it is not a base mode: `getCanvasMode()` composes the
 * per-tab `ui.preview` flag with an `edit`/`design` base and presents "preview" to every downstream
 * gate, and `tab.capabilities.modes` lists it exactly the same way. A caller naming a mode is
 * naming the mode it will observe, so the enum is the observable set, not the storage set.
 */
export const CANVAS_MODES = [
  "edit",
  "design",
  "preview",
  "source",
  "stylebook",
  "grid",
  "git-diff",
] as const;

export type CanvasMode = (typeof CANVAS_MODES)[number];

/** The base modes the preview flag composes with — the two the Canvas view axis shows it beside. */
const PREVIEWABLE_BASE_MODES = new Set(["edit", "design"]);

// ─── §4.2 axis 2 — the Canvas view ───────────────────────────────────────────
// `Edit │ Design │ Preview` is ONE control with three VALUES, not two base modes plus a toggle on a
// Different bar. The composition rule below is the whole reason it can be: `preview` was never a
// Base mode — it is a flag that composes with one — so a switcher that showed "Design" selected
// While the pane was previewing was reporting a state the app was not in (§4.4).

/** The three values of the Canvas view axis, in the order the segmented control lists them. */
export const CANVAS_VIEWS = ["edit", "design", "preview"] as const;

export type CanvasView = (typeof CANVAS_VIEWS)[number];

/** A tab's view state, as the axis reads it — its base mode and whether preview composes over it. */
interface ViewableTab {
  capabilities: { modes: string[] };
  session: { ui: { canvasMode: string; preview?: boolean } };
}

/**
 * The view this pane is in, or `null` when its editor is not the Canvas at all.
 *
 * The EFFECTIVE view, so the control can never disagree with the canvas: previewing over an `edit`
 * base reads `"preview"`, not `"edit"`.
 */
export function canvasViewOf(tab: ViewableTab): CanvasView | null {
  const base = tab.session.ui.canvasMode;
  if (!PREVIEWABLE_BASE_MODES.has(base)) {
    return null;
  }
  return tab.session.ui.preview === true ? "preview" : (base as CanvasView);
}

/**
 * The views this document supports, in axis order — the control's entries.
 *
 * Filtered by `capabilities.modes` for the same reason the editor-kind dropdown is (§4.2): a
 * permanently dead segment is a question the app refuses to answer.
 */
export function canvasViewsFor(tab: ViewableTab): CanvasView[] {
  return CANVAS_VIEWS.filter((value) => tab.capabilities.modes.includes(value));
}

/**
 * Move a pane onto one of the three views. The one writer the segmented control routes through.
 *
 * Idempotent in both directions, which is what `canvas.togglePreview` could not be: arriving at
 * Edit or Design clears the preview flag, so "Design" means Design from any starting state.
 *
 * @param tab The pane's tab.
 * @param value The view to land on.
 * @param setCanvasMode Writes the BASE mode — `studio.ts`'s own, injected because this module does
 *   not own the canvas render loop.
 */
export function setCanvasView(
  tab: ViewableTab,
  value: CanvasView,
  setCanvasMode: (mode: string) => void,
): void {
  if (value === "preview") {
    if (PREVIEWABLE_BASE_MODES.has(tab.session.ui.canvasMode)) {
      tab.session.ui.preview = true;
    }
    return;
  }
  tab.session.ui.preview = false;
  if (tab.session.ui.canvasMode !== value) {
    setCanvasMode(value);
  }
}

/** What the canvas view verbs need that this module does not own. */
export interface CanvasCommandDeps {
  /** The effective mode, `ui.preview` already composed in — `studio.ts`'s `getCanvasMode`. */
  getCanvasMode: () => string;
  /** Write the BASE mode (`ui.canvasMode`) — `studio.ts`'s `setCanvasMode`. */
  setCanvasMode: (mode: string) => void;
}

/** A document is open in a pane — every verb here writes that pane's own view state. */
const documentOpen = (ctx: { document: { open: boolean } }) => ctx.document.open;

/**
 * The canvas view verbs — `setMode`, `setZoom`, `setEditZoom`.
 *
 * **These are the setters that retire `canvas.togglePreview`** (plan §13.3 clause 3). A toggle
 * cannot say which state it ends in, so six screenshots taken through it photographed whichever way
 * the default happened to point that week; `canvas.setMode { mode: "preview" }` means the same
 * thing twice in a row and from any starting state.
 *
 * Three refusals, each a wrong picture that used to be accepted silently:
 *
 * - A mode the open document cannot render (`tab.capabilities.modes`) — a `.csv` has no `design`.
 * - `"preview"` over a base mode it does not compose with — `ui.preview` is ignored in `source`, so
 *   setting it there would report a state the app is not in.
 * - A zoom outside the supported range, which the interactive controls clamp and a caller may not.
 *
 * @param {CanvasCommandDeps} deps
 * @returns {AnyCommand[]}
 */
export function canvasViewCommands(deps: CanvasCommandDeps): AnyCommand[] {
  /** The open tab, or a refusal naming why there is nothing to act on. */
  function requireTab(commandId: string) {
    const tab = activeTab.value;
    if (!tab) {
      throw new RangeError(`command "${commandId}" needs an open document; no tab is active`);
    }
    return tab;
  }

  return [
    {
      args: argsSchema({
        mode: enumProperty(CANVAS_MODES, "The canvas mode to switch the active pane to."),
      }),
      category: "View",
      id: "canvas.setMode",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "an open document",
      when: documentOpen,
      aiTool: {
        description:
          "Switch the active pane's canvas to a mode: edit, design, preview, source, stylebook, " +
          "grid or git-diff. Fails when the open document does not support that mode.",
        name: "set_canvas_mode",
      },
      run: (_commandCtx, args) => {
        const mode = enumArg("canvas.setMode", args, "mode", CANVAS_MODES);
        const tab = requireTab("canvas.setMode");
        const { modes } = tab.capabilities;
        if (!modes.includes(mode)) {
          throw new RangeError(
            `command "canvas.setMode" argument "mode": "${mode}" is not a mode this document ` +
              `supports — it declares: ${modes.join(", ")}`,
          );
        }
        if (mode === "preview") {
          const base = tab.session.ui.canvasMode;
          if (!PREVIEWABLE_BASE_MODES.has(base)) {
            throw new RangeError(
              `command "canvas.setMode" argument "mode": "preview" composes with the edit and ` +
                `design base modes; this pane is in "${base}"`,
            );
          }
          tab.session.ui.preview = true;
          return;
        }
        // Idempotent in both directions: leaving preview is part of arriving anywhere else, so a
        // Shot that says "design" gets design whether or not the previous step turned preview on.
        tab.session.ui.preview = false;
        deps.setCanvasMode(mode);
      },
      title: "Set Canvas Mode",
    },
    {
      args: argsSchema({
        zoom: numberProperty("Pan-zoom scale, 1 = 100%.", {
          maximum: PAN_ZOOM_MAX,
          minimum: PAN_ZOOM_MIN,
        }),
      }),
      category: "View",
      id: "canvas.setZoom",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "a document on the pan-zoom surface",
      when: documentOpen,
      run: (_commandCtx, args) => {
        requireTab("canvas.setZoom");
        setUserZoom(boundedNumberArg("canvas.setZoom", args, "zoom", PAN_ZOOM_MIN, PAN_ZOOM_MAX));
      },
      title: "Set Zoom",
    },
    {
      args: argsSchema({
        fit: {
          description:
            'How the document is framed: "width" | "page" | "none", or a numeric pan-zoom scale.',
          oneOf: [
            { enum: [...FIT_WORDS], type: "string" },
            { maximum: PAN_ZOOM_MAX, minimum: PAN_ZOOM_MIN, type: "number" },
          ],
        },
      }),
      category: "View",
      id: "canvas.setFit",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "an open document",
      when: documentOpen,
      run: (_commandCtx, args) => {
        requireTab("canvas.setFit");
        setFit(fitArg("canvas.setFit", args, "fit"));
      },
      title: "Set Fit",
    },
    {
      args: argsSchema({
        zoom: numberProperty("Edit-mode content zoom, 1 = 100%.", {
          maximum: EDIT_ZOOM_MAX,
          minimum: EDIT_ZOOM_MIN,
        }),
      }),
      category: "View",
      id: "canvas.setEditZoom",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "a document in edit mode",
      when: documentOpen,
      enablement: () => deps.getCanvasMode() === "edit",
      run: (_commandCtx, args) => {
        requireTab("canvas.setEditZoom");
        setEditZoom(
          boundedNumberArg("canvas.setEditZoom", args, "zoom", EDIT_ZOOM_MIN, EDIT_ZOOM_MAX),
        );
      },
      title: "Set Edit Zoom",
    },
  ];
}

/**
 * Register the canvas view verbs. Called from the bootstrap, beside the transforms they drive.
 *
 * @param {CommandRegistry} registry
 * @param {CanvasCommandDeps} deps
 */
export function registerCanvasViewCommands(
  registry: CommandRegistry,
  deps: CanvasCommandDeps,
): void {
  registry.registerAll(canvasViewCommands(deps));
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
