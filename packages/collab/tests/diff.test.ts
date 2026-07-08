import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { applyDocOpToDoc } from "../src/ops.ts";
import { deepEqual, diffDocs, replaceYStructure } from "../src/diff.ts";
import { metaMap, seedStructure, yDocToJson } from "../src/schema.ts";

/** The core invariant: replaying the diff transforms a into b. */
function assertDiffFaithful(a: JxMutableNode, b: JxMutableNode): number {
  const ops = diffDocs(a, b);
  expect(ops).not.toBeNull();
  const replayed = structuredClone(a);
  for (const op of ops!) {
    applyDocOpToDoc(replayed, op);
  }
  expect(replayed).toEqual(b);
  return ops!.length;
}

const DOC: JxMutableNode = {
  children: [
    { attributes: { id: "hero" }, tagName: "header", textContent: "Hi" },
    { tagName: "p", textContent: "one" },
    { tagName: "p", textContent: "two" },
    "loose text",
    { children: [{ tagName: "li", textContent: "a" }], tagName: "ul" },
  ],
  state: { count: { default: 1 } },
  tagName: "div",
};

describe("diffDocs core invariant", () => {
  test("identical documents diff to zero ops", () => {
    expect(diffDocs(DOC, structuredClone(DOC))).toEqual([]);
  });

  test("key change on a nested node is one surgical set-key", () => {
    const b = structuredClone(DOC);
    (b.children as JxMutableNode[])[1]!.textContent = "changed";
    const ops = diffDocs(DOC, b)!;
    expect(ops).toEqual([
      { key: "textContent", op: "set-key", path: ["children", 1], value: "changed" },
    ]);
    assertDiffFaithful(DOC, b);
  });

  test("key deletion emits a value-less set-key", () => {
    const b = structuredClone(DOC);
    delete b.state;
    expect(diffDocs(DOC, b)).toEqual([{ key: "state", op: "set-key", path: [] }]);
  });

  test("prepend (the classic positional trap) inserts once instead of rewriting every child", () => {
    const b = structuredClone(DOC);
    (b.children as unknown[]).unshift({ tagName: "nav" });
    const ops = diffDocs(DOC, b)!;
    expect(ops).toEqual([
      { index: 0, node: { tagName: "nav" }, op: "insert-child", parentPath: [] },
    ]);
  });

  test("mid-list removal", () => {
    const b = structuredClone(DOC);
    (b.children as unknown[]).splice(1, 1);
    const ops = diffDocs(DOC, b)!;
    expect(ops).toEqual([{ index: 1, op: "remove-child", parentPath: [] }]);
  });

  test("retag degrades to remove+insert (weak keys never pair different tagNames)", () => {
    const a: JxMutableNode = { children: [{ tagName: "p", textContent: "x" }], tagName: "div" };
    const b: JxMutableNode = { children: [{ tagName: "h1", textContent: "x" }], tagName: "div" };
    const ops = diffDocs(a, b)!;
    expect(ops.map((op) => op.op).toSorted()).toEqual(["insert-child", "remove-child"]);
    assertDiffFaithful(a, b);
  });

  test("wrap: a node moving one level deeper", () => {
    const b = structuredClone(DOC);
    const children = b.children as JxMutableNode[];
    children[1] = { children: [children[1]!], tagName: "blockquote" };
    assertDiffFaithful(DOC, b);
  });

  test("reorder of identical siblings converges (as remove+insert)", () => {
    const a: JxMutableNode = {
      children: [
        { attributes: { id: "a" }, tagName: "p" },
        { attributes: { id: "b" }, tagName: "p" },
        { attributes: { id: "c" }, tagName: "p" },
      ],
      tagName: "div",
    };
    const b = structuredClone(a);
    (b.children as unknown[]).reverse();
    assertDiffFaithful(a, b);
  });

  test("id-keyed children align for recursive diffs despite content edits", () => {
    const a: JxMutableNode = {
      children: [
        { attributes: { id: "x" }, tagName: "p", textContent: "old-x" },
        { attributes: { id: "y" }, tagName: "p", textContent: "old-y" },
      ],
      tagName: "div",
    };
    const b = structuredClone(a);
    const bc = b.children as JxMutableNode[];
    bc[0]!.textContent = "new-x";
    bc[1]!.textContent = "new-y";
    const ops = diffDocs(a, b)!;
    // Both children edited in place — no splices.
    expect(ops.every((op) => op.op === "set-key")).toBe(true);
    expect(ops).toHaveLength(2);
    assertDiffFaithful(a, b);
  });

  test("string children edit via set-child", () => {
    const a: JxMutableNode = { children: ["hello", { tagName: "p" }], tagName: "div" };
    const b: JxMutableNode = { children: ["goodbye", { tagName: "p" }], tagName: "div" };
    const ops = diffDocs(a, b)!;
    expect(ops).toEqual([{ index: 0, node: "goodbye", op: "set-child", parentPath: [] }]);
  });

  test("children appearing/disappearing entirely", () => {
    const a: JxMutableNode = { tagName: "div" };
    const b: JxMutableNode = { children: [{ tagName: "p" }], tagName: "div" };
    assertDiffFaithful(a, b);
    assertDiffFaithful(b, a);
  });

  test("mapped-array children replace whole", () => {
    const a: JxMutableNode = { children: [{ tagName: "p" }], tagName: "div" };
    const b = {
      children: { map: { $ref: "#/state/items" }, template: { tagName: "li" } },
      tagName: "div",
    } as unknown as JxMutableNode;
    const ops = diffDocs(a, b)!;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ key: "children", op: "set-key", path: [] });
    assertDiffFaithful(a, b);
  });

  test("deep nested edits address the b-side path", () => {
    const b = structuredClone(DOC);
    const ul = (b.children as JxMutableNode[])[4]!;
    (ul.children as JxMutableNode[])[0]!.textContent = "z";
    const ops = diffDocs(DOC, b)!;
    expect(ops).toEqual([
      { key: "textContent", op: "set-key", path: ["children", 4, "children", 0], value: "z" },
    ]);
  });

  test("maxOps overflow returns null", () => {
    const many = (prefix: string): JxMutableNode => ({
      children: Array.from({ length: 60 }, (_, i) => ({
        tagName: "p",
        textContent: `${prefix}${i}`,
      })),
      tagName: "div",
    });
    expect(diffDocs(many("a"), many("b"), { maxOps: 10 })).toBeNull();
  });
});

describe("diffDocs randomized invariant", () => {
  function makeRng(seed: number) {
    let state = seed % 2_147_483_647;
    if (state <= 0) {
      state += 2_147_483_646;
    }
    return (maxExclusive: number): number => {
      state = (state * 16_807) % 2_147_483_647;
      return state % maxExclusive;
    };
  }

  test("random tree pairs replay faithfully", () => {
    for (const seed of [3, 11, 99, 2024]) {
      const rng = makeRng(seed);
      const randomTree = (depth: number): JxMutableNode => {
        const node: JxMutableNode = { tagName: ["div", "p", "span"][rng(3)]! };
        if (rng(2) === 0) {
          node.textContent = `t${rng(50)}`;
        }
        if (depth < 3 && rng(3) > 0) {
          node.children = Array.from({ length: rng(4) }, () =>
            rng(5) === 0 ? `s${rng(20)}` : randomTree(depth + 1),
          );
        }
        return node;
      };
      const a = randomTree(0);
      const b = randomTree(0);
      const ops = diffDocs(a, b, { maxOps: 10_000 });
      expect(ops).not.toBeNull();
      const replayed = structuredClone(a);
      for (const op of ops!) {
        applyDocOpToDoc(replayed, op);
      }
      expect(replayed).toEqual(b);
    }
  });
});

describe("deepEqual", () => {
  test("object key order is irrelevant; array order matters", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: [1, { x: null }] }, { a: [1, { x: null }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
  });
});

describe("replaceYStructure", () => {
  test("hard-replaces the tree and bumps canonicalRev", () => {
    const ydoc = new Y.Doc();
    seedStructure(ydoc, DOC);
    const before = Number(metaMap(ydoc).get("canonicalRev"));
    const next: JxMutableNode = { children: [{ tagName: "main" }], tagName: "body" };
    replaceYStructure(ydoc, next, "test");
    expect(yDocToJson(ydoc)).toEqual(next);
    expect(Number(metaMap(ydoc).get("canonicalRev"))).toBe(before + 1);
    // Stale keys from the old tree are gone.
    expect("state" in yDocToJson(ydoc)).toBe(false);
  });
});
