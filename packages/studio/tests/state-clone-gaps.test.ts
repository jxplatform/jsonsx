/**
 * State gaps — cloneAlongPath (structural-sharing clone used by mutation history) and the
 * array-recursion branch of normalizeArrayChildren, both uncovered by state.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { cloneAlongPath, normalizeArrayChildren } from "../src/state";
import type { JxMutableNode } from "@jxsuite/schema/types";

describe("cloneAlongPath", () => {
  test("clones every node along the path, sharing off-path subtrees", () => {
    const shared = { tagName: "aside", textContent: "shared" };
    const doc = {
      children: [{ children: [{ tagName: "em", textContent: "deep" }], tagName: "div" }, shared],
      tagName: "main",
    } as unknown as JxMutableNode;

    const { root, target } = cloneAlongPath(doc, ["children", 0, "children", 0]);
    expect(root).not.toBe(doc);
    expect(root.children).not.toBe(doc.children);
    expect((root.children as JxMutableNode[])[0]).not.toBe((doc.children as JxMutableNode[])[0]);
    // The target is the cloned leaf, mutable without touching the original.
    expect(target).not.toBe(((doc.children as JxMutableNode[])[0]!.children as JxMutableNode[])[0]);
    target.textContent = "edited";
    expect(
      ((doc.children as JxMutableNode[])[0]!.children as JxMutableNode[])[0]!.textContent,
    ).toBe("deep");
    // Off-path subtrees stay shared references.
    expect((root.children as JxMutableNode[])[1]).toBe(shared as unknown as JxMutableNode);
  });

  test("clones an array root shallowly", () => {
    const doc = [{ tagName: "p" }, { tagName: "span" }] as unknown as JxMutableNode;
    const { root, target } = cloneAlongPath(doc, [1]);
    expect(Array.isArray(root)).toBe(true);
    expect(root).not.toBe(doc);
    expect(target).not.toBe((doc as unknown as JxMutableNode[])[1]);
    expect(target.tagName).toBe("span");
  });

  test("a dead-end path returns the last existing node as the target", () => {
    const doc = { children: [{ tagName: "p" }], tagName: "div" } as unknown as JxMutableNode;
    const { root, target } = cloneAlongPath(doc, ["children", 5, "children", 0]);
    // Children[5] does not exist: the clone stops at the children array.
    expect(root).not.toBe(doc);
    expect(Array.isArray(target)).toBe(true);
    expect(target).toBe(root.children as unknown as JxMutableNode);
  });

  test("an empty path clones only the root", () => {
    const doc = { tagName: "div" } as unknown as JxMutableNode;
    const { root, target } = cloneAlongPath(doc, []);
    expect(root).not.toBe(doc);
    expect(target).toBe(root);
  });
});

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
