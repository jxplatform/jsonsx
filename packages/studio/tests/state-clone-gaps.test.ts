/** State gaps — the array-recursion branch of normalizeArrayChildren, uncovered by state.test.ts. */
import { describe, expect, test } from "bun:test";
import { normalizeArrayChildren } from "../src/state";
import type { JxMutableNode } from "@jxsuite/schema/types";

describe("normalizeArrayChildren", () => {
  test("recurses through a top-level array of nodes", () => {
    const legacy = {
      children: { $prototype: "Array", items: [1], map: { tagName: "li" } },
      tagName: "ul",
    } as unknown as JxMutableNode;
    const list = [legacy, { tagName: "p" }] as unknown as JxMutableNode;

    const result = normalizeArrayChildren(list);
    expect(result).toBe(list);
    // The legacy whole-children repeater became a single member of a children array.
    expect(Array.isArray(legacy.children)).toBe(true);
    expect((legacy.children as JxMutableNode[])[0]!.$prototype).toBe("Array");
  });

  test("passes primitives through untouched", () => {
    expect(normalizeArrayChildren("text")).toBe("text");
    expect(normalizeArrayChildren(null)).toBeNull();
  });
});
