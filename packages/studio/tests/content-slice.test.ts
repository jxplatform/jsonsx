/**
 * Character-offset slicing of block content. Pure data in, pure data out — no DOM, no document —
 * which is what makes the awkward cases (a bold run cut in half, a link straddling a boundary, a
 * `<br>` inside the range) cheap to pin down exactly.
 */
import { describe, expect, test } from "bun:test";
import {
  contentLength,
  contentOf,
  normalizeContent,
  sliceContent,
  spliceAcross,
  toStored,
} from "../src/editor/content-slice";
import type { Content } from "../src/editor/content-slice";

/** "he" + bold("ll") + "o" — length 5, with a boundary inside the bold run. */
const RICH: Content = ["he", { tagName: "strong", textContent: "ll" }, "o"];

describe("contentOf", () => {
  test("reads either storage shape", () => {
    expect(contentOf({ tagName: "p", textContent: "abc" })).toEqual(["abc"]);
    expect(
      contentOf({ children: ["a", { tagName: "em", textContent: "b" }], tagName: "p" }),
    ).toEqual(["a", { tagName: "em", textContent: "b" }]);
  });

  test("an empty or absent block has no content", () => {
    expect(contentOf({ tagName: "p", textContent: "" })).toEqual([]);
    expect(contentOf({ tagName: "p" })).toEqual([]);
    expect(contentOf(null)).toEqual([]);
  });
});

describe("contentLength", () => {
  test("counts rendered characters through nesting", () => {
    expect(contentLength(RICH)).toBe(5);
    expect(
      contentLength([
        { children: ["a", { tagName: "code", textContent: "bc" }], tagName: "strong" },
      ]),
    ).toBe(3);
  });

  test("a void inline contributes nothing", () => {
    expect(contentLength([{ tagName: "br" }])).toBe(0);
  });
});

describe("sliceContent", () => {
  test("cuts plain text", () => {
    expect(sliceContent(["hello"], 1, 4)).toEqual(["ell"]);
  });

  test("cuts an inline element in half, keeping it an element", () => {
    // The whole point: "he**ll**o" cut at 3 keeps a SHORTER BOLD RUN, not plain text.
    expect(sliceContent(RICH, 0, 3)).toEqual(["he", { tagName: "strong", textContent: "l" }]);
    expect(sliceContent(RICH, 3, 5)).toEqual([{ tagName: "strong", textContent: "l" }, "o"]);
  });

  test("keeps a fully-contained element whole", () => {
    expect(sliceContent(RICH, 2, 4)).toEqual([{ tagName: "strong", textContent: "ll" }]);
  });

  test("drops elements entirely outside the range", () => {
    expect(sliceContent(RICH, 0, 2)).toEqual(["he"]);
    expect(sliceContent(RICH, 4, 5)).toEqual(["o"]);
  });

  test("preserves an element's other attributes when clipping it", () => {
    const link: Content = [
      "go ",
      { attributes: { href: "/spec" }, tagName: "a", textContent: "there" },
    ];
    expect(sliceContent(link, 0, 6)).toEqual([
      "go ",
      { attributes: { href: "/spec" }, tagName: "a", textContent: "the" },
    ]);
  });

  test("recurses through nested inline markup", () => {
    const nested: Content = [
      { children: ["a", { tagName: "em", textContent: "bc" }], tagName: "strong" },
    ];
    expect(sliceContent(nested, 0, 2)).toEqual([
      { children: ["a", { tagName: "em", textContent: "b" }], tagName: "strong" },
    ]);
  });

  test("keeps a void inline the range reaches", () => {
    // A `<br>` has no characters to clip, so a naive length test would drop it from every slice.
    const withBreak: Content = ["a", { tagName: "br" }, "b"];
    expect(sliceContent(withBreak, 1, 2)).toEqual([{ tagName: "br" }, "b"]);
  });

  test("an empty range yields nothing", () => {
    expect(sliceContent(RICH, 2, 2)).toEqual([]);
    expect(sliceContent(RICH, 5, 5)).toEqual([]);
  });

  test("clamps past the end", () => {
    expect(sliceContent(["abc"], 1, 99)).toEqual(["bc"]);
  });
});

describe("normalizeContent", () => {
  test("merges adjacent strings and drops empties", () => {
    expect(normalizeContent(["a", "", "b", { tagName: "em", textContent: "c" }, "d", "e"])).toEqual(
      ["ab", { tagName: "em", textContent: "c" }, "de"],
    );
  });
});

describe("spliceAcross", () => {
  test("joins the head's prefix to the tail's suffix", () => {
    // Keep "First" from the head, drop through "Second" in the tail, keep " line".
    expect(spliceAcross(["First line"], 5, ["Second line"], 6)).toEqual(["First line"]);
  });

  test("inserts replacement text between them", () => {
    expect(spliceAcross(["abcdef"], 2, ["uvwxyz"], 4, "-")).toEqual(["ab-yz"]);
  });

  test("preserves markup on both sides of the join", () => {
    const head: Content = ["keep ", { tagName: "strong", textContent: "bold" }, " cut"];
    const tail: Content = ["cut ", { tagName: "em", textContent: "it" }, " keep"];
    expect(spliceAcross(head, 9, tail, 4)).toEqual([
      "keep ",
      { tagName: "strong", textContent: "bold" },
      { tagName: "em", textContent: "it" },
      " keep",
    ]);
  });

  test("selecting whole blocks leaves an empty result", () => {
    expect(spliceAcross(["all"], 0, ["gone"], 4)).toEqual([]);
  });
});

describe("toStored", () => {
  test("folds all-plain content back to textContent", () => {
    expect(toStored(["a", "b"])).toEqual({ textContent: "ab" });
    expect(toStored([])).toEqual({ textContent: "" });
  });

  test("keeps children when markup survives", () => {
    expect(toStored(["a", { tagName: "em", textContent: "b" }])).toEqual({
      children: ["a", { tagName: "em", textContent: "b" }],
    });
  });
});
