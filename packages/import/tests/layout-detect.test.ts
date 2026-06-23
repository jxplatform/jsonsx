import { describe, test, expect } from "bun:test";
import { detectLayout, hashSubtree, treesEqual } from "../src/layout-detect.ts";
import type { JxElement } from "@jxsuite/schema/types";

describe("hashSubtree", () => {
  test("hashes text nodes as #text", () => {
    expect(hashSubtree("hello")).toBe("#text");
  });

  test("hashes empty element", () => {
    expect(hashSubtree({ tagName: "div" })).toBe("<div>");
  });

  test("hashes element with children", () => {
    const node: JxElement = {
      tagName: "nav",
      children: [
        { tagName: "a", textContent: "Home" },
        { tagName: "a", textContent: "About" },
      ],
    };
    expect(hashSubtree(node)).toBe("<nav><a>#text,<a>#text");
  });

  test("same structure different text produces same hash", () => {
    const a: JxElement = {
      tagName: "div",
      children: [{ tagName: "p", textContent: "Hello" }],
    };
    const b: JxElement = {
      tagName: "div",
      children: [{ tagName: "p", textContent: "World" }],
    };
    expect(hashSubtree(a)).toBe(hashSubtree(b));
  });
});

describe("treesEqual", () => {
  test("identical text nodes are equal", () => {
    expect(treesEqual("hello", "hello")).toBe(true);
  });

  test("different text nodes are not equal", () => {
    expect(treesEqual("hello", "world")).toBe(false);
  });

  test("text vs element is not equal", () => {
    expect(treesEqual("hello", { tagName: "span" })).toBe(false);
  });

  test("identical simple elements are equal", () => {
    expect(
      treesEqual({ tagName: "div", textContent: "hi" }, { tagName: "div", textContent: "hi" }),
    ).toBe(true);
  });

  test("different tagNames are not equal", () => {
    expect(treesEqual({ tagName: "div" }, { tagName: "span" })).toBe(false);
  });

  test("different textContent are not equal", () => {
    expect(treesEqual({ tagName: "p", textContent: "a" }, { tagName: "p", textContent: "b" })).toBe(
      false,
    );
  });

  test("deep nested trees are compared correctly", () => {
    const tree = (text: string): JxElement => ({
      tagName: "nav",
      children: [{ tagName: "a", textContent: text }],
    });
    expect(treesEqual(tree("Home"), tree("Home"))).toBe(true);
    expect(treesEqual(tree("Home"), tree("About"))).toBe(false);
  });
});

describe("detectLayout", () => {
  test("returns null for fewer than 2 pages", () => {
    const pages = new Map<string, JxElement>([
      ["pages/index.json", { tagName: "div", children: [] }],
    ]);
    expect(detectLayout(pages)).toBeNull();
  });

  test("returns null when no shared elements", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [{ tagName: "h1", textContent: "Home" }],
        },
      ],
      [
        "pages/about.json",
        {
          tagName: "div",
          children: [{ tagName: "h1", textContent: "About" }],
        },
      ],
    ]);
    expect(detectLayout(pages)).toBeNull();
  });

  test("detects shared header", () => {
    const header: JxElement = {
      tagName: "nav",
      children: [
        { tagName: "a", textContent: "Home" },
        { tagName: "a", textContent: "About" },
      ],
    };

    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [{ ...structuredClone(header) }, { tagName: "main", textContent: "Welcome" }],
        },
      ],
      [
        "pages/about.json",
        {
          tagName: "div",
          children: [{ ...structuredClone(header) }, { tagName: "main", textContent: "About us" }],
        },
      ],
    ]);

    const result = detectLayout(pages)!;
    expect(result).not.toBeNull();

    // Layout should have: header + slot
    const layoutChildren = result.layout.children as JxElement[];
    expect(layoutChildren.length).toBe(2); // Header + slot
    expect(layoutChildren[0].tagName).toBe("nav");
    expect(layoutChildren[1].tagName).toBe("slot");

    // Stripped pages should only have the unique content
    const indexStripped = result.strippedPages.get("pages/index.json")!;
    const indexChildren = indexStripped.children as JxElement[];
    expect(indexChildren.length).toBe(1);
    expect(indexChildren[0].textContent).toBe("Welcome");
    expect((indexStripped as any).$layout).toBe("layouts/base.json");
  });

  test("detects shared header AND footer", () => {
    const header: JxElement = {
      tagName: "nav",
      children: [{ tagName: "a", textContent: "Home" }],
    };
    const footer: JxElement = {
      tagName: "footer",
      textContent: "© 2026",
    };

    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [
            structuredClone(header),
            { tagName: "main", textContent: "Home page" },
            structuredClone(footer),
          ],
        },
      ],
      [
        "pages/about.json",
        {
          tagName: "div",
          children: [
            structuredClone(header),
            { tagName: "main", textContent: "About page" },
            structuredClone(footer),
          ],
        },
      ],
    ]);

    const result = detectLayout(pages)!;
    expect(result).not.toBeNull();

    // Layout: header + slot + footer
    const layoutChildren = result.layout.children as JxElement[];
    expect(layoutChildren.length).toBe(3);
    expect(layoutChildren[0].tagName).toBe("nav");
    expect(layoutChildren[1].tagName).toBe("slot");
    expect(layoutChildren[2].tagName).toBe("footer");

    // Each page should only have its main content
    for (const [, stripped] of result.strippedPages) {
      const children = stripped.children as JxElement[];
      expect(children.length).toBe(1);
      expect(children[0].tagName).toBe("main");
    }
  });

  test("works with 3+ pages", () => {
    const header: JxElement = { tagName: "header", textContent: "Site" };

    const entries: [string, JxElement][] = ["index", "about", "contact"].map((name) => [
      `pages/${name}.json`,
      {
        tagName: "div",
        children: [structuredClone(header), { tagName: "section", textContent: name }],
      },
    ]);
    const pages = new Map<string, JxElement>(entries);

    const result = detectLayout(pages)!;
    expect(result).not.toBeNull();
    expect(result.strippedPages.size).toBe(3);
  });
});
