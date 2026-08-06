/**
 * Virtual-window.ts — the windowing primitive behind every long Library layout.
 *
 * **Why this is the acceptance criterion and not a nicety.** The Manage view it replaces rendered
 * one card per file with no cap, and each Pages/Layouts/Components/Content card mounted a REAL
 * `@jxsuite/runtime` render of that document. Opening "All" on a 300-page project therefore built
 * 300 live documents, in one synchronous lit pass, and kept every one of them alive in an unbounded
 * `Map`. The window is what makes the cost proportional to the VIEWPORT instead of to the project.
 *
 * The maths is deliberately a pure function ({@link computeWindow}) rather than a class: it is the
 * part that has to be right, it is the part the perf test measures, and it needs no DOM to state.
 * {@link createVirtualWindow} is the thin observer that feeds it scroll positions.
 *
 * One primitive, four consumers inside the Library (Table rows, Cards, Media, Board columns), and
 * the same shape the Files tree and Outline tree want — the geometry never mentions what an item
 * IS.
 */

/// <reference lib="dom" />

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
  const { scroller, count, rowHeight, columns, onChange, overscanRows } = options;
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
      scrollTop: scroller.scrollTop,
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
