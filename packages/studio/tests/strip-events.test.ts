import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { stripEventHandlers } from "../src/utils/strip-events";
import type { JxMutableNode } from "@jxsuite/schema/types";

describe("stripEventHandlers", () => {
  test("strips on* $ref handlers", () => {
    const node = {
      onclick: { $ref: "#/state/handleClick" },
      tagName: "button",
      textContent: "Click me",
    };
    const result = stripEventHandlers(node) as any;
    expect(result.onclick).toBeUndefined();
    expect(result.textContent).toBe("Click me");
    expect(result.tagName).toBe("button");
  });

  test("strips on* Function $prototype handlers", () => {
    const node = {
      onchange: {
        $prototype: "Function",
        body: "state.value = event.target.value",
      },
      tagName: "input",
      type: "text",
    };
    const result = stripEventHandlers(node) as any;
    expect(result.onchange).toBeUndefined();
    expect(result.type).toBe("text");
  });

  test("preserves non-event on* properties", () => {
    const node = {
      style: { color: "red" },
      tagName: "div",
      textContent: "hello",
    };
    const result = stripEventHandlers(node) as any;
    expect(result.textContent).toBe("hello");
    expect(result.style).toEqual({ color: "red" });
  });

  test("recurses into children", () => {
    const node = {
      children: [
        {
          onclick: { $ref: "#/state/fn" },
          tagName: "button",
          textContent: "Click",
        },
      ],
      tagName: "div",
    };
    const result = stripEventHandlers(node) as any;
    expect(result.children[0].onclick).toBeUndefined();
    expect(result.children[0].textContent).toBe("Click");
  });

  test("recurses into cases", () => {
    const node = {
      cases: {
        a: { onclick: { $ref: "#/state/fn" }, tagName: "span" },
        b: { tagName: "p", textContent: "hello" },
      },
      tagName: "div",
    };
    const result = stripEventHandlers(node) as any;
    expect(result.cases.a.onclick).toBeUndefined();
    expect(result.cases.b.textContent).toBe("hello");
  });

  test("handles arrays", () => {
    const nodes = [
      { onclick: { $ref: "#/state/nav" }, tagName: "a" },
      { tagName: "span", textContent: "hi" },
    ];
    const result = stripEventHandlers(nodes as unknown as JxMutableNode) as any;
    expect(result[0].onclick).toBeUndefined();
    expect(result[1].textContent).toBe("hi");
  });

  test("returns primitives unchanged", () => {
    expect(stripEventHandlers(null as unknown as JxMutableNode) as unknown).toBe(null);
    expect(stripEventHandlers("string" as unknown as JxMutableNode) as unknown).toBe("string");
    expect(stripEventHandlers(42 as unknown as JxMutableNode) as unknown).toBe(42);
  });

  test("drops server-timed state but preserves state, style, attributes, $media", () => {
    const node = {
      $media: { "--md": "(min-width: 768px)" },
      attributes: { "data-x": "1" },
      state: { count: 0, fetchUser: { timing: "server" } },
      style: { color: "red" },
      tagName: "div",
    };
    const result = stripEventHandlers(node) as any;
    expect(result.state).toEqual({ count: 0 }); // Server-timed entry dropped.
    expect(result.style).toEqual({ color: "red" });
    expect(result.attributes).toEqual({ "data-x": "1" });
    expect(result.$media).toEqual({ "--md": "(min-width: 768px)" });
  });
});
