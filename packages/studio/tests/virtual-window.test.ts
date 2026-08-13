/**
 * Tests for src/ui/virtual-window.ts — the windowing primitive.
 *
 * The whole acceptance criterion of P7.1 reduces to one property, asserted here directly: the
 * number of items a window yields is a function of the VIEWPORT, not of the collection. Everything
 * else in this file is the degenerate cases that would otherwise render an empty Library and look
 * like a broken one.
 */
import { stubRect } from "./harness";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OVERSCAN_ROWS,
  computeWindow,
  createVirtualWindow,
  listScrollTop,
  listWindow,
  measuredRowHeight,
  nearestScroller,
  revealListRow,
  sameWindow,
  scrollTopToReveal,
  watchListWindow,
} from "../src/ui/virtual-window";

describe("computeWindow", () => {
  test("yields a slice proportional to the viewport, not to the collection", () => {
    const spec = { rowHeight: 32, scrollTop: 0, viewportHeight: 320 };
    const small = computeWindow({ ...spec, count: 50 });
    const huge = computeWindow({ ...spec, count: 50_000 });
    expect(huge.end - huge.start).toBe(small.end - small.start);
    // 320/32 = 10 visible rows, +1 partial, + overscan below (there is none above at scrollTop 0).
    expect(huge.end - huge.start).toBe(11 + DEFAULT_OVERSCAN_ROWS);
  });

  test("reserves the scroll height the unrendered rows would have occupied", () => {
    const range = computeWindow({
      count: 1000,
      rowHeight: 20,
      scrollTop: 2000,
      viewportHeight: 200,
    });
    const rendered = (range.end - range.start) * 20;
    expect(range.padTop + rendered + range.padBottom).toBe(1000 * 20);
  });

  test("counts rows, not items, when the layout flows into columns", () => {
    const range = computeWindow({
      columns: 4,
      count: 400,
      rowHeight: 100,
      scrollTop: 0,
      viewportHeight: 300,
    });
    expect(range.totalRows).toBe(100);
    expect(range.start).toBe(0);
    // 3 visible rows + 1 partial + overscan, times 4 columns.
    expect(range.end).toBe((4 + DEFAULT_OVERSCAN_ROWS) * 4);
  });

  test("overscans above once the list is scrolled", () => {
    const range = computeWindow({
      count: 1000,
      overscanRows: 2,
      rowHeight: 10,
      scrollTop: 500,
      viewportHeight: 100,
    });
    expect(range.start).toBe((50 - 2) * 1);
    expect(range.padTop).toBe(480);
  });

  test("never runs past the end of the collection", () => {
    const range = computeWindow({
      count: 12,
      rowHeight: 40,
      scrollTop: 10_000,
      viewportHeight: 400,
    });
    expect(range.end).toBe(12);
    expect(range.start).toBeLessThanOrEqual(12);
    expect(range.padBottom).toBe(0);
  });

  test("an unmeasured container renders EVERYTHING rather than nothing", () => {
    // A Library that renders nothing is indistinguishable from a Library that found nothing, so
    // A zero-height (display:none, not yet laid out) scroller must not window at all.
    const range = computeWindow({ count: 7, rowHeight: 0, scrollTop: 0, viewportHeight: 0 });
    expect(range).toEqual({ end: 7, padBottom: 0, padTop: 0, start: 0, totalRows: 7 });
  });

  test("an empty collection is an empty window, not a negative one", () => {
    const range = computeWindow({ count: 0, rowHeight: 32, scrollTop: 0, viewportHeight: 320 });
    expect(range).toEqual({ end: 0, padBottom: 0, padTop: 0, start: 0, totalRows: 0 });
  });

  test("clamps a nonsense scrollTop and a fractional count", () => {
    const range = computeWindow({
      count: 10.7,
      rowHeight: 10,
      scrollTop: -500,
      viewportHeight: 50,
    });
    expect(range.start).toBe(0);
    // 5 visible rows + 1 partial + 3 overscan = 9, out of the 10 whole items 10.7 truncates to.
    expect(range.end).toBe(9);
  });

  test("columns below one are treated as one", () => {
    const range = computeWindow({
      columns: 0,
      count: 5,
      rowHeight: 10,
      scrollTop: 0,
      viewportHeight: 100,
    });
    expect(range.totalRows).toBe(5);
  });
});

describe("sameWindow", () => {
  const base = { end: 10, padBottom: 4, padTop: 2, start: 0, totalRows: 30 };

  test("ignores padding, which changes with every pixel of scroll", () => {
    expect(sameWindow(base, { ...base, padBottom: 900, padTop: 900 })).toBe(true);
  });

  test("sees a changed slice", () => {
    expect(sameWindow(base, { ...base, start: 1 })).toBe(false);
    expect(sameWindow(base, { ...base, end: 11 })).toBe(false);
    expect(sameWindow(base, { ...base, totalRows: 31 })).toBe(false);
  });
});

describe("createVirtualWindow", () => {
  function scroller(height: number) {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: 800 });
    el.scrollTop = 0;
    return el;
  }

  test("reports the first window on creation", () => {
    const seen: number[][] = [];
    const el = scroller(100);
    const handle = createVirtualWindow({
      count: () => 1000,
      onChange: (range) => seen.push([range.start, range.end]),
      rowHeight: () => 10,
      scroller: el,
    });
    expect(handle.range().start).toBe(0);
    expect(seen.length).toBe(1);
    handle.destroy();
  });

  test("reports only when the SLICE changes, not on every scroll event", () => {
    const el = scroller(100);
    let changes = 0;
    const handle = createVirtualWindow({
      count: () => 1000,
      onChange: () => {
        changes += 1;
      },
      overscanRows: 0,
      rowHeight: () => 100,
      scroller: el,
    });
    expect(changes).toBe(1);
    // Within the same row: no new slice.
    el.scrollTop = 40;
    el.dispatchEvent(new Event("scroll"));
    expect(changes).toBe(1);
    // Past the row boundary: a new slice.
    el.scrollTop = 140;
    el.dispatchEvent(new Event("scroll"));
    expect(changes).toBe(2);
    handle.destroy();
  });

  test("a destroyed window stops listening and stops measuring", () => {
    const el = scroller(100);
    let changes = 0;
    const handle = createVirtualWindow({
      count: () => 1000,
      onChange: () => {
        changes += 1;
      },
      rowHeight: () => 10,
      scroller: el,
    });
    handle.destroy();
    el.scrollTop = 5000;
    el.dispatchEvent(new Event("scroll"));
    handle.measure();
    expect(changes).toBe(1);
  });

  test("re-measures against the CURRENT count and column count", () => {
    const el = scroller(100);
    let count = 10;
    let columns = 1;
    const handle = createVirtualWindow({
      columns: () => columns,
      count: () => count,
      onChange: () => {},
      rowHeight: () => 10,
      scroller: el,
    });
    expect(handle.range().totalRows).toBe(10);
    count = 40;
    columns = 4;
    handle.measure();
    expect(handle.range().totalRows).toBe(10);
    expect(handle.range().end).toBe(40);
    handle.destroy();
  });

  test("observes resizes where the environment has a ResizeObserver", () => {
    const observed: Element[] = [];
    let disconnected = false;
    const original = globalThis.ResizeObserver;
    function FakeResizeObserver(this: Record<string, unknown>, cb: () => void) {
      this.disconnect = () => {
        disconnected = true;
      };
      this.observe = (target: Element) => {
        observed.push(target);
        cb();
      };
      this.unobserve = () => null;
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      const el = scroller(100);
      const handle = createVirtualWindow({
        count: () => 10,
        onChange: () => {},
        rowHeight: () => 10,
        scroller: el,
      });
      expect(observed).toEqual([el]);
      handle.destroy();
      expect(disconnected).toBe(true);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});

// ─── The DOM half: a list that does not own its scrollbar ────────────────────
//
// Both trees scroll inside `#left-panel`, above a toolbar and (for Files) a project header. Every
// Case below is one of the ways that arrangement can be got wrong: measuring the scroller's own
// ScrollTop instead of the list's, treating a container that declares `overflow-y: auto` but never
// Scrolls as the scroller, or windowing a list nothing scrolls at all.

/** A scroller with a real box, since happy-dom performs no layout. */
function scrollBox(opts: { clientHeight: number; scrollHeight: number; overflow?: string }) {
  const el = document.createElement("div");
  el.style.overflowY = opts.overflow ?? "auto";
  Object.defineProperty(el, "clientHeight", { configurable: true, value: opts.clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: opts.scrollHeight });
  el.scrollTop = 0;
  document.body.append(el);
  return el;
}

/** A list inside `scroller`, `offset` pixels down its content. */
function listIn(scroller: HTMLElement, offset: number) {
  const chrome = document.createElement("div");
  const list = document.createElement("div");
  scroller.append(chrome, list);
  const place = () => {
    stubRect(scroller, { height: scroller.clientHeight, top: 0 });
    stubRect(list, { height: 1000, top: offset - scroller.scrollTop });
  };
  place();
  scroller.addEventListener("scroll", place);
  return list;
}

describe("nearestScroller", () => {
  test("finds the ancestor that actually scrolls", () => {
    const scroller = scrollBox({ clientHeight: 200, scrollHeight: 2000 });
    const list = listIn(scroller, 40);
    expect(nearestScroller(list)).toBe(scroller);
  });

  test("walks past a container that declares overflow but has nothing to scroll", () => {
    // `.file-tree` is exactly this: `overflow-y: auto` with no height, so it grows with its
    // Content. Calling it the scroller would read its whole content height as the VIEWPORT and
    // Window nothing, silently.
    const scroller = scrollBox({ clientHeight: 200, scrollHeight: 2000 });
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    Object.defineProperty(inner, "clientHeight", { configurable: true, value: 2000 });
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 2000 });
    scroller.append(inner);
    expect(nearestScroller(inner)).toBe(scroller);
  });

  test("a list nothing scrolls has no scroller", () => {
    const fits = scrollBox({ clientHeight: 500, scrollHeight: 400 });
    expect(nearestScroller(fits)).toBeNull();
    expect(nearestScroller(null)).toBeNull();
  });

  test("overflow: visible is not a scroller however far its content overflows", () => {
    const overflowing = scrollBox({ clientHeight: 100, scrollHeight: 9000, overflow: "visible" });
    expect(nearestScroller(overflowing)).toBeNull();
  });
});

describe("listScrollTop", () => {
  test("is measured from the list's own top, not the scroller's", () => {
    const scroller = scrollBox({ clientHeight: 200, scrollHeight: 2000 });
    const list = listIn(scroller, 60);
    scroller.scrollTop = 260;
    scroller.dispatchEvent(new Event("scroll"));
    // 260 down the scroller, with 60px of toolbar above the list, is 200 into the list.
    expect(listScrollTop(scroller, list)).toBe(200);
  });

  test("is the scroller's own scrollTop when the list IS the scroller", () => {
    const scroller = scrollBox({ clientHeight: 200, scrollHeight: 2000 });
    scroller.scrollTop = 130;
    expect(listScrollTop(scroller, scroller)).toBe(130);
  });

  test("never goes negative while the chrome above the list is still on screen", () => {
    const scroller = scrollBox({ clientHeight: 200, scrollHeight: 2000 });
    const list = listIn(scroller, 60);
    expect(listScrollTop(scroller, list)).toBe(0);
  });
});

describe("listWindow", () => {
  test("windows a list against whatever scrolls it", () => {
    const scroller = scrollBox({ clientHeight: 240, scrollHeight: 4800 });
    const list = listIn(scroller, 0);
    const range = listWindow(list, { count: 200, rowHeight: 24 });
    expect(range.start).toBe(0);
    expect(range.end).toBe(11 + DEFAULT_OVERSCAN_ROWS);
    expect(range.padTop + (range.end - range.start) * 24 + range.padBottom).toBe(200 * 24);
  });

  test("subtracts the chrome above the list, so the window is not one toolbar out", () => {
    const scroller = scrollBox({ clientHeight: 240, scrollHeight: 4800 });
    const list = listIn(scroller, 48);
    scroller.scrollTop = 48 + 24 * 20;
    scroller.dispatchEvent(new Event("scroll"));
    const range = listWindow(list, { count: 200, rowHeight: 24 });
    expect(range.start).toBe(20 - DEFAULT_OVERSCAN_ROWS);
  });

  test("answers the whole list for a list that has not been rendered, or is detached", () => {
    expect(listWindow(null, { count: 500, rowHeight: 24 }).end).toBe(500);
    const orphan = document.createElement("div");
    expect(listWindow(orphan, { count: 500, rowHeight: 24 }).end).toBe(500);
  });

  test("answers the whole list when nothing scrolls it — there is nothing to save", () => {
    const scroller = scrollBox({ clientHeight: 500, scrollHeight: 400 });
    const list = listIn(scroller, 0);
    expect(listWindow(list, { count: 12, rowHeight: 24 }).end).toBe(12);
  });
});

describe("scrollTopToReveal", () => {
  const spec = { listOffset: 40, rowHeight: 20, scrollTop: 200, viewportHeight: 100 };

  test("says nothing when the row is already in view", () => {
    expect(scrollTopToReveal({ ...spec, index: 9 })).toBeNull();
  });

  test("brings a row above the viewport to its top edge", () => {
    expect(scrollTopToReveal({ ...spec, index: 2 })).toBe(80);
  });

  test("brings a row below the viewport to its bottom edge", () => {
    expect(scrollTopToReveal({ ...spec, index: 40 })).toBe(40 + 41 * 20 - 100);
  });

  test("never asks for a negative scroll position", () => {
    expect(scrollTopToReveal({ ...spec, index: 0, listOffset: 0, scrollTop: 10 })).toBe(0);
  });
});

describe("revealListRow", () => {
  test("scrolls to a row the window does not hold, and says so", () => {
    const scroller = scrollBox({ clientHeight: 240, scrollHeight: 4800 });
    const list = listIn(scroller, 0);
    expect(revealListRow(list, 100, 24)).toBe(true);
    expect(scroller.scrollTop).toBe(101 * 24 - 240);
  });

  test("does nothing for a row that is already visible", () => {
    const scroller = scrollBox({ clientHeight: 240, scrollHeight: 4800 });
    const list = listIn(scroller, 0);
    expect(revealListRow(list, 2, 24)).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  test("refuses what it cannot compute: no list, no scroller, no row, no height", () => {
    const scroller = scrollBox({ clientHeight: 240, scrollHeight: 4800 });
    const list = listIn(scroller, 0);
    expect(revealListRow(null, 3, 24)).toBe(false);
    expect(revealListRow(document.createElement("div"), 3, 24)).toBe(false);
    expect(revealListRow(list, -1, 24)).toBe(false);
    expect(revealListRow(list, 3, 0)).toBe(false);
  });
});

describe("measuredRowHeight", () => {
  test("believes a measured row over the declared constant", () => {
    const list = document.createElement("div");
    const row = document.createElement("div");
    row.className = "row";
    Object.defineProperty(row, "offsetHeight", { configurable: true, value: 31 });
    list.append(row);
    expect(measuredRowHeight(list, ".row", 24)).toBe(31);
  });

  test("falls back to the declared height until a row has been laid out", () => {
    const list = document.createElement("div");
    const row = document.createElement("div");
    row.className = "row";
    list.append(row);
    // OffsetHeight is 0 in happy-dom, and 0 in a real browser for a display:none pane.
    expect(measuredRowHeight(list, ".row", 24)).toBe(24);
    expect(measuredRowHeight(list, ".missing", 24)).toBe(24);
    expect(measuredRowHeight(null, ".row", 24)).toBe(24);
  });
});

describe("watchListWindow", () => {
  test("repaints when the window changes, and only then", () => {
    const scroller = scrollBox({ clientHeight: 240, scrollHeight: 4800 });
    const list = listIn(scroller, 0);
    let changes = 0;
    const watch = watchListWindow(null, list, {
      count: () => 200,
      onChange: () => {
        changes += 1;
      },
      rowHeight: () => 24,
    });
    expect(watch).not.toBeNull();
    expect(changes).toBe(1);
    scroller.scrollTop = 4;
    scroller.dispatchEvent(new Event("scroll"));
    expect(changes).toBe(1);
    scroller.scrollTop = 24 * 40;
    scroller.dispatchEvent(new Event("scroll"));
    expect(changes).toBe(2);
    watch!.window.destroy();
  });

  test("keeps the same watch for the same list, and moves it for a new one", () => {
    const scroller = scrollBox({ clientHeight: 240, scrollHeight: 4800 });
    const list = listIn(scroller, 0);
    let changes = 0;
    const spec = {
      count: () => 200,
      onChange: () => {
        changes += 1;
      },
      rowHeight: () => 24,
    };
    const first = watchListWindow(null, list, spec);
    expect(watchListWindow(first, list, spec)).toBe(first);
    // A re-bind per render would re-measure per render, and a fresh measurement always "changes".
    expect(changes).toBe(1);

    const second = listIn(scroller, 0);
    const moved = watchListWindow(first, second, spec);
    expect(moved).not.toBe(first);
    moved!.window.destroy();
  });

  test("drops the watch when nothing scrolls the list any more", () => {
    const scroller = scrollBox({ clientHeight: 240, scrollHeight: 4800 });
    const list = listIn(scroller, 0);
    const spec = { count: () => 200, onChange: () => {}, rowHeight: () => 24 };
    const watch = watchListWindow(null, list, spec);
    const orphan = document.createElement("div");
    expect(watchListWindow(watch, orphan, spec)).toBeNull();
  });
});
