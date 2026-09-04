import { describe, test, expect } from "bun:test";
import { applyStylesToTree, orderBreakpointKeys } from "../src/apply-styles.ts";
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

describe("breakpoint key order", () => {
  /*
   * `@--name` keys become `@media` blocks at equal specificity, so the LAST matching one wins.
   * Breakpoints are planned and iterated ascending, and the keys used to be written in that order,
   * which inverts the cascade for max-width: at 500px both `(max-width:767px)` and
   * `(max-width:1024px)` match and the 1024 rule was landing second. On the corpus that hit 1,900
   * nodes, 343 of them disagreeing on a real property.
   */
  const QUERIES = {
    "--767": "(max-width: 767px)",
    "--1024": "(max-width: 1024px)",
    "--1390": "(min-width: 1390px)",
  };

  test("writes max-width descending so the narrower query wins", () => {
    expect(orderBreakpointKeys(["--767", "--1024"], QUERIES)).toEqual(["--1024", "--767"]);
  });

  test("writes min-width ascending so the wider query wins", () => {
    const queries = { "--600": "(min-width: 600px)", "--1390": "(min-width: 1390px)" };
    expect(orderBreakpointKeys(["--1390", "--600"], queries)).toEqual(["--600", "--1390"]);
  });

  test("groups max-width before min-width, each in its own direction", () => {
    expect(orderBreakpointKeys(["--767", "--1390", "--1024"], QUERIES)).toEqual([
      "--1024",
      "--767",
      "--1390",
    ]);
  });

  test("keeps an unreadable query last rather than letting it displace a known one", () => {
    const queries = { ...QUERIES, "--x": "(min-width: 48rem)" };
    expect(orderBreakpointKeys(["--x", "--767", "--1024"], queries)).toEqual([
      "--1024",
      "--767",
      "--x",
    ]);
  });

  test("is stable with no query map at all", () => {
    const noQueries: Record<string, string> | undefined = undefined;
    expect(orderBreakpointKeys(["--767", "--1024"], noQueries)).toEqual(["--767", "--1024"]);
  });

  test("applies the deltas onto the node in that order", () => {
    const root: JxElement = { tagName: "div", children: [{ tagName: "p" }] as JxElement[] };
    applyStylesToTree(
      root,
      [],
      {
        "--767": [{ path: [0], style: { fontSize: "12px" } }],
        "--1024": [{ path: [0], style: { fontSize: "14px" } }],
      },
      QUERIES,
    );
    const node = (root.children as JxElement[])[0]!;
    expect(Object.keys(node.style as object)).toEqual(["@--1024", "@--767"]);
  });
});
