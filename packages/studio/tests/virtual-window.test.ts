/**
 * Tests for src/browse/virtual-window.ts — the windowing primitive.
 *
 * The whole acceptance criterion of P7.1 reduces to one property, asserted here directly: the
 * number of items a window yields is a function of the VIEWPORT, not of the collection. Everything
 * else in this file is the degenerate cases that would otherwise render an empty Library and look
 * like a broken one.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OVERSCAN_ROWS,
  computeWindow,
  createVirtualWindow,
  sameWindow,
} from "../src/browse/virtual-window";

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
