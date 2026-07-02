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
import type { DragSrcKind, DropPreview } from "../src/canvas/iframe-protocol";

// Stylebook is pulled in transitively via panels/dnd (applyDropInstruction); stub it light.
void mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
}));

// The inline-edit guard (grabCandidatePath returns null while editing) is unit-proven by toggling
// This mock's `editing` flag; the real inline-edit module is irrelevant to the grab math.
let editing = false;
void mock.module("../src/editor/inline-edit", () => ({
  isEditing: () => editing,
}));

const {
  AUTO_SCROLL_BAND,
  beginIframeDrag,
  cancelIframeDrag,
  clearIframeDrag,
  computeDropInstruction,
  grabCandidatePath,
  isDragActive,
  passedGrabThreshold,
  scrollDirection,
  startGrabDetector,
} = await import("../src/canvas/iframe-drop");
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
  editing = false;
  // Reset the module-global flow-3 drag-active flag so a detector in one test never leaks `dragActive`
  // Into the next (each test wires a fresh detector with its own closure `src`).
  clearIframeDrag();
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

describe("passedGrabThreshold (pure)", () => {
  const origin = { x: 100, y: 100 };
  test("within threshold → false", () => {
    expect(passedGrabThreshold(origin, { x: 102, y: 101 })).toBe(false);
  });
  test("past threshold on X → true", () => {
    expect(passedGrabThreshold(origin, { x: 105, y: 100 })).toBe(true);
  });
  test("past threshold on Y → true", () => {
    expect(passedGrabThreshold(origin, { x: 100, y: 95 })).toBe(true);
  });
});

describe("grabCandidatePath", () => {
  test("resolves the nearest [data-jx-path] ancestor's path", () => {
    const outer = el(["children", 0], { height: 50, top: 0 });
    const inner = document.createElement("span");
    outer.append(inner);
    expect(grabCandidatePath(inner)).toEqual(["children", 0]);
  });

  test("returns null when the target has no addressable ancestor", () => {
    expect(grabCandidatePath(document.createElement("div"))).toBeNull();
  });

  test("returns null for a non-Element target", () => {
    expect(grabCandidatePath(null)).toBeNull();
  });
});

describe("iframe drag-active state (flow 3 cancel single-source)", () => {
  test("begin → active; clear → inactive (no hook fired)", () => {
    let cancelled = 0;
    beginIframeDrag(() => {
      cancelled += 1;
    });
    expect(isDragActive()).toBe(true);
    clearIframeDrag();
    expect(isDragActive()).toBe(false);
    expect(cancelled).toBe(0);
  });

  test("cancelIframeDrag runs the hook once and goes inactive", () => {
    let cancelled = 0;
    beginIframeDrag(() => {
      cancelled += 1;
    });
    cancelIframeDrag();
    expect(cancelled).toBe(1);
    expect(isDragActive()).toBe(false);
    // A second cancel is a no-op (single-source: the hook never double-fires).
    cancelIframeDrag();
    expect(cancelled).toBe(1);
  });
});

describe("startGrabDetector (flow 3 — iframe-driven)", () => {
  /** A recording channel + a stub deps whose previewAt returns a fixed preview (or null). */
  function setup(preview: DropPreview | null = null) {
    const posts: Record<string, unknown>[] = [];
    const channel = { post: (m: Record<string, unknown>) => posts.push(m) };
    const seen: { previews: { cursor: { x: number; y: number }; src: DragSrcKind }[] } = {
      previews: [],
    };
    const armed: { cursor: { x: number; y: number }; dragSeq: number; src: DragSrcKind }[] = [];
    let stopped = 0;
    const deps = {
      armAutoScroll: (cursor: { x: number; y: number }, dragSeq: number, src: DragSrcKind) =>
        armed.push({ cursor, dragSeq, src }),
      gen: () => 7,
      previewAt: (cursor: { x: number; y: number }, src: DragSrcKind) => {
        seen.previews.push({ cursor, src });
        return preview;
      },
      stopAutoScroll: () => {
        stopped += 1;
      },
    };
    return { armed, channel, deps, posts, seen, stopped: () => stopped };
  }

  test("originate then drive: dragOriginate + a dragOver carrying the cursor (gen + preview)", () => {
    const preview: DropPreview = {
      edge: "top",
      instruction: "reorder-above",
      referenceRect: { height: 50, width: 100, x: 0, y: 0 },
      targetPath: ["children", 1],
    };
    const { armed, channel, deps, posts, seen } = setup(preview);
    const target = el(["children", 1], { height: 50, top: 0 });
    document.body.append(target);
    const stop = startGrabDetector(channel as never, document, deps as never);

    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    // A move past threshold originates AND drives the first move in one event.
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 30 }),
    );

    const originate = posts.find((p) => p.kind === "dragOriginate");
    expect(originate).toMatchObject({ kind: "dragOriginate", path: ["children", 1] });
    const over = posts.find((p) => p.kind === "dragOver");
    // The cursor is iframe-local (no parentCursorToIframe — the iframe owns its coords); gen + preview
    // Come straight from the injected deps.
    expect(over).toMatchObject({ cursor: { x: 20, y: 30 }, gen: 7, kind: "dragOver", preview });
    // The originate seq tags both messages (the parent adopts it).
    expect(over!.dragSeq).toBe(originate!.dragSeq);
    // The injected previewAt saw the iframe-local cursor + the tree-node src for the grabbed path.
    expect(seen.previews[0]).toEqual({
      cursor: { x: 20, y: 30 },
      src: { path: ["children", 1], type: "tree-node" },
    });
    expect(armed[0]!.src).toEqual({ path: ["children", 1], type: "tree-node" });
    expect(isDragActive()).toBe(true);

    stop();
    target.remove();
  });

  test("suppresses native dragstart while a candidate is armed or the drag is live", () => {
    // A REAL mouse press-drag over a draggable <img>/selection starts a native HTML5 drag, which
    // Pointercancels the stream and kills the grab before it originates — the detector must
    // PreventDefault dragstart from the moment a candidate is armed.
    const { channel, deps } = setup(null);
    const target = el(["children", 1], { height: 50, top: 0 });
    document.body.append(target);
    const stop = startGrabDetector(channel as never, document, deps as never);

    // No candidate armed → native drags stay native.
    const before = new Event("dragstart", { bubbles: true, cancelable: true });
    target.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    // Candidate armed (pointerdown, below threshold) → dragstart suppressed.
    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    const armedEv = new Event("dragstart", { bubbles: true, cancelable: true });
    target.dispatchEvent(armedEv);
    expect(armedEv.defaultPrevented).toBe(true);

    // Drag live (past threshold) → still suppressed.
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 30 }),
    );
    const liveEv = new Event("dragstart", { bubbles: true, cancelable: true });
    target.dispatchEvent(liveEv);
    expect(liveEv.defaultPrevented).toBe(true);

    stop();
    target.remove();
  });

  test("suppresses selectstart only while the drag is live (plain clicks keep native selection)", () => {
    const { channel, deps } = setup(null);
    const target = el(["children", 1], { height: 50, top: 0 });
    document.body.append(target);
    const stop = startGrabDetector(channel as never, document, deps as never);

    // Armed but below threshold → selection still allowed (a plain click must not lose it).
    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    const whileArmed = new Event("selectstart", { bubbles: true, cancelable: true });
    target.dispatchEvent(whileArmed);
    expect(whileArmed.defaultPrevented).toBe(false);

    // Live drag → selection suppressed for the rest of the gesture.
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 30 }),
    );
    const whileLive = new Event("selectstart", { bubbles: true, cancelable: true });
    target.dispatchEvent(whileLive);
    expect(whileLive.defaultPrevented).toBe(true);

    stop();
    target.remove();
  });

  test("clears the text selection the pre-threshold moves started when the drag originates", () => {
    const { channel, deps } = setup(null);
    const target = el(["children", 1], { height: 50, top: 0 });
    target.textContent = "grab me";
    document.body.append(target);
    const stop = startGrabDetector(channel as never, document, deps as never);

    // Simulate the selection a real press-drag builds up before the grab threshold.
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(sel.rangeCount).toBe(1);

    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 30 }),
    );
    expect(document.getSelection()!.rangeCount).toBe(0);

    stop();
    target.remove();
  });

  test("a later move (after originating) drives another dragOver from its own cursor", () => {
    const { channel, deps, posts } = setup(null);
    const target = el(["children", 1], { height: 50, top: 0 });
    document.body.append(target);
    const stop = startGrabDetector(channel as never, document, deps as never);

    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 30 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 60, clientY: 90 }),
    );
    const overs = posts.filter((p) => p.kind === "dragOver");
    expect(overs).toHaveLength(2);
    // The second dragOver carries the second cursor; preview is null (no target) but cursor present.
    expect(overs[1]).toMatchObject({ cursor: { x: 60, y: 90 }, kind: "dragOver", preview: null });

    stop();
    target.remove();
  });

  test("pointerup posts dropResult computed FRESH and tears the drag down", () => {
    const preview: DropPreview = {
      edge: "bottom",
      instruction: "reorder-below",
      referenceRect: { height: 50, width: 100, x: 0, y: 0 },
      targetPath: ["children", 1],
    };
    const { channel, deps, posts, stopped } = setup(preview);
    const target = el(["children", 1], { height: 50, top: 0 });
    document.body.append(target);
    const stop = startGrabDetector(channel as never, document, deps as never);

    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 30 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 25, clientY: 40 }),
    );

    const result = posts.find((p) => p.kind === "dropResult");
    expect(result).toMatchObject({
      gen: 7,
      instruction: "reorder-below",
      kind: "dropResult",
      targetPath: ["children", 1],
    });
    // The drag is no longer active and auto-scroll was stopped on the drop.
    expect(isDragActive()).toBe(false);
    expect(stopped()).toBeGreaterThan(0);

    stop();
    target.remove();
  });

  test("a null-target pointerup posts a dropResult with null instruction/targetPath", () => {
    const { channel, deps, posts } = setup(null);
    const target = el(["children", 1], { height: 50, top: 0 });
    document.body.append(target);
    const stop = startGrabDetector(channel as never, document, deps as never);

    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 30 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 20, clientY: 30 }),
    );
    expect(posts.find((p) => p.kind === "dropResult")).toMatchObject({
      instruction: null,
      kind: "dropResult",
      targetPath: null,
    });
    stop();
    target.remove();
  });

  test("a pointerdown that doesn't move past threshold never originates", () => {
    const { channel, deps, posts } = setup();
    const target = el(["children", 1], { height: 50, top: 0 });
    document.body.append(target);
    const stop = startGrabDetector(channel as never, document, deps as never);

    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 11, clientY: 11 }),
    );
    expect(posts.find((p) => p.kind === "dragOriginate")).toBeUndefined();
    expect(posts.find((p) => p.kind === "dragOver")).toBeUndefined();
    stop();
    target.remove();
  });

  test("a non-primary button never arms a candidate", () => {
    const { channel, deps, posts } = setup();
    const target = el(["children", 1], { height: 50, top: 0 });
    document.body.append(target);
    const stop = startGrabDetector(channel as never, document, deps as never);
    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 2, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }),
    );
    expect(posts.find((p) => p.kind === "dragOriginate")).toBeUndefined();
    stop();
    target.remove();
  });

  test("INLINE-EDIT GUARD: a pointerdown+move while editing originates nothing", () => {
    editing = true;
    // The guard returns null during an inline-edit session (typing must not start a reorder).
    const inner = document.createElement("span");
    const wrap = el(["children", 1], { height: 50, top: 0 });
    wrap.append(inner);
    expect(grabCandidatePath(inner)).toBeNull();

    const { channel, deps, posts } = setup();
    document.body.append(wrap);
    const stop = startGrabDetector(channel as never, document, deps as never);
    inner.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }),
    );
    expect(posts).toHaveLength(0);
    stop();
    wrap.remove();
  });
});
