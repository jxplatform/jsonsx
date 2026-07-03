import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  canvasRectToParent,
  createOverlayLayer,
  parentCursorToIframe,
} from "../src/canvas/iframe-overlay";

describe("canvasRectToParent", () => {
  test("maps an iframe rect straight through at zoom 1", () => {
    expect(canvasRectToParent({ height: 20, width: 100, x: 10, y: 5 })).toEqual({
      height: 20,
      left: 10,
      top: 5,
      width: 100,
    });
  });

  test("scales position and size by the zoom factor", () => {
    const rect = { height: 20, width: 100, x: 10, y: 5 };
    expect(canvasRectToParent(rect, 2)).toEqual({ height: 40, left: 20, top: 10, width: 200 });
    expect(canvasRectToParent(rect, 0.5)).toEqual({ height: 10, left: 5, top: 2.5, width: 50 });
  });
});

describe("parentCursorToIframe", () => {
  // The cursor is in true post-transform parent-viewport px; the iframe lives inside a scaled wrap,
  // So the inverse map subtracts the iframe's (panned) top-left then DIVIDES by the zoom scale.
  test("scale = 1: subtracts the iframe offset only", () => {
    expect(parentCursorToIframe({ x: 130, y: 75 }, { left: 30, top: 25 }, 1)).toEqual({
      x: 100,
      y: 50,
    });
  });

  test("scale = 2: a parent-px delta maps to half as many iframe px", () => {
    // Iframe at (30,25); cursor 200px right / 100px down of it in parent px → 100/50 iframe px.
    expect(parentCursorToIframe({ x: 230, y: 125 }, { left: 30, top: 25 }, 2)).toEqual({
      x: 100,
      y: 50,
    });
  });

  test("scale = 0.5: a parent-px delta maps to twice as many iframe px", () => {
    expect(parentCursorToIframe({ x: 80, y: 50 }, { left: 30, top: 25 }, 0.5)).toEqual({
      x: 100,
      y: 50,
    });
  });

  test("a pan offset cancels because the iframe rect's left/top are panned too", () => {
    // Same iframe content point (100,50 iframe px) under two different pans → identical result, so
    // The pan is fully absorbed by reading rectOf(iframe) fresh (its GBCR bakes in the pan).
    const noPan = parentCursorToIframe({ x: 230, y: 125 }, { left: 30, top: 25 }, 2);
    // Pan the wrap by (+40,+40): the iframe's parent rect AND the cursor both shift by 40px.
    const panned = parentCursorToIframe({ x: 270, y: 165 }, { left: 70, top: 65 }, 2);
    expect(panned).toEqual(noPan);
  });
});

describe("zoom-invariance pairing (indicator/ghost draw side uses scale=1)", () => {
  // D-2: the iframe + overlay are descendants of the scaled wrap, so the browser scales overlay
  // Boxes WITH the iframe. The indicator draw side must therefore pass scale=1 — a referenceRect in
  // Iframe-viewport px maps straight through to overlay-local px (NO extra zoom multiply).
  test("canvasRectToParent at scale=1 leaves a referenceRect unscaled even under zoom=2", () => {
    const referenceRect = { height: 40, width: 120, x: 10, y: 20 };
    const placement = canvasRectToParent(referenceRect, 1);
    expect(placement).toEqual({ height: 40, left: 10, top: 20, width: 120 });
    // The cursor map at the same zoom DIVIDES by 2 — the two sides use opposite conventions on
    // Purpose (draw=scale1, cursor=÷scale); this pairing guards a future double-scale regression.
    const cursorLocal = parentCursorToIframe({ x: 10, y: 20 }, { left: 0, top: 0 }, 2);
    expect(cursorLocal).toEqual({ x: 5, y: 10 });
  });
});

describe("createOverlayLayer", () => {
  test("builds a non-interactive layer with hidden selection + hover boxes", () => {
    const layer = createOverlayLayer(document);
    expect(layer.root.style.pointerEvents).toBe("none");
    const sel = layer.root.querySelector(".overlay-selection") as HTMLElement;
    const hover = layer.root.querySelector(".overlay-hover") as HTMLElement;
    expect(sel.style.display).toBe("none");
    expect(hover.style.display).toBe("none");
  });

  test("the insertion '+' is the one pointer-events:auto element, hidden until placed", () => {
    const layer = createOverlayLayer(document);
    // The overlay root suppresses pointer events; the "+" re-enables them so it can be clicked.
    expect(layer.root.style.pointerEvents).toBe("none");
    expect(layer.insertButton.tagName).toBe("BUTTON");
    expect(layer.insertButton.className).toContain("insertion-helper");
    expect(layer.insertButton.textContent).toBe("+");
    expect(layer.insertButton.style.pointerEvents).toBe("auto");
    expect(layer.insertButton.style.display).toBe("none");
  });

  test("setSelection positions the box, and null hides it", () => {
    const layer = createOverlayLayer(document);
    const sel = layer.root.querySelector(".overlay-selection") as HTMLElement;

    layer.setSelection({ height: 20, left: 10, top: 5, width: 100 });
    expect(sel.style.display).toBe("block");
    expect(sel.style.left).toBe("10px");
    expect(sel.style.top).toBe("5px");
    expect(sel.style.width).toBe("100px");
    expect(sel.style.height).toBe("20px");

    layer.setSelection(null);
    expect(sel.style.display).toBe("none");
  });

  test("setSelection label renders inside the box (stylebook tag chip) and clears when omitted", () => {
    const layer = createOverlayLayer(document);
    const sel = layer.root.querySelector(".overlay-selection") as HTMLElement;

    layer.setSelection({ height: 20, left: 10, top: 5, width: 100 }, "<p>");
    const label = sel.querySelector(".overlay-label") as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.textContent).toBe("<p>");
    expect(label.style.display).toBe("block");

    // A plain (label-less) selection hides the chip but keeps the box.
    layer.setSelection({ height: 20, left: 10, top: 5, width: 100 });
    expect(sel.style.display).toBe("block");
    expect(label.style.display).toBe("none");

    // One label element, reused across selections.
    layer.setSelection({ height: 1, left: 1, top: 1, width: 1 }, "<ul li>");
    expect(label.textContent).toBe("<ul li>");
    expect(sel.querySelectorAll(".overlay-label")).toHaveLength(1);
  });

  test("setHover positions the hover box independently", () => {
    const layer = createOverlayLayer(document);
    const hover = layer.root.querySelector(".overlay-hover") as HTMLElement;
    layer.setHover({ height: 8, left: 1, top: 2, width: 40 });
    expect(hover.style.display).toBe("block");
    expect(hover.style.left).toBe("1px");
    layer.setHover(null);
    expect(hover.style.display).toBe("none");
  });

  test("dispose removes the layer from its parent", () => {
    const layer = createOverlayLayer(document);
    document.body.append(layer.root);
    expect(layer.root.isConnected).toBe(true);
    layer.dispose();
    expect(layer.root.isConnected).toBe(false);
  });
});

describe("setDropIndicator (Phase 4c)", () => {
  const drop = () => {
    const layer = createOverlayLayer(document);
    return { box: layer.root.querySelector(".canvas-drop-indicator") as HTMLElement, layer };
  };

  test("starts hidden", () => {
    expect(drop().box.style.display).toBe("none");
  });

  test("edge=inside draws a dashed box over the reference rect", () => {
    const { box, layer } = drop();
    layer.setDropIndicator({ height: 40, left: 10, top: 20, width: 120 }, "inside");
    expect(box.style.display).toBe("block");
    expect(box.className).toContain("inside");
    expect(box.style.left).toBe("10px");
    expect(box.style.top).toBe("20px");
    expect(box.style.width).toBe("120px");
    expect(box.style.height).toBe("40px");
  });

  test("edge=top draws a thin line at the reference's top", () => {
    const { box, layer } = drop();
    layer.setDropIndicator({ height: 40, left: 10, top: 20, width: 120 }, "top");
    expect(box.className).toContain("line");
    expect(box.style.top).toBe("20px");
    expect(box.style.height).toBe("");
  });

  test("edge=bottom draws a thin line at the reference's bottom (top+height)", () => {
    const { box, layer } = drop();
    layer.setDropIndicator({ height: 40, left: 10, top: 20, width: 120 }, "bottom");
    expect(box.className).toContain("line");
    expect(box.style.top).toBe("60px");
  });

  test("null hides the indicator", () => {
    const { box, layer } = drop();
    layer.setDropIndicator({ height: 40, left: 10, top: 20, width: 120 }, "inside");
    layer.setDropIndicator(null);
    expect(box.style.display).toBe("none");
  });
});

describe("setInsertZone (insertion '+')", () => {
  test("centers the '+' on the anchor box, becomes visible, and tags data-edge", () => {
    const layer = createOverlayLayer(document);
    const btn = layer.insertButton;
    // A top-edge anchor box: zero-height, full width. The "+" centers on its midpoint.
    layer.setInsertZone({ height: 0, left: 10, top: 200, width: 300 }, "top");
    expect(btn.style.display).toBe("grid");
    expect(btn.classList.contains("visible")).toBe(true);
    expect(btn.dataset.edge).toBe("top");
    // Center = left + width/2 = 10 + 150 = 160; top + height/2 = 200 + 0 = 200; translated -50%.
    expect(btn.style.left).toBe("160px");
    expect(btn.style.top).toBe("200px");
    expect(btn.style.translate).toBe("-50% -50%");
  });

  test("a center zone (empty container) anchors at the box's center", () => {
    const layer = createOverlayLayer(document);
    const btn = layer.insertButton;
    layer.setInsertZone({ height: 80, left: 0, top: 0, width: 200 }, "center");
    expect(btn.dataset.edge).toBe("center");
    expect(btn.style.left).toBe("100px");
    expect(btn.style.top).toBe("40px");
  });

  test("null hides the '+' and drops the visible class", () => {
    const layer = createOverlayLayer(document);
    const btn = layer.insertButton;
    layer.setInsertZone({ height: 0, left: 10, top: 20, width: 120 }, "bottom");
    layer.setInsertZone(null);
    expect(btn.style.display).toBe("none");
    expect(btn.classList.contains("visible")).toBe(false);
  });
});
