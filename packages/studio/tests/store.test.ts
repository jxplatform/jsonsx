import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  COMMON_SELECTORS,
  VOID_ELEMENTS,
  cancelStyleDebounce,
  debouncedStyleCommit,
  isNestedSelector,
  registerRenderer,
  render,
  renderOnly,
  rendersInFlight,
} from "../src/store";

// ─── isNestedSelector ───────────────────────────────────────────────────────

describe("isNestedSelector", () => {
  test("returns true for pseudo-class selectors", () => {
    expect(isNestedSelector(":hover")).toBe(true);
    expect(isNestedSelector(":focus")).toBe(true);
    expect(isNestedSelector("::before")).toBe(true);
  });

  test("returns true for class selectors", () => {
    expect(isNestedSelector(".active")).toBe(true);
    expect(isNestedSelector(".dark")).toBe(true);
  });

  test("returns true for & selectors", () => {
    expect(isNestedSelector("& > li")).toBe(true);
    expect(isNestedSelector("& .child")).toBe(true);
  });

  test("returns true for attribute selectors", () => {
    expect(isNestedSelector('[type="text"]')).toBe(true);
    expect(isNestedSelector("[hidden]")).toBe(true);
  });

  test("returns false for regular properties", () => {
    expect(isNestedSelector("color")).toBe(false);
    expect(isNestedSelector("fontSize")).toBe(false);
    expect(isNestedSelector("--custom-prop")).toBe(false);
    expect(isNestedSelector("@--md")).toBe(false);
  });
});

// `stripEventHandlers` moved to ../src/utils/strip-events — see strip-events.test.ts.

// ─── Constants ──────────────────────────────────────────────────────────────

describe("VOID_ELEMENTS", () => {
  test("contains standard void elements", () => {
    expect(VOID_ELEMENTS.has("input")).toBe(true);
    expect(VOID_ELEMENTS.has("br")).toBe(true);
    expect(VOID_ELEMENTS.has("hr")).toBe(true);
    expect(VOID_ELEMENTS.has("img")).toBe(true);
    expect(VOID_ELEMENTS.has("meta")).toBe(true);
    expect(VOID_ELEMENTS.has("link")).toBe(true);
  });

  test("does not contain non-void elements", () => {
    expect(VOID_ELEMENTS.has("div")).toBe(false);
    expect(VOID_ELEMENTS.has("span")).toBe(false);
    expect(VOID_ELEMENTS.has("p")).toBe(false);
  });
});

describe("COMMON_SELECTORS", () => {
  test("includes common pseudo-classes", () => {
    expect(COMMON_SELECTORS).toContain(":hover");
    expect(COMMON_SELECTORS).toContain(":focus");
    expect(COMMON_SELECTORS).toContain(":active");
    expect(COMMON_SELECTORS).toContain("::before");
    expect(COMMON_SELECTORS).toContain("::after");
  });
});

// ─── Render orchestration ───────────────────────────────────────────────────

describe("render orchestration", () => {
  test("registerRenderer + render calls all renderers", () => {
    const calls: any[] = [];
    registerRenderer("test-a", () => calls.push("a"));
    registerRenderer("test-b", () => calls.push("b"));
    render();
    expect(calls).toContain("a");
    expect(calls).toContain("b");
  });

  test("renderOnly calls specific renderers", () => {
    const calls: any[] = [];
    registerRenderer("only-x", () => calls.push("x"));
    registerRenderer("only-y", () => calls.push("y"));
    calls.length = 0;
    renderOnly("only-x");
    expect(calls).toEqual(["x"]);
  });

  test("renderOnly skips unregistered names", () => {
    renderOnly("non-existent-renderer");
  });
});

// ─── Debounced style commit ─────────────────────────────────────────────────

describe("debouncedStyleCommit", () => {
  test("creates a debounced function", () => {
    const fn = debouncedStyleCommit("test-prop", 100, () => {});
    expect(typeof fn).toBe("function");
  });

  test("cancelStyleDebounce does not throw for unknown prop", () => {
    cancelStyleDebounce("unknown-prop");
  });
});

// ─── Render accounting (probe.idle() condition 1) ───────────────────────────

describe("rendersInFlight", () => {
  test("is zero at rest and while a synchronous renderer runs it is one", () => {
    expect(rendersInFlight()).toBe(0);
    let seen = -1;
    registerRenderer("count-sync", () => {
      seen = rendersInFlight();
    });
    try {
      renderOnly("count-sync");
      expect(seen).toBe(1);
      expect(rendersInFlight()).toBe(0);
    } finally {
      registerRenderer("count-sync", () => {});
    }
  });

  test("an ASYNC renderer stays counted until its promise settles", async () => {
    // `registerRenderer` declares `() => void`, and TypeScript happily accepts an async function
    // There — so a renderer that awaits keeps repainting long after render() returned. Counting
    // Only the synchronous body would report "settled" over a half-painted panel.
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerRenderer("count-async", (() => pending) as () => void);
    try {
      render();
      expect(rendersInFlight()).toBe(1);
      release();
      await pending;
      expect(rendersInFlight()).toBe(0);
    } finally {
      registerRenderer("count-async", () => {});
    }
  });

  test("a renderer that throws is logged and released, never left counted", () => {
    registerRenderer("count-throws", () => {
      throw new Error("boom");
    });
    try {
      renderOnly("count-throws");
      expect(rendersInFlight()).toBe(0);
    } finally {
      registerRenderer("count-throws", () => {});
    }
  });

  test("a renderer whose promise REJECTS is released too", async () => {
    const rejected = Promise.reject(new Error("async boom"));
    registerRenderer("count-rejects", (() => rejected) as () => void);
    try {
      renderOnly("count-rejects");
      expect(rendersInFlight()).toBe(1);
      await rejected.catch(() => {});
      // One more microtask turn for the counter's own settle handler.
      await Promise.resolve();
      expect(rendersInFlight()).toBe(0);
    } finally {
      registerRenderer("count-rejects", () => {});
    }
  });
});
