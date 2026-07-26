/**
 * Tests for src/canvas/iframe-drop.ts — the PURE drop math (computeDropInstruction). The point
 * hit-test (resolveDropTarget) is CDP-only (happy-dom's elementFromPoint returns null), so it is
 * NOT unit-proven here; only the pure placement math + targetPath shape parity are covered.
 *
 * Geometry comes from stubRect; the targetPath parity assertion runs the REAL applyDropInstruction
 * against a live tab so the `[...parentPath, "children", idx]` shape is proven to resolve.
 */
import { resetWorkspaceWithTab, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";

// Stylebook is pulled in transitively via panels/dnd (applyDropInstruction); stub it light.
void mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
}));

const { AUTO_SCROLL_BAND, computeDropInstruction, scrollDirection } =
  await import("../src/canvas/iframe-drop");
const { applyDropInstruction } = await import("../src/panels/dnd");
const { serializeJxPath } = await import("../src/canvas/path-mapping");
const { getNodeAtPath } = await import("../src/state");
const { activeTab, closeAllTabs } = await import("../src/workspace/workspace");

type Path = (string | number)[];

/** A stub element carrying a data-jx-path and a fixed rect. */
function el(path: Path, rect: { top: number; height: number; left?: number; width?: number }) {
  const node = document.createElement("div");
  node.dataset.jxPath = serializeJxPath(path);
  stubRect(node, {
    height: rect.height,
    left: rect.left ?? 0,
    top: rect.top,
    width: rect.width ?? 100,
  });
  return node;
}

const blockSrc = { type: "block" as const };

function makeDoc(): JxMutableNode {
  return {
    children: [
      { children: [{ tagName: "h2", textContent: "title" }], tagName: "section" },
      { tagName: "p", textContent: "para" },
      { tagName: "img" },
    ],
    tagName: "div",
  };
}

beforeEach(() => {
  resetWorkspaceWithTab(makeDoc());
});

afterEach(() => {
  closeAllTabs();
});

describe("computeDropInstruction — leaf", () => {
  test("relY < 0.5 → reorder-above (edge top)", () => {
    // P (path [children,1]) is a leaf (only textContent). Cursor in the top half.
    const target = el(["children", 1], { height: 50, top: 200 });
    const out = computeDropInstruction(target, 210, makeDoc(), blockSrc);
    expect(out).toEqual({
      edge: "top",
      instruction: "reorder-above",
      referenceRect: { height: 50, width: 100, x: 0, y: 200 },
      targetPath: ["children", 1],
    });
  });

  test("relY >= 0.5 → reorder-below (edge bottom)", () => {
    const target = el(["children", 1], { height: 50, top: 200 });
    const out = computeDropInstruction(target, 240, makeDoc(), blockSrc);
    expect(out?.instruction).toBe("reorder-below");
    expect(out?.edge).toBe("bottom");
  });

  test("a void tag (img) is a leaf even though it has no textContent rule", () => {
    const target = el(["children", 2], { height: 50, top: 250 });
    const out = computeDropInstruction(target, 255, makeDoc(), blockSrc);
    expect(out?.instruction).toBe("reorder-above");
  });
});

describe("computeDropInstruction — container", () => {
  test("relY < 0.25 → reorder-above", () => {
    // Section (path [children,0]) has element children → container.
    const target = el(["children", 0], { height: 100, top: 100 });
    const out = computeDropInstruction(target, 110, makeDoc(), blockSrc);
    expect(out?.instruction).toBe("reorder-above");
    expect(out?.edge).toBe("top");
  });

  test("relY > 0.75 → reorder-below", () => {
    const target = el(["children", 0], { height: 100, top: 100 });
    const out = computeDropInstruction(target, 190, makeDoc(), blockSrc);
    expect(out?.instruction).toBe("reorder-below");
    expect(out?.edge).toBe("bottom");
  });

  test("0.25 <= relY <= 0.75 → make-child (edge inside)", () => {
    const target = el(["children", 0], { height: 100, top: 100 });
    const out = computeDropInstruction(target, 150, makeDoc(), blockSrc);
    expect(out?.instruction).toBe("make-child");
    expect(out?.edge).toBe("inside");
  });

  test("zero-height target does not divide by zero (relY treated as 0 → above)", () => {
    const target = el(["children", 0], { height: 0, top: 100 });
    const out = computeDropInstruction(target, 100, makeDoc(), blockSrc);
    expect(out?.instruction).toBe("reorder-above");
  });
});

describe("computeDropInstruction — root nearestChildEdge", () => {
  test("nearest child edge among element children, with the [...parent, children, idx] shape", () => {
    const root = el([], { height: 300, top: 100 });
    const section = el(["children", 0], { height: 100, top: 100 });
    const p = el(["children", 1], { height: 50, top: 200 });
    const img = el(["children", 2], { height: 50, top: 250 });
    root.append(section, p, img);
    // Cursor near the bottom edge of `p` (bottom=250, y=248) → reorder-below child index 1.
    const out = computeDropInstruction(root, 248, makeDoc(), blockSrc);
    expect(out?.instruction).toBe("reorder-below");
    expect(out?.targetPath).toEqual(["children", 1]);
  });

  test("empty root → make-child of root", () => {
    const root = el([], { height: 100, top: 0 });
    const out = computeDropInstruction(root, 50, makeDoc(), blockSrc);
    expect(out).toEqual({
      edge: "inside",
      instruction: "make-child",
      referenceRect: { height: 100, width: 100, x: 0, y: 0 },
      targetPath: [],
    });
  });
});

describe("computeDropInstruction — canDrop (tree-node)", () => {
  test("dropping a node onto its own descendant returns null", () => {
    // Source = section [children,0]; target = its child h2 [children,0,children,0].
    const target = el(["children", 0, "children", 0], { height: 30, top: 110 });
    const src = { path: ["children", 0], type: "tree-node" as const };
    expect(computeDropInstruction(target, 115, makeDoc(), src)).toBeNull();
  });

  test("dropping a node onto itself returns null", () => {
    const target = el(["children", 1], { height: 50, top: 200 });
    const src = { path: ["children", 1], type: "tree-node" as const };
    expect(computeDropInstruction(target, 210, makeDoc(), src)).toBeNull();
  });

  test("a block source always passes canDrop", () => {
    const target = el(["children", 0, "children", 0], { height: 30, top: 110 });
    expect(computeDropInstruction(target, 115, makeDoc(), blockSrc)).not.toBeNull();
  });
});

describe("targetPath parity through REAL applyDropInstruction", () => {
  test("root nearestChildEdge targetPath inserts a block at the resolved index", () => {
    const root = el([], { height: 300, top: 100 });
    const section = el(["children", 0], { height: 100, top: 100 });
    const p = el(["children", 1], { height: 50, top: 200 });
    const img = el(["children", 2], { height: 50, top: 250 });
    root.append(section, p, img);

    // Cursor at the bottom of `img` (y=300) → reorder-below child index 2.
    const out = computeDropInstruction(root, 300, makeDoc(), blockSrc);
    if (!out) {
      throw new Error("expected a drop preview");
    }
    expect(out.instruction).toBe("reorder-below");
    expect(out.targetPath).toEqual(["children", 2]);

    const fragment: JxMutableNode = { tagName: "hr" };
    applyDropInstruction(
      activeTab.value,
      { type: out.instruction },
      { fragment, type: "block" },
      out.targetPath,
    );

    // Reorder-below idx 2 → inserted at index 3 (end). Doc had 3 children.
    const liveDoc = activeTab.value!.doc.document as JxMutableNode;
    const children = liveDoc.children as JxMutableNode[];
    expect(children.length).toBe(4);
    expect(children[3]!.tagName).toBe("hr");
  });

  test("container make-child targetPath appends the block as the last child", () => {
    const target = el(["children", 0], { height: 100, top: 100 });
    const out = computeDropInstruction(target, 150, makeDoc(), blockSrc);
    if (!out) {
      throw new Error("expected a drop preview");
    }
    expect(out.instruction).toBe("make-child");
    expect(out.targetPath).toEqual(["children", 0]);

    const fragment: JxMutableNode = { tagName: "span" };
    applyDropInstruction(
      activeTab.value,
      { type: out.instruction },
      { fragment, type: "block" },
      out.targetPath,
    );

    const liveDoc = activeTab.value!.doc.document as JxMutableNode;
    const section = getNodeAtPath(liveDoc, ["children", 0]) as JxMutableNode;
    const kids = section.children as JxMutableNode[];
    // Section had 1 child (h2) → now 2, the span appended last.
    expect(kids.length).toBe(2);
    expect(kids[1]!.tagName).toBe("span");
  });
});

describe("scrollDirection (pure)", () => {
  test("top band → -1 (scroll up)", () => {
    expect(scrollDirection(10, 800, 40)).toBe(-1);
  });
  test("bottom band → +1 (scroll down)", () => {
    expect(scrollDirection(790, 800, 40)).toBe(1);
  });
  test("middle → 0 (no auto-scroll)", () => {
    expect(scrollDirection(400, 800, 40)).toBe(0);
  });
  test("exactly at the band edges is outside the band (boundary)", () => {
    // At y === band it is NOT < band; at y === viewportH - band it is NOT > that → both 0.
    expect(scrollDirection(40, 800, 40)).toBe(0);
    expect(scrollDirection(760, 800, 40)).toBe(0);
  });
  test("defaults to AUTO_SCROLL_BAND when no band passed", () => {
    expect(scrollDirection(AUTO_SCROLL_BAND - 1, 800)).toBe(-1);
  });
});
