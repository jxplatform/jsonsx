/**
 * Virtual-window.ts — the windowing primitive behind every long list in Studio.
 *
 * **Why this is the acceptance criterion and not a nicety.** The Manage view the Library replaces
 * rendered one card per file with no cap, and each Pages/Layouts/Components/Content card mounted a
 * REAL `@jxsuite/runtime` render of that document. Opening "All" on a 300-page project therefore
 * built 300 live documents, in one synchronous lit pass, and kept every one of them alive in an
 * unbounded `Map`. The window is what makes the cost proportional to the VIEWPORT instead of to the
 * project. The two trees pay a smaller version of the same bill — a 5 000-node page drew 5 000
 * rows, each an `sp-icon` custom element — and they now pay it through this file.
 *
 * **It lives in `ui/`, not in `browse/`.** P3 workstream 11 promised "one virtual-list primitive
 * behind the Files tree and the Outline tree, reused by the Library grid", and what shipped sat
 * inside the Library and was imported by the Library alone. A primitive two surfaces share cannot
 * live inside one of them: the next surface that needs it either reaches across a feature boundary
 * or writes a second copy, and a second copy is how "the tree renders every row" survived a phase
 * that had already solved it.
 *
 * The maths is deliberately a pure function ({@link computeWindow}) rather than a class: it is the
 * part that has to be right, it is the part the perf test measures, and it needs no DOM to state.
 * {@link createVirtualWindow} is the thin observer that feeds it scroll positions, and the
 * {@link nearestScroller} half below is the small amount of DOM a list that does NOT own its own
 * scrollbar needs — both trees scroll inside `#left-panel`, which also holds their toolbars.
 *
 * One primitive, three surfaces: the Library (Table rows, Cards, Media), the Files tree and the
 * Outline. The geometry never mentions what an item IS.
 */

/// <reference lib="dom" />

import { rectOf } from "../utils/geometry";

/** The measurement a window is computed from. Everything is in CSS pixels. */
export interface WindowSpec {
  /** How many items exist in total. */
  count: number;
  /** Height of one ROW. A grid row holds {@link WindowSpec.columns} items. */
  rowHeight: number;
  /** Items per row. 1 for a list. Clamped to at least 1. */
  columns?: number;
  /** The scroller's current `scrollTop`. */
  scrollTop: number;
  /** The scroller's visible height. */
  viewportHeight: number;
  /** Extra rows rendered above and below the viewport. Defaults to {@link DEFAULT_OVERSCAN_ROWS}. */
  overscanRows?: number;
}

/**
 * Which items to render, and how much empty space to reserve either side of them.
 *
 * `padTop`/`padBottom` are spacer heights rather than absolute positioning, so a windowed list is
 * still an ordinary flow container: it wraps, it prints, and a focused control inside it scrolls
 * into view without anything computing coordinates.
 */
export interface WindowRange {
  /** First item index, inclusive. */
  start: number;
  /** Last item index, EXCLUSIVE. */
  end: number;
  /** Pixels of spacer above the first rendered row. */
  padTop: number;
  /** Pixels of spacer below the last rendered row. */
  padBottom: number;
  /** Total rows the full list would occupy — what the scrollbar is sized from. */
  totalRows: number;
}

/**
 * Rows kept beyond each edge of the viewport.
 *
 * Three, not zero: a window with no overscan repaints on every scroll frame and shows a blank strip
 * for one frame at speed. Three is the smallest value at which neither is observable at a normal
 * wheel velocity, and it is small enough that the LRU preview cap still dominates.
 */
export const DEFAULT_OVERSCAN_ROWS = 3;

/** Clamp `value` into `[low, high]`. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The visible window for a spec.
 *
 * Total-safe by construction: a zero or negative `rowHeight` (an unmeasured container, a display:
 * none pane) yields the whole list rather than an infinite loop or an empty render, because a
 * Library that renders nothing is indistinguishable from a Library that found nothing — the exact
 * confusion this phase exists to remove.
 */
export function computeWindow(spec: WindowSpec): WindowRange {
  const count = Math.max(0, Math.trunc(spec.count));
  const columns = Math.max(1, Math.trunc(spec.columns ?? 1));
  const totalRows = Math.ceil(count / columns);

  if (!(spec.rowHeight > 0) || !(spec.viewportHeight > 0)) {
    return { end: count, padBottom: 0, padTop: 0, start: 0, totalRows };
  }

  const overscan = Math.max(0, Math.trunc(spec.overscanRows ?? DEFAULT_OVERSCAN_ROWS));
  const scrollTop = Math.max(0, spec.scrollTop);
  const firstVisibleRow = Math.floor(scrollTop / spec.rowHeight);
  const visibleRows = Math.ceil(spec.viewportHeight / spec.rowHeight) + 1;

  const startRow = clamp(firstVisibleRow - overscan, 0, totalRows);
  const endRow = clamp(firstVisibleRow + visibleRows + overscan, startRow, totalRows);

  return {
    end: Math.min(count, endRow * columns),
    padBottom: (totalRows - endRow) * spec.rowHeight,
    padTop: startRow * spec.rowHeight,
    start: Math.min(count, startRow * columns),
    totalRows,
  };
}

/** Two ranges are the same window — the guard that keeps scrolling from repainting every frame. */
export function sameWindow(a: WindowRange, b: WindowRange): boolean {
  return a.start === b.start && a.end === b.end && a.totalRows === b.totalRows;
}

// ─── The observer ────────────────────────────────────────────────────────────

export interface VirtualWindow {
  /** The current range. Read during render; never stale by more than one frame. */
  range: () => WindowRange;
  /** Re-measure and recompute (count changed, layout changed, container resized). */
  measure: () => void;
  /** Stop listening. Idempotent. */
  destroy: () => void;
}

export interface VirtualWindowOptions {
  /** The element that scrolls. */
  scroller: HTMLElement;
  /**
   * The list inside `scroller`, when the scroller carries more than the list.
   *
   * Both trees scroll inside `#left-panel`, which also holds a project header, a toolbar and — for
   * the Files tree — a search field. Their first row is therefore NOT at `scrollTop` 0, and a
   * window computed from the scroller's own `scrollTop` would be that header's height out from the
   * first scroll onwards. Omit it when the list IS the scroller (the Library's pane).
   */
  list?: HTMLElement;
  /** Item count right now — read on every measure, so it may change without re-creating. */
  count: () => number;
  /** Row height right now. */
  rowHeight: () => number;
  /** Items per row right now. */
  columns?: () => number;
  /** Called only when the window actually CHANGED. */
  onChange: (range: WindowRange) => void;
  overscanRows?: number;
}

/**
 * Watch a scroller and report window changes.
 *
 * Scroll is listened to passively and answered synchronously: the range is cheap to compute and a
 * rAF hop would paint the spacer before the content one frame in three. `ResizeObserver` covers the
 * pane being resized; where the environment has none (happy-dom), `measure()` is the whole contract
 * and the caller drives it — which is also how the perf test drives it.
 */
export function createVirtualWindow(options: VirtualWindowOptions): VirtualWindow {
  const { scroller, list, count, rowHeight, columns, onChange, overscanRows } = options;
  let current: WindowRange = { end: 0, padBottom: 0, padTop: 0, start: 0, totalRows: 0 };
  let destroyed = false;

  function measure() {
    if (destroyed) {
      return;
    }
    const next = computeWindow({
      columns: columns?.() ?? 1,
      count: count(),
      overscanRows: overscanRows ?? DEFAULT_OVERSCAN_ROWS,
      rowHeight: rowHeight(),
      scrollTop: list ? listScrollTop(scroller, list) : scroller.scrollTop,
      viewportHeight: scroller.clientHeight,
    });
    const changed = !sameWindow(current, next);
    current = next;
    if (changed) {
      onChange(next);
    }
  }

  scroller.addEventListener("scroll", measure, { passive: true });

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => measure());
    resizeObserver.observe(scroller);
  }

  measure();

  return {
    destroy() {
      destroyed = true;
      scroller.removeEventListener("scroll", measure);
      resizeObserver?.disconnect();
      resizeObserver = null;
    },
    measure,
    range: () => current,
  };
}

// ─── A list that does not own its scrollbar ──────────────────────────────────

/**
 * The element that scrolls `el`, or null when nothing does.
 *
 * TWO conditions, and the second is the one that makes this honest. An element is the scroller only
 * if it both declares a scrolling overflow AND currently has something to scroll. `.file-tree`
 * declares `overflow-y: auto` (styles/panels.css) but is never given a height, so it grows with its
 * content and never scrolls — treating it as the scroller would read its full content height as the
 * VIEWPORT height and window nothing at all, silently. The `scrollHeight > clientHeight` test walks
 * past it to `#left-panel`, which is where both trees actually scroll.
 *
 * The same test is why a list whose content fits is never windowed: there is nothing to scroll, so
 * there is nothing to save, and the whole list renders exactly as it always did.
 */
export function nearestScroller(el: HTMLElement | null): HTMLElement | null {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    // Cheap test first: happy-dom performs no layout, so this is 0 > 0 for every element and no
    // Test ever pays for a `getComputedStyle` walk it cannot answer.
    if (node.scrollHeight <= node.clientHeight) {
      continue;
    }
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
      return node;
    }
  }
  return null;
}

/**
 * How far `list`'s first row has scrolled above the top of `scroller`'s viewport.
 *
 * Measured from the two rects rather than from `offsetTop`, because the chrome between them is not
 * a fixed height: the Files tree's toolbar and the project header are both conditional. When the
 * list IS the scroller there is no chrome and its own `scrollTop` is the answer.
 */
export function listScrollTop(scroller: HTMLElement, list: HTMLElement): number {
  if (scroller === list) {
    return Math.max(0, scroller.scrollTop);
  }
  return Math.max(0, rectOf(scroller).top - rectOf(list).top);
}

/**
 * The window for a list rendered inside whatever scrolls it — the trees' entry point.
 *
 * Answers "the whole list" for a list that has not been rendered yet, has been detached, or is not
 * inside anything that scrolls. That is not a fallback bolted on for tests: it is the FIRST paint
 * of every session (nothing can be measured before the rows exist), and it is every list short
 * enough to fit. Both must render everything, and both are what the trees did before they
 * windowed.
 */
export function listWindow(
  list: HTMLElement | null,
  spec: { count: number; rowHeight: number; columns?: number; overscanRows?: number },
): WindowRange {
  const scroller = list?.isConnected === true ? nearestScroller(list) : null;
  if (!scroller || !list) {
    const count = Math.max(0, Math.trunc(spec.count));
    return { end: count, padBottom: 0, padTop: 0, start: 0, totalRows: count };
  }
  return computeWindow({
    columns: spec.columns ?? 1,
    count: spec.count,
    ...(spec.overscanRows === undefined ? {} : { overscanRows: spec.overscanRows }),
    rowHeight: spec.rowHeight,
    scrollTop: listScrollTop(scroller, list),
    viewportHeight: scroller.clientHeight,
  });
}

/**
 * The `scrollTop` that brings row `index` into view, or null when it already is.
 *
 * `block: "nearest"` semantics, stated as arithmetic: a windowed list cannot delegate this to
 * `Element.scrollIntoView`, because the row it must reveal is precisely the one that has no
 * element. Pure, so the reveal rule is testable without a scroller.
 */
export function scrollTopToReveal(spec: {
  index: number;
  rowHeight: number;
  /** Where the list's first row sits in the scroller's CONTENT, not its viewport. */
  listOffset: number;
  scrollTop: number;
  viewportHeight: number;
}): number | null {
  const top = spec.listOffset + spec.index * spec.rowHeight;
  const bottom = top + spec.rowHeight;
  if (top < spec.scrollTop) {
    return Math.max(0, top);
  }
  if (bottom > spec.scrollTop + spec.viewportHeight) {
    return Math.max(0, bottom - spec.viewportHeight);
  }
  return null;
}

/**
 * Scroll `list` so that its row at `index` is inside the window on the next render.
 *
 * Returns whether anything moved. The re-render is deliberately NOT triggered here: assigning
 * `scrollTop` fires a `scroll` event, and the watch installed by {@link watchListWindow} is already
 * the one thing that decides when a scroll is worth a repaint. A caller that repainted as well
 * would paint twice for one keystroke.
 */
export function revealListRow(list: HTMLElement | null, index: number, rowHeight: number): boolean {
  const scroller = list?.isConnected === true ? nearestScroller(list) : null;
  if (!scroller || !list || index < 0 || !(rowHeight > 0)) {
    return false;
  }
  const { scrollTop } = scroller;
  const next = scrollTopToReveal({
    index,
    listOffset: scrollTop - listScrollTop(scroller, list),
    rowHeight,
    scrollTop,
    viewportHeight: scroller.clientHeight,
  });
  if (next === null) {
    return false;
  }
  scroller.scrollTop = next;
  return true;
}

/**
 * The height one row actually has, measured, with the stylesheet's declared height as the answer
 * until a row exists to measure.
 *
 * Both are needed. The DECLARED height (`styles/panels.css` gives `.layer-row` and
 * `.file-tree-item` a `block-size`) is what lets the FIRST render window anything at all, before
 * any row has been laid out. The MEASUREMENT is what stops that constant becoming a lie the day
 * someone changes the row's padding, a user zooms, or a locale's font raises the line box: a window
 * computed from a stale height does not fail loudly, it drifts, and the list quietly ends a few
 * rows short of its own scrollbar.
 */
export function measuredRowHeight(
  list: HTMLElement | null,
  selector: string,
  declared: number,
): number {
  const row = list?.querySelector<HTMLElement>(selector);
  return row && row.offsetHeight > 0 ? row.offsetHeight : declared;
}

/** A live scroll watch over one list element. Held at module scope by the surface that renders it. */
export interface ListWindowWatch {
  /** The list this watch is bound to. A different element means a different watch. */
  list: HTMLElement;
  /** The scroller it resolved to when it was bound. */
  scroller: HTMLElement;
  window: VirtualWindow;
}

/**
 * Bind — or keep — the scroll watch that repaints a windowed list.
 *
 * Called from the surface's `afterRender`, where the rows exist and the scroller can be resolved,
 * and handed back its own previous handle so re-binding is the exception rather than the rule: the
 * tree element survives every re-render (lit reuses it), so the steady state is "same list, same
 * scroller, nothing to do". A new element — the panel remounted, or moved dock — moves the
 * listener, and a list that no longer scrolls drops it.
 *
 * Returns the handle to keep, or null when nothing scrolls this list.
 */
export function watchListWindow(
  previous: ListWindowWatch | null,
  list: HTMLElement,
  spec: { count: () => number; rowHeight: () => number; onChange: () => void },
): ListWindowWatch | null {
  const scroller = nearestScroller(list);
  if (previous && previous.list === list && previous.scroller === scroller) {
    return previous;
  }
  previous?.window.destroy();
  if (!scroller) {
    return null;
  }
  return {
    list,
    scroller,
    window: createVirtualWindow({
      count: spec.count,
      list,
      onChange: () => spec.onChange(),
      rowHeight: spec.rowHeight,
      scroller,
    }),
  };
}
