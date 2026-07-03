/**
 * Tests for src/canvas/iframe-insert.ts — the PURE insertion-"+"-zone math (computeInsertZones).
 * The point hit-test (resolving the hovered element from a cursor) is CDP-only and lives in
 * iframe-interaction; only the pure edge/index math is unit-proven here, following
 * iframe-drop.test.
 *
 * Geometry comes from stubRect; layout direction (row vs column) is driven by inline parent styles
 * (happy-dom's getComputedStyle reads them). The posted insertParentPath + index are the exact
 * parentElementPath/childIndex of the hovered path, so they feed mutateInsertNode unchanged.
 */
import { stubRect } from "./harness";
import { describe, expect, test } from "bun:test";
import { computeInsertZones, EDGE_THRESHOLD, insertZonesKey } from "../src/canvas/iframe-insert";
import { serializeJxPath } from "../src/canvas/path-mapping";
import type { JxMutableNode } from "@jxsuite/schema/types";

type Path = (string | number)[];

/** A stub element carrying a data-jx-path and a fixed iframe-viewport rect. */
function el(path: Path, rect: { top: number; left: number; width: number; height: number }) {
  const node = document.createElement("div");
  node.dataset.jxPath = serializeJxPath(path);
  stubRect(node, rect);
  return node;
}

/** A parent element with an explicit layout direction (for the row/column branch). */
function parentWith(child: HTMLElement, css: Partial<CSSStyleDeclaration>): HTMLElement {
  const parent = document.createElement("div");
  Object.assign(parent.style, css);
  parent.append(child);
  document.body.append(parent);
  return parent;
}

// The math ignores the shadow doc (it resolves structure from the stamped path); a stub satisfies
// The signature parity with iframe-drop's computeDropInstruction.
const DOC: JxMutableNode = { children: [], tagName: "div" };

describe("computeInsertZones — empty container", () => {
  test("an empty-container-placeholder → one centered zone inserting as first child", () => {
    const target = el(["children", 0], { height: 80, left: 10, top: 20, width: 200 });
    target.classList.add("empty-container-placeholder");
    document.body.append(target);
    const zones = computeInsertZones(target, { x: 100, y: 60 }, DOC);
    expect(zones).toEqual([
      {
        edge: "center",
        index: 0,
        insertParentPath: ["children", 0],
        rect: { height: 80, width: 200, x: 10, y: 20 },
      },
    ]);
  });
});

describe("computeInsertZones — column layout (top/bottom edges)", () => {
  test("cursor within EDGE_THRESHOLD of the top edge → leading zone (index = childIndex)", () => {
    const target = el(["children", 1], { height: 100, left: 0, top: 200, width: 300 });
    parentWith(target, { display: "block" });
    // RelY = 205 - 200 = 5 < 14 → top edge, insert BEFORE (index 1) into the parent [].
    const zones = computeInsertZones(target, { x: 50, y: 205 }, DOC);
    expect(zones).toEqual([
      {
        edge: "top",
        index: 1,
        insertParentPath: [],
        rect: { height: 0, width: 300, x: 0, y: 200 },
      },
    ]);
  });

  test("cursor within EDGE_THRESHOLD of the bottom edge → trailing zone (index = childIndex + 1)", () => {
    const target = el(["children", 1], { height: 100, left: 0, top: 200, width: 300 });
    parentWith(target, { display: "block" });
    // RelY = 295 - 200 = 95; height - relY = 5 < 14 → bottom edge, insert AFTER (index 2).
    const zones = computeInsertZones(target, { x: 50, y: 295 }, DOC);
    expect(zones).toEqual([
      {
        edge: "bottom",
        index: 2,
        insertParentPath: [],
        rect: { height: 0, width: 300, x: 0, y: 300 },
      },
    ]);
  });

  test("cursor mid-element (no near edge) → null", () => {
    const target = el(["children", 1], { height: 100, left: 0, top: 200, width: 300 });
    parentWith(target, { display: "block" });
    expect(computeInsertZones(target, { x: 50, y: 250 }, DOC)).toBeNull();
  });
});

describe("computeInsertZones — row layout (left/right edges)", () => {
  test("a flex-row parent: cursor near the left edge → leading zone with a left anchor rect", () => {
    const target = el(["children", 2], { height: 40, left: 100, top: 0, width: 80 });
    parentWith(target, { display: "flex", flexDirection: "row" });
    // RelX = 108 - 100 = 8 < 14 → left edge, insert BEFORE (index 2).
    const zones = computeInsertZones(target, { x: 108, y: 20 }, DOC);
    expect(zones).toEqual([
      {
        edge: "left",
        index: 2,
        insertParentPath: [],
        rect: { height: 40, width: 0, x: 100, y: 0 },
      },
    ]);
  });

  test("a flex-row parent: cursor near the right edge → trailing zone (index + 1), right anchor", () => {
    const target = el(["children", 2], { height: 40, left: 100, top: 0, width: 80 });
    parentWith(target, { display: "flex", flexDirection: "row" });
    // RelX = 175 - 100 = 75; width - relX = 5 < 14 → right edge, insert AFTER (index 3).
    const zones = computeInsertZones(target, { x: 175, y: 20 }, DOC);
    expect(zones).toEqual([
      {
        edge: "right",
        index: 3,
        insertParentPath: [],
        rect: { height: 40, width: 0, x: 180, y: 0 },
      },
    ]);
  });

  test("a grid parent with grid-auto-flow:column is also a row layout (left/right edges)", () => {
    const target = el(["children", 0], { height: 40, left: 100, top: 0, width: 80 });
    parentWith(target, { display: "grid", gridAutoFlow: "column" });
    const zones = computeInsertZones(target, { x: 102, y: 20 }, DOC);
    expect(zones?.[0]!.edge).toBe("left");
  });

  test("a plain flex (column default) uses TOP/BOTTOM edges, not left/right", () => {
    // Display:flex with no row flex-direction → flexDirection defaults to "column" → column branch.
    const target = el(["children", 0], { height: 100, left: 0, top: 0, width: 300 });
    parentWith(target, { display: "flex" });
    const zones = computeInsertZones(target, { x: 150, y: 5 }, DOC);
    expect(zones?.[0]!.edge).toBe("top");
  });

  test("a flex-row parent: cursor mid-element (neither left nor right edge) → null", () => {
    const target = el(["children", 2], { height: 40, left: 100, top: 0, width: 80 });
    parentWith(target, { display: "flex", flexDirection: "row" });
    // RelX = 140 - 100 = 40, and width - relX = 40 — both ≥ 14 → no edge zone.
    expect(computeInsertZones(target, { x: 140, y: 20 }, DOC)).toBeNull();
  });
});

describe("computeInsertZones — root / degenerate → null", () => {
  test("the root element (path.length < 2, no parent element path) → null", () => {
    const target = el([], { height: 100, left: 0, top: 0, width: 300 });
    parentWith(target, { display: "block" });
    expect(computeInsertZones(target, { x: 50, y: 1 }, DOC)).toBeNull();
  });

  test("a one-segment path (e.g. ['map']) has no parentElementPath → null", () => {
    const target = el(["map"], { height: 100, left: 0, top: 0, width: 300 });
    parentWith(target, { display: "block" });
    expect(computeInsertZones(target, { x: 50, y: 1 }, DOC)).toBeNull();
  });

  test("an element with no data-jx-path → null", () => {
    const node = document.createElement("div");
    stubRect(node, { height: 100, left: 0, top: 0, width: 300 });
    expect(computeInsertZones(node, { x: 50, y: 1 }, DOC)).toBeNull();
  });

  test("a non-numeric childIndex (e.g. ['cases','default']) → null", () => {
    // ParentElementPath is non-null here (length 2), but the last segment is a string → no sibling
    // Index to insert at, so the math bails rather than producing an unusable zone.
    const target = el(["cases", "default"], { height: 100, left: 0, top: 0, width: 300 });
    parentWith(target, { display: "block" });
    expect(computeInsertZones(target, { x: 50, y: 1 }, DOC)).toBeNull();
  });

  test("a detached element (no parentElement) → null even with a sibling path", () => {
    const target = el(["children", 1], { height: 100, left: 0, top: 0, width: 300 });
    // Not appended to any parent → targetEl.parentElement is null.
    expect(computeInsertZones(target, { x: 50, y: 1 }, DOC)).toBeNull();
  });
});

describe("EDGE_THRESHOLD", () => {
  test("is the salvaged 14px constant", () => {
    expect(EDGE_THRESHOLD).toBe(14);
  });
});

describe("insertZonesKey", () => {
  test("null and empty collapse to the same sentinel so no redundant post fires", () => {
    expect(insertZonesKey(null)).toBe("none");
    expect(insertZonesKey([])).toBe("none");
  });

  test("encodes edge + parentPath + index so a changed zone gets a fresh key", () => {
    const a = insertZonesKey([{ edge: "top", index: 1, insertParentPath: [], rect: zeroRect() }]);
    const b = insertZonesKey([
      { edge: "bottom", index: 2, insertParentPath: [], rect: zeroRect() },
    ]);
    expect(a).toBe("top::1");
    expect(b).toBe("bottom::2");
    expect(a).not.toBe(b);
  });

  test("the same structural zone with a different rect yields the same key (rect not in the key)", () => {
    const a = insertZonesKey([
      { edge: "top", index: 1, insertParentPath: ["children", 0], rect: zeroRect() },
    ]);
    const b = insertZonesKey([
      {
        edge: "top",
        index: 1,
        insertParentPath: ["children", 0],
        rect: { height: 9, width: 9, x: 9, y: 9 },
      },
    ]);
    expect(a).toBe(b);
    expect(a).toBe("top:children/0:1");
  });
});

function zeroRect() {
  return { height: 0, width: 0, x: 0, y: 0 };
}
