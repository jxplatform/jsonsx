/**
 * The two-sided change map. Pure logic, so no DOM harness — but the FIRST import still matters for
 * the coverage manifest, which asks whether the source file was loaded at all.
 *
 * The assertions that earn their place are the ones `diffDocs` cannot make: that a removal is
 * addressed in the ORIGINAL document while the current side is left alone, and that a change is
 * PAIRED across the two coordinate spaces so "change 3 of 12" names one change on both artboards.
 */

import { describe, expect, test } from "bun:test";
import { buildChangeMap } from "../src/canvas/diff-marks";
import type { JxMutableNode } from "@jxsuite/schema/types";

const p = (text: string) => ({ tagName: "p", textContent: text });
const doc = (...children: unknown[]): JxMutableNode =>
  ({ children, tagName: "div" }) as unknown as JxMutableNode;

describe("buildChangeMap", () => {
  test("an identical pair yields nothing at all", () => {
    const map = buildChangeMap(doc(p("one"), p("two")), doc(p("one"), p("two")));
    expect(map.steps).toEqual([]);
    expect(map.original).toEqual([]);
    expect(map.current).toEqual([]);
    expect(map.degraded).toBe(false);
  });

  test("a removal is addressed in the ORIGINAL and leaves the current side untouched", () => {
    // The coordinate claim. `diffDocs` emits `remove-child` at parentPath + index 1, but its
    // Recursion and its later inserts are addressed in `b` — so an op list cannot tell the Original
    // Artboard which node to tint without re-deriving the alignment.
    const map = buildChangeMap(doc(p("keep"), p("gone")), doc(p("keep")));
    expect(map.original).toEqual([{ kind: "removed", path: ["children", 1] }]);
    expect(map.current).toEqual([]);
    expect(map.steps).toEqual([
      { currentPath: null, kind: "removed", originalPath: ["children", 1] },
    ]);
  });

  test("an addition is addressed in the CURRENT and leaves the original side untouched", () => {
    const map = buildChangeMap(doc(p("keep")), doc(p("keep"), p("new")));
    expect(map.current).toEqual([{ kind: "added", path: ["children", 1] }]);
    expect(map.original).toEqual([]);
  });

  test("a modified node is PAIRED, at each side's own index", () => {
    // The indices differ, which is the whole point: an insertion before the edited node shifts it
    // On one side only, and the stepper has to reveal the same change on both boards.
    // The `id` is what makes the pairing unambiguous — see the positional-alignment test below for
    // What happens without one.
    const lead = (text: string) => ({
      attributes: { id: "lead" },
      tagName: "p",
      textContent: text,
    });
    const map = buildChangeMap(
      doc(lead("edit me"), p("tail")),
      doc(p("inserted"), lead("edited"), p("tail")),
    );
    expect(map.steps.filter((step) => step.kind === "modified")).toEqual([
      { currentPath: ["children", 1], kind: "modified", originalPath: ["children", 0] },
    ]);
  });

  test("unkeyed siblings align POSITIONALLY inside a gap, not by content", () => {
    /* Worth pinning because it is a limit the marks inherit rather than a bug they can fix. Weak
       keys are `tagName` plus `id`/`$props.key`, so a run of anonymous <p>s is indistinguishable
       and the gap's LCS pairs them in order. Insert a paragraph above an edited one and the FIRST
       slot reads as modified while the last reads as added, which is the same change described from
       the other end. Authoring a key is the only thing that sharpens it. */
    const map = buildChangeMap(
      doc(p("edit me"), p("tail")),
      doc(p("inserted"), p("edited"), p("tail")),
    );
    expect(map.steps).toEqual([
      { currentPath: ["children", 0], kind: "modified", originalPath: ["children", 0] },
      { currentPath: ["children", 1], kind: "added", originalPath: null },
    ]);
  });

  test("many changed keys on one node mark it once", () => {
    // `class` rather than `id`: the weak key is tagName plus id, so changing an id makes it a
    // Different logical node and the pair becomes a removal and an addition instead.
    const before = doc({ attributes: { class: "a" }, tagName: "p", textContent: "x" });
    const after = doc({ attributes: { class: "b" }, tagName: "p", textContent: "y" });
    expect(buildChangeMap(before, after).steps).toHaveLength(1);
  });

  test("changing an id is a replacement, because the id is half the weak key", () => {
    const before = doc({ attributes: { id: "a" }, tagName: "p", textContent: "x" });
    const after = doc({ attributes: { id: "b" }, tagName: "p", textContent: "x" });
    expect(
      buildChangeMap(before, after)
        .steps.map((step) => step.kind)
        .toSorted(),
    ).toEqual(["added", "removed"]);
  });

  test("a text edit marks the element that owns the text, because textContent is a key", () => {
    const map = buildChangeMap(doc(p("before")), doc(p("after")));
    expect(map.original).toEqual([{ kind: "modified", path: ["children", 0] }]);
    expect(map.current).toEqual([{ kind: "modified", path: ["children", 0] }]);
  });

  test("a bare string child is attributed to its PARENT, which is what carries a stamp", () => {
    // Rule 2. `makeStamper` returns early for anything that is not an HTMLElement, so a mark at
    // `["children", 1]` here would name a text node the frame can never resolve.
    const map = buildChangeMap(doc(p("a"), "loose"), doc(p("a"), "changed"));
    expect(map.original).toEqual([{ kind: "modified", path: [] }]);
    expect(map.steps).toHaveLength(1);
  });

  test("several changed string children still mark the parent once", () => {
    const map = buildChangeMap(doc("one", "two"), doc("uno", "dos"));
    expect(map.steps).toHaveLength(1);
    expect(map.original).toEqual([{ kind: "modified", path: [] }]);
  });

  test("nested changes carry both paths down independently", () => {
    const section = (text: string) => ({ children: [p(text)], tagName: "section" });
    const map = buildChangeMap(doc(section("deep")), doc(p("inserted"), section("deeper")));
    expect(map.steps).toContainEqual({
      currentPath: ["children", 1, "children", 0],
      kind: "modified",
      originalPath: ["children", 0, "children", 0],
    });
  });

  describe("root keys", () => {
    test("are reported in words and never tinted", () => {
      // Rule 3: the root's stamped element is the whole page, so a mark there says "everything
      // Changed" and the reader learns nothing.
      const before = { children: [p("same")], state: { n: { default: 1 } }, tagName: "div" };
      const after = { children: [p("same")], state: { n: { default: 2 } }, tagName: "div" };
      const map = buildChangeMap(before as JxMutableNode, after as JxMutableNode);
      expect(map.rootKeys).toEqual(["state"]);
      expect(map.original).toEqual([]);
      expect(map.current).toEqual([]);
      expect(map.steps).toEqual([]);
    });

    test("a root key change alongside a node change reports both, separately", () => {
      const before = { children: [p("x")], state: { n: { default: 1 } }, tagName: "div" };
      const after = { children: [p("y")], state: { n: { default: 2 } }, tagName: "div" };
      const map = buildChangeMap(before as JxMutableNode, after as JxMutableNode);
      expect(map.rootKeys).toEqual(["state"]);
      expect(map.steps).toHaveLength(1);
    });
  });

  test("children replaced wholesale mark the owning node", () => {
    const before = doc({ children: [p("a")], tagName: "ul" });
    const after = doc({ children: "not an array", tagName: "ul" });
    expect(buildChangeMap(before, after as unknown as JxMutableNode).steps).toEqual([
      { currentPath: ["children", 0], kind: "modified", originalPath: ["children", 0] },
    ]);
  });

  test("a reorder of identical siblings is a removal plus an addition, not a move", () => {
    // Stated rather than fixed: the matcher cannot tell a move from a delete-plus-insert of an
    // Equal value, so a "moved" mark would be a claim the data does not support.
    const map = buildChangeMap(doc(p("a"), p("b")), doc(p("b"), p("a")));
    const kinds = map.steps.map((s) => s.kind).toSorted();
    expect(kinds).toEqual(["added", "removed"]);
  });

  describe("maxCells", () => {
    test("degrades a group too large to align, and says so", () => {
      const before = doc(...Array.from({ length: 30 }, (_, i) => p(`a${i}`)));
      const after = doc(...Array.from({ length: 30 }, (_, i) => p(`b${i}`)));
      const map = buildChangeMap(before, after, { maxCells: 100 });
      expect(map.degraded).toBe(true);
      // Still correct marks, just unpaired: every original child removed, every current one added.
      expect(map.original).toHaveLength(30);
      expect(map.current).toHaveLength(30);
      expect(map.steps.every((s) => s.kind !== "modified")).toBe(true);
    });

    test("a comfortable budget pairs normally and never sets degraded", () => {
      const map = buildChangeMap(doc(p("a")), doc(p("b")), { maxCells: 100 });
      expect(map.degraded).toBe(false);
      expect(map.steps).toHaveLength(1);
    });
  });

  test("steps read in document order down both sides at once", () => {
    const map = buildChangeMap(
      doc(p("gone"), p("keep"), p("edit")),
      doc(p("keep"), p("edited"), p("appended")),
    );
    expect(map.steps.map((s) => s.kind)).toEqual(["removed", "modified", "added"]);
  });
});
