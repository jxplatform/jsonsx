import { describe, expect, test } from "bun:test";
import { applyDocOpToDoc, childArray, cloneValue } from "../src/tabs/doc-op-apply";
import type { JxDocOp } from "../src/tabs/patch-ops";
import type { JxMutableNode } from "@jxsuite/schema/types";

const doc = (): JxMutableNode =>
  ({
    children: [
      { tagName: "p", textContent: "a" },
      { tagName: "p", textContent: "b" },
    ],
    tagName: "div",
  }) as unknown as JxMutableNode;

describe("applyDocOpToDoc", () => {
  test("set-key sets a value (cloned, not aliased)", () => {
    const d = doc();
    const value = { color: "red" };
    applyDocOpToDoc(d, { key: "style", op: "set-key", path: ["children", 0], value });
    const node = (d.children as JxMutableNode[])[0]!;
    expect(node.style).toEqual({ color: "red" });
    // Stored value is a clone — mutating the source must not leak in.
    value.color = "blue";
    expect((node.style as { color: string }).color).toBe("red");
  });

  test("set-key with undefined value deletes the key", () => {
    const d = doc();
    applyDocOpToDoc(d, {
      key: "textContent",
      op: "set-key",
      path: ["children", 0],
      value: undefined,
    });
    expect((d.children as JxMutableNode[])[0]!.textContent).toBeUndefined();
  });

  test("set-key throws on a missing node", () => {
    expect(() =>
      applyDocOpToDoc(doc(), { key: "x", op: "set-key", path: ["children", 9], value: 1 }),
    ).toThrow(/doc-op-node-not-found/);
  });

  test("insert-child / remove-child / set-child splice the children array", () => {
    const d = doc();
    applyDocOpToDoc(d, {
      index: 1,
      node: { tagName: "span" },
      op: "insert-child",
      parentPath: [],
    });
    expect((d.children as JxMutableNode[]).map((c) => c.tagName)).toEqual(["p", "span", "p"]);

    applyDocOpToDoc(d, { index: 0, op: "remove-child", parentPath: [] });
    expect((d.children as JxMutableNode[]).map((c) => c.tagName)).toEqual(["span", "p"]);

    applyDocOpToDoc(d, { index: 0, node: { tagName: "h1" }, op: "set-child", parentPath: [] });
    expect((d.children as JxMutableNode[]).map((c) => c.tagName)).toEqual(["h1", "p"]);
  });

  test("move-child relocates a node between children arrays", () => {
    const d = {
      children: [
        { children: [{ tagName: "a" }], tagName: "div" },
        { children: [], tagName: "div" },
      ],
      tagName: "div",
    } as unknown as JxMutableNode;
    applyDocOpToDoc(d, {
      fromIndex: 0,
      fromParentPath: ["children", 0],
      op: "move-child",
      toIndex: 0,
      toParentPath: ["children", 1],
    });
    const kids = d.children as JxMutableNode[];
    expect((kids[0]!.children as JxMutableNode[]).length).toBe(0);
    expect((kids[1]!.children as JxMutableNode[])[0]!.tagName).toBe("a");
  });

  test("throws on an unknown op", () => {
    expect(() => applyDocOpToDoc(doc(), { op: "bogus" } as unknown as JxDocOp)).toThrow(
      /unknown-doc-op/,
    );
  });
});

describe("cloneValue", () => {
  test("passes through null/undefined and deep-clones objects", () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- verifying the undefined pass-through
    expect(cloneValue(undefined)).toBeUndefined();
    expect(cloneValue(null)).toBeNull();
    const src = { a: { b: 1 } };
    const out = cloneValue(src);
    expect(out).toEqual(src);
    expect(out.a).not.toBe(src.a);
  });
});

describe("childArray", () => {
  test("lazily creates the children array", () => {
    const node = { tagName: "div" } as unknown as JxMutableNode;
    const arr = childArray(node);
    expect(arr).toEqual([]);
    expect(node.children).toBe(arr);
  });

  test("throws when the target is a children array, not a node", () => {
    expect(() => childArray([] as unknown as JxMutableNode)).toThrow(/must point at a node/);
  });

  test("throws on mapped-array (non-array) children", () => {
    const mapped = { children: { $map: [] } } as unknown as JxMutableNode;
    expect(() => childArray(mapped)).toThrow(/mapped-array/);
  });
});
