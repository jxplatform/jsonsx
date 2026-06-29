/// <reference lib="dom" />
/**
 * Parent-side canvas overlay layer for the iframe host. Because the cross-origin bridge forbids the
 * parent from reading the iframe's DOM, selection/hover boxes are drawn from rects the iframe posts
 * back (see {@link measureHits}/`hover`). This module owns the pure rect→overlay math ({@link
 * canvasRectToParent}) and a small DOM layer that floats above the iframe, reusing the same
 * `overlay-box`/`overlay-selection`/`overlay-hover` classes as the legacy canvas for visual
 * parity.
 */

import type { SerializableRect } from "./iframe-protocol";

/** An overlay box position in the parent overlay layer's local coordinates. */
export interface OverlayPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Map a rect measured in the iframe's own viewport to the parent overlay layer's coordinates. The
 * overlay layer is positioned exactly over the iframe (same top-left), so the only transform is the
 * zoom `scale` (applied as a CSS `transform: scale()` on the iframe element, hence a plain multiply
 * here). Kept pure so the zoom math is unit-tested independently of the DOM.
 */
export function canvasRectToParent(rect: SerializableRect, scale = 1): OverlayPlacement {
  return {
    height: rect.height * scale,
    left: rect.x * scale,
    top: rect.y * scale,
    width: rect.width * scale,
  };
}

/**
 * Map a parent-viewport cursor (e.g. a pragmatic `location.current.input`, in true post-transform
 * parent px) into the iframe's own viewport coordinates. The iframe + overlay are descendants of
 * the scaled `panzoom-wrap`, so the cursor must be DIVIDED by the zoom `scale` (the inverse of the
 * CSS `transform: scale()` the browser already applied). `iframeRect` is `rectOf(iframe)` (its GBCR
 * bakes in pan + scale, so subtracting its `left`/`top` cancels the pan offset). Pure, so the
 * sign/order of the transform is unit-tested independently of the DOM. Empirical `scale` is derived
 * by the caller as `rectOf(iframe).width / iframe.clientWidth` (NOT `effectiveZoom()` — a separate
 * path that can desync).
 */
export function parentCursorToIframe(
  cursor: { x: number; y: number },
  iframeRect: { left: number; top: number },
  scale = 1,
): { x: number; y: number } {
  return {
    x: (cursor.x - iframeRect.left) / scale,
    y: (cursor.y - iframeRect.top) / scale,
  };
}

/** The geometric side a drop indicator draws on (mirrors {@link DropPreview}'s `edge`). */
export type DropEdge = "top" | "bottom" | "inside";

/** A floating overlay layer over the iframe that draws a selection box and a hover box. */
export interface OverlayLayer {
  /** Position the selection box (or hide it when `placement` is null). */
  setSelection: (placement: OverlayPlacement | null) => void;
  /** Position the hover box (or hide it when `placement` is null). */
  setHover: (placement: OverlayPlacement | null) => void;
  /**
   * Draw the drop indicator for a drag-over (Phase 4c). `placement` is the reference node's rect in
   * overlay-local coords (the caller maps the iframe-space `referenceRect` via
   * {@link canvasRectToParent} at scale=1 — the overlay is INSIDE the scaled panzoom-wrap, so the
   * browser already scales it; multiplying by zoom would double-scale, D-2). `edge` "inside" → a
   * dashed box over the reference; "top"/"bottom" → a thin line at the reference's top/bottom edge.
   * Pass null to hide.
   */
  setDropIndicator: (placement: OverlayPlacement | null, edge?: DropEdge) => void;
  /** The layer root element (caller appends it over the iframe). */
  readonly root: HTMLElement;
  /** Remove the layer from the DOM. */
  dispose: () => void;
}

function place(box: HTMLElement, placement: OverlayPlacement | null): void {
  if (!placement) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.style.left = `${placement.left}px`;
  box.style.top = `${placement.top}px`;
  box.style.width = `${placement.width}px`;
  box.style.height = `${placement.height}px`;
}

/** Build (but do not mount) an overlay layer with hidden selection + hover boxes. */
export function createOverlayLayer(doc: Document = document): OverlayLayer {
  const root = doc.createElement("div");
  root.className = "jx-canvas-iframe-overlay";
  // Float over the iframe without intercepting pointer events (the iframe handles its own hit-test).
  root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2";

  const selectionBox = doc.createElement("div");
  selectionBox.className = "overlay-box overlay-selection";
  selectionBox.style.display = "none";

  const hoverBox = doc.createElement("div");
  hoverBox.className = "overlay-box overlay-hover";
  hoverBox.style.display = "none";

  // Reuses the legacy `.canvas-drop-indicator` CSS (`.line` = thin bar, `.inside` = dashed box).
  const dropBox = doc.createElement("div");
  dropBox.className = "canvas-drop-indicator";
  dropBox.style.display = "none";

  root.append(hoverBox, selectionBox, dropBox);

  return {
    dispose: () => root.remove(),
    root,
    setDropIndicator: (placement, edge = "inside") => placeDropIndicator(dropBox, placement, edge),
    setHover: (placement) => place(hoverBox, placement),
    setSelection: (placement) => place(selectionBox, placement),
  };
}

/**
 * Position the drop indicator box. `inside` → a dashed box over the reference rect; `top`/`bottom`
 * → a thin horizontal line at the reference's top/bottom (full reference width, zero-height bar).
 * The placement is already in overlay-local coords at scale=1 (D-2).
 */
function placeDropIndicator(
  box: HTMLElement,
  placement: OverlayPlacement | null,
  edge: DropEdge,
): void {
  if (!placement) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.style.left = `${placement.left}px`;
  box.style.width = `${placement.width}px`;
  if (edge === "inside") {
    box.className = "canvas-drop-indicator inside";
    box.style.top = `${placement.top}px`;
    box.style.height = `${placement.height}px`;
    return;
  }
  box.className = "canvas-drop-indicator line";
  box.style.height = "";
  box.style.top = `${edge === "top" ? placement.top : placement.top + placement.height}px`;
}
