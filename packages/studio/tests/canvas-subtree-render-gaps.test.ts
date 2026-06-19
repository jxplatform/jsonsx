import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { renderSubtree } from "../src/canvas/canvas-subtree-render";
import { makePathMapper } from "../src/canvas/canvas-live-render";
import type { CanvasPanel } from "../src/types";
import type { JxMutableNode } from "@jxsuite/schema/types";

const sampleDoc = (): JxMutableNode =>
  ({
    children: [{ tagName: "p", textContent: "hi" }],
    tagName: "div",
  }) as unknown as JxMutableNode;

describe("renderSubtree — guards", () => {
  test("throws when the panel has no live render context", () => {
    const panel = { liveCtx: null } as unknown as CanvasPanel;
    expect(() =>
      renderSubtree(panel, sampleDoc(), ["children", 0], document.createElement("div")),
    ).toThrow("panel-missing-live-ctx");
  });

  test("throws when the document node cannot be found", () => {
    const panel = {
      liveCtx: { pathMapper: () => {}, scope: {} },
      renderScope: null,
    } as unknown as CanvasPanel;
    expect(() =>
      renderSubtree(panel, sampleDoc(), ["children", 99], document.createElement("div")),
    ).toThrow(/node-not-found/);
  });
});

describe("renderSubtree — layout-wrapped path remap", () => {
  test("re-applies the slot-container offset for page children", () => {
    const liveCtx = {
      arrayPaths: new Set<string>(),
      canvasMode: "design",
      layoutWrapped: true,
      pageContentOffset: 1,
      pageContentPrefix: ["children", 0, "children"],
      pathMapper: makePathMapper({
        arrayPaths: new Set(),
        canvasMode: "design",
        layoutWrapped: true,
        pageContentPrefix: ["children", 0, "children"],
      }),
      scope: {},
    };
    const panel = { liveCtx, renderScope: null } as unknown as CanvasPanel;
    const el = renderSubtree(panel, sampleDoc(), ["children", 0], document.createElement("div"));
    expect(el).toBeInstanceOf(HTMLElement);
    expect((el as HTMLElement).tagName).toBe("P");
    // Canvas content never receives pointer events directly.
    expect((el as HTMLElement).style.pointerEvents).toBe("none");
  });
});
