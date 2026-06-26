import { describe, test, expect } from "bun:test";
import { applyStylesToTree } from "../src/apply-styles.ts";
import type { JxElement } from "@jxsuite/schema/types";
import type { DiffedStyle } from "../src/style-diff.ts";

describe("applyStylesToTree", () => {
  test("applies base styles to matching nodes", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [
        {
          tagName: "div",
          children: [
            { tagName: "h1", textContent: "Hello" },
            { tagName: "p", textContent: "World" },
          ],
        },
      ],
    };

    const styles: DiffedStyle[] = [
      { path: [0], style: { display: "flex", gap: "16px" } },
      { path: [0, 0], style: { fontSize: "32px", fontWeight: 700 } },
      { path: [0, 1], style: { color: "rgb(100, 100, 100)" } },
    ];

    applyStylesToTree(tree, styles);

    const container = (tree.children as JxElement[])[0]!;
    expect(container.style).toEqual({ display: "flex", gap: "16px" });

    const h1 = (container.children as JxElement[])[0]!;
    expect(h1.style).toEqual({ fontSize: "32px", fontWeight: 700 });

    const p = (container.children as JxElement[])[1]!;
    expect(p.style).toEqual({ color: "rgb(100, 100, 100)" });
  });

  test("merges with existing inline styles", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [{ tagName: "p", style: { color: "red" }, textContent: "Styled" }],
    };

    const styles: DiffedStyle[] = [{ path: [0], style: { fontSize: "14px", fontWeight: 400 } }];

    applyStylesToTree(tree, styles);

    const p = (tree.children as JxElement[])[0]!;
    expect(p.style).toEqual({ color: "red", fontSize: "14px", fontWeight: 400 });
  });

  test("applies $media deltas as nested @breakpoint objects", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [{ tagName: "div", children: [{ tagName: "h1", textContent: "Title" }] }],
    };

    const baseStyles: DiffedStyle[] = [
      { path: [0], style: { display: "flex", flexDirection: "row" } },
    ];

    const mediaDeltas: Record<string, DiffedStyle[]> = {
      "--768": [{ path: [0], style: { flexDirection: "column" } }],
      "--640": [{ path: [0], style: { flexDirection: "column", gap: "8px" } }],
    };

    applyStylesToTree(tree, baseStyles, mediaDeltas);

    const container = (tree.children as JxElement[])[0]!;
    expect(container.style).toEqual({
      display: "flex",
      flexDirection: "row",
      "@--768": { flexDirection: "column" },
      "@--640": { flexDirection: "column", gap: "8px" },
    });
  });

  test("skips text-node children in path indexing", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [
        "Some text",
        { tagName: "p", textContent: "First element" },
        "More text",
        { tagName: "p", textContent: "Second element" },
      ],
    };

    const styles: DiffedStyle[] = [
      { path: [0], style: { color: "blue" } },
      { path: [1], style: { color: "green" } },
    ];

    applyStylesToTree(tree, styles);

    const p1 = (tree.children as JxElement[])[1]!;
    expect(p1.style).toEqual({ color: "blue" });

    const p2 = (tree.children as JxElement[])[3]!;
    expect(p2.style).toEqual({ color: "green" });
  });

  test("handles tree with no children gracefully", () => {
    const tree: JxElement = { tagName: "div" };
    const styles: DiffedStyle[] = [{ path: [0], style: { color: "red" } }];

    // Should not throw
    applyStylesToTree(tree, styles);
    expect(tree.style).toBeUndefined();
  });

  test("handles empty styles array", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [{ tagName: "p", textContent: "Hello" }],
    };

    applyStylesToTree(tree, []);

    const p = (tree.children as JxElement[])[0]!;
    expect(p.style).toBeUndefined();
  });
});
