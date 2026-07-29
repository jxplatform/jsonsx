/**
 * Canvas perf timing (W9) — span aggregation, the p95 window, mark/measure gating, and the
 * full-render mirror fields the profiling gate reads off `__jxCanvasPerf`.
 */
import "./with-dom.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  beginSpan,
  canvasPerf,
  recordSpan,
  resetCanvasPerf,
  SPAN_FULL_RENDER,
  timeSpan,
  timeSpanAsync,
} from "../src/canvas/canvas-perf";

afterEach(() => {
  localStorage.removeItem("jx-canvas-debug");
  resetCanvasPerf();
});

describe("recordSpan", () => {
  test("aggregates count, last, max, and total per span name", () => {
    recordSpan("alpha", 4);
    recordSpan("alpha", 10);
    recordSpan("alpha", 6);
    const stats = canvasPerf.timings.alpha!;
    expect(stats.count).toBe(3);
    expect(stats.lastMs).toBe(6);
    expect(stats.maxMs).toBe(10);
    expect(stats.totalMs).toBe(20);
  });

  test("keeps span names independent", () => {
    recordSpan("alpha", 1);
    recordSpan("beta", 2);
    expect(canvasPerf.timings.alpha!.count).toBe(1);
    expect(canvasPerf.timings.beta!.count).toBe(1);
    expect(canvasPerf.timings.beta!.lastMs).toBe(2);
  });

  test("clamps non-finite and negative durations to zero", () => {
    recordSpan("alpha", Number.NaN);
    recordSpan("alpha", -5);
    recordSpan("alpha", Number.POSITIVE_INFINITY);
    const stats = canvasPerf.timings.alpha!;
    expect(stats.count).toBe(3);
    expect(stats.maxMs).toBe(0);
    expect(stats.totalMs).toBe(0);
  });

  test("p95 is the nearest-rank value over the retained samples", () => {
    // 1..100 → the 95th percentile by nearest rank is 95.
    for (let i = 1; i <= 100; i++) {
      recordSpan("alpha", i);
    }
    expect(canvasPerf.timings.alpha!.p95Ms).toBe(95);
  });

  test("p95 of a single sample is that sample", () => {
    recordSpan("alpha", 7);
    expect(canvasPerf.timings.alpha!.p95Ms).toBe(7);
  });

  test("the sample window is bounded, so old outliers leave p95 but maxMs is all-time", () => {
    // One huge sample, then 128 small ones — the outlier is evicted from the p95 window.
    recordSpan("alpha", 9999);
    for (let i = 0; i < 128; i++) {
      recordSpan("alpha", 1);
    }
    const stats = canvasPerf.timings.alpha!;
    expect(stats.count).toBe(129);
    expect(stats.p95Ms).toBe(1);
    expect(stats.maxMs).toBe(9999);
  });

  test("mirrors the full-render span onto the top-level fields", () => {
    recordSpan(SPAN_FULL_RENDER, 12);
    expect(canvasPerf.lastFullRenderMs).toBe(12);
    expect(canvasPerf.p95FullRenderMs).toBe(12);
    // A different span must not touch the mirror.
    recordSpan("other", 500);
    expect(canvasPerf.lastFullRenderMs).toBe(12);
  });
});

describe("beginSpan", () => {
  test("records one span and returns its duration", () => {
    const end = beginSpan("alpha");
    const duration = end();
    expect(canvasPerf.timings.alpha!.count).toBe(1);
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  test("is idempotent — a second close records nothing more", () => {
    const end = beginSpan("alpha");
    end();
    end();
    end();
    expect(canvasPerf.timings.alpha!.count).toBe(1);
  });

  test("emits mark/measure only when debug mode is on", () => {
    const mark = spyOn(performance, "mark").mockImplementation(() => undefined as never);
    const measure = spyOn(performance, "measure").mockImplementation(() => undefined as never);
    try {
      beginSpan("quiet")();
      expect(mark).not.toHaveBeenCalled();
      expect(measure).not.toHaveBeenCalled();

      localStorage.setItem("jx-canvas-debug", "1");
      beginSpan("loud")();
      expect(mark).toHaveBeenCalledWith("jx-loud-start");
      expect(measure).toHaveBeenCalledWith("jx-loud", "jx-loud-start");
    } finally {
      mark.mockRestore();
      measure.mockRestore();
    }
  });

  test("still records the duration when performance.mark throws", () => {
    localStorage.setItem("jx-canvas-debug", "1");
    const mark = spyOn(performance, "mark").mockImplementation(() => {
      throw new Error("no marks here");
    });
    try {
      expect(() => beginSpan("alpha")()).not.toThrow();
      expect(canvasPerf.timings.alpha!.count).toBe(1);
    } finally {
      mark.mockRestore();
    }
  });
});

describe("timeSpan", () => {
  test("returns the body's value and records the span", () => {
    const value = timeSpan("alpha", () => 42);
    expect(value).toBe(42);
    expect(canvasPerf.timings.alpha!.count).toBe(1);
  });

  test("records the span even when the body throws", () => {
    expect(() =>
      timeSpan("alpha", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(canvasPerf.timings.alpha!.count).toBe(1);
  });
});

describe("timeSpanAsync", () => {
  test("awaits the body and records the span once", async () => {
    const value = await timeSpanAsync("alpha", async () => {
      await Promise.resolve();
      return "done";
    });
    expect(value).toBe("done");
    expect(canvasPerf.timings.alpha!.count).toBe(1);
  });

  test("records the span when the promise rejects", async () => {
    let message = "";
    try {
      await timeSpanAsync("alpha", () => Promise.reject(new Error("nope")));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("nope");
    expect(canvasPerf.timings.alpha!.count).toBe(1);
  });
});

describe("resetCanvasPerf", () => {
  test("clears timings, the mirror fields, and the p95 window", () => {
    recordSpan(SPAN_FULL_RENDER, 30);
    recordSpan("alpha", 5);
    resetCanvasPerf();
    expect(canvasPerf.timings).toEqual({});
    expect(canvasPerf.lastFullRenderMs).toBe(0);
    expect(canvasPerf.p95FullRenderMs).toBe(0);
    // The retained samples are gone too: a fresh 1ms sample must not see the old 30ms one.
    recordSpan(SPAN_FULL_RENDER, 1);
    expect(canvasPerf.timings[SPAN_FULL_RENDER]!.maxMs).toBe(1);
  });
});
