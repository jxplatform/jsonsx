/**
 * The selection SET — `tabs/selection.ts` (§6.5).
 *
 * The whole point of this module is one invariant, so it is what these tests hammer: **a selection
 * of one behaves exactly as a selection did before it was a list.** Every helper here is asserted
 * at `length === 1` first, against the value the old single-path field would have carried, and only
 * then at `length > 1`.
 */
import {
  cloneSelection,
  comparePaths,
  isSelected,
  isSpliceablePath,
  primarySelection,
  pruneSelection,
  rangeSelection,
  selectionAnchor,
  selectionsEqual,
  structuralBatch,
  toggleSelected,
  topLevelSelection,
  unifyValues,
  uniquePaths,
} from "../src/tabs/selection";
import { describe, expect, test } from "bun:test";

const A = ["children", 0];
const B = ["children", 1];
const C = ["children", 2];
const A0 = ["children", 0, "children", 0];

/** The Outline rows that are NOT splice coordinates, each one a single ctrl-click away. */
const ROOT: (string | number)[] = [];
const MAP_TEMPLATE = ["children", 1, "map"];
const MAP_TEMPLATE_CHILD = ["children", 1, "map", "children", 0];
const SWITCH_CASE = ["children", 1, "cases", "warn"];
const LEGACY_WHOLE_CHILDREN = ["children"];

describe("primarySelection — the single-target invariant", () => {
  test("a selection of one IS its only path, for every surface that asks", () => {
    expect(primarySelection([A])).toEqual(A);
    expect(primarySelection([[]])).toEqual([]);
  });

  test("empty and absent both mean nothing is selected", () => {
    expect(primarySelection([])).toBeNull();
    expect(primarySelection(null)).toBeNull();
    expect(primarySelection(undefined as unknown as null)).toBeNull();
  });

  test("with several, the primary is the most recently added", () => {
    expect(primarySelection([A, B, C])).toEqual(C);
  });
});

describe("selectionAnchor", () => {
  test("a selection of one is its own anchor", () => {
    expect(selectionAnchor([A])).toEqual(A);
  });

  test("the anchor is the FIRST path and survives extension", () => {
    expect(selectionAnchor([A, B, C])).toEqual(A);
    expect(selectionAnchor([])).toBeNull();
    expect(selectionAnchor(undefined as unknown as null)).toBeNull();
  });
});

describe("isSelected", () => {
  test("compares by value, not by reference", () => {
    expect(isSelected([A], ["children", 0])).toBe(true);
    expect(isSelected([A], B)).toBe(false);
  });

  test("no path and no selection are both false rather than throwing", () => {
    expect(isSelected([A], null)).toBe(false);
    expect(isSelected(null, A)).toBe(false);
    expect(isSelected(undefined as unknown as null, A)).toBe(false);
  });
});

describe("toggleSelected — ctrl/cmd-accumulate", () => {
  test("adding appends, so the new path becomes the primary and the anchor is untouched", () => {
    const next = toggleSelected([A], B);
    expect(next).toEqual([A, B]);
    expect(primarySelection(next)).toEqual(B);
    expect(selectionAnchor(next)).toEqual(A);
  });

  test("toggling a selected path removes it, keeping the survivors in order", () => {
    expect(toggleSelected([A, B, C], B)).toEqual([A, C]);
  });

  test("toggling the only selected path leaves nothing selected", () => {
    expect(toggleSelected([A], A)).toEqual([]);
  });

  test("the result never aliases the input — a caller cannot mutate a selection through it", () => {
    const before = [A];
    const next = toggleSelected(before, B);
    next[0]![0] = "MUTATED";
    expect(before[0]).toEqual(["children", 0]);
  });
});

describe("rangeSelection — shift-click", () => {
  const rows = [A, A0, B, C];

  test("downward: anchor first, target last, so a further shift re-extends from the anchor", () => {
    const next = rangeSelection(rows, A, B);
    expect(next).toEqual([A, A0, B]);
    expect(selectionAnchor(next)).toEqual(A);
    expect(primarySelection(next)).toEqual(B);
  });

  test("upward: the run is reversed so the anchor still leads", () => {
    const next = rangeSelection(rows, C, A0);
    expect(next).toEqual([C, B, A0]);
    expect(selectionAnchor(next)).toEqual(C);
    expect(primarySelection(next)).toEqual(A0);
  });

  test("anchor === target is a selection of exactly one", () => {
    expect(rangeSelection(rows, B, B)).toEqual([B]);
  });

  test("no anchor degenerates to a plain click", () => {
    expect(rangeSelection(rows, null, B)).toEqual([B]);
  });

  test("an anchor collapsed out of the visible rows degenerates to a plain click", () => {
    expect(rangeSelection([A, B], A0, B)).toEqual([B]);
  });

  test("a target the surface does not draw degenerates to that target alone", () => {
    expect(rangeSelection(rows, A, ["children", 9])).toEqual([["children", 9]]);
  });
});

describe("pruneSelection — what a deletion invalidates", () => {
  test("a one-path selection of the deleted node ends up empty, exactly as it used to", () => {
    expect(pruneSelection([A], A)).toEqual([]);
  });

  test("descendants of the deleted node go with it", () => {
    expect(pruneSelection([A0], A)).toEqual([]);
  });

  test("unrelated paths survive", () => {
    expect(pruneSelection([A, B], A)).toEqual([B]);
  });
});

describe("comparePaths", () => {
  test("numbers compare numerically, so children/10 follows children/9", () => {
    expect(comparePaths(["children", 9], ["children", 10])).toBeLessThan(0);
  });

  test("a prefix sorts before what extends it — parents before children", () => {
    expect(comparePaths(A, A0)).toBeLessThan(0);
    expect(comparePaths(A0, A)).toBeGreaterThan(0);
  });

  test("equal paths compare equal", () => {
    expect(comparePaths(A, ["children", 0])).toBe(0);
  });

  test("non-numeric segments compare by string order, in both directions", () => {
    expect(comparePaths(["cases", "a"], ["cases", "b"])).toBeLessThan(0);
    expect(comparePaths(["cases", "b"], ["cases", "a"])).toBeGreaterThan(0);
  });
});

describe("topLevelSelection", () => {
  test("a node contained by another selected node is dropped", () => {
    expect(topLevelSelection([A, A0])).toEqual([A]);
  });

  test("siblings all survive", () => {
    expect(topLevelSelection([A, B])).toEqual([A, B]);
  });

  test("one path is always top level", () => {
    expect(topLevelSelection([A0])).toEqual([A0]);
  });
});

describe("isSpliceablePath — the one path shape a structural verb can act on", () => {
  test("a tail of children + index is the only true, at any depth", () => {
    expect(isSpliceablePath(A)).toBe(true);
    expect(isSpliceablePath(A0)).toBe(true);
    expect(isSpliceablePath(MAP_TEMPLATE_CHILD)).toBe(true);
  });

  test("the document element names no position in a parent", () => {
    expect(isSpliceablePath(ROOT)).toBe(false);
  });

  test("a repeater's map template is a row, not a child slot", () => {
    // `parentElementPath(["children", 1, "map"])` is `["children"]` — the children ARRAY, whose
    // `.children` is undefined. This predicate returning false is what keeps `.splice` off it.
    expect(isSpliceablePath(MAP_TEMPLATE)).toBe(false);
  });

  test("a $switch case is a row, not a child slot", () => {
    // `childIndex` of a `$switch` case is the string "warn"; splicing at it takes the wrong child.
    expect(isSpliceablePath(SWITCH_CASE)).toBe(false);
  });

  test("the legacy whole-children repeater and a bare index are both refused", () => {
    expect(isSpliceablePath(LEGACY_WHOLE_CHILDREN)).toBe(false);
    expect(isSpliceablePath([0])).toBe(false);
    // A stringified index is not an index: `splice("1", 1)` is not the edit the path names.
    expect(isSpliceablePath(["children", "1"])).toBe(false);
  });
});

describe("structuralBatch — the order a splice loop must run in", () => {
  test("one path in, the same one path out", () => {
    expect(structuralBatch([A])).toEqual([A]);
  });

  test("LAST node first, so no splice renumbers a coordinate a later step needs", () => {
    expect(structuralBatch([A, B, C])).toEqual([C, B, A]);
  });

  test("contained paths are dropped before the ordering", () => {
    expect(structuralBatch([A0, C, A])).toEqual([C, A]);
  });

  test("a path no splice can perform never enters the loop", () => {
    // The reproduction: ctrl-click a repeater's template row, ctrl-click the paragraph below it,
    // Press Delete. What survives the filter is the paragraph alone.
    expect(structuralBatch([MAP_TEMPLATE, C])).toEqual([C]);
    expect(structuralBatch([SWITCH_CASE, A])).toEqual([A]);
  });

  test("a selected document element shadows the whole batch rather than half of it", () => {
    // `[]` and `["children"]` contain every path beside them, so containment empties the batch
    // Before spliceability ever looks at it — and neither is a splice coordinate either.
    expect(structuralBatch([ROOT, A, C])).toEqual([]);
    expect(structuralBatch([LEGACY_WHOLE_CHILDREN, A])).toEqual([]);
  });

  test("nothing spliceable in, nothing out — and no throw", () => {
    expect(structuralBatch([MAP_TEMPLATE, SWITCH_CASE])).toEqual([]);
    expect(structuralBatch([])).toEqual([]);
  });

  test("containment is decided BEFORE spliceability, on the selection the user made", () => {
    // The template shadows what is inside it: selecting the template and a node within it must
    // Yield nothing, not the child the user never pointed at.
    expect(structuralBatch([MAP_TEMPLATE, MAP_TEMPLATE_CHILD])).toEqual([]);
  });
});

describe("uniquePaths — what makes selection.setPaths idempotent", () => {
  test("the FIRST occurrence wins, so the anchor and the primary are stable", () => {
    const next = uniquePaths([A, B, A]);
    expect(next).toEqual([A, B]);
    expect(selectionAnchor(next)).toEqual(A);
  });

  test("running it twice lands on the same list", () => {
    expect(uniquePaths(uniquePaths([A, B, A]))).toEqual([A, B]);
  });
});

describe("selectionsEqual", () => {
  test("order matters, because the anchor and the primary are ends of the list", () => {
    expect(selectionsEqual([A, B], [A, B])).toBe(true);
    expect(selectionsEqual([A, B], [B, A])).toBe(false);
  });

  test("null, undefined and [] are the same selection", () => {
    expect(selectionsEqual(null, [])).toBe(true);
    expect(selectionsEqual(undefined as unknown as null, [])).toBe(true);
  });

  test("different lengths are never equal", () => {
    expect(selectionsEqual([A], [A, B])).toBe(false);
  });
});

describe("cloneSelection", () => {
  test("copies every path, so a stored selection cannot follow the live one", () => {
    const live = [A, B];
    const copy = cloneSelection(live);
    expect(copy).toEqual(live);
    copy[0]![1] = 99;
    expect(live[0]).toEqual(["children", 0]);
  });
});

describe("unifyValues — the Mixed decision", () => {
  test("one value is never mixed, which is why one selected node renders no Mixed state", () => {
    expect(unifyValues(["8px"])).toEqual({ mixed: false, value: "8px" });
  });

  test("agreement yields the agreed value", () => {
    expect(unifyValues(["8px", "8px", "8px"])).toEqual({ mixed: false, value: "8px" });
  });

  test("disagreement yields mixed with no value to show", () => {
    expect(unifyValues(["8px", "12px"])).toEqual({ mixed: true, value: undefined });
  });

  test("compares by shape, so two equal bindings written separately agree", () => {
    expect(unifyValues([{ $ref: "#/state/x" }, { $ref: "#/state/x" }]).mixed).toBe(false);
    expect(unifyValues([{ $ref: "#/state/x" }, { $ref: "#/state/y" }]).mixed).toBe(true);
  });

  test("null and undefined are the same absence", () => {
    expect(unifyValues([null, undefined as unknown as null]).mixed).toBe(false);
  });

  test("nothing to compare is not mixed", () => {
    expect(unifyValues([])).toEqual({ mixed: false, value: undefined });
  });
});
