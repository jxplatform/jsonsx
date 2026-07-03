/// <reference lib="dom" />
/**
 * Geometry read funnel — the single place the studio reads element bounds and does point hit-tests.
 *
 * Centralizing these reads is a seam for the iframe-canvas migration: today every call delegates
 * straight to the DOM, but routing them through one module lets later phases redirect
 * CANVAS-element geometry to rects posted out of the iframe (which the parent can't measure
 * directly) without touching dozens of call sites. A test (`geometry.test.ts`) asserts no raw
 * `getBoundingClientRect`/`elementFromPoint`/`elementsFromPoint` calls exist elsewhere in `src`.
 */

/** Bounding rect of an element, in viewport coordinates. */
export function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

/**
 * Bounding rect of a Range, in viewport coordinates. Lives here (the one allowlisted home for
 * `getBoundingClientRect`) so the `geometry.test.ts` textual guard passes — the iframe-side
 * selection snapshot funnels its caret/selection geometry through this, never calling
 * `range.getBoundingClientRect()` directly.
 */
export function rectOfRange(r: Range): DOMRect {
  return r.getBoundingClientRect();
}

/** Topmost element at a viewport point, in `root` (defaults to the global document). */
export function elementAtPoint(
  x: number,
  y: number,
  root: Document | ShadowRoot = document,
): Element | null {
  return root.elementFromPoint(x, y);
}

/** All elements at a viewport point, front-to-back, in `root` (defaults to the global document). */
export function elementsAtPoint(
  x: number,
  y: number,
  root: Document | ShadowRoot = document,
): Element[] {
  return root.elementsFromPoint(x, y);
}
