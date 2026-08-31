/**
 * The pure half of the differ, imported DIRECTLY from `../src/diff-core.ts`.
 *
 * The direct import is the point of the file as much as the assertions are. `diff.ts` re-exports
 * everything here, so every existing suite reaches this code through that barrel and Bun would
 * still attribute the coverage — but `scripts/check-coverage-manifest.ts` asks whether a source
 * file was loaded, and a module that only ever arrives through someone else's re-export is one
 * refactor away from being invisible to it.
 *
 * What is actually new here is {@link matchChildren} as a PUBLIC function and its `maxCells` bound.
 * `diff.test.ts` proves the replay invariant through `diffDocs`; it cannot see the pairing, because
 * `diffDocs` discards the `a`-side indices on its way to an op list.
 */

import { describe, expect, test } from "bun:test";
import { deepEqual, diffDocs, matchChildren } from "../src/diff-core.ts";

const node = (tag: string, text: string) => ({ tagName: tag, textContent: text });

describe("matchChildren", () => {
  test("pairs identical children as anchors and marks them identical", () => {
    const a = [node("p", "one"), node("p", "two")];
    const matches = matchChildren(a, structuredClone(a));
    expect(matches).toEqual([
      { aIndex: 0, bIndex: 0, identical: true },
      { aIndex: 1, bIndex: 1, identical: true },
    ]);
  });

  test("carries BOTH sides' indices when an insertion shifts them apart", () => {
    // The whole reason this is exported: b's index is 2 where a's is 1, and an op list addressed
    // In b alone could not tell the Original artboard which node to mark.
    const keep = node("p", "keep");
    const tail = node("p", "tail");
    const matches = matchChildren([keep, tail], [keep, node("p", "inserted"), tail]);
    expect(matches).toEqual([
      { aIndex: 0, bIndex: 0, identical: true },
      { aIndex: 1, bIndex: 2, identical: true },
    ]);
  });

  test("aligns a changed child by weak key rather than dropping it", () => {
    // Same tag, different text: not byte-identical, so it must come back as a NON-identical pair
    // For the caller to recurse into, not as a remove plus an insert.
    const matches = matchChildren([node("p", "before")], [node("p", "after")]);
    expect(matches).toEqual([{ aIndex: 0, bIndex: 0, identical: false }]);
  });

  test("matches never cross", () => {
    const matches = matchChildren(
      [node("h1", "a"), node("p", "b"), node("p", "c")],
      [node("p", "b"), node("h1", "a"), node("p", "c")],
    );
    const aIdx = matches.map((m) => m.aIndex);
    const bIdx = matches.map((m) => m.bIndex);
    expect(aIdx).toEqual([...aIdx].toSorted((x, y) => x - y));
    expect(bIdx).toEqual([...bIdx].toSorted((x, y) => x - y));
  });

  test("an unmatched child on either side simply has no pair", () => {
    expect(matchChildren([node("p", "gone")], [])).toEqual([]);
    expect(matchChildren([], [node("p", "new")])).toEqual([]);
  });

  describe("maxCells", () => {
    test("degrades to no matches rather than allocating the table", () => {
      const a = Array.from({ length: 40 }, (_, i) => node("p", `a${i}`));
      expect(matchChildren(a, structuredClone(a), { maxCells: 100 })).toEqual([]);
    });

    test("a budget the pair fits inside changes nothing", () => {
      const a = Array.from({ length: 4 }, (_, i) => node("p", `a${i}`));
      expect(matchChildren(a, structuredClone(a), { maxCells: 100 })).toHaveLength(4);
    });

    test("is unbounded by default, so diffDocs is untouched by the option existing", () => {
      const a = Array.from({ length: 60 }, (_, i) => node("p", `a${i}`));
      expect(matchChildren(a, structuredClone(a))).toHaveLength(60);
    });
  });
});

describe("the barrel and the pure half agree", () => {
  test("deepEqual and diffDocs are the same functions through either specifier", async () => {
    const viaBarrel = await import("../src/diff.ts");
    expect(viaBarrel.deepEqual).toBe(deepEqual);
    expect(viaBarrel.diffDocs).toBe(diffDocs);
    expect(viaBarrel.matchChildren).toBe(matchChildren);
  });
});
