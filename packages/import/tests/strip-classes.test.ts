import { describe, test, expect } from "bun:test";
import { stripClasses } from "../src/strip-classes.ts";
import type { JxElement } from "@jxsuite/schema/types";

describe("stripClasses", () => {
  test("removes attributes.class and reports the count", () => {
    const node: JxElement = { tagName: "div", attributes: { class: "hero grid" } };
    expect(stripClasses(node)).toBe(1);
    expect(node.attributes).toBeUndefined();
  });

  test("removes a className property too", () => {
    const node = { tagName: "div", className: "hero" } as unknown as JxElement;
    expect(stripClasses(node)).toBe(1);
    expect("className" in node).toBe(false);
  });

  test("keeps the rest of the attributes, and the map they live in", () => {
    const node: JxElement = {
      tagName: "a",
      attributes: { class: "btn", href: "/pricing", "aria-label": "Pricing", id: "cta" },
    };
    stripClasses(node);
    expect(node.attributes).toEqual({ href: "/pricing", "aria-label": "Pricing", id: "cta" });
  });

  test("recurses, and counts every class it removed", () => {
    const tree: JxElement = {
      tagName: "section",
      attributes: { class: "wrap" },
      children: [
        { tagName: "h1", attributes: { class: "title" }, textContent: "Hi" },
        {
          tagName: "ul",
          attributes: { class: "list" },
          children: [
            { tagName: "li", attributes: { class: "item" } },
            { tagName: "li", attributes: { class: "item" } },
          ],
        },
      ],
    };
    expect(stripClasses(tree)).toBe(5);
    expect(JSON.stringify(tree)).not.toContain("class");
  });

  test("leaves a tree with no classes exactly as it found it", () => {
    const tree: JxElement = {
      tagName: "div",
      attributes: { id: "root" },
      children: [{ tagName: "p", textContent: "text" }],
    };
    const before = structuredClone(tree);
    expect(stripClasses(tree)).toBe(0);
    expect(tree).toEqual(before);
  });

  test("string children are not elements and are left alone", () => {
    const tree = {
      tagName: "p",
      children: ["some text", { tagName: "em", attributes: { class: "x" } }],
    } as unknown as JxElement;
    expect(stripClasses(tree)).toBe(1);
    expect((tree.children as unknown[])[0]).toBe("some text");
  });

  test("a bare string is not a node", () => {
    expect(stripClasses("just text")).toBe(0);
  });
});
