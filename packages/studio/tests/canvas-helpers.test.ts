import { resetStudioState, resetWorkspaceWithTab, stubRect } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  bubbleInlinePath,
  effectiveZoom,
  findCanvasElement,
  getActivePanel,
  initCanvasHelpers,
  overlayBoxDescriptor,
  panelMediaToActiveMedia,
} from "../src/canvas/canvas-helpers";
import { canvasPanels, elToPath } from "../src/store";
import { closeAllTabs } from "../src/workspace/workspace";
import type { JxMutableNode } from "@jxsuite/schema/types";

beforeEach(() => {
  resetStudioState();
  canvasPanels.length = 0;
  closeAllTabs();
});

// ─── effectiveZoom ────────────────────────────────────────────────────────────

describe("effectiveZoom", () => {
  test("returns 1 in edit (content) mode regardless of zoom", () => {
    initCanvasHelpers({ getCanvasMode: () => "edit", getZoom: () => 3 });
    expect(effectiveZoom()).toBe(1);
  });

  test("returns ctx zoom in design mode", () => {
    initCanvasHelpers({ getCanvasMode: () => "design", getZoom: () => 2.5 });
    expect(effectiveZoom()).toBe(2.5);
  });

  test("falls back to active tab zoom when ctx has no getZoom", () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.zoom = 1.75;
    initCanvasHelpers({ getCanvasMode: () => "design" } as never);
    expect(effectiveZoom()).toBe(1.75);
  });

  test("falls back to 1 when no tab and no getZoom", () => {
    closeAllTabs();
    initCanvasHelpers({ getCanvasMode: () => "preview" } as never);
    expect(effectiveZoom()).toBe(1);
  });
});

// ─── panelMediaToActiveMedia ──────────────────────────────────────────────────

describe("panelMediaToActiveMedia", () => {
  test("empty string means base context (null)", () => {
    expect(panelMediaToActiveMedia("")).toBeNull();
  });

  test("null and undefined mean base context", () => {
    const missing: string | undefined = undefined;
    expect(panelMediaToActiveMedia(null)).toBeNull();
    expect(panelMediaToActiveMedia(missing)).toBeNull();
  });

  test("'base' maps to null", () => {
    expect(panelMediaToActiveMedia("base")).toBeNull();
  });

  test("named breakpoint passes through", () => {
    expect(panelMediaToActiveMedia("md")).toBe("md");
  });
});

// ─── getActivePanel ───────────────────────────────────────────────────────────

describe("getActivePanel", () => {
  test("returns null when there are no panels", () => {
    expect(getActivePanel()).toBeNull();
  });

  test("returns the only panel when there is exactly one", () => {
    const panel = { mediaName: "anything" };
    canvasPanels.push(panel as never);
    expect(getActivePanel()).toBe(panel as never);
  });

  test("activeMedia null resolves to the base panel", () => {
    resetWorkspaceWithTab();
    const base = { mediaName: "base" };
    const md = { mediaName: "md" };
    canvasPanels.push(md as never, base as never);
    expect(getActivePanel()).toBe(base as never);
  });

  test("activeMedia null resolves to a null-media panel", () => {
    resetWorkspaceWithTab();
    const plain = { mediaName: null };
    const md = { mediaName: "md" };
    canvasPanels.push(md as never, plain as never);
    expect(getActivePanel()).toBe(plain as never);
  });

  test("named activeMedia resolves to the matching panel", () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.activeMedia = "md";
    const base = { mediaName: "base" };
    const md = { mediaName: "md" };
    canvasPanels.push(base as never, md as never);
    expect(getActivePanel()).toBe(md as never);
  });

  test("falls back to the first panel when nothing matches", () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.activeMedia = "xl";
    const sm = { mediaName: "sm" };
    const md = { mediaName: "md" };
    canvasPanels.push(sm as never, md as never);
    expect(getActivePanel()).toBe(sm as never);
  });

  test("no active tab behaves like activeMedia null", () => {
    closeAllTabs();
    const base = { mediaName: "base" };
    canvasPanels.push({ mediaName: "md" } as never, base as never);
    expect(getActivePanel()).toBe(base as never);
  });
});

// ─── bubbleInlinePath ─────────────────────────────────────────────────────────

describe("bubbleInlinePath", () => {
  const doc: JxMutableNode = {
    children: [
      {
        children: [{ tagName: "strong", textContent: "bold" }],
        tagName: "p",
      },
      {
        children: [{ children: [{ tagName: "em" }], tagName: "p" }],
        tagName: "section",
      },
    ],
    tagName: "div",
  };

  test("returns path unchanged when doc is undefined", () => {
    const path = ["children", 0];
    expect(bubbleInlinePath(undefined, path)).toBe(path);
  });

  test("bubbles inline strong out of its paragraph", () => {
    const result = bubbleInlinePath(doc, ["children", 0, "children", 0]);
    expect(result).toEqual(["children", 0]);
  });

  test("stops at a non-inline ancestor (p inside div)", () => {
    const result = bubbleInlinePath(doc, ["children", 0]);
    expect(result).toEqual(["children", 0]);
  });

  test("non-inline child is returned as-is", () => {
    // P inside section is not inline-in-context
    const result = bubbleInlinePath(doc, ["children", 1, "children", 0]);
    expect(result).toEqual(["children", 1, "children", 0]);
  });

  test("bubbles em out of nested paragraph but not past section", () => {
    const result = bubbleInlinePath(doc, ["children", 1, "children", 0, "children", 0]);
    expect(result).toEqual(["children", 1, "children", 0]);
  });

  test("invalid path (missing node) returns original path", () => {
    const path = ["children", 9, "children", 0];
    expect(bubbleInlinePath(doc, path)).toBe(path);
  });

  test("short path (root) is returned as-is", () => {
    const path: (string | number)[] = [];
    expect(bubbleInlinePath(doc, path)).toBe(path);
  });

  test("defaults missing tagNames to div (non-inline)", () => {
    const anonDoc: JxMutableNode = {
      children: [{ children: [{ textContent: "x" }] }],
    } as JxMutableNode;
    const result = bubbleInlinePath(anonDoc, ["children", 0, "children", 0]);
    expect(result).toEqual(["children", 0, "children", 0]);
  });
});

// ─── findCanvasElement ────────────────────────────────────────────────────────

describe("findCanvasElement", () => {
  function buildCanvas() {
    const canvas = document.createElement("div");
    const root = document.createElement("div");
    const p0 = document.createElement("p");
    p0.textContent = "first";
    const p1 = document.createElement("p");
    p1.textContent = "second";
    root.append(p0, p1);
    canvas.append(root);
    return { canvas, p0, p1, root };
  }

  test("returns null for an empty canvas", () => {
    const canvas = document.createElement("div");
    expect(findCanvasElement([], canvas)).toBeNull();
  });

  test("empty path returns the root element", () => {
    const { canvas, root } = buildCanvas();
    expect(findCanvasElement([], canvas)).toBe(root);
  });

  test("walks children indices and verifies via elToPath", () => {
    const { canvas, p1 } = buildCanvas();
    elToPath.set(p1, ["children", 1]);
    expect(findCanvasElement(["children", 1], canvas)).toBe(p1);
  });

  test("returns null when path key is not children/cases", () => {
    const { canvas } = buildCanvas();
    expect(findCanvasElement(["style", 0], canvas)).toBeNull();
  });

  test("supports cases segments", () => {
    const { canvas, p0 } = buildCanvas();
    elToPath.set(p0, ["cases", 0]);
    expect(findCanvasElement(["cases", 0], canvas)).toBe(p0);
  });

  test("undefined index falls to first child", () => {
    const { canvas, p0 } = buildCanvas();
    elToPath.set(p0, ["children"]);
    expect(findCanvasElement(["children"], canvas)).toBe(p0);
  });

  test("'map' index dives through the repeater perimeter", () => {
    const canvas = document.createElement("div");
    const root = document.createElement("div");
    const wrapper = document.createElement("div");
    const item = document.createElement("li");
    wrapper.append(item);
    root.append(wrapper);
    canvas.append(root);
    elToPath.set(item, ["children", "map"]);
    expect(findCanvasElement(["children", "map"], canvas)).toBe(item);
  });

  test("resolves an array member node (perimeter) and its template via the 'map' hop", () => {
    const canvas = document.createElement("div");
    const root = document.createElement("div");
    const p0 = document.createElement("p");
    const perimeter = document.createElement("div"); // Array member at children[1]
    const item = document.createElement("li"); // Template
    perimeter.append(item);
    root.append(p0, perimeter);
    canvas.append(root);
    elToPath.set(perimeter, ["children", 1]);
    elToPath.set(item, ["children", 1, "map"]);
    expect(findCanvasElement(["children", 1], canvas)).toBe(perimeter);
    expect(findCanvasElement(["children", 1, "map"], canvas)).toBe(item);
  });

  test("falls back to a full scan when the direct walk dead-ends", () => {
    const { canvas, p1 } = buildCanvas();
    // Walk to children[5] fails, but p1 is registered under that path
    elToPath.set(p1, ["children", 5]);
    expect(findCanvasElement(["children", 5], canvas)).toBe(p1);
  });

  test("falls back to a full scan when the walked element path mismatches", () => {
    const { canvas, p0, p1 } = buildCanvas();
    elToPath.set(p0, ["children", 99]);
    elToPath.set(p1, ["children", 0]);
    expect(findCanvasElement(["children", 0], canvas)).toBe(p1);
  });

  test("returns null when no element matches", () => {
    const { canvas } = buildCanvas();
    expect(findCanvasElement(["children", 0], canvas)).toBeNull();
  });
});

// ─── overlayBoxDescriptor ─────────────────────────────────────────────────────

describe("overlayBoxDescriptor", () => {
  function setup() {
    const viewport = document.createElement("div");
    viewport.scrollLeft = 10;
    viewport.scrollTop = 20;
    stubRect(viewport, { height: 600, left: 100, top: 50, width: 800 });
    const el = document.createElement("p");
    stubRect(el, { height: 60, left: 150, top: 80, width: 200 });
    return { el, panel: { viewport } as never, viewport };
  }

  test("computes scaled box at zoom 2", () => {
    initCanvasHelpers({ getCanvasMode: () => "design", getZoom: () => 2 });
    const { el, panel } = setup();
    const box = overlayBoxDescriptor(el, "hover", panel);
    expect(box.cls).toBe("overlay-box overlay-hover");
    expect(box.left).toBe("30px"); // (150-100+10)/2
    expect(box.top).toBe("25px"); // (80-50+20)/2
    expect(box.width).toBe("100px");
    expect(box.height).toBe("30px");
  });

  test("edit mode uses scale 1", () => {
    initCanvasHelpers({ getCanvasMode: () => "edit", getZoom: () => 2 });
    const { el, panel } = setup();
    const box = overlayBoxDescriptor(el, "selection", panel);
    expect(box.cls).toBe("overlay-box overlay-selection");
    expect(box.left).toBe("60px");
    expect(box.top).toBe("50px");
    expect(box.width).toBe("200px");
    expect(box.height).toBe("60px");
  });
});
