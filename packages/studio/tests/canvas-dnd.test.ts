/**
 * Tests for src/panels/canvas-dnd.ts — canvas drop targets, the panel drag monitor, and the drop
 * indicator geometry.
 *
 * The pragmatic-drag-and-drop adapter is mocked to capture registrations so callbacks can be driven
 * directly with synthetic locations; element geometry comes from stubRect.
 */
import { resetWorkspaceWithTab, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";

type AnyRec = Record<string, any>;

const dropTargets: AnyRec[] = [];
const monitors: AnyRec[] = [];

mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: () => () => {},
  dropTargetForElements: (cfg: AnyRec) => {
    dropTargets.push(cfg);
    return () => {};
  },
  monitorForElements: (cfg: AnyRec) => {
    monitors.push(cfg);
    return () => {};
  },
}));

// Imported transitively via panels/dnd; stubbed to keep the graph light.
mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
}));

const { canvasPanels, elToPath } = await import("../src/store");
const { view } = await import("../src/view");
const { closeAllTabs } = await import("../src/workspace/workspace");
const { initCanvasHelpers } = await import("../src/canvas/canvas-helpers");
const { registerPanelDnD, registerSubtreeDnD } = await import("../src/panels/canvas-dnd");

let mode = "design";
let zoom = 1;
initCanvasHelpers({ getCanvasMode: () => mode, getZoom: () => zoom });

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

interface Fixture {
  panel: AnyRec;
  rootEl: HTMLElement;
  sectionEl: HTMLElement;
  h2El: HTMLElement;
  pEl: HTMLElement;
  imgEl: HTMLElement;
  orphanEl: HTMLElement;
  monitor: AnyRec;
  dropFor: (el: Element) => AnyRec;
}

function makePanel(): AnyRec {
  const element = document.createElement("div");
  const viewport = document.createElement("div");
  const canvas = document.createElement("div");
  const overlayClk = document.createElement("div");
  const dropLine = document.createElement("div");
  viewport.append(canvas);
  element.append(viewport, overlayClk, dropLine);
  document.body.append(element);
  stubRect(viewport, { height: 1000, left: 0, top: 0, width: 1000 });
  return { canvas, dropLine, element, mediaName: "base", overlayClk, viewport };
}

/** Canvas mirroring makeDoc(): root(path []) > section > h2, p, img + an unmapped orphan. */
function setupCanvas(): Fixture {
  const panel = makePanel();
  canvasPanels.push(panel as never);
  const { canvas } = panel;
  const rootEl = document.createElement("div");
  const sectionEl = document.createElement("section");
  const h2El = document.createElement("h2");
  const pEl = document.createElement("p");
  const imgEl = document.createElement("img");
  const orphanEl = document.createElement("div");
  sectionEl.append(h2El);
  rootEl.append(sectionEl, pEl, imgEl);
  canvas.append(rootEl, orphanEl);

  elToPath.set(rootEl, []);
  elToPath.set(sectionEl, ["children", 0]);
  elToPath.set(h2El, ["children", 0, "children", 0]);
  elToPath.set(pEl, ["children", 1]);
  elToPath.set(imgEl, ["children", 2]);

  stubRect(rootEl, { height: 300, left: 0, top: 100, width: 300 });
  stubRect(sectionEl, { height: 100, left: 10, top: 100, width: 200 });
  stubRect(h2El, { height: 30, left: 20, top: 110, width: 100 });
  stubRect(pEl, { height: 50, left: 10, top: 200, width: 200 });
  stubRect(imgEl, { height: 50, left: 10, top: 250, width: 50 });

  const before = dropTargets.length;
  registerPanelDnD(panel as never);
  expect(dropTargets.length - before).toBe(5); // Orphan skipped
  const monitor = monitors.at(-1)!;
  const dropFor = (el: Element) => dropTargets.find((d) => d.element === el)!;
  return { dropFor, h2El, imgEl, monitor, orphanEl, pEl, panel, rootEl, sectionEl };
}

const loc = (
  targets: { data: AnyRec; element: Element }[],
  input?: { clientX: number; clientY: number },
) => ({ current: { dropTargets: targets, input: input ?? { clientX: 0, clientY: 0 } } });

const targetOf = (el: Element, path: unknown, isVoid = false) => ({
  data: { _isVoid: isVoid, path },
  element: el,
});

beforeEach(() => {
  mode = "design";
  zoom = 1;
  dropTargets.length = 0;
  monitors.length = 0;
  view.canvasDndCleanups = [];
  view.lastDragInput = null;
  resetWorkspaceWithTab(makeDoc());
});

afterEach(() => {
  // Drop with no target resets the module-level _activeDropEl and panel indicators
  monitors.at(-1)?.onDrop({ location: loc([]), source: { data: {} } });
  for (const p of canvasPanels as unknown as AnyRec[]) {
    p.element.remove();
  }
  canvasPanels.length = 0;
});

describe("registerElementDropTarget — getData/canDrop", () => {
  test("getData reflects live leaf-ness from the document", () => {
    const { dropFor, sectionEl, pEl, imgEl, rootEl } = setupCanvas();
    expect(dropFor(sectionEl).getData()).toEqual({ _isVoid: false, path: ["children", 0] });
    // P has only a textContent — no element children
    expect(dropFor(pEl).getData()).toEqual({ _isVoid: true, path: ["children", 1] });
    // Img is a void element
    expect(dropFor(imgEl).getData()).toEqual({ _isVoid: true, path: ["children", 2] });
    expect(dropFor(rootEl).getData()).toEqual({ _isVoid: false, path: [] });
  });

  test("getData treats a missing document as void", () => {
    const { dropFor, sectionEl } = setupCanvas();
    closeAllTabs();
    expect(dropFor(sectionEl).getData()).toEqual({ _isVoid: true, path: ["children", 0] });
  });

  test("getData falls back to an empty path when the element was unmapped", () => {
    const { dropFor, h2El } = setupCanvas();
    elToPath.delete(h2El);
    expect(dropFor(h2El).getData().path).toEqual([]);
  });

  test("canDrop rejects unmapped elements and descendant drops", () => {
    const { dropFor, sectionEl, h2El, pEl } = setupCanvas();
    expect(dropFor(h2El).canDrop({ source: { data: { path: ["children", 0] } } })).toBe(false);
    expect(dropFor(pEl).canDrop({ source: { data: { path: ["children", 0] } } })).toBe(true);
    expect(dropFor(sectionEl).canDrop({ source: { data: {} } })).toBe(true);
    elToPath.delete(sectionEl);
    expect(dropFor(sectionEl).canDrop({ source: { data: {} } })).toBe(false);
  });
});

describe("monitor — drag lifecycle", () => {
  test("onDragStart enables pointer events on canvas elements and disables overlays", () => {
    const { monitor, panel, sectionEl } = setupCanvas();
    monitor.onDragStart({ location: loc([], { clientX: 5, clientY: 6 }) });
    expect(view.lastDragInput).toEqual({ clientX: 5, clientY: 6 });
    expect(sectionEl.style.pointerEvents).toBe("auto");
    expect(panel.overlayClk.style.pointerEvents).toBe("none");
  });

  test("onDrag over a non-leaf middle shows the inside indicator", () => {
    const { monitor, panel, sectionEl } = setupCanvas();
    monitor.onDrag({
      location: loc([targetOf(sectionEl, ["children", 0])], { clientX: 50, clientY: 150 }),
    });
    expect(panel.dropLine.style.display).toBe("block");
    expect(panel.dropLine.className).toBe("canvas-drop-indicator inside");
    expect(panel.dropLine.style.top).toBe("100px");
    expect(panel.dropLine.style.left).toBe("10px");
    expect(panel.dropLine.style.width).toBe("200px");
    expect(panel.dropLine.style.height).toBe("100px");
    expect(sectionEl.classList.contains("canvas-drop-target")).toBe(true);
  });

  test("onDrag near the top/bottom edges shows reorder lines", () => {
    const { monitor, panel, sectionEl } = setupCanvas();
    monitor.onDrag({
      location: loc([targetOf(sectionEl, ["children", 0])], { clientX: 50, clientY: 110 }),
    });
    expect(panel.dropLine.className).toBe("canvas-drop-indicator line");
    expect(panel.dropLine.style.top).toBe("100px");
    expect(panel.dropLine.style.height).toBe("");
    expect(sectionEl.classList.contains("canvas-drop-target")).toBe(false);

    monitor.onDrag({
      location: loc([targetOf(sectionEl, ["children", 0])], { clientX: 50, clientY: 195 }),
    });
    expect(panel.dropLine.style.top).toBe("200px"); // Section bottom
  });

  test("onDrag over a leaf splits at the midpoint", () => {
    const { monitor, panel, pEl } = setupCanvas();
    monitor.onDrag({
      location: loc([targetOf(pEl, ["children", 1], true)], { clientX: 50, clientY: 210 }),
    });
    expect(panel.dropLine.style.top).toBe("200px"); // Above

    monitor.onDrag({
      location: loc([targetOf(pEl, ["children", 1], true)], { clientX: 50, clientY: 240 }),
    });
    expect(panel.dropLine.style.top).toBe("250px"); // Below
  });

  test("onDrag over the root snaps to the nearest child edge", () => {
    const { monitor, panel, rootEl } = setupCanvas();
    monitor.onDrag({ location: loc([targetOf(rootEl, [])], { clientX: 50, clientY: 105 }) });
    // Nearest edge: section top → reorder-above child 0
    expect(panel.dropLine.className).toBe("canvas-drop-indicator line");
    expect(panel.dropLine.style.top).toBe("100px");
    expect(panel.dropLine.style.width).toBe("200px"); // Reference is the section

    monitor.onDrag({ location: loc([targetOf(rootEl, [])], { clientX: 50, clientY: 248 }) });
    // Nearest edge: p bottom → reorder-below child 1
    expect(panel.dropLine.style.top).toBe("250px");
  });

  test("indicator geometry divides by the effective zoom", () => {
    zoom = 2;
    const { monitor, panel, sectionEl } = setupCanvas();
    monitor.onDrag({
      location: loc([targetOf(sectionEl, ["children", 0])], { clientX: 50, clientY: 150 }),
    });
    expect(panel.dropLine.style.top).toBe("50px");
    expect(panel.dropLine.style.left).toBe("5px");
    expect(panel.dropLine.style.width).toBe("100px");
    expect(panel.dropLine.style.height).toBe("50px");
  });

  test("edit mode forces zoom 1", () => {
    mode = "edit";
    zoom = 4;
    const { monitor, panel, sectionEl } = setupCanvas();
    monitor.onDrag({
      location: loc([targetOf(sectionEl, ["children", 0])], { clientX: 50, clientY: 150 }),
    });
    expect(panel.dropLine.style.top).toBe("100px");
  });

  test("moving between targets transfers the drop-target class", () => {
    const { monitor, sectionEl, pEl } = setupCanvas();
    monitor.onDrag({
      location: loc([targetOf(sectionEl, ["children", 0])], { clientX: 50, clientY: 150 }),
    });
    expect(sectionEl.classList.contains("canvas-drop-target")).toBe(true);
    monitor.onDrag({
      location: loc([targetOf(pEl, ["children", 1], true)], { clientX: 50, clientY: 210 }),
    });
    expect(sectionEl.classList.contains("canvas-drop-target")).toBe(false);
  });

  test("onDrag over a non-canvas target hides this panel's indicator", () => {
    const { monitor, panel, sectionEl } = setupCanvas();
    monitor.onDrag({
      location: loc([targetOf(sectionEl, ["children", 0])], { clientX: 50, clientY: 150 }),
    });
    const outside = document.createElement("div");
    document.body.append(outside);
    monitor.onDrag({
      location: loc([targetOf(outside, ["children", 0])], { clientX: 50, clientY: 150 }),
    });
    expect(panel.dropLine.style.display).toBe("none");
    expect(sectionEl.classList.contains("canvas-drop-target")).toBe(false);
    outside.remove();
  });

  test("a target with a non-array path counts as non-canvas", () => {
    const { monitor, panel, sectionEl } = setupCanvas();
    monitor.onDrag({
      location: loc([targetOf(sectionEl, ["children", 0])], { clientX: 50, clientY: 150 }),
    });
    monitor.onDrag({
      location: loc([targetOf(sectionEl, "children/0")], { clientX: 50, clientY: 150 }),
    });
    expect(panel.dropLine.style.display).toBe("none");
  });

  test("onDrag over dead space keeps the last indicator visible", () => {
    const { monitor, panel, sectionEl } = setupCanvas();
    monitor.onDrag({
      location: loc([targetOf(sectionEl, ["children", 0])], { clientX: 50, clientY: 150 }),
    });
    monitor.onDrag({ location: loc([], { clientX: 0, clientY: 0 }) });
    expect(panel.dropLine.style.display).toBe("block");
    expect(sectionEl.classList.contains("canvas-drop-target")).toBe(true);
  });
});

describe("monitor — onDrop", () => {
  test("drops a block fragment above a leaf and resets drag state", () => {
    const fx = setupCanvas();
    const tab = resetWorkspaceWithTab(makeDoc());
    fx.monitor.onDragStart({ location: loc([], { clientX: 50, clientY: 210 }) });
    fx.monitor.onDrop({
      location: loc([targetOf(fx.pEl, ["children", 1], true)], { clientX: 50, clientY: 210 }),
      source: { data: { fragment: { tagName: "hr" }, type: "block" } },
    });
    const children = tab.doc.document.children as JxMutableNode[];
    expect(children.map((c) => c.tagName)).toEqual(["section", "hr", "p", "img"]);
    // Drag state reset
    expect(view.lastDragInput).toBeNull();
    expect(fx.panel.dropLine.style.display).toBe("none");
    expect(fx.panel.overlayClk.style.pointerEvents).toBe("");
    expect(fx.sectionEl.style.pointerEvents).toBe("none");
  });

  test("without drag input the drop defaults to make-child", () => {
    const fx = setupCanvas();
    const tab = resetWorkspaceWithTab(makeDoc());
    view.lastDragInput = null;
    fx.monitor.onDrop({
      location: loc([targetOf(fx.sectionEl, ["children", 0])]),
      source: { data: { fragment: { tagName: "em" }, type: "block" } },
    });
    const [section] = tab.doc.document.children as JxMutableNode[];
    expect((section.children as JxMutableNode[]).map((c) => c.tagName)).toEqual(["h2", "em"]);
  });

  test("dropping on an empty root appends to the document", () => {
    const panel = makePanel();
    canvasPanels.push(panel as never);
    const emptyRoot = document.createElement("div");
    panel.canvas.append(emptyRoot);
    elToPath.set(emptyRoot, []);
    registerPanelDnD(panel as never);
    const monitor = monitors.at(-1)!;
    const tab = resetWorkspaceWithTab({ children: [], tagName: "div" });
    view.lastDragInput = { clientX: 5, clientY: 5 };
    monitor.onDrop({
      location: loc([targetOf(emptyRoot, [])]),
      source: { data: { fragment: { tagName: "p" }, type: "block" } },
    });
    expect((tab.doc.document.children as JxMutableNode[]).map((c) => c.tagName)).toEqual(["p"]);
  });

  test("drop without a canvas target only cleans up", () => {
    const fx = setupCanvas();
    const tab = resetWorkspaceWithTab(makeDoc());
    const before = JSON.stringify(tab.doc.document);
    fx.monitor.onDragStart({ location: loc([], { clientX: 1, clientY: 1 }) });
    fx.monitor.onDrop({
      location: loc([]),
      source: { data: { fragment: { tagName: "hr" }, type: "block" } },
    });
    expect(JSON.stringify(tab.doc.document)).toBe(before);
    expect(view.lastDragInput).toBeNull();
    expect(fx.panel.overlayClk.style.pointerEvents).toBe("");
  });
});

describe("registerSubtreeDnD", () => {
  test("registers the mapped root and mapped descendants only", () => {
    setupCanvas();
    const before = dropTargets.length;
    const subtree = document.createElement("div");
    const inner = document.createElement("span");
    const unmapped = document.createElement("i");
    subtree.append(inner, unmapped);
    elToPath.set(subtree, ["children", 3]);
    elToPath.set(inner, ["children", 3, "children", 0]);
    registerSubtreeDnD(subtree);
    expect(dropTargets.length - before).toBe(2);
  });

  test("skips an unmapped root", () => {
    setupCanvas();
    const before = dropTargets.length;
    const subtree = document.createElement("div");
    const inner = document.createElement("span");
    subtree.append(inner);
    elToPath.set(inner, ["children", 4]);
    registerSubtreeDnD(subtree);
    expect(dropTargets.length - before).toBe(1);
  });
});
