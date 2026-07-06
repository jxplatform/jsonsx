import { describe, test, expect } from "bun:test";
import { componentize } from "../src/componentize.ts";
import type { JxElement } from "@jxsuite/schema/types";

function card(title: string, desc: string, href: string): JxElement {
  return {
    tagName: "div",
    style: { padding: "1rem", border: "1px solid #ccc" },
    children: [
      { tagName: "h3", textContent: title },
      { tagName: "p", textContent: desc },
      { tagName: "a", attributes: { href }, textContent: "Learn More" },
    ],
  };
}

describe("componentize", () => {
  test("returns empty when no recurring subtrees", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [{ tagName: "h1", textContent: "Hello" }],
        },
      ],
    ]);
    const result = componentize(pages);
    expect(result.components.size).toBe(0);
  });

  test("detects recurring card pattern across pages", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [card("Card A", "Description A", "/a"), card("Card B", "Description B", "/b")],
        },
      ],
    ]);
    const result = componentize(pages);
    expect(result.components.size).toBe(1);

    const [fileName, comp] = [...result.components.entries()][0]!;
    expect(fileName).toMatch(/\.json$/);
    expect(comp.$id).toBeTruthy();
    expect(comp.tagName).toMatch(/^component-/);
    expect(comp.instanceCount).toBe(2);
    expect(comp.template.tagName).toBe("div");
  });

  test("extracts varying text into state props with interpolation", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [card("Title 1", "Desc 1", "/link1"), card("Title 2", "Desc 2", "/link2")],
        },
      ],
    ]);
    const result = componentize(pages);
    const comp = [...result.components.values()][0]!;

    expect(comp.template.state).toBeUndefined();

    const templateStr = JSON.stringify(comp.template);
    expect(templateStr).toContain("${state.");
  });

  test("rewrites call-sites with tagName and $props", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [card("Card A", "Desc A", "/a"), card("Card B", "Desc B", "/b")],
        },
      ],
    ]);
    const result = componentize(pages);
    const page = result.rewrittenPages.get("pages/index.json")!;

    expect(Array.isArray(page.children)).toBe(true);
    const children = page.children as JxElement[];
    expect(children.length).toBe(2);

    for (const child of children) {
      expect(child.tagName).toMatch(/^component-/);
      expect(child.$props).toBeTruthy();
    }
  });

  test("detects pattern across multiple pages", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [card("Home Card", "Home desc", "/home")],
        },
      ],
      [
        "pages/about.json",
        {
          tagName: "div",
          children: [card("About Card", "About desc", "/about")],
        },
      ],
    ]);
    const result = componentize(pages);
    expect(result.components.size).toBe(1);

    const comp = [...result.components.values()][0]!;
    expect(comp.instanceCount).toBe(2);

    const indexPage = result.rewrittenPages.get("pages/index.json")!;
    const aboutPage = result.rewrittenPages.get("pages/about.json")!;
    expect((indexPage.children as JxElement[])[0]!.tagName).toMatch(/^component-/);
    expect((aboutPage.children as JxElement[])[0]!.tagName).toMatch(/^component-/);
  });

  test("respects minInstances threshold", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [card("A", "a", "/a"), card("B", "b", "/b")],
        },
      ],
    ]);
    const result = componentize(pages, { minInstances: 3 });
    expect(result.components.size).toBe(0);
  });

  test("respects minDepth threshold", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [
            { tagName: "span", textContent: "A" },
            { tagName: "span", textContent: "B" },
          ],
        },
      ],
    ]);
    // Span with textContent has depth 1, minDepth 2 should skip
    const result = componentize(pages, { minDepth: 2 });
    expect(result.components.size).toBe(0);
  });

  test("static text stays literal, only varying values become interpolated", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [card("Card A", "Desc A", "/a"), card("Card B", "Desc B", "/b")],
        },
      ],
    ]);
    const result = componentize(pages);
    const comp = [...result.components.values()][0]!;
    const templateStr = JSON.stringify(comp.template);
    // "Learn More" is the same across both cards, should NOT be interpolated
    expect(templateStr).toContain("Learn More");
  });

  test("preserves pages with no recurring patterns unchanged", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [
            { tagName: "h1", textContent: "Hello" },
            { tagName: "p", textContent: "World" },
          ],
        },
      ],
    ]);
    const result = componentize(pages);
    const page = result.rewrittenPages.get("pages/index.json")!;
    expect(JSON.stringify(page)).toBe(
      JSON.stringify({
        tagName: "div",
        children: [
          { tagName: "h1", textContent: "Hello" },
          { tagName: "p", textContent: "World" },
        ],
      }),
    );
  });

  test("$props values match the actual instance values", () => {
    const pages = new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [card("Alpha", "First", "/alpha"), card("Beta", "Second", "/beta")],
        },
      ],
    ]);
    const result = componentize(pages);
    const page = result.rewrittenPages.get("pages/index.json")!;
    const children = page.children as JxElement[];

    const props0 = children[0]!.$props as Record<string, string>;
    const props1 = children[1]!.$props as Record<string, string>;

    const allValues0 = Object.values(props0);
    const allValues1 = Object.values(props1);

    expect(allValues0).toContain("Alpha");
    expect(allValues0).toContain("First");
    expect(allValues0).toContain("/alpha");
    expect(allValues1).toContain("Beta");
    expect(allValues1).toContain("Second");
    expect(allValues1).toContain("/beta");
  });
});
