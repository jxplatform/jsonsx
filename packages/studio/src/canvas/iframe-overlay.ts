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

/** A floating overlay layer over the iframe that draws a selection box and a hover box. */
export interface OverlayLayer {
  /** Position the selection box (or hide it when `placement` is null). */
  setSelection: (placement: OverlayPlacement | null) => void;
  /** Position the hover box (or hide it when `placement` is null). */
  setHover: (placement: OverlayPlacement | null) => void;
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

  root.append(hoverBox, selectionBox);

  return {
    dispose: () => root.remove(),
    root,
    setHover: (placement) => place(hoverBox, placement),
    setSelection: (placement) => place(selectionBox, placement),
  };
}
