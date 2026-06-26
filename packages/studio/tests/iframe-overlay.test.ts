import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { canvasRectToParent, createOverlayLayer } from "../src/canvas/iframe-overlay";

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
