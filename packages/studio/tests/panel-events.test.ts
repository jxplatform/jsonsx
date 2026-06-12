/**
 * Tests for src/panels/panel-events.ts — the unified canvas overlay event handlers:
 * click-to-select, double-click inline edit, context menu, hover tracking, and the action-bar click
 * guard.
 *
 * Happy-dom has no hit testing, so document.elementFromPoint/elementsFromPoint are stubbed to
 * return scripted elements.
 */
import { pointer, resetWorkspaceWithTab, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { elToPath, registerRenderer } from "../src/store";
import { view } from "../src/view";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { isEditing, startEditing } from "../src/editor/inline-edit";
import { dismissContextMenu } from "../src/editor/context-menu";
import { initCanvasHelpers } from "../src/canvas/canvas-helpers";
import { layoutElements } from "../src/canvas/canvas-live-render";
import { initPanelEvents, registerPanelEvents } from "../src/panels/panel-events";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../src/state";

type AnyRec = Record<string, any>;

let mode = "select";
initCanvasHelpers({ getCanvasMode: () => mode, getZoom: () => 1 });

// The context menu renders into the studio layer system
const layerHost = document.createElement("div");
layerHost.innerHTML =
  '<div id="layer-popover"></div><div id="layer-modal"></div><div id="layer-dialog"></div>';
document.body.append(layerHost);
const { initLayers } = await import("../src/ui/layers");
initLayers();

const enterCalls: [HTMLElement, JxPath][] = [];
const navCalls: string[] = [];
initPanelEvents({
  enterInlineEdit: (el, path) => enterCalls.push([el, path]),
  getCanvasMode: () => mode,
  navigateToComponent: (path) => navCalls.push(path),
});

let overlaysRenders = 0;
let rightPanelRenders = 0;
registerRenderer("overlays", () => {
  overlaysRenders += 1;
});
registerRenderer("rightPanel", () => {
  rightPanelRenders += 1;
});

// Hit-testing stubs
let elementsAt: Element[] = [];
(document as AnyRec).elementsFromPoint = () => elementsAt;
(document as AnyRec).elementFromPoint = () => elementsAt[0] ?? null;

function makeDoc(): JxMutableNode {
  return {
    children: [
      { tagName: "p", textContent: "Hello" },
      {
        children: [
          { children: ["text ", { tagName: "strong", textContent: "bold" }], tagName: "p" },
        ],
        tagName: "section",
      },
    ],
    tagName: "div",
  };
}

interface Fixture {
  panel: AnyRec;
  overlayClk: HTMLElement;
  pEl: HTMLElement;
  sectionEl: HTMLElement;
  pInnerEl: HTMLElement;
  strongEl: HTMLElement;
  orphanEl: HTMLElement;
  canvas: HTMLElement;
}

function setup(): Fixture {
  const element = document.createElement("div");
  const viewport = document.createElement("div");
  const canvas = document.createElement("div");
  const overlayClk = document.createElement("div");
  viewport.append(canvas);
  element.append(viewport, overlayClk);
  document.body.append(element);

  const pEl = document.createElement("p");
  const sectionEl = document.createElement("section");
  const pInnerEl = document.createElement("p");
  const strongEl = document.createElement("strong");
  const orphanEl = document.createElement("div");
  pInnerEl.append("text ", strongEl);
  sectionEl.append(pInnerEl);
  canvas.append(pEl, sectionEl, orphanEl);

  elToPath.set(pEl, ["children", 0]);
  elToPath.set(sectionEl, ["children", 1]);
  elToPath.set(pInnerEl, ["children", 1, "children", 0]);
  elToPath.set(strongEl, ["children", 1, "children", 0, "children", 1]);

  const panel: AnyRec = { canvas, element, mediaName: "tablet", overlayClk, viewport };
  registerPanelEvents(panel as never);
  return { canvas, orphanEl, overlayClk, pEl, pInnerEl, panel, sectionEl, strongEl };
}

/** Place the floating action bar over (0,0)-(100,100) so events inside it are guarded. */
function installActionBar() {
  const bar = document.createElement("div");
  const inner = document.createElement("div");
  bar.append(inner);
  stubRect(inner, { height: 100, left: 0, top: 0, width: 100 });
  view.blockActionBarEl = bar;
}

beforeEach(() => {
  mode = "select";
  enterCalls.length = 0;
  navCalls.length = 0;
  overlaysRenders = 0;
  rightPanelRenders = 0;
  elementsAt = [];
  view.blockActionBarEl = null;
  view.layoutSelection = null;
  view.canvasEventCleanups = [];
  resetWorkspaceWithTab(makeDoc());
});

afterEach(() => {
  dismissContextMenu();
  for (const cleanup of view.canvasEventCleanups) {
    cleanup();
  }
  view.canvasEventCleanups = [];
  document.body.innerHTML = "";
});

describe("registerPanelEvents — wiring", () => {
  test("mounts the insertion helper into the panel viewport", () => {
    const { panel } = setup();
    expect(panel.viewport.querySelector(".insertion-helper")).not.toBeNull();
  });

  test("cleanups abort the listeners and unmount the helper", () => {
    const fx = setup();
    const tab = activeTab.value!;
    for (const cleanup of view.canvasEventCleanups) {
      cleanup();
    }
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(tab.session.selection).toBeNull();
    expect(fx.panel.viewport.querySelector(".insertion-helper")).toBeNull();
  });
});

describe("click — selection", () => {
  test("selects the clicked element and adopts the panel media", () => {
    const fx = setup();
    const tab = activeTab.value!;
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(tab.session.selection).toEqual(["children", 0]);
    expect(tab.session.ui.activeMedia).toBe("tablet");
  });

  test("clicks inside the block action bar are ignored", () => {
    const fx = setup();
    const tab = activeTab.value!;
    installActionBar();
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "click", { clientX: 50, clientY: 50 });
    expect(tab.session.selection).toBeNull();
    // Outside the bar the click goes through
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(tab.session.selection).toEqual(["children", 0]);
  });

  test("clicking empty space clears the selection", () => {
    const fx = setup();
    const tab = activeTab.value!;
    tab.session.selection = ["children", 0];
    elementsAt = [document.body];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(tab.session.selection).toBeNull();
  });

  test("the canvas itself and unmapped elements are skipped", () => {
    const fx = setup();
    const tab = activeTab.value!;
    elementsAt = [fx.canvas, fx.orphanEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(tab.session.selection).toBeNull();
  });

  test("inline elements bubble to their block parent", () => {
    const fx = setup();
    const tab = activeTab.value!;
    elementsAt = [fx.strongEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(tab.session.selection).toEqual(["children", 1, "children", 0]);
  });

  test("design mode records a pending inline edit", () => {
    mode = "design";
    const fx = setup();
    const tab = activeTab.value!;
    tab.doc.mode = "design";
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(tab.session.selection).toEqual(["children", 0]);
    expect(tab.session.ui.pendingInlineEdit).toEqual({
      mediaName: "tablet",
      path: ["children", 0],
    });
    expect(enterCalls).toHaveLength(0);
  });

  test("edit mode enters inline edit on an already-selected editable block", () => {
    mode = "edit";
    const fx = setup();
    const tab = activeTab.value!;
    tab.session.selection = ["children", 0];
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(enterCalls).toEqual([[fx.pEl, ["children", 0]]]);
  });

  test("content-mode documents enter inline edit regardless of canvas mode", () => {
    mode = "design";
    const fx = setup();
    const tab = activeTab.value!;
    tab.doc.mode = "content";
    tab.session.selection = ["children", 0];
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(enterCalls).toEqual([[fx.pEl, ["children", 0]]]);
  });

  test("a selected non-editable element falls through to plain selection", () => {
    mode = "edit";
    const fx = setup();
    const tab = activeTab.value!;
    tab.session.selection = ["children", 1];
    elementsAt = [fx.sectionEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(enterCalls).toHaveLength(0);
    expect(tab.session.selection).toEqual(["children", 1]);
  });

  test("clicking a layout element selects the layout instead of a node", () => {
    const fx = setup();
    const tab = activeTab.value!;
    tab.session.selection = ["children", 0];
    layoutElements.add(fx.sectionEl);
    try {
      elementsAt = [fx.sectionEl];
      pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
      expect(view.layoutSelection).toEqual({ el: fx.sectionEl, layoutPath: null });
      expect(tab.session.selection).toBeNull();
      expect(rightPanelRenders).toBe(1);
    } finally {
      layoutElements.delete(fx.sectionEl);
    }
  });

  test("a normal click clears a previous layout selection", () => {
    const fx = setup();
    view.layoutSelection = { el: fx.sectionEl, layoutPath: null };
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(view.layoutSelection).toBeNull();
  });

  test("clicking while inline editing stops the edit", () => {
    const fx = setup();
    startEditing(fx.pEl, ["children", 0], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    expect(isEditing()).toBe(true);
    elementsAt = [document.body];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(isEditing()).toBe(false);
  });

  test("without a tab the click is inert", () => {
    const fx = setup();
    closeAllTabs();
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "click", { clientX: 500, clientY: 500 });
    expect(enterCalls).toHaveLength(0);
  });
});

describe("dblclick — inline edit", () => {
  test("enters inline edit on an editable block in edit mode", () => {
    mode = "edit";
    const fx = setup();
    const tab = activeTab.value!;
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "dblclick", { clientX: 500, clientY: 500 });
    expect(tab.session.selection).toEqual(["children", 0]);
    expect(tab.session.ui.activeMedia).toBe("tablet");
    expect(enterCalls).toEqual([[fx.pEl, ["children", 0]]]);
  });

  test("bubbles inline elements and edits the resolved block", () => {
    mode = "design";
    const fx = setup();
    elementsAt = [fx.strongEl];
    pointer(fx.overlayClk, "dblclick", { clientX: 500, clientY: 500 });
    expect(enterCalls).toEqual([[fx.pInnerEl, ["children", 1, "children", 0]]]);
  });

  test("does nothing outside edit/design modes", () => {
    mode = "preview";
    const fx = setup();
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "dblclick", { clientX: 500, clientY: 500 });
    expect(enterCalls).toHaveLength(0);
  });

  test("non-editable targets and the action-bar region are ignored", () => {
    mode = "edit";
    const fx = setup();
    elementsAt = [fx.sectionEl];
    pointer(fx.overlayClk, "dblclick", { clientX: 500, clientY: 500 });
    expect(enterCalls).toHaveLength(0);

    installActionBar();
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "dblclick", { clientX: 50, clientY: 50 });
    expect(enterCalls).toHaveLength(0);
  });

  test("without a tab the dblclick is inert", () => {
    mode = "edit";
    const fx = setup();
    closeAllTabs();
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "dblclick", { clientX: 500, clientY: 500 });
    expect(enterCalls).toHaveLength(0);
  });
});

describe("contextmenu", () => {
  test("opens the context menu for the bubbled element path", () => {
    const fx = setup();
    const tab = activeTab.value!;
    elementsAt = [fx.strongEl];
    const e = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      clientY: 500,
    });
    fx.overlayClk.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    // ShowContextMenu selects the node
    expect(tab.session.selection).toEqual(["children", 1, "children", 0]);
  });

  test("right-clicking empty space just prevents the default menu", () => {
    const fx = setup();
    const tab = activeTab.value!;
    elementsAt = [document.body];
    const e = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      clientY: 500,
    });
    fx.overlayClk.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(tab.session.selection).toBeNull();
  });

  test("the action-bar region swallows contextmenu", () => {
    const fx = setup();
    installActionBar();
    elementsAt = [fx.pEl];
    const e = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    fx.overlayClk.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(activeTab.value!.session.selection).toBeNull();
  });
});

describe("hover tracking", () => {
  test("mousemove sets hover and re-renders overlays once per path", () => {
    const fx = setup();
    const tab = activeTab.value!;
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "mousemove", { clientX: 500, clientY: 500 });
    expect(tab.session.hover).toEqual(["children", 0]);
    expect(overlaysRenders).toBe(1);
    // Same element again — no extra render
    pointer(fx.overlayClk, "mousemove", { clientX: 501, clientY: 500 });
    expect(overlaysRenders).toBe(1);
  });

  test("leaving canvas elements clears the hover", () => {
    const fx = setup();
    const tab = activeTab.value!;
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "mousemove", { clientX: 500, clientY: 500 });
    elementsAt = [document.body];
    pointer(fx.overlayClk, "mousemove", { clientX: 500, clientY: 500 });
    expect(tab.session.hover).toBeNull();
    expect(overlaysRenders).toBe(2);
    // Already null — no extra render
    pointer(fx.overlayClk, "mousemove", { clientX: 500, clientY: 500 });
    expect(overlaysRenders).toBe(2);
  });

  test("mousemove respects the action-bar guard and missing tab", () => {
    const fx = setup();
    installActionBar();
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "mousemove", { clientX: 50, clientY: 50 });
    expect(activeTab.value!.session.hover).toBeNull();

    view.blockActionBarEl = null;
    closeAllTabs();
    pointer(fx.overlayClk, "mousemove", { clientX: 500, clientY: 500 });
    expect(overlaysRenders).toBe(0);
  });

  test("mouseleave clears an active hover", () => {
    const fx = setup();
    const tab = activeTab.value!;
    elementsAt = [fx.pEl];
    pointer(fx.overlayClk, "mousemove", { clientX: 500, clientY: 500 });
    expect(tab.session.hover).toEqual(["children", 0]);
    pointer(fx.overlayClk, "mouseleave");
    expect(tab.session.hover).toBeNull();
    expect(overlaysRenders).toBe(2);
    // No hover — nothing happens
    pointer(fx.overlayClk, "mouseleave");
    expect(overlaysRenders).toBe(2);
  });
});
