/**
 * The diff panes' review state: the change map, the cursor, and the Visual/Code choice.
 *
 * Pane-keyed, and the tests say so: two panes comparing two files at once is the ordinary case (the
 * Source Control panel's diff in the primary, a Diff lens beside it), and it is the shape an
 * app-level slot got wrong before the lens carried its own comparison.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearDiffView,
  diffChangeCount,
  diffChangeMapOf,
  diffStepOf,
  diffViewOf,
  resetDiffViews,
  setDiffChangeMap,
  setDiffView,
  stepDiff,
} from "../src/canvas/diff-view";
import type { ChangeMap } from "../src/canvas/diff-marks";

const mapOf = (count: number): ChangeMap => ({
  current: [],
  degraded: false,
  original: [],
  rootKeys: [],
  steps: Array.from({ length: count }, (_, i) => ({
    currentPath: ["children", i],
    kind: "modified" as const,
    originalPath: ["children", i],
  })),
});

beforeEach(() => {
  resetDiffViews();
});

describe("the cursor", () => {
  test("starts before the list, so the first forward step lands on the first change", () => {
    setDiffChangeMap("primary", mapOf(3));
    expect(diffStepOf("primary")).toBe(-1);
    expect(stepDiff("primary", 1)).toBe(0);
  });

  test("enters from the end it is aimed at", () => {
    setDiffChangeMap("primary", mapOf(3));
    expect(stepDiff("primary", -1)).toBe(2);
  });

  test("stops at each end rather than wrapping", () => {
    // A tab strip is a ring; a change list is a document read top to bottom, and wrapping would
    // Silently return a reviewer to a part of the page they had already cleared.
    setDiffChangeMap("primary", mapOf(2));
    expect(stepDiff("primary", 1)).toBe(0);
    expect(stepDiff("primary", 1)).toBe(1);
    expect(stepDiff("primary", 1)).toBeNull();
    expect(diffStepOf("primary")).toBe(1);
  });

  test("refuses to move when there are no changes", () => {
    setDiffChangeMap("primary", mapOf(0));
    expect(stepDiff("primary", 1)).toBeNull();
    expect(diffChangeCount("primary")).toBe(0);
  });

  test("is CLAMPED across a re-read, not reset", () => {
    /* The save loop. Every save re-reads the comparison and rebuilds the map, so resetting here
       would send an author who had reached change 7 back to change 1 on every ⌘S. */
    setDiffChangeMap("primary", mapOf(10));
    stepDiff("primary", 1);
    stepDiff("primary", 1);
    stepDiff("primary", 1);
    expect(diffStepOf("primary")).toBe(2);
    setDiffChangeMap("primary", mapOf(10));
    expect(diffStepOf("primary")).toBe(2);
  });

  test("clamps down when the list got shorter than the cursor", () => {
    setDiffChangeMap("primary", mapOf(10));
    for (let i = 0; i < 8; i++) {
      stepDiff("primary", 1);
    }
    expect(diffStepOf("primary")).toBe(7);
    setDiffChangeMap("primary", mapOf(3));
    expect(diffStepOf("primary")).toBe(2);
  });

  test("goes back before the list when every change is gone", () => {
    setDiffChangeMap("primary", mapOf(4));
    stepDiff("primary", 1);
    setDiffChangeMap("primary", mapOf(0));
    expect(diffStepOf("primary")).toBe(-1);
  });
});

describe("per pane", () => {
  test("two panes hold two independent comparisons and two cursors", () => {
    setDiffChangeMap("primary", mapOf(5));
    setDiffChangeMap("secondary", mapOf(2));
    stepDiff("primary", 1);
    stepDiff("primary", 1);
    expect(diffStepOf("primary")).toBe(1);
    expect(diffStepOf("secondary")).toBe(-1);
    expect(diffChangeCount("secondary")).toBe(2);
  });

  test("the view choice is per pane too", () => {
    setDiffView("primary", "code");
    expect(diffViewOf("primary")).toBe("code");
    expect(diffViewOf("secondary")).toBe("visual");
  });

  test("clearing one pane leaves the other alone", () => {
    setDiffChangeMap("primary", mapOf(3));
    setDiffChangeMap("secondary", mapOf(3));
    clearDiffView("primary");
    expect(diffChangeMapOf("primary")).toBeNull();
    expect(diffChangeCount("secondary")).toBe(3);
  });
});

describe("defaults", () => {
  test("an unknown pane reads as empty and visual, never throwing", () => {
    expect(diffChangeMapOf("nobody")).toBeNull();
    expect(diffChangeCount("nobody")).toBe(0);
    expect(diffStepOf("nobody")).toBe(-1);
    expect(diffViewOf("nobody")).toBe("visual");
    expect(stepDiff("nobody", 1)).toBeNull();
  });

  test("a comparison that could not be built is a null map, not an absent pane", () => {
    setDiffChangeMap("primary", null);
    expect(diffChangeMapOf("primary")).toBeNull();
    expect(diffChangeCount("primary")).toBe(0);
  });
});
