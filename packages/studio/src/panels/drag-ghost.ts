/// <reference lib="dom" />
/**
 * Cross-frame drag GHOST (Phase 4c, commit 5). A single parent-realm `position:fixed` layer that
 * follows the raw pointer 1:1 during a canvas drag. It lives OUTSIDE the scaled `panzoom-wrap`
 * (D-3) — a sibling of `#canvas-wrap` on `<body>` — so it tracks `clientX`/`clientY` directly and
 * is NEVER subject to the canvas zoom transform (drawing it in the scaled overlay would shrink/grow
 * it with zoom). pragmatic's native drag image is suppressed per source via
 * `disableNativeDragPreview`, so this is the only drag affordance the user sees.
 *
 * One ghost is reused across drags + panels: {@link setDragGhost} shows it with a label and moves
 * it to a cursor; {@link clearDragGhost} hides it. The element is created lazily on first show so
 * the module has no import-time DOM side effect (and stays inert in tests until used).
 */

let ghostEl: HTMLElement | null = null;

/** Lazily create (once) the fixed ghost element appended to `<body>`. */
function ensureGhost(doc: Document): HTMLElement {
  if (ghostEl?.isConnected) {
    return ghostEl;
  }
  const el = doc.createElement("div");
  el.className = "jx-drag-ghost";
  // Fixed + non-interactive + above the canvas; offset slightly from the cursor so it doesn't sit
  // Under the pointer and block hit-testing visuals. Positioned via left/top on each move.
  el.style.cssText =
    "position:fixed;left:0;top:0;z-index:9999;pointer-events:none;display:none;" +
    "padding:2px 8px;border-radius:4px;font-size:12px;line-height:1.4;white-space:nowrap;" +
    "background:var(--accent,#3b82f6);color:var(--accent-fg,#fff);box-shadow:0 2px 8px rgba(0,0,0,0.25);" +
    "transform:translate(8px,8px)";
  doc.body.append(el);
  ghostEl = el;
  return el;
}

/**
 * Show the ghost with `label`, positioned at the raw pointer (`x`,`y` in parent-viewport px). Safe
 * to call every pointermove; reuses the one element.
 */
export function setDragGhost(label: string, x: number, y: number, doc: Document = document): void {
  const el = ensureGhost(doc);
  el.textContent = label;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.display = "block";
}

/** Move the ghost to a new pointer position without changing its label (no-op when hidden). */
export function moveDragGhost(x: number, y: number): void {
  if (!ghostEl || ghostEl.style.display === "none") {
    return;
  }
  ghostEl.style.left = `${x}px`;
  ghostEl.style.top = `${y}px`;
}

/** Hide the ghost (between drags). The element is retained for reuse. */
export function clearDragGhost(): void {
  if (ghostEl) {
    ghostEl.style.display = "none";
  }
}
