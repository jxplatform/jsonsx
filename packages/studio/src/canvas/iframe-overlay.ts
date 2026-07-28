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
  /**
   * Position the selection box (or hide it when `placement` is null). `label` shows a small badge
   * on the box (stylebook draws the selected tag, e.g. "<p>", via the legacy `.overlay-label` CSS);
   * omitted/null hides it.
   */
  setSelection: (placement: OverlayPlacement | null, label?: string | null) => void;
  /**
   * Draw remote collaborators' selection boxes (colored outline + name tag). Replaces the whole set
   * each call; pass [] to clear. Placements are overlay-local coords like setSelection's.
   */
  setPresence: (items: { placement: OverlayPlacement; color: string; label: string }[]) => void;
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
  /**
   * Position the clickable insertion "+" at `placement` (overlay-local coords, mapped via
   * {@link canvasRectToParent} at scale=1 like the drop indicator, D-2), centered on the anchor box
   * and tagged with `edge` (for the `[data-edge]` styling). Pass null to hide it. This is the ONE
   * element on the otherwise `pointer-events:none` overlay that captures pointer events, so the
   * author can actually click it; the caller wires its click/mouseenter/mouseleave via
   * {@link insertButton}.
   */
  setInsertZone: (placement: OverlayPlacement | null, edge?: InsertButtonEdge) => void;
  /**
   * Highlight the image an external file drop would REPLACE (flow 5). Distinct from
   * {@link setDropIndicator}, which shows where a new element would be inserted — the two answer
   * different questions ("this picture is about to change" vs. "the element lands here"), so a drop
   * shows exactly one of them. `placement` is overlay-local like the others; null hides it.
   */
  setReplaceTarget: (placement: OverlayPlacement | null) => void;
  /** The clickable "+" button, so the caller can attach click + hover (grace-timer) listeners. */
  readonly insertButton: HTMLButtonElement;
  /** The layer root element (caller appends it over the iframe). */
  readonly root: HTMLElement;
  /** Remove the layer from the DOM. */
  dispose: () => void;
}

/** The geometric side the insertion "+" anchors to (mirrors {@link InsertZone}'s `edge`). */
export type InsertButtonEdge = "top" | "bottom" | "left" | "right" | "center";

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

  const selectionLabel = doc.createElement("div");
  selectionLabel.className = "overlay-label";
  selectionLabel.style.display = "none";
  selectionBox.append(selectionLabel);

  const hoverBox = doc.createElement("div");
  hoverBox.className = "overlay-box overlay-hover";
  hoverBox.style.display = "none";

  // Reuses the legacy `.canvas-drop-indicator` CSS (`.line` = thin bar, `.inside` = dashed box).
  const dropBox = doc.createElement("div");
  dropBox.className = "canvas-drop-indicator";
  dropBox.style.display = "none";

  // The clickable insertion "+" — reuses the legacy `.insertion-helper` circle styling. It is the
  // ONE element on the `pointer-events:none` overlay that re-enables pointer events, so the author
  // Can click it (the legacy CSS-anchor positioning rules are inert here — no `position-anchor` is
  // Set — so it is positioned explicitly via left/top by placeInsertButton).
  const insertButton = doc.createElement("button");
  insertButton.className = "insertion-helper";
  insertButton.textContent = "+";
  insertButton.style.pointerEvents = "auto";
  insertButton.style.display = "none";

  // The "this picture will be replaced" highlight for an external file drop.
  const replaceBox = doc.createElement("div");
  replaceBox.className = "canvas-replace-target";
  replaceBox.style.display = "none";

  // Remote collaborators' selection boxes live in their own container, replaced wholesale.
  const presenceGroup = doc.createElement("div");
  presenceGroup.className = "overlay-presence-group";

  root.append(hoverBox, selectionBox, dropBox, replaceBox, insertButton, presenceGroup);

  return {
    dispose: () => root.remove(),
    insertButton,
    root,
    setDropIndicator: (placement, edge = "inside") => placeDropIndicator(dropBox, placement, edge),
    setHover: (placement) => place(hoverBox, placement),
    setInsertZone: (placement, edge = "center") => placeInsertButton(insertButton, placement, edge),
    setReplaceTarget: (placement) => place(replaceBox, placement),
    setPresence: (items) => {
      presenceGroup.replaceChildren();
      for (const item of items) {
        const box = doc.createElement("div");
        box.className = "overlay-box overlay-presence";
        box.style.cssText =
          `position:absolute;display:block;pointer-events:none;` +
          `outline:1.5px solid ${item.color};outline-offset:1px;` +
          `left:${item.placement.left}px;top:${item.placement.top}px;` +
          `width:${item.placement.width}px;height:${item.placement.height}px`;
        const tag = doc.createElement("div");
        tag.className = "overlay-presence-tag";
        tag.textContent = item.label;
        tag.style.cssText =
          `position:absolute;top:-18px;left:-2px;padding:1px 5px;border-radius:3px;` +
          `font:10px/1.4 sans-serif;color:#fff;white-space:nowrap;background:${item.color}`;
        box.append(tag);
        presenceGroup.append(box);
      }
    },
    setSelection: (placement, label = null) => {
      place(selectionBox, placement);
      if (placement && label) {
        selectionLabel.textContent = label;
        selectionLabel.style.display = "block";
      } else {
        selectionLabel.style.display = "none";
      }
    },
  };
}

/**
 * Position the insertion "+" centered on the anchor `placement` (a zero-thickness edge box from the
 * iframe), or hide it when null. Sets `data-edge` for the `[data-edge]` styling and toggles the
 * `visible` class the legacy CSS uses (display + opacity). Explicit left/top centering replaces the
 * legacy CSS-anchor positioning, which can't reach across the iframe boundary.
 */
function placeInsertButton(
  btn: HTMLButtonElement,
  placement: OverlayPlacement | null,
  edge: InsertButtonEdge,
): void {
  if (!placement) {
    btn.style.display = "none";
    btn.classList.remove("visible");
    return;
  }
  btn.dataset.edge = edge;
  btn.classList.add("visible");
  // Center the 20×20 circle on the anchor box's midpoint (the edge for a zero-thickness box).
  btn.style.display = "grid";
  btn.style.left = `${placement.left + placement.width / 2}px`;
  btn.style.top = `${placement.top + placement.height / 2}px`;
  btn.style.translate = "-50% -50%";
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
