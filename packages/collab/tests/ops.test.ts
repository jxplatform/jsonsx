import { describe, expect, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxDocOp } from "../src/ops.ts";
import { applyDocOpToDoc, childArray, cloneValue, getNodeAtPath } from "../src/ops.ts";

function doc(): JxMutableNode {
  return {
    children: [
      { tagName: "h1", textContent: "Title" },
      { children: [{ tagName: "p" }], tagName: "section" },
    ],
    tagName: "div",
  };
}

describe("getNodeAtPath", () => {
  test("walks nested paths and tolerates missing segments", () => {
    const d = doc();
    expect(getNodeAtPath(d, [])).toBe(d);
    expect(getNodeAtPath(d, ["children", 0, "textContent"])).toBe(
      "Title" as unknown as JxMutableNode,
    );
    expect(getNodeAtPath(d, ["children", 9, "textContent"])).toBeUndefined();
  });
});

describe("childArray", () => {
  test("lazily creates children on a leaf node", () => {
    const node: JxMutableNode = { tagName: "p" };
    const children = childArray(node);
    expect(children).toEqual([]);
    expect(node.children).toBe(children);
  });

  test("refuses a children array passed as the node", () => {
    expect(() => childArray([] as unknown as JxMutableNode)).toThrow(TypeError);
  });

  test("refuses mapped-array children", () => {
    const node = { children: { map: {} }, tagName: "ul" } as unknown as JxMutableNode;
    expect(() => childArray(node)).toThrow(TypeError);
  });
});

describe("cloneValue", () => {
  test("deep-clones objects and passes null/undefined through", () => {
    const value = { nested: { a: [1, 2] } };
    const clone = cloneValue(value);
    expect(clone).toEqual(value);
    expect(clone).not.toBe(value);
    expect(clone.nested).not.toBe(value.nested);
    expect(cloneValue(null)).toBeNull();
    // oxlint-disable-next-line unicorn/no-useless-undefined -- the undefined pass-through IS the case under test
    expect(cloneValue(undefined)).toBeUndefined();
  });
});

describe("applyDocOpToDoc", () => {
  test("set-key sets, replaces, and deletes", () => {
    const d = doc();
    applyDocOpToDoc(d, { key: "textContent", op: "set-key", path: ["children", 0], value: "New" });
    expect((d.children as JxMutableNode[])[0]!.textContent).toBe("New");
    applyDocOpToDoc(d, { key: "textContent", op: "set-key", path: ["children", 0] });
    expect("textContent" in (d.children as JxMutableNode[])[0]!).toBe(false);
  });

  test("set-key on a missing node throws with a machine-readable reason", () => {
    expect(() =>
      applyDocOpToDoc(doc(), { key: "x", op: "set-key", path: ["children", 9], value: 1 }),
    ).toThrow("doc-op-node-not-found:children/9");
  });

  test("insert/remove/set-child splice the children array", () => {
    const d = doc();
    applyDocOpToDoc(d, { index: 1, node: "loose", op: "insert-child", parentPath: [] });
    expect((d.children as unknown[])[1]).toBe("loose");
    applyDocOpToDoc(d, {
      index: 1,
      node: { tagName: "aside" },
      op: "set-child",
      parentPath: [],
    });
    expect((d.children as JxMutableNode[])[1]!.tagName).toBe("aside");
    applyDocOpToDoc(d, { index: 1, op: "remove-child", parentPath: [] });
    expect(d.children).toHaveLength(2);
  });

  test("move-child resolves both parents before splicing (same-level sibling move)", () => {
    const d = doc();
    // Move h1 into the section (which sits at index 1 BEFORE the removal).
    applyDocOpToDoc(d, {
      fromIndex: 0,
      fromParentPath: [],
      op: "move-child",
      toIndex: 1,
      toParentPath: ["children", 1],
    });
    expect(d.children).toHaveLength(1);
    const section = (d.children as JxMutableNode[])[0]!;
    expect((section.children as JxMutableNode[])[1]!.tagName).toBe("h1");
  });

  test("inserted nodes are cloned, never aliased to the op", () => {
    const d = doc();
    const node = { tagName: "em" };
    applyDocOpToDoc(d, { index: 0, node, op: "insert-child", parentPath: [] });
    node.tagName = "mutated";
    expect((d.children as JxMutableNode[])[0]!.tagName).toBe("em");
  });

  test("unknown op kinds throw", () => {
    expect(() => applyDocOpToDoc(doc(), { op: "nope" } as unknown as JxDocOp)).toThrow(
      "unknown-doc-op:nope",
    );
  });
});
