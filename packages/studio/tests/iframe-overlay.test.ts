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
