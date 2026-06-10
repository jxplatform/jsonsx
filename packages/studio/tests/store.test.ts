import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";
import {
  isNestedSelector,
  stripEventHandlers,
  VOID_ELEMENTS,
  COMMON_SELECTORS,
  registerRenderer,
  render,
  renderOnly,
  debouncedStyleCommit,
  cancelStyleDebounce,
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

// ─── stripEventHandlers ─────────────────────────────────────────────────────

describe("stripEventHandlers", () => {
  test("strips on* $ref handlers", () => {
    const node = {
      tagName: "button",
      onclick: { $ref: "#/state/handleClick" },
      textContent: "Click me",
    };
    const result = stripEventHandlers(node) as any;
    expect(result.onclick).toBeUndefined();
    expect(result.textContent).toBe("Click me");
    expect(result.tagName).toBe("button");
  });

  test("strips on* Function $prototype handlers", () => {
    const node = {
      tagName: "input",
      onchange: {
        $prototype: "Function",
        body: "state.value = event.target.value",
      },
      type: "text",
    };
    const result = stripEventHandlers(node) as any;
    expect(result.onchange).toBeUndefined();
    expect(result.type).toBe("text");
  });

  test("preserves non-event on* properties", () => {
    const node = {
      tagName: "div",
      textContent: "hello",
      style: { color: "red" },
    };
    const result = stripEventHandlers(node) as any;
    expect(result.textContent).toBe("hello");
    expect(result.style).toEqual({ color: "red" });
  });

  test("recurses into children", () => {
    const node = {
      tagName: "div",
      children: [
        {
          tagName: "button",
          onclick: { $ref: "#/state/fn" },
          textContent: "Click",
        },
      ],
    };
    const result = stripEventHandlers(node) as any;
    expect(result.children[0].onclick).toBeUndefined();
    expect(result.children[0].textContent).toBe("Click");
  });

  test("recurses into cases", () => {
    const node = {
      tagName: "div",
      cases: {
        a: { tagName: "span", onclick: { $ref: "#/state/fn" } },
        b: { tagName: "p", textContent: "hello" },
      },
    };
    const result = stripEventHandlers(node) as any;
    expect(result.cases.a.onclick).toBeUndefined();
    expect(result.cases.b.textContent).toBe("hello");
  });

  test("handles arrays", () => {
    const nodes = [
      { tagName: "a", onclick: { $ref: "#/state/nav" } },
      { tagName: "span", textContent: "hi" },
    ];
    const result = stripEventHandlers(nodes) as any;
    expect(result[0].onclick).toBeUndefined();
    expect(result[1].textContent).toBe("hi");
  });

  test("returns primitives unchanged", () => {
    expect(stripEventHandlers(null as unknown as JxMutableNode) as unknown).toBe(null);
    expect(stripEventHandlers("string" as unknown as JxMutableNode) as unknown).toBe("string");
    expect(stripEventHandlers(42 as unknown as JxMutableNode) as unknown).toBe(42);
  });

  test("preserves state, style, attributes, $media", () => {
    const node = {
      tagName: "div",
      state: { count: 0 },
      style: { color: "red" },
      attributes: { "data-x": "1" },
      $media: { "--md": "(min-width: 768px)" },
    };
    const result = stripEventHandlers(node) as any;
    expect(result.state).toEqual({ count: 0 });
    expect(result.style).toEqual({ color: "red" });
    expect(result.attributes).toEqual({ "data-x": "1" });
    expect(result.$media).toEqual({ "--md": "(min-width: 768px)" });
  });
});

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
