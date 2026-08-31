/// <reference lib="dom" />
/**
 * Canvas panel utilities — extracted from studio.js (Phase 4l). Panzoom infrastructure: panel DOM
 * template creation, centering, transform application, zoom indicator, and fit-to-screen.
 */

import { html, nothing } from "lit-html";
import type { CanvasPanel, JsonValue } from "../types";
import { ref } from "lit-html/directives/ref.js";
import { classMap } from "lit-html/directives/class-map.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";

import { renderOnly } from "../store";
import {
  activeCanvasSurface,
  activeMediaOfPane,
  canvasModeOfPane,
  derivationOfPane,
  tabOfMountedPanel,
  tabOfPane,
} from "./canvas-surface";
import type { CanvasSurface } from "./canvas-surface";
import { activeTab, workspace } from "../workspace/workspace";
import { panelMediaToActiveMedia, panelOfSurface } from "./canvas-helpers";
import { rectOf } from "../utils/geometry";
import { EDIT_WIDTH_MIN, clearEditWidth, setEditWidth } from "./edit-width";
import { activeDocumentHasPopover, popoverPathFor } from "./popover-path";
import { getEffectiveLocales, getEffectiveMedia } from "../site-context";
import type { JxPath } from "../state";
import { dynamicRouteParams } from "../page-params";
import {
  argsSchema,
  booleanArg,
  booleanProperty,
  boundedNumberArg,
  enumArg,
  enumProperty,
  numberProperty,
  stringArg,
  stringProperty,
} from "../commands/command-args";
import type { TemplateResult } from "lit-html";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { CommandArgValues } from "../commands/command-args";
import type { Tab } from "../tabs/tab";

/*
 * There is no `initCanvasUtils`, and no `_ctx`.
 *
 * It injected three functions — `getCanvasMode`, `getZoom`, `setZoomDirect` — and all three were
 * spelled `activeTab.value`, which is the FOCUSED pane's tab. Every geometry function here already
 * takes a `CanvasSurface`, so the pan/zoom offsets and the pan-zoom wrap moved onto it while the
 * SCALE stayed behind the injection, and the two disagreed in four visible ways:
 *
 *   1 · the unfocused pane drew at the focused tab's scale — `scale(1)` for a document at 2×;
 *   2 · the side pane's `+` zoomed the PRIMARY's document, by a factor computed from the side's
 *       own zoom (`b.zoom * 1.2` written to `a`);
 *   3 · `getFit()` keyed on `activeTab`, so the unfocused pod reported the focused pane's fit;
 *   4 · the side pane entering Design ran `fitOnCanvasEntry` → `setZoomDirect(0.163)` and the
 *       PRIMARY snapped to 16%, because the other pane had fitted itself.
 *
 * `scripts/check-pane-singletons.ts` could not see any of it: it bans `view.<field>` by name and
 * the zoom was never on `view`. The rule it enforces is now the general one — per-stage state is
 * reached through a surface — and this module reads `activeTab` in exactly one place, the command
 * verbs, where "the active pane" is the whole meaning of the request.
 */

/** The tab a stage is showing. The one route from a surface to the state its geometry needs. */
function tabOfSurface(surface: CanvasSurface): Tab | null {
  return tabOfPane(surface.paneId);
}

/**
 * A stage's own pan-zoom scale. 1 when its pane shows nothing.
 *
 * **`session.ui.zoom` is per-TAB, and a LENS shares its tab with the pane beside it** — so under a
 * lens the two stages would zoom together, which is exactly what "the same page at another
 * breakpoint" must not do. The derivation carries the lens's own scale.
 */
function zoomOf(surface: CanvasSurface): number {
  const derived = derivationOfPane(surface.paneId);
  if (derived?.kind === "lens") {
    return derived.zoom;
  }
  return tabOfSurface(surface)?.session.ui.zoom ?? 1;
}

/**
 * A stage's own pan-zoom scale, for the CONTROL that reports it.
 *
 * The zoom pod printed `tab.session.ui.zoom`, which is the source pane's number under a lens — so a
 * breakpoint lens zoomed to 40% reported whatever the desktop pane was at, and its `-` divided the
 * wrong figure. Every zoom verb already takes a surface; the readout has to as well.
 */
export function stageZoom(surface: CanvasSurface = activeCanvasSurface()): number {
  return zoomOf(surface);
}

/** Write a stage's own pan-zoom scale. A no-op when its pane shows nothing. See {@link zoomOf}. */
function setZoomOf(surface: CanvasSurface, zoom: number): void {
  const derived = derivationOfPane(surface.paneId);
  if (derived?.kind === "lens") {
    derived.zoom = zoom;
    return;
  }
  const tab = tabOfSurface(surface);
  if (tab) {
    tab.session.ui.zoom = zoom;
  }
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
                  // The breakpoint belongs to the tab of the pane that MOUNTED this artboard — the
                  // Parent-side twin of the iframe's `hit` message, resolved the same way.
                  // `updateUi` writes to `activeTab`, which is the FOCUSED pane's tab, so clicking
                  // A header in an unfocused pane set another document's breakpoint and the Style
                  // Panel then edited a compound block the person never opened.
                  const tab = tabOfMountedPanel(panel);
                  if (tab) {
                    tab.session.ui.activeMedia = panelMediaToActiveMedia(mediaName);
                  }
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

/*
 * Every geometry function below takes its surface EXPLICITLY, and none of them defaults to
 * `activeCanvasSurface()`.
 *
 * A default is how one pane's fit lands on the other's transform: the fit that runs on a mode
 * transition, the observer that re-centres until content settles and the wheel that pans are all
 * scheduled from a render, and a render belongs to the pane it was scheduled for — which is the
 * focused pane only by coincidence. Every call site already holds a surface or a tab.
 */

/** Center a stage's content horizontally in its viewport, top-aligned vertically. */
export function centerCanvas(surface: CanvasSurface) {
  if (!surface.panzoomWrap) {
    return;
  }
  const wrapWidth = surface.wrap.clientWidth;
  const contentWidth = surface.panzoomWrap.scrollWidth;
  const zoom = zoomOf(surface);
  const scaledWidth = contentWidth * zoom;
  surface.panX = Math.max(16, (wrapWidth - scaledWidth) / 2);
  surface.panY = 0;
}

/**
 * Attach a ResizeObserver to view.panzoomWrap that re-centers until the user pans. Handles async
 * content (runtime rendering, data fetching) that changes layout after initial paint.
 */
export function observeCenterUntilStable(surface: CanvasSurface) {
  if (surface.centerObserver) {
    surface.centerObserver.disconnect();
    surface.centerObserver = null;
  }
  if (!surface.panzoomWrap) {
    return;
  }
  surface.needsCenter = true;
  surface.centerObserver = new ResizeObserver(() => {
    if (!surface.needsCenter) {
      surface.centerObserver?.disconnect();
      surface.centerObserver = null;
      return;
    }
    centerCanvas(surface);
    applyTransform(surface);
  });
  surface.centerObserver.observe(surface.panzoomWrap);
  centerCanvas(surface);
}

/** Apply the current zoom + pan transform to the panzoom wrapper. */
export function applyTransform(surface: CanvasSurface) {
  if (!surface.panzoomWrap) {
    return;
  }
  const zoom = zoomOf(surface);
  surface.panzoomWrap.style.transform = `translate(${surface.panX}px, ${surface.panY}px) scale(${zoom})`;
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
export function applyEditZoom(surface: CanvasSurface = activeCanvasSurface()) {
  // THIS pane's effective mode. It was the focused pane's, so a side pane in Edit was refused its
  // Own content zoom whenever the primary happened to be in Design.
  if (canvasModeOfPane(surface.paneId) !== "edit") {
    return;
  }
  const [panel] = surface.panels;
  if (!panel?.canvas || !panel.viewport) {
    return;
  }
  const canvasEl = panel.canvas;
  const iframe = canvasEl.querySelector("iframe");
  const editZoom = tabOfSurface(surface)?.session.ui.editZoom ?? 1;
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
    const column = surface.wrap.querySelector<HTMLElement>(".content-edit-column");
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

/**
 * Set a stage's edit zoom (clamped) and apply it synchronously.
 *
 * The SURFACE decides whose zoom this is, not the focus. Both this and {@link requestEditZoom}
 * opened `activeTab.value`, so the side pane's `+` and the wheel over the side pane's stage — which
 * had already resolved the right surface and the right tab — wrote the primary's `editZoom`.
 */
export function setEditZoom(zoom: number, surface: CanvasSurface = activeCanvasSurface()) {
  const tab = tabOfSurface(surface);
  if (!tab) {
    return;
  }
  tab.session.ui.editZoom = clampEditZoom(zoom);
  applyEditZoom(surface);
}

/**
 * One pending edit-zoom frame PER STAGE.
 *
 * A single `let _editZoomRaf` was a shared slot: a wheel burst over one pane suppressed the other
 * pane's coalesced reflow entirely, and the frame that did run applied whichever surface won the
 * race. Keyed by pane id, for the reason `canvas-render.ts` keys its own render frames that way.
 */
const _editZoomRafs = new Map<string, number>();

/**
 * Wheel-rate edit-zoom setter: the reactive `editZoom` write lands immediately (the zoom pod's
 * label tracks it), but the DOM work — an iframe width resize, i.e. a real reflow — is coalesced to
 * one `applyEditZoom()` per animation frame so a fast ctrl+scroll burst doesn't thrash layout.
 */
export function requestEditZoom(zoom: number, surface: CanvasSurface = activeCanvasSurface()) {
  const tab = tabOfSurface(surface);
  if (!tab) {
    return;
  }
  tab.session.ui.editZoom = clampEditZoom(zoom);
  if (_editZoomRafs.has(surface.paneId)) {
    return;
  }
  _editZoomRafs.set(
    surface.paneId,
    requestAnimationFrame(() => {
      _editZoomRafs.delete(surface.paneId);
      applyEditZoom(surface);
    }),
  );
}

/**
 * Compute and apply a geometric fit. Pure arithmetic — it declares nothing.
 *
 * `axis` is the fit's own meaning: `"page"` fits both axes (the whole artboard, in view), `"width"`
 * fits the horizontal axis and lets the page run off the bottom, which is what you want on a long
 * document you are about to scroll. `maxZoom` caps the result.
 */
function applyGeometricFit(surface: CanvasSurface, axis: "width" | "page", maxZoom: number): void {
  if (!surface.panzoomWrap) {
    return;
  }
  const wrapWidth = surface.wrap.clientWidth;
  const wrapHeight = surface.wrap.clientHeight;
  const gap = 24;
  const padding = 32;
  let totalPanelWidth = 0;
  const { panels } = surface;
  for (const p of panels) {
    totalPanelWidth += p._width || 800;
  }
  totalPanelWidth += gap * Math.max(0, panels.length - 1) + padding;

  const zoom = zoomOf(surface);
  const wrapRect = rectOf(surface.panzoomWrap);
  const unscaledHeight = wrapRect.height / zoom;
  const maxPanelHeight = unscaledHeight + padding;

  const fitZoomW = wrapWidth / totalPanelWidth;
  const fitZoomH = wrapHeight / maxPanelHeight;
  const wanted = axis === "width" ? fitZoomW : Math.min(fitZoomW, fitZoomH);
  const fitZoom = Math.min(maxZoom, Math.max(PAN_ZOOM_MIN, wanted));

  setZoomOf(surface, fitZoom);

  const scaledWidth = totalPanelWidth * fitZoom;
  const scaledHeight = maxPanelHeight * fitZoom;
  surface.panX = Math.max(0, (wrapWidth - scaledWidth) / 2);
  surface.panY = Math.max(0, (wrapHeight - scaledHeight) / 2);
  applyTransform(surface);
}

/**
 * Fit all panels within the viewport, and declare that as the document's fit.
 *
 * `maxZoom` caps the result. The Fit control passes the full {@link PAN_ZOOM_MAX} (asking to fit is
 * asking to magnify a small artboard too); the automatic fit on entering a panzoom mode passes 1,
 * because arriving at a document should never blow it up past life size.
 */
export function fitToScreen({
  maxZoom = PAN_ZOOM_MAX,
  surface = activeCanvasSurface(),
}: { maxZoom?: number; surface?: CanvasSurface } = {}) {
  // Declared before the guard: "frame the whole page" is a preference the author expressed, and it
  // Stays true whether or not there is a laid-out artboard to apply it to this instant.
  declareFit("page", surface);
  applyGeometricFit(surface, "page", maxZoom);
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

/**
 * The registry key for the document a STAGE is showing (null when its pane shows none).
 *
 * It read `activeTab`, which is why the unfocused pane's zoom pod reported the focused pane's fit —
 * and why "Fit page" chosen in one pane changed the label in the other.
 */
function fitKey(surface: CanvasSurface): string | null {
  const tab = tabOfSurface(surface);
  if (!tab) {
    return null;
  }
  /* A LENS shares the tab with the pane it derives from, so the tab alone stops being a key: the
     mobile lens and the desktop pane would declare ONE fit between them and re-frame each other on
     every mode transition. Same reason `zoomOf` reads the derivation. */
  const lens = derivationOfPane(surface.paneId)?.kind === "lens" ? `::${surface.paneId}` : "";
  return `${tab.id}::${tab.documentPath ?? ""}${lens}`;
}

/** Write a stage's document's fit without applying it — the internal half of {@link setFit}. */
function declareFit(fit: FitMode, surface: CanvasSurface): void {
  const key = fitKey(surface);
  if (key) {
    _fits.set(key, fit);
  }
}

/** A stage's declared fit, or {@link DEFAULT_FIT}. Readable by that pane's zoom control. */
export function getFit(surface: CanvasSurface = activeCanvasSurface()): FitMode {
  const key = fitKey(surface);
  return (key === null ? undefined : _fits.get(key)) ?? DEFAULT_FIT;
}

/** Whether a stage's document has declared a fit of its own. */
export function hasDeclaredFit(surface: CanvasSurface = activeCanvasSurface()): boolean {
  const key = fitKey(surface);
  return key !== null && _fits.has(key);
}

/** Drop every declared fit — a fresh session, and the tests. */
export function resetFits(): void {
  _fits.clear();
}

/** Honour a fit right now. Defaults to the STAGE's own declared one. */
export function applyFit(fit?: FitMode, surface: CanvasSurface = activeCanvasSurface()): void {
  /* Resolved in the body rather than as a parameter default: a default may only read parameters
     declared BEFORE it, and the fit belongs to the surface that comes after. Reading `getFit()`
     with no surface is exactly what made the default answer for the FOCUSED pane. */
  const chosen = fit ?? getFit(surface);
  if (chosen === "none") {
    applyTransform(surface);
    return;
  }
  if (typeof chosen === "number") {
    setZoomOf(surface, clampPanZoom(chosen));
    applyTransform(surface);
    return;
  }
  // Capped at life size: arriving at a document should never blow it up past 100%.
  applyGeometricFit(surface, chosen, 1);
}

/** Declare the active document's fit AND honour it. The one writer every control routes through. */
export function setFit(fit: FitMode, surface: CanvasSurface = activeCanvasSurface()): void {
  declareFit(fit, surface);
  applyFit(fit, surface);
}

/**
 * Record the active document's CURRENT pan-zoom as its declared fit.
 *
 * For the gesture paths that move the zoom themselves and then have to say so — ctrl+scroll writes
 * `ui.zoom` directly, pinch will too. An author-chosen zoom is a numeric fit, so re-entering the
 * mode restores it instead of re-framing over the top of it.
 */
export function markExplicitZoom(surface: CanvasSurface = activeCanvasSurface()): void {
  declareFit(clampPanZoom(zoomOf(surface)), surface);
}

/**
 * Set the active tab's pan-zoom on the author's behalf: clamped, declared as this document's fit,
 * and applied. Every author-facing pan-zoom control routes through here.
 */
export function setUserZoom(zoom: number, surface: CanvasSurface = activeCanvasSurface()): void {
  const tab = tabOfSurface(surface);
  if (!tab) {
    return;
  }
  // The fit is declared BEFORE the reactive write, not after: `ui.zoom` is tracked, effects run
  // Synchronously on assignment, and the zoom pod reads `getFit()` while it renders — so declaring
  // Second means the control repaints one interaction behind the state it is reporting.
  const next = clampPanZoom(zoom);
  declareFit(next, surface);
  setZoomOf(surface, next);
  applyTransform(surface);
}

/**
 * Honour the declared fit when a pane enters a panzoom mode (Design, Stylebook).
 *
 * Called on the mode transition only. At that point the panels exist with their declared widths but
 * the iframes have not painted, which is why the geometry is driven by the panel widths rather than
 * by anything measured from content.
 */
export function fitOnCanvasEntry(surface: CanvasSurface): void {
  /* An unmeasurable viewport would fit to the 5% floor, which is worse than the clipping this
     replaces. Leave the zoom alone.
     This guard is load-bearing rather than defensive now: a zoomed pane grid hides the other cell
     with `display:none`, so its stage really does measure zero — and unzooming re-fits for free
     through {@link observeCenterUntilStable}'s observer, which fires on the restored layout. */
  if (surface.wrap.clientWidth <= 0) {
    applyTransform(surface);
    return;
  }
  applyFit(getFit(surface), surface);
}

/** Reset zoom to 100% and re-center horizontally, declaring 100% as this document's fit. */
export function resetZoom(surface: CanvasSurface = activeCanvasSurface()) {
  declareFit(1, surface);
  if (!surface.panzoomWrap) {
    return;
  }
  setZoomOf(surface, 1);
  centerCanvas(surface);
  applyTransform(surface);
}

/**
 * How far, in parent-viewport px, the pane must move down-screen to centre `rect`.
 *
 * Both inputs are `getBoundingClientRect` space, which is also the space the canvas host answers in
 * (`iframe-host.ts`'s `pointForRect` composes the frame offset and the empirical scale before it
 * hands a rect back), so one arithmetic serves a rect measured from a parent DOM element and a rect
 * measured inside a canvas iframe alike.
 */
function centeringOffset(surface: CanvasSurface, rect: { top: number; height: number }): number {
  const wrapRect = rectOf(surface.wrap);
  const elCenterY = rect.top + rect.height / 2 - wrapRect.top;
  return wrapRect.height / 2 - elCenterY;
}

/**
 * The element a reveal actually MOVES, or `null` when the panzoom transform is the only mover.
 *
 * This is the whole Edit-vs-Design distinction, in one place. Design, Stylebook and git-diff render
 * a `.panzoom-wrap` and are moved by writing `view.panY`; **Edit renders no panzoom wrap at all** —
 * it is an ordinary scrolling column (`.content-edit-canvas`, the edit branch of `renderCanvas`),
 * and the only thing that brings a node below the fold into view there is its scroll container.
 *
 * Reading it off the stage's own active panel is what keeps the two callers from disagreeing. It is
 * the discriminator `_panToEl` has always used, and `renderCanvas` re-establishes it on every
 * render: a surface's `panels` is emptied and its panzoom wrap nulled before any branch runs, so
 * the panel that answers here is this mode's, never the last mode's.
 *
 * **It took its surface as a parameter only after the rule grew a second hop.** It was zero-arity
 * and called `getActivePanel()`, which is the FOCUSED pane's — so `revealBy(surface, …)` was handed
 * one stage and scrolled another's. Benign in the tree, because both callers happened to pass the
 * focused surface, and invisible to the one-hop rule for exactly the wrong reason: a forwarder
 * whose whole body is `getActivePanel()?.scrollContainer` launders a focus read behind a name.
 *
 * @param {CanvasSurface} surface
 * @returns {HTMLElement | null}
 */
export function revealScroller(surface: CanvasSurface): HTMLElement | null {
  return panelOfSurface(surface)?.scrollContainer ?? null;
}

/**
 * Move the pane by `offsetY`, on whichever surface this mode actually moves.
 *
 * `smooth` is the caller's intent, not a property of the surface: the Outline's jump-to-node is a
 * gesture an author watches, so it eases. The panzoom branch always eases — its 250ms tween is the
 * one {@link import("./iframe-host").revealCanvasPath} waits out frame by frame — but a scroll has
 * no such settle protocol, so an un-eased caller gets a scroll that is finished on return.
 */
function revealBy(surface: CanvasSurface, offsetY: number, smooth: boolean): void {
  const scroller = revealScroller(surface);
  if (!scroller) {
    animatePanBy(surface, offsetY);
    return;
  }
  const top = scroller.scrollTop - offsetY;
  if (smooth) {
    scroller.scrollTo({ behavior: "smooth", top });
    return;
  }
  // No clamp: the browser clamps `scrollTop` into `[0, scrollHeight - clientHeight]` itself, and
  // Clamping here would only make a unit test agree with arithmetic the DOM never performs.
  scroller.scrollTop = top;
}

/**
 * Centre a PARENT-VIEWPORT rect in the pane — for callers whose target lives inside an iframe (no
 * parent DOM element to measure; the host converts the measured iframe rect and passes it here).
 *
 * Was `animatePanBy` unconditionally, which made it a NO-OP on the Edit surface: `view.panY` only
 * reaches the screen through a `.panzoom-wrap` transform, and Edit has none — so `revealCanvasPath`
 * reported a node's unchanged off-screen point and the click that followed selected nothing.
 */
export function panToParentRect(
  rect: { top: number; height: number },
  surface: CanvasSurface = activeCanvasSurface(),
) {
  revealBy(surface, centeringOffset(surface, rect), false);
}

/** Animate a stage's `panY` by `offsetY` with the shared 250ms ease-out. */
function animatePanBy(surface: CanvasSurface, offsetY: number) {
  const startY = surface.panY;
  const targetY = startY + offsetY;
  const start = performance.now();
  const duration = 250;
  const step = (now: number) => {
    const t = Math.min((now - start) / duration, 1);
    const ease = t * (2 - t);
    surface.panY = startY + (targetY - startY) * ease;
    applyTransform(surface);
    if (t < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
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
// `Edit │ Design` is a radio and `Preview` is a TOGGLE beside it, because that is what the storage
// Has always been: `preview` is not a base mode, it is a flag that composes with one.
//
// This was argued the other way, and the argument is worth keeping because it is half right. One
// Three-value control, it said, because a switcher showing "Design" selected while the pane was
// Previewing reports a state the app is not in. But the app IS in Design — with preview composed
// Over it — and a three-value radio could only ever show one of the two facts. It picked the
// Composed one and hid the base, so while previewing nothing said what you were previewing or what
// Leaving would return you to. A pressed toggle beside a marked radio shows both, which is the
// State, and neither half is silent.

/**
 * Every value of the Canvas view axis. `preview` composes with the other two rather than replacing
 * them.
 */
export const CANVAS_VIEWS = ["edit", "design", "preview"] as const;

export type CanvasView = (typeof CANVAS_VIEWS)[number];

/** A tab's view state, as the axis reads it — its base mode and whether preview composes over it. */
interface ViewableTab {
  capabilities: { modes: string[] };
  session: { ui: { canvasMode: string; preview?: boolean } };
}

/*
 * `canvasViewOf` lived here: it collapsed the base and the preview flag into ONE effective view, so
 * a three-value radio could mark exactly one of Edit/Design/Preview. Splitting that radio into a
 * two-value base plus a preview toggle took its last caller — the two halves are read separately
 * now, by `canvasBaseViewOf` and `previewStateOf` below. `canvasModeOfPane` still composes the two
 * for the RENDERER, which does want one answer.
 */

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
 * The BASE views a document supports — the radio's entries. Preview is not among them.
 *
 * Preview was the third value of a three-way radio, which made it read as a mode you leave Design
 * to enter: while previewing, the control could not tell you which mode you would come back to. It
 * has always been stored as a per-tab flag over an edit/design base, so the radio was describing
 * the storage inaccurately. Split so the two axes are drawn as what they are.
 */
export function canvasBaseViewsFor(tab: ViewableTab): CanvasView[] {
  return canvasViewsFor(tab).filter((value) => value !== "preview");
}

/** The base view the tab returns to — what the radio marks while preview is on. */
export function canvasBaseViewOf(tab: ViewableTab): CanvasView | null {
  const base = tab.session.ui.canvasMode;
  return PREVIEWABLE_BASE_MODES.has(base) ? (base as CanvasView) : null;
}

/**
 * Whether this document can be previewed at all, and whether it is being.
 *
 * `available` is a fact about the DOCUMENT (its declared modes) and about the base it is currently
 * in — `source` composes with no preview, so the toggle is not offered there.
 */
export function previewStateOf(tab: ViewableTab): { available: boolean; on: boolean } {
  return {
    available:
      tab.capabilities.modes.includes("preview") &&
      PREVIEWABLE_BASE_MODES.has(tab.session.ui.canvasMode),
    on: tab.session.ui.preview === true,
  };
}

/**
 * Move a pane onto one of the three views. The one writer the segmented control routes through.
 *
 * Idempotent in both directions, which is what `canvas.togglePreview` could not be: arriving at
 * Edit or Design clears the preview flag, so "Design" means Design from any starting state.
 *
 * @param tab The pane's tab.
 * @param value The view to land on.
 * @param setCanvasMode Writes the BASE mode of the tab it is GIVEN — `studio.ts`'s own, injected
 *   because this module does not own the canvas render loop. It took only a mode, which is how the
 *   side pane's `Edit │ Design │ Preview` control cleared its own tab's preview flag and then moved
 *   the FOCUSED pane's tab to `design`.
 */
export function setCanvasView<T extends ViewableTab>(
  tab: T,
  value: CanvasView,
  setCanvasMode: (tab: T, mode: string) => void,
): void {
  if (value === "preview") {
    if (PREVIEWABLE_BASE_MODES.has(tab.session.ui.canvasMode)) {
      tab.session.ui.preview = true;
    }
    return;
  }
  tab.session.ui.preview = false;
  if (tab.session.ui.canvasMode !== value) {
    setCanvasMode(tab, value);
  }
}

/** What the canvas view verbs need that this module does not own. */

export interface CanvasCommandDeps {
  /** The effective mode, `ui.preview` already composed in — `studio.ts`'s `getCanvasMode`. */
  getCanvasMode: () => string;
  /** Write the BASE mode (`ui.canvasMode`) of the tab it is given — `studio.ts`'s `setCanvasMode`. */
  setCanvasMode: (tab: Tab | null, mode: string) => void;
  /** Open or close a pane's resolving-with popover — `pane-context.ts`'s `setResolvingOpen`. */
  setResolvingOpen: (paneId: string, open: boolean) => void;
  /**
   * Repaint ONE pane's stage — `studio.ts`'s `renderCanvas`, taking the pane.
   *
   * Injected rather than imported: `canvas-render.ts` imports this module, so reaching back for
   * `renderCanvas` would close a cycle. It takes the pane id because the rendering-context verbs
   * do: `renderOnly("canvas")` resolves the FOCUSED pane, so the side bar's size switcher wrote the
   * side pane's tab and repainted the primary, leaving the stage it changed showing the old width.
   */
  renderPane: (paneId: string) => void;
  /**
   * Write a tab's open popover and tell its frames — `canvas/popover-state.ts`'s `setOpenPopover`.
   *
   * Injected for the same reason `renderPane` is: that module imports `iframe-host`, which imports
   * this one, so reaching for it directly would close a cycle.
   */
  setOpenPopover: (tab: Tab, path: JxPath | null) => void;
}

/** A document is open in a pane — every verb here writes that pane's own view state. */
/* The pan-zoom surface, as one set rather than three spellings of it.
   `canvas.setZoom` and `canvas.setFit` used to gate on `document.open` alone while their peers
   `canvas.zoomIn`/`zoomOut`/`zoomReset` gate on `document.open && editor.kind === "canvas"` — so
   driving Studio with a Library pane focused, `setZoom` and `setFit` both SUCCEEDED and wrote a
   zoom the surface they name was not showing, in the same state where the three verbs that mean
   the same thing refused with "requires an open document". `pane-context.ts`'s zoom pod already
   draws itself for exactly these three modes; this is that rule, written once. */
const PANZOOM_MODES = new Set(["design", "stylebook", "git-diff"]);

const documentOpen = (ctx: { document: { open: boolean } }) => ctx.document.open;

/** The three values `session.ui.previewColorScheme` may hold (spec §9.5). */
const COLOR_SCHEMES = ["auto", "light", "dark"] as const;

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

  /**
   * The tab a rendering-context verb addresses: the named pane's, or the focused one's.
   *
   * The bar is drawn once PER PANE (§18), and the side pane's controls have always written the side
   * pane's tab — so a verb that could only reach the focused one would be a narrower capability
   * than the control it replaced, which is the opposite of the point.
   */
  function contextTab(commandId: string, args: CommandArgValues) {
    const { pane } = args as { pane?: unknown };
    if (pane === undefined) {
      return requireTab(commandId);
    }
    const paneId = stringArg(commandId, args, "pane");
    const tab = tabOfPane(paneId);
    if (!tab) {
      throw new RangeError(
        `command "${commandId}" argument "pane": "${paneId}" has no open document`,
      );
    }
    return tab;
  }

  /** The optional pane selector every rendering-context verb accepts. */
  const paneArg = {
    pane: stringProperty("Which pane to render this way. Defaults to the focused one."),
  };

  /**
   * Repaint the pane a rendering-context verb just wrote — not the focused one.
   *
   * `renderOnly("canvas")` calls `renderCanvas()` with no pane, which resolves the FOCUSED one.
   * These verbs take a `pane` precisely because the side bar addresses the side pane, so the two
   * resolutions disagree exactly when it matters.
   */
  function repaint(args: CommandArgValues): void {
    deps.renderPane(paneOfArgs(args));
  }

  /** The pane a rendering-context verb addresses, named or focused. {@link repaint}'s own rule. */
  function paneOfArgs(args: CommandArgValues): string {
    const { pane } = args as { pane?: unknown };
    return typeof pane === "string" ? pane : workspace.activePaneId;
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
        /* There is no second refusal here. The pane used to be asked too — the side pane hosted
           Code, Diff, Config, Entry, Grid and Library only, so a Canvas mode was refused by
           NAME with a sentence telling you to unsplit first. Both panes draw a live Canvas now
           (`panels/pane-grid.ts`), so the document's own declared modes are the whole answer. */
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
        // The tab `requireTab()` already resolved, not "whatever is focused when the write lands".
        deps.setCanvasMode(tab, mode);
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
      enablement: () => PANZOOM_MODES.has(deps.getCanvasMode()),
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
      // The sentence has to match the gate, or the refusal teaches the wrong thing.
      requires: "a document on the pan-zoom surface",
      when: documentOpen,
      enablement: () => PANZOOM_MODES.has(deps.getCanvasMode()),
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
    {
      args: {
        additionalProperties: false,
        properties: {
          ...paneArg,
          width: {
            description:
              "How wide the Edit column should render, in CSS pixels, or null to go back to the " +
              "chosen breakpoint's own width.",
            type: ["number", "null"],
          },
        },
        required: ["width"],
        type: "object",
      },
      category: "View",
      id: "canvas.setEditWidth",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "a document in edit mode",
      when: documentOpen,
      enablement: () => deps.getCanvasMode() === "edit",
      /*
       * The addressable form of the drag (`canvas/edit-width-drag.ts`).
       *
       * The gesture does NOT come through here — it writes the store directly, once per pointermove,
       * because this verb ends in `repaint`, and a full canvas pass per move would rebuild the
       * iframe and break the handle's own pointer capture along with it. That is the same division
       * `canvas.setEditZoom` already has with `requestEditZoom`: the command is the name, the
       * gesture is the hot path.
       *
       * A width WIDER than the pane is not refused. The column is `width: 100%` under a `max-width`,
       * so it simply renders at the pane's width — which is the same clamp the drag applies, arrived
       * at by CSS instead of by arithmetic. Refusing would make the verb depend on the window size.
       */
      run: (_commandCtx, args) => {
        const tab = contextTab("canvas.setEditWidth", args);
        const { width } = args as { width?: unknown };
        if (width === null) {
          clearEditWidth(paneOfArgs(args));
          repaint(args);
          return;
        }
        setEditWidth(
          paneOfArgs(args),
          tab,
          boundedNumberArg("canvas.setEditWidth", args, "width", EDIT_WIDTH_MIN, 10_000),
        );
        repaint(args);
      },
      title: "Set Edit Width",
    },
    /*
     * ── The rendering context (§4.2's control ③) ──────────────────────────────────────────────
     *
     * Three setters for the three axes the Context popover offers. The popover wrote
     * `session.ui.activeMedia` / `previewColorScheme` / `showLayout` through `updateUi` directly, so
     * none of them was a command: not in the palette, not scriptable, not addressable by the
     * assistant, and not bindable — in a design whose first principle is that a capability exists
     * as a `Command` record and every surface projects it.
     *
     * SETTERS, not cycles. §5.3's keymap declares `⌘⌥↑`/`⌘⌥↓` and `⌘⌥⇧S` to cycle the size and
     * scheme axes, and a chord carries no argument, so those chords need `next`/`prev` records of
     * their own — a delta each, which is what §13's R1 forbids a screenshot from naming. Naming the
     * state you end in works from every surface; the chords are a separate decision and are not
     * made here.
     */
    {
      args: {
        additionalProperties: false,
        properties: {
          ...paneArg,
          media: {
            description:
              "A breakpoint key the document renders under, or null for the base rendering.",
            type: ["string", "null"],
          },
        },
        required: ["media"],
        type: "object",
      },
      category: "View",
      id: "canvas.setBreakpoint",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "an open document",
      when: documentOpen,
      run: (_commandCtx, args) => {
        const tab = contextTab("canvas.setBreakpoint", args);
        const { media } = args as { media?: unknown };
        if (media !== null && typeof media !== "string") {
          throw new RangeError(
            `command "canvas.setBreakpoint" argument "media": expected a breakpoint key or null`,
          );
        }
        /* REFUSES a key the document cannot render under, rather than rendering at a breakpoint
           that does not exist — the rule `data.expandRow` applies to a state entry's name.
           `getEffectiveMedia` and not `document.$media`: the popover offers the SITE's breakpoints
           too, and a command that refused what the control offers would be worse than no command. */
        const declared = Object.keys(
          getEffectiveMedia(tab.doc.document?.$media as Record<string, string> | undefined),
        );
        if (media !== null && !declared.includes(media)) {
          throw new RangeError(
            `command "canvas.setBreakpoint" argument "media": "${media}" is not a breakpoint this ` +
              `document defines — it defines: ${declared.length > 0 ? declared.join(", ") : "nothing"}`,
          );
        }
        tab.session.ui.activeMedia = media;
        repaint(args);
      },
      title: "Set Breakpoint",
    },
    {
      args: argsSchema({
        ...paneArg,
        scheme: enumProperty(COLOR_SCHEMES, "Which color scheme the canvas renders in."),
      }),
      category: "View",
      id: "canvas.setColorScheme",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "an open document",
      when: documentOpen,
      run: (_commandCtx, args) => {
        const tab = contextTab("canvas.setColorScheme", args);
        tab.session.ui.previewColorScheme = enumArg(
          "canvas.setColorScheme",
          args,
          "scheme",
          COLOR_SCHEMES,
        ) as "auto" | "dark" | "light";
        repaint(args);
      },
      title: "Set Color Scheme",
    },
    /*
     * The language a pane RENDERS AS — and only that.
     *
     * Jx has no message catalogue: a translation is a different file in a different directory
     * (site-architecture §13.3), so "show this page in French" is a navigation and the locale
     * preset owns it. What is left over is genuinely a rendering context, and it is the half of
     * §13.4 the canvas can show today: the artboard root's `lang` and `dir`. That is why this is a
     * verb and not a label — an RTL locale mirrors the layout on screen. (§13.4's other half,
     * `$page.locale` in the rendered state, is injected by the compiler and not by the canvas's
     * `substitutePreviewParams`; previewing it is a separate change to the render path.)
     *
     * It lives in this file rather than in `i18n/i18n-commands.ts` because `contextTab`, `paneArg`
     * and `repaint` are local closures here, and every rendering-context verb needs all three: the
     * bar is drawn per pane, so a verb that could only reach the focused one would repaint the
     * wrong stage. `insert.data` sits outside its namespace's module for the same reason.
     */
    {
      args: argsSchema(
        {
          ...paneArg,
          locale: stringProperty("BCP 47 tag this pane renders as."),
        },
        ["locale"],
      ),
      category: "View",
      id: "i18n.switchLocale",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "an open document in a project that declares more than one locale",
      when: (ctx) => ctx.document.open && ctx.project.isMultilingual,
      run: (_commandCtx, args) => {
        const tab = contextTab("i18n.switchLocale", args);
        const locale = stringArg("i18n.switchLocale", args, "locale");
        /* Read at RUN time. `projectState` is replaced wholesale rather than mutated, so a value
           cached at module scope answers for whichever project was open when this file loaded. */
        const i18n = getEffectiveLocales();
        /* REFUSES a tag the project does not declare, rather than clamping to the default — the
           rule `canvas.setBreakpoint` applies to a breakpoint key. A locale is a URL prefix and an
           `hreflang` at the same time, so rendering "as" a language the site does not have would
           preview a page that cannot exist. */
        if (i18n === null || !i18n.locales.includes(locale)) {
          throw new RangeError(
            `command "i18n.switchLocale" argument "locale": "${locale}" is not a locale this ` +
              `project declares — it declares: ${i18n === null ? "nothing" : i18n.locales.join(", ")}`,
          );
        }
        tab.session.ui.previewLocale = locale;
        repaint(args);
      },
      title: "Set Rendering Language",
    },
    {
      args: argsSchema({
        ...paneArg,
        visible: booleanProperty("True to draw the page's layout elements, false to hide them."),
      }),
      category: "View",
      id: "canvas.setLayoutVisible",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "an open document",
      when: documentOpen,
      run: (_commandCtx, args) => {
        const tab = contextTab("canvas.setLayoutVisible", args);
        tab.session.ui.showLayout = booleanArg("canvas.setLayoutVisible", args, "visible");
        repaint(args);
      },
      title: "Show Layout Elements",
    },
    {
      /**
       * Draw a popover open on the canvas so it can be selected, edited and styled.
       *
       * ONE record covers open, close and switch. `open` defaults to true, and `open: false` with
       * no path closes whatever is open — because a `toggle` cannot say which state it ends in,
       * which `scripts/check-shot-contract.ts` rejects outright (`/\.toggle[A-Z]/`) and
       * `services/automation.ts` throws on. A documentation screenshot of an open popover is only
       * possible through an idempotent setter.
       *
       * A VIEW state: `undo: "none"`, because it writes `session.ui` and never the document.
       */
      args: argsSchema({
        ...paneArg,
        open: booleanProperty("True to draw the popover open, false to close it."),
        path: {
          description:
            "Document path of the popover. Defaults to the popover the selection is in or at.",
          items: { type: ["string", "number"] },
          type: "array",
        },
      }),
      category: "View",
      enablement: () => activeDocumentHasPopover(),
      group: "3_canvas",
      id: "canvas.setPopoverOpen",
      level: "document",
      menus: ["palette"],
      requires: "a popover in the open document",
      run: (_commandCtx, args) => {
        const tab = contextTab("canvas.setPopoverOpen", args);
        const raw = (args ?? {}) as { open?: unknown; path?: JxPath };
        const open =
          raw.open === undefined ? true : booleanArg("canvas.setPopoverOpen", args, "open");
        if (!open && raw.path === undefined) {
          deps.setOpenPopover(tab, null);
          return;
        }
        const path = popoverPathFor(tab, raw.path);
        /* REFUSES a path that is not a popover rather than opening nothing — the rule
           `canvas.setBreakpoint` applies to a breakpoint key. A <dialog> is refused with it: its UA
           rules key off `open`, not `popover`, so de-popovering one falls back to a different rule
           with a different name and the canvas would draw it wrong. */
        if (path === null) {
          throw new RangeError(
            'command "canvas.setPopoverOpen" argument "path": names no popover in this document — ' +
              "a popover is an element with a `popover` attribute, and <dialog> is not one",
          );
        }
        deps.setOpenPopover(tab, open ? path : null);
      },
      title: "Show Popover",
      when: documentOpen,
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          ...paneArg,
          open: {
            default: true,
            description: "True to open the resolving-with popover, false to close it.",
            type: "boolean",
          },
        },
        required: [],
        type: "object",
      },
      category: "View",
      id: "canvas.setResolvingOpen",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "an open document",
      when: documentOpen,
      /*
       * The route params and component test props live in a popover now, and a transient surface
       * opens by COMMAND rather than by clicking (plan §13.2) — otherwise the one shot that types a
       * test value would need a CSS selector to reach it, which §13's contract forbids outright.
       * The pointer and the camera use the same door.
       */
      run: (_commandCtx, args) => {
        // Resolve the tab first, so a pane with no document refuses before anything opens.
        contextTab("canvas.setResolvingOpen", args);
        const { open, pane } = args as { open?: unknown; pane?: unknown };
        // `open` defaults to true and is never COERCED: `{ open: "no" }` would otherwise read as a
        // Close, the class of silent wrong answer this setter family exists to stop.
        deps.setResolvingOpen(
          typeof pane === "string" ? pane : workspace.activePaneId,
          open === undefined || booleanArg("canvas.setResolvingOpen", args, "open"),
        );
      },
      title: "Show Resolving Values",
    },
    /*
     * ── The values a render resolves WITH ─────────────────────────────────────────────────────
     *
     * The two controls in that popover wrote `session.ui` through `updateUi` directly, while every
     * control in the rendering-context popover beside them runs a command — and `runContextCommand`
     * says why in as many words: "the popover WAS the capability, and the palette, the assistant and
     * `__jxAutomation` had no name for it." Moving these behind a click without naming them would
     * have reintroduced that, one layer deeper: a value you can now only reach by opening a popover
     * and typing.
     *
     * The screenshot budget agrees. `counter-test-prop` typed into `pane.primary/prop:count`; with
     * a verb it spends a `cmd` instead, so `inputSteps` falls 14 → 13 and the region leaves the
     * manifest, dropping `nonDerivedRegions` 11 → 10. Both budgets may only ratchet down, and this
     * ratchets both.
     */
    {
      args: {
        additionalProperties: false,
        properties: {
          ...paneArg,
          name: stringProperty("The prop's name, as the component's state declares it."),
          value: {
            description:
              "The test value — any JSON. Null clears it and the prop returns to its default.",
            type: ["string", "number", "boolean", "array", "object", "null"],
          },
        },
        required: ["name"],
        type: "object",
      },
      category: "View",
      id: "canvas.setTestProp",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "an open component document",
      when: documentOpen,
      run: (_commandCtx, args) => {
        const tab = contextTab("canvas.setTestProp", args);
        const name = stringArg("canvas.setTestProp", args, "name");
        // REFUSES a prop the component does not declare, rather than seeding a value nothing reads
        // — the rule `data.expandRow` and `canvas.setBreakpoint` both apply to their own names.
        const declared = Object.keys(
          (tab.doc.document?.state as Record<string, unknown> | undefined) ?? {},
        );
        if (!declared.includes(name)) {
          throw new RangeError(
            `command "canvas.setTestProp" argument "name": "${name}" is not a prop this component ` +
              `declares — it declares: ${declared.length > 0 ? declared.join(", ") : "nothing"}`,
          );
        }
        const { value } = args as { value?: unknown };
        const next = { ...tab.session.ui.previewProps };
        if (value === null || value === undefined) {
          delete next[name];
        } else {
          next[name] = value as JsonValue;
        }
        tab.session.ui.previewProps = Object.keys(next).length > 0 ? next : null;
        repaint(args);
      },
      title: "Set Test Value",
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          ...paneArg,
          name: stringProperty("The route parameter's name, without brackets."),
          value: stringProperty("The value to preview the route with. Empty clears it."),
        },
        required: ["name", "value"],
        type: "object",
      },
      category: "View",
      id: "canvas.setRouteParam",
      level: "document",
      menus: ["palette"],
      group: "3_canvas",
      requires: "an open page with a dynamic route",
      when: documentOpen,
      run: (_commandCtx, args) => {
        const tab = contextTab("canvas.setRouteParam", args);
        const name = stringArg("canvas.setRouteParam", args, "name");
        const declared = dynamicRouteParams(tab.documentPath);
        if (!declared.includes(name)) {
          throw new RangeError(
            `command "canvas.setRouteParam" argument "name": "${name}" is not a parameter of this ` +
              `route — it has: ${declared.length > 0 ? declared.join(", ") : "none"}`,
          );
        }
        tab.session.ui.previewParams = {
          ...tab.session.ui.previewParams,
          [name]: stringArg("canvas.setRouteParam", args, "value"),
        };
        repaint(args);
      },
      title: "Set Route Parameter",
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

/**
 * Toggle the "active" class on a stage's artboard headers, from that stage's own `activeMedia`.
 *
 * Surface-taking for the same reason everything else here is: the breakpoint a header reports is a
 * fact about the document that stage is drawing, and reading `activeTab` drew the focused pane's
 * breakpoint onto the other pane's artboards.
 */
export function updateActivePanelHeaders(surface: CanvasSurface = activeCanvasSurface()) {
  const activeMedia = activeMediaOfPane(surface.paneId);
  for (const p of surface.panels) {
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
