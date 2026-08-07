import {
  registerPrimaryStage,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
  standUpPaneGrid,
  stubRect,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  applyEditZoom,
  applyTransform,
  canvasPanelTemplate,
  centerCanvas,
  clampEditZoom,
  clampPanZoom,
  EDIT_ZOOM_MAX,
  EDIT_ZOOM_MIN,
  applyFit,
  DEFAULT_FIT,
  fitOnCanvasEntry,
  fitToScreen,
  getFit,
  hasDeclaredFit,
  markExplicitZoom,
  observeCenterUntilStable,
  PAN_ZOOM_MAX,
  PAN_ZOOM_MIN,
  panToElement,
  panToParentRect,
  requestEditZoom,
  resetFits,
  resetZoom,
  revealScroller,
  setFit,
  setEditZoom,
  setUserZoom,
  updateActivePanelHeaders,
} from "../src/canvas/canvas-utils";
import { initShellRefs, registerRenderer } from "../src/store";
import {
  activeCanvasSurface,
  surfaceForPane,
  tabOfPane,
  unregisterCanvasSurface,
} from "../src/canvas/canvas-surface";
import {
  closeAllTabs,
  openTab,
  PRIMARY_PANE,
  SECONDARY_PANE,
  workspace,
} from "../src/workspace/workspace";
import type { CanvasPanel } from "../src/types";

/* The panels of the FOCUSED pane's stage. Panels belong to a pane's surface now, not to the
   app (`src/canvas/canvas-surface.ts`); the array identity is stable, so a module-level
   binding still sees what the render mutated. */
const canvasPanels = activeCanvasSurface().panels;

/** The primary pane's surface — every geometry helper takes one explicitly now. */
function primary() {
  return surfaceForPane(PRIMARY_PANE);
}

// ─── Test context plumbing ────────────────────────────────────────────────────

/*
 * There is nothing to inject any more.
 *
 * `initCanvasUtils` handed the module `getCanvasMode`, `getZoom` and `setZoomDirect`, and all three
 * were `activeTab.value` — the FOCUSED pane's tab — while every geometry function already took an
 * explicit `CanvasSurface`. The fixture mirrored that split with a `let zoom` and a
 * `setZoomDirect` mock, which is why a two-pane failure could never surface here: there was only
 * one number to observe. The scale is read and written through the surface's own tab now, so the
 * assertions read it there too.
 */

/** The primary pane's own pan-zoom scale. */
const paneZoom = () => tabOfPane(PRIMARY_PANE)?.session.ui.zoom ?? 1;

/** Put the primary pane's document at `value`. */
function setPaneZoom(value: number) {
  const tab = tabOfPane(PRIMARY_PANE);
  if (tab) {
    tab.session.ui.zoom = value;
  }
}

/** Put the primary pane's document into `mode` — what `canvasModeOfPane` answers with. */
function setPaneMode(mode: string) {
  const tab = tabOfPane(PRIMARY_PANE);
  if (tab) {
    tab.session.ui.canvasMode = mode;
  }
}

/** A fresh primary tab already in `mode`. */
function tabInMode(mode: string) {
  const tab = resetWorkspaceWithTab();
  tab.session.ui.canvasMode = mode;
  return tab;
}

const overlaysRenderer = mock(() => {});
registerRenderer("overlays", overlaysRenderer);

function setupShell() {
  document.body.innerHTML = "";
  for (const id of ["activity-bar", "left-panel", "right-panel", "toolbar", "statusbar"]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
  registerPrimaryStage();
}

/** Define a read-only layout metric on an element (happy-dom does no layout). */
function defineMetric(el: Element, prop: string, value: number) {
  Object.defineProperty(el, prop, { configurable: true, value });
}

function makePanzoomWrap() {
  const el = document.createElement("div");
  primary().wrap.append(el);
  surfaceForPane("primary").panzoomWrap = el;
  return el;
}

const originalRaf = globalThis.requestAnimationFrame;
const OriginalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  setupShell();
  resetStudioState();
  /* One primary pane holding one tab, every time. The geometry reads its scale and its mode off
     that tab, so a suite that left the workspace to whatever the previous test built would be
     measuring another test's document. */
  resetWorkspaceWithTab();
  overlaysRenderer.mockClear();
  canvasPanels.length = 0;
  surfaceForPane("primary").panzoomWrap = null;
  surfaceForPane("primary").centerObserver = null;
  surfaceForPane("primary").needsCenter = true;
  surfaceForPane("primary").panX = 0;
  surfaceForPane("primary").panY = 0;
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.ResizeObserver = OriginalResizeObserver;
});

// ─── canvasPanelTemplate ──────────────────────────────────────────────────────

describe("canvasPanelTemplate", () => {
  test("wires all panel DOM refs during render", async () => {
    const { tpl, panel } = canvasPanelTemplate("md", "Tablet (768px)", false, 768);
    await renderInto(tpl);
    expect(panel.element?.classList.contains("canvas-panel")).toBe(true);
    expect(panel.viewport?.classList.contains("canvas-panel-viewport")).toBe(true);
    expect(panel.canvas?.classList.contains("canvas-panel-canvas")).toBe(true);
    expect(panel.mediaName).toBe("md");
    expect(panel._width).toBe(768);
    expect(panel.ready).toBe(false);
  });

  test("sets data-media attribute and label header", async () => {
    const { tpl, panel } = canvasPanelTemplate("md", "Tablet (768px)", false, 768);
    await renderInto(tpl);
    expect(panel.element?.dataset.media).toBe("md");
    const header = panel.element?.querySelector(".canvas-panel-header");
    expect(header?.textContent?.trim()).toBe("Tablet (768px)");
  });

  test("applies pixel widths to viewport and canvas when not full-width", async () => {
    const { tpl, panel } = canvasPanelTemplate("md", "Tablet", false, 768);
    await renderInto(tpl);
    expect(panel.viewport?.style.width).toBe("768px");
    expect(panel.canvas?.style.width).toBe("768px");
  });

  test("full-width panel omits viewport width and header", async () => {
    const { tpl, panel } = canvasPanelTemplate(null, null, true);
    await renderInto(tpl);
    expect(panel.element?.classList.contains("full-width")).toBe(true);
    expect(panel.element?.querySelector(".canvas-panel-header")).toBeNull();
    expect(panel.element?.dataset.media).toBeUndefined();
    expect(panel.viewport?.style.width).toBe("");
    expect(panel.mediaName).toBe("");
    expect(panel._width).toBeNull();
  });

  /** Mount a panel the way a render does — into a pane's stage, which is what addresses it. */
  async function mountPanel(
    media: string | null,
    label: string,
    paneId: string = PRIMARY_PANE,
  ): Promise<CanvasPanel> {
    const { tpl, panel } = canvasPanelTemplate(media, label, false, 768);
    await renderInto(tpl);
    surfaceForPane(paneId).panels.push(panel);
    return panel;
  }

  function clickHeader(panel: CanvasPanel) {
    const header = panel.element!.querySelector(".canvas-panel-header") as HTMLElement;
    header.click();
  }

  test("header click sets activeMedia from panel media", async () => {
    const tab = resetWorkspaceWithTab();
    clickHeader(await mountPanel("md", "Tablet (768px)"));
    expect(tab.session.ui.activeMedia).toBe("md");
  });

  test("base panel header click resets activeMedia to null", async () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.activeMedia = "md";
    clickHeader(await mountPanel("base", "Base (320px)"));
    expect(tab.session.ui.activeMedia).toBeNull();
  });

  /*
   * The breakpoint belongs to the tab of the pane that MOUNTED the artboard. This is the
   * parent-side twin of the iframe's `hit` message: `updateUi` writes to `activeTab`, which is the
   * FOCUSED pane's tab, so clicking a header in a pane the keyboard is not in set another
   * document's breakpoint — and the Style panel then edited a compound block nobody had opened.
   */
  test("the header writes the breakpoint of the pane that mounted it, not the focused one", async () => {
    const focused = resetWorkspaceWithTab(undefined, { documentPath: "/project/a.json", id: "a" });
    const other = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "/project/b.json",
      id: "b",
    });
    // Tab "b" lives in the side pane; the keyboard stays in the primary, on "a".
    workspace.panes[0]!.tabOrder = ["a"];
    workspace.panes[0]!.activeTabId = "a";
    workspace.panes = [
      ...workspace.panes,
      { activeTabId: "b", id: SECONDARY_PANE, tabOrder: ["b"] },
    ];
    workspace.activePaneId = PRIMARY_PANE;

    clickHeader(await mountPanel("md", "Tablet (768px)", SECONDARY_PANE));

    expect(other.session.ui.activeMedia).toBe("md");
    expect(focused.session.ui.activeMedia).toBeNull();

    surfaceForPane(SECONDARY_PANE).panels.length = 0;
  });
});

// ─── centerCanvas ─────────────────────────────────────────────────────────────

describe("centerCanvas", () => {
  test("no-op when there is no panzoom wrapper", () => {
    surfaceForPane("primary").panX = 123;
    centerCanvas(primary());
    expect(surfaceForPane("primary").panX).toBe(123);
  });

  test("centers content horizontally and resets panY", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 1000);
    defineMetric(wrap, "scrollWidth", 800);
    surfaceForPane("primary").panY = 99;
    centerCanvas(primary());
    expect(surfaceForPane("primary").panX).toBe(100); // (1000 - 800) / 2
    expect(surfaceForPane("primary").panY).toBe(0);
  });

  test("clamps panX to 16 when content is wider than the viewport", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 500);
    defineMetric(wrap, "scrollWidth", 800);
    setPaneZoom(2);
    centerCanvas(primary());
    expect(surfaceForPane("primary").panX).toBe(16);
  });
});

// ─── applyTransform ───────────────────────────────────────────────────────────

describe("applyTransform", () => {
  test("no-op without panzoom wrapper", () => {
    applyTransform(primary());
    expect(overlaysRenderer).not.toHaveBeenCalled();
  });

  test("applies translate + scale and re-renders overlays", () => {
    const wrap = makePanzoomWrap();
    surfaceForPane("primary").panX = 10;
    surfaceForPane("primary").panY = 20;
    setPaneZoom(2);
    applyTransform(primary());
    expect(wrap.style.transform).toBe("translate(10px, 20px) scale(2)");
    expect(overlaysRenderer).toHaveBeenCalled();
  });

  test("stylebook mode needs no per-mode overlay redraw (iframe overlays live in the wrap)", () => {
    makePanzoomWrap();
    setPaneMode("stylebook");
    overlaysRenderer.mockClear();
    applyTransform(primary());
    expect(overlaysRenderer).toHaveBeenCalled();
  });
});

// ─── fitToScreen / resetZoom ──────────────────────────────────────────────────

describe("fitToScreen", () => {
  test("no-op without panzoom wrapper", () => {
    fitToScreen({ surface: primary() });
    expect(paneZoom()).toBe(1);
  });

  test("fits panels to the viewport and centers", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 1000);
    defineMetric(primary().wrap, "clientHeight", 600);
    stubRect(wrap, { height: 300, width: 1056 });
    canvasPanels.push({ _width: 400 } as never, { _width: 600 } as never);

    fitToScreen({ surface: primary() });

    // Total width = 400 + 600 + 24 gap + 32 padding = 1056; height fit = 600/332
    const expectedZoom = Math.min(1000 / 1056, 600 / 332);
    expect(paneZoom()).toBeCloseTo(expectedZoom, 10);
    expect(surfaceForPane("primary").panX).toBeCloseTo(
      Math.max(0, (1000 - 1056 * expectedZoom) / 2),
    );
    expect(surfaceForPane("primary").panY).toBeCloseTo(Math.max(0, (600 - 332 * expectedZoom) / 2));
    expect(wrap.style.transform).toContain(`scale(${expectedZoom}`);
  });

  test("defaults panel width to 800 and clamps zoom to at least 0.05", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 1);
    defineMetric(primary().wrap, "clientHeight", 600);
    stubRect(wrap, { height: 300 });
    canvasPanels.push({} as never);
    fitToScreen({ surface: primary() });
    expect(paneZoom()).toBe(0.05);
  });
});

// ─── Author zoom vs. the automatic fit on entering a panzoom mode ─────────────

describe("pan zoom clamping", () => {
  test("clamps to the supported range", () => {
    expect(clampPanZoom(100)).toBe(PAN_ZOOM_MAX);
    expect(clampPanZoom(0)).toBe(PAN_ZOOM_MIN);
    expect(clampPanZoom(1.5)).toBe(1.5);
  });
});

describe("declared fit", () => {
  beforeEach(() => {
    resetFits();
  });

  test("an undeclared document reports the default fit", () => {
    resetWorkspaceWithTab();
    expect(hasDeclaredFit()).toBe(false);
    expect(getFit()).toBe(DEFAULT_FIT);
  });

  test("setUserZoom clamps, declares the number as the fit, and applies the transform", () => {
    const tab = resetWorkspaceWithTab();
    const wrap = makePanzoomWrap();
    expect(hasDeclaredFit()).toBe(false);

    setUserZoom(99);

    expect(tab.session.ui.zoom).toBe(PAN_ZOOM_MAX);
    expect(getFit()).toBe(PAN_ZOOM_MAX);
    expect(wrap.style.transform).toContain("scale(");
  });

  test("markExplicitZoom declares whatever the zoom currently is", () => {
    resetWorkspaceWithTab();
    makePanzoomWrap();
    setPaneZoom(0.75);
    markExplicitZoom();
    expect(getFit()).toBe(0.75);
  });

  test("setUserZoom and markExplicitZoom are no-ops with no tab open", () => {
    closeAllTabs();
    setUserZoom(2);
    markExplicitZoom();
    expect(hasDeclaredFit()).toBe(false);
    expect(getFit()).toBe(DEFAULT_FIT);
  });

  test("the fit is per document, so another document still gets the default", () => {
    const tab = resetWorkspaceWithTab();
    tab.documentPath = "pages/index.md";
    setFit("width");
    expect(getFit()).toBe("width");
    tab.documentPath = "pages/about.md";
    expect(hasDeclaredFit()).toBe(false);
    expect(getFit()).toBe(DEFAULT_FIT);
  });

  test('applyFit("none") frames nothing', () => {
    resetWorkspaceWithTab();
    const wrap = makePanzoomWrap();
    setPaneZoom(0.4);
    applyFit("none");
    expect(paneZoom()).toBe(0.4);
    expect(wrap.style.transform).toContain("scale(0.4)");
  });

  test('a declared "width" fit ignores the height axis', () => {
    resetWorkspaceWithTab();
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 700);
    // A viewport far too short for the artboard: "page" would fit to this, "width" must not.
    defineMetric(primary().wrap, "clientHeight", 100);
    stubRect(wrap, { height: 600, width: 1312 });
    canvasPanels.push({ _width: 1280 } as never);

    setFit("width");

    expect(paneZoom()).toBeCloseTo(700 / 1312, 10);
  });
});

describe("fitOnCanvasEntry", () => {
  beforeEach(() => {
    resetFits();
    resetWorkspaceWithTab();
  });

  test("fits a wide artboard that would otherwise land clipped", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 700);
    defineMetric(primary().wrap, "clientHeight", 600);
    stubRect(wrap, { height: 0, width: 1312 });
    canvasPanels.push({ _width: 1280 } as never);

    fitOnCanvasEntry(primary());

    // 1280 + 32 padding = 1312 → the artboard is scaled down to fit 700px of viewport.
    expect(paneZoom()).toBeCloseTo(700 / 1312, 10);
  });

  test("never magnifies past life size", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 2000);
    defineMetric(primary().wrap, "clientHeight", 1200);
    stubRect(wrap, { height: 0, width: 432 });
    canvasPanels.push({ _width: 400 } as never);

    fitOnCanvasEntry(primary());

    expect(paneZoom()).toBe(1);
  });

  test("the Fit control may still magnify", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 2000);
    defineMetric(primary().wrap, "clientHeight", 1200);
    stubRect(wrap, { height: 0, width: 432 });
    canvasPanels.push({ _width: 400 } as never);

    fitToScreen({ surface: primary() });

    expect(paneZoom()).toBeCloseTo(2000 / 432, 10);
  });

  test("honours a numeric fit the author declared for this document", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 700);
    canvasPanels.push({ _width: 1280 } as never);
    setPaneZoom(0.5);
    markExplicitZoom();

    fitOnCanvasEntry(primary());

    expect(paneZoom()).toBe(0.5);
    expect(wrap.style.transform).toContain("scale(0.5)");
  });

  test("leaves the zoom alone when the viewport has no measurable width", () => {
    // A hidden or not-yet-laid-out pane would otherwise fit to the 5% floor.
    makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 0);
    canvasPanels.push({ _width: 1280 } as never);

    fitOnCanvasEntry(primary());

    expect(paneZoom()).toBe(1);
  });
});

describe("resetZoom", () => {
  test("no-op without panzoom wrapper", () => {
    resetZoom(primary());
    expect(paneZoom()).toBe(1);
  });

  test("resets zoom to 1, re-centers, and declares 1 as the fit", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 1000);
    defineMetric(wrap, "scrollWidth", 500);
    resetWorkspaceWithTab();
    setPaneZoom(3);
    resetZoom(primary());
    expect(getFit()).toBe(1);
    expect(paneZoom()).toBe(1);
    expect(surfaceForPane("primary").panX).toBe(250);
    expect(wrap.style.transform).toBe("translate(250px, 0px) scale(1)");
  });
});

// ─── Edit-mode content zoom ───────────────────────────────────────────────────

/** Build the edit-mode panel DOM applyEditZoom operates on, with stubbed layout metrics. */
function makeEditPanel(columnWidth = 800) {
  const sc = document.createElement("div");
  sc.className = "content-edit-canvas";
  const column = document.createElement("div");
  column.className = "content-edit-column";
  const viewport = document.createElement("div");
  viewport.className = "canvas-panel-viewport";
  const canvas = document.createElement("div");
  canvas.className = "canvas-panel-canvas";
  const iframe = document.createElement("iframe");
  canvas.append(iframe);
  viewport.append(canvas);
  column.append(viewport);
  sc.append(column);
  primary().wrap.append(sc);
  stubRect(column, { width: columnWidth });
  defineMetric(iframe, "offsetHeight", 500);
  const panel = { _width: null, canvas, viewport } as unknown as CanvasPanel;
  canvasPanels.push(panel as never);
  return { canvas, column, iframe, panel, viewport };
}

describe("applyEditZoom", () => {
  test("no-op outside edit mode", () => {
    const tab = tabInMode("design");
    tab.session.ui.editZoom = 2;
    const { canvas } = makeEditPanel();
    applyEditZoom(primary());
    expect(canvas.style.transform).toBe("");
  });

  test("no-op without a mounted panel", () => {
    tabInMode("edit").session.ui.editZoom = 2;
    expect(() => applyEditZoom(primary())).not.toThrow();
  });

  test("shrinks the iframe layout width and counter-scales back to the column footprint", () => {
    const tab = tabInMode("edit");
    tab.session.ui.editZoom = 2;
    const { canvas, iframe, panel, viewport } = makeEditPanel(800);

    applyEditZoom(primary());

    // LayoutWidth = 800 / 2 = 400 → rendered footprint = 400 * scale(2) = 800 again.
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.transform).toBe("scale(2)");
    expect(canvas.style.transformOrigin).toBe("top left");
    expect(iframe.style.width).toBe("400px");
    // The viewport (white page surface) is pinned to the SCALED content height.
    expect(viewport.style.height).toBe("1000px");
    expect(panel._width).toBe(400);
    expect(overlaysRenderer).toHaveBeenCalled();
  });

  test("zoom-out grows the layout width past the footprint", () => {
    tabInMode("edit").session.ui.editZoom = 0.5;
    const { canvas, iframe } = makeEditPanel(600);
    applyEditZoom(primary());
    expect(canvas.style.width).toBe("1200px");
    expect(canvas.style.transform).toBe("scale(0.5)");
    expect(iframe.style.width).toBe("1200px");
  });

  test("editZoom 1 restores the fluid layout exactly", () => {
    const tab = tabInMode("edit");
    tab.session.ui.editZoom = 2;
    const { canvas, iframe, panel, viewport } = makeEditPanel();
    applyEditZoom(primary());

    tab.session.ui.editZoom = 1;
    applyEditZoom(primary());

    expect(canvas.style.width).toBe("");
    expect(canvas.style.transform).toBe("");
    expect(iframe.style.width).toBe("100%");
    expect(viewport.style.height).toBe("");
    expect(panel._width).toBeNull();
  });

  test("no-op when the column has no measurable width", () => {
    tabInMode("edit").session.ui.editZoom = 2;
    const { canvas } = makeEditPanel(0);
    applyEditZoom(primary());
    expect(canvas.style.transform).toBe("");
  });
});

describe("setEditZoom / requestEditZoom", () => {
  test("clampEditZoom bounds the range", () => {
    expect(clampEditZoom(0.01)).toBe(EDIT_ZOOM_MIN);
    expect(clampEditZoom(99)).toBe(EDIT_ZOOM_MAX);
    expect(clampEditZoom(1.5)).toBe(1.5);
  });

  test("setEditZoom clamps, persists on the tab, and applies synchronously", () => {
    const tab = tabInMode("edit");
    const { canvas } = makeEditPanel(600);
    setEditZoom(99);
    expect(tab.session.ui.editZoom).toBe(EDIT_ZOOM_MAX);
    expect(canvas.style.transform).toBe(`scale(${EDIT_ZOOM_MAX})`);
  });

  test("setEditZoom without a tab is a no-op", () => {
    closeAllTabs();
    expect(() => setEditZoom(2)).not.toThrow();
  });

  test("requestEditZoom writes state immediately but coalesces DOM work to one frame", () => {
    const tab = tabInMode("edit");
    const { canvas } = makeEditPanel(600);
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    }) as typeof requestAnimationFrame;

    requestEditZoom(2);
    requestEditZoom(2.5);

    // Both reactive writes landed, but only ONE frame was scheduled and no DOM write happened yet.
    expect(tab.session.ui.editZoom).toBe(2.5);
    expect(frames.length).toBe(1);
    expect(canvas.style.transform).toBe("");

    frames[0]!(0);
    expect(canvas.style.transform).toBe("scale(2.5)");
  });

  test("requestEditZoom without a tab is a no-op", () => {
    closeAllTabs();
    expect(() => requestEditZoom(2)).not.toThrow();
  });
});

// ─── observeCenterUntilStable ─────────────────────────────────────────────────

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  cb: () => void;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
}

describe("observeCenterUntilStable", () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });

  test("no-op without panzoom wrapper", () => {
    observeCenterUntilStable(primary());
    expect(surfaceForPane("primary").centerObserver).toBeNull();
    expect(FakeResizeObserver.instances.length).toBe(0);
  });

  test("observes the wrapper and re-centers on resize while needed", () => {
    const wrap = makePanzoomWrap();
    defineMetric(primary().wrap, "clientWidth", 1000);
    defineMetric(wrap, "scrollWidth", 600);
    observeCenterUntilStable(primary());
    expect(surfaceForPane("primary").needsCenter).toBe(true);
    const ro = FakeResizeObserver.instances[0]!;
    expect(ro.observed).toEqual([wrap]);
    expect(surfaceForPane("primary").panX).toBe(200);

    surfaceForPane("primary").panX = 0;
    ro.cb();
    expect(surfaceForPane("primary").panX).toBe(200);
    expect(wrap.style.transform).toContain("translate(200px, 0px)");
  });

  test("disconnects once the user pans (needsCenter false)", () => {
    makePanzoomWrap();
    observeCenterUntilStable(primary());
    const ro = FakeResizeObserver.instances[0]!;
    surfaceForPane("primary").needsCenter = false;
    ro.cb();
    expect(ro.disconnected).toBe(true);
    expect(surfaceForPane("primary").centerObserver).toBeNull();
  });

  test("replaces a previous observer", () => {
    makePanzoomWrap();
    observeCenterUntilStable(primary());
    observeCenterUntilStable(primary());
    const first = FakeResizeObserver.instances[0]!;
    const second = FakeResizeObserver.instances[1]!;
    expect(first.disconnected).toBe(true);
    expect(second.disconnected).toBe(false);
  });
});

// ─── panToElement / panToParentRect ───────────────────────────────────────────

function makeRenderedPanel(opts: { scrollContainer?: HTMLElement | null } = {}) {
  const canvas = document.createElement("div");
  const root = document.createElement("div");
  const target = document.createElement("p");
  root.append(target);
  canvas.append(root);
  const panel = {
    canvas,
    mediaName: "base",
    scrollContainer: opts.scrollContainer ?? null,
  } as unknown as CanvasPanel;
  canvasPanels.push(panel as never);
  return { canvas, panel, target };
}

describe("panToElement", () => {
  test("no-op when there is no active panel", () => {
    surfaceForPane("primary").panY = 7;
    panToElement(["children", 0]);
    expect(surfaceForPane("primary").panY).toBe(7);
  });

  test("no-op when the panel has no canvas", () => {
    canvasPanels.push({ canvas: null, mediaName: "base" } as never);
    surfaceForPane("primary").panY = 7;
    panToElement(["children", 0]);
    expect(surfaceForPane("primary").panY).toBe(7);
  });

  test("no-op when the element is not found", () => {
    makeRenderedPanel();
    surfaceForPane("primary").panY = 7;
    panToElement(["children", 99]);
    expect(surfaceForPane("primary").panY).toBe(7);
  });

  test("scrolls the scroll container smoothly in content mode", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.scrollTop = 100;
    const scrollTo = mock((_opts: ScrollToOptions) => {});
    (scrollContainer as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
    const { target } = makeRenderedPanel({ scrollContainer });

    stubRect(primary().wrap, { height: 600, top: 0 });
    stubRect(target, { height: 50, top: 100 });
    panToElement(["children", 0]);

    // ElCenterY = 125, vpCenterY = 300, offsetY = 175 → top = 100 - 175
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: -75 });
  });

  test("animates panY via requestAnimationFrame without a scroll container", () => {
    const { target } = makeRenderedPanel();
    makePanzoomWrap();
    stubRect(primary().wrap, { height: 600, top: 0 });
    stubRect(target, { height: 0, top: 500 });

    // Drive the animation deterministically: one mid-flight frame, one final frame
    const frames = [100, 1000];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const dt = frames.shift() ?? 1000;
      cb(performance.now() + dt);
      return 0;
    }) as typeof requestAnimationFrame;

    surfaceForPane("primary").panY = 0;
    panToElement(["children", 0]);

    // OffsetY = 300 - 500 = -200; final eased value lands on the target
    expect(surfaceForPane("primary").panY).toBeCloseTo(-200);
  });
});

describe("panToParentRect", () => {
  test("pans by the parent-viewport rect (the stylebook pan-to-card entry point)", () => {
    makePanzoomWrap();
    stubRect(primary().wrap, { height: 600, top: 0 });

    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(performance.now() + 1000);
      return 0;
    }) as typeof requestAnimationFrame;

    surfaceForPane("primary").panY = 50;
    panToParentRect({ height: 0, top: 0 });
    // OffsetY = 300 → target = 350
    expect(surfaceForPane("primary").panY).toBeCloseTo(350);
  });

  /*
   * The Edit surface. `revealCanvasPath` composes exactly this with a measure on either side, so
   * these four cases are the geometry the block-action-bar shot's caret step depends on: while this
   * function only wrote `surfaceForPane("primary").panY`, Edit — which renders no `.panzoom-wrap` — did not move at all.
   */
  test("scrolls the active panel's container when the pane is a scrolling surface", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.scrollTop = 0;
    makeRenderedPanel({ scrollContainer });
    stubRect(primary().wrap, { height: 885, top: 0 });

    // The measured case from P4: children/1 at y=1139 in an 885px viewport.
    panToParentRect({ height: 40, top: 1139 });

    // ElCenterY = 1159, vpCenterY = 442.5, offsetY = -716.5 → scrollTop = 0 + 716.5
    expect(scrollContainer.scrollTop).toBeCloseTo(716.5);
  });

  test("scrolls back up for a node above the fold, from the container's current position", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.scrollTop = 800;
    makeRenderedPanel({ scrollContainer });
    stubRect(primary().wrap, { height: 600, top: 100 });

    // Rect centre 150 is 50px below the pane's top, i.e. 250px above its centre.
    panToParentRect({ height: 100, top: 100 });

    expect(scrollContainer.scrollTop).toBeCloseTo(800 - 250);
  });

  test("does not ease the scroll — the point it answers with must be true on return", () => {
    const scrollContainer = document.createElement("div");
    const scrollTo = mock((_opts: ScrollToOptions) => {});
    (scrollContainer as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
    makeRenderedPanel({ scrollContainer });
    stubRect(primary().wrap, { height: 600, top: 0 });

    panToParentRect({ height: 0, top: 1000 });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollContainer.scrollTop).toBeCloseTo(700);
  });

  test("still pans when the active panel is a panzoom stage, scroll container or not", () => {
    makeRenderedPanel();
    makePanzoomWrap();
    stubRect(primary().wrap, { height: 600, top: 0 });
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(performance.now() + 1000);
      return 0;
    }) as typeof requestAnimationFrame;

    surfaceForPane("primary").panY = 0;
    panToParentRect({ height: 0, top: 900 });

    // OffsetY = 300 - 900 = -600
    expect(surfaceForPane("primary").panY).toBeCloseTo(-600);
  });
});

describe("revealScroller", () => {
  test("is null with no panel, and null for a panzoom panel", () => {
    expect(revealScroller(primary())).toBeNull();
    makeRenderedPanel();
    expect(revealScroller(primary())).toBeNull();
  });

  test("is the active panel's scroll container on the Edit surface", () => {
    const scrollContainer = document.createElement("div");
    makeRenderedPanel({ scrollContainer });
    expect(revealScroller(primary())).toBe(scrollContainer);
  });

  /*
   * It answers about the SURFACE it was handed, not about the focused pane. It used to be
   * zero-arity and to call `getActivePanel()`, which resolves through `activeCanvasSurface()` — so
   * `revealBy(surface, …)` was handed one stage and scrolled whichever one had the keyboard. Benign
   * only because both callers happened to pass the focused surface; a reveal in a side pane would
   * have scrolled the primary and then re-measured a node that had not moved.
   */
  test("answers for the surface it is given, not the focused one", () => {
    const sideScroller = document.createElement("div");
    const side = surfaceForPane("secondary");
    side.panels.push({
      canvas: document.createElement("div"),
      mediaName: "base",
      scrollContainer: sideScroller,
    } as unknown as CanvasPanel);
    // The FOCUSED pane has a scroller of its own, and a different one.
    const primaryScroller = document.createElement("div");
    makeRenderedPanel({ scrollContainer: primaryScroller });

    expect(revealScroller(side)).toBe(sideScroller);
    expect(revealScroller(primary())).toBe(primaryScroller);
    side.panels.length = 0;
  });
});

// ─── updateActivePanelHeaders ─────────────────────────────────────────────────

describe("updateActivePanelHeaders", () => {
  async function renderPanels() {
    const base = canvasPanelTemplate("base", "Base (320px)", false, 320);
    const md = canvasPanelTemplate("md", "Tablet (768px)", false, 768);
    await renderInto(base.tpl);
    await renderInto(md.tpl);
    canvasPanels.push(base.panel as never, md.panel as never);
    return { base: base.panel, md: md.panel };
  }

  test("marks the base header active when activeMedia is null", async () => {
    resetWorkspaceWithTab();
    const { base, md } = await renderPanels();
    updateActivePanelHeaders();
    expect(base.element?.querySelector(".canvas-panel-header")?.classList.contains("active")).toBe(
      true,
    );
    expect(md.element?.querySelector(".canvas-panel-header")?.classList.contains("active")).toBe(
      false,
    );
  });

  test("marks the matching breakpoint header active", async () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.activeMedia = "md";
    const { base, md } = await renderPanels();
    updateActivePanelHeaders();
    expect(base.element?.querySelector(".canvas-panel-header")?.classList.contains("active")).toBe(
      false,
    );
    expect(md.element?.querySelector(".canvas-panel-header")?.classList.contains("active")).toBe(
      true,
    );
  });

  test("tolerates panels without headers or elements", async () => {
    resetWorkspaceWithTab();
    const noLabel = canvasPanelTemplate(null, null, true);
    await renderInto(noLabel.tpl);
    canvasPanels.push(noLabel.panel as never, { element: null, mediaName: "md" } as never);
    expect(() => updateActivePanelHeaders()).not.toThrow();
  });
});

// ─── Two panes, two scales ────────────────────────────────────────────────────

describe("the pan-zoom axis is per stage", () => {
  /*
   * Defect S3, as four assertions.
   *
   * `panX`, `panY` and `panzoomWrap` moved onto `CanvasSurface`; the SCALE did not. It stayed
   * behind `initCanvasUtils`, whose `getZoom`/`setZoomDirect` were `activeTab.value` — so every
   * function below took an explicit surface and then asked the focused pane what scale to draw it
   * at. `scripts/check-pane-singletons.ts` could not see it: it banned `view.<field>` by name, and
   * the zoom was never on `view`.
   */

  /** Two panes on two documents, each with its own registered stage and panzoom wrap. */
  function twoPanes() {
    const a = resetWorkspaceWithTab(undefined, { documentPath: "/project/a.json", id: "a" });
    const b = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "/project/b.json",
      id: "b",
    });
    workspace.panes[0]!.tabOrder = ["a"];
    workspace.panes[0]!.activeTabId = "a";
    workspace.panes = [
      ...workspace.panes,
      { activeTabId: "b", id: SECONDARY_PANE, tabOrder: ["b"] },
    ];
    // The keyboard stays in the PRIMARY throughout — that is what makes the side pane "unfocused".
    workspace.activePaneId = PRIMARY_PANE;

    const side = standUpPaneGrid(SECONDARY_PANE);
    const primaryWrap = makePanzoomWrap();
    const sideWrap = document.createElement("div");
    side.wrap.append(sideWrap);
    side.panzoomWrap = sideWrap;
    return { a, b, primaryWrap, side, sideWrap };
  }

  afterEach(() => {
    surfaceForPane(SECONDARY_PANE).panels.length = 0;
    unregisterCanvasSurface(SECONDARY_PANE);
  });

  test("each stage draws at its OWN document's scale", () => {
    const { a, b, primaryWrap, side, sideWrap } = twoPanes();
    a.session.ui.zoom = 1;
    b.session.ui.zoom = 2;

    applyTransform(primary());
    applyTransform(side);

    // The failure was `scale(1)` here: the unfocused pane drew at the FOCUSED tab's scale.
    expect(sideWrap.style.transform).toContain("scale(2)");
    expect(primaryWrap.style.transform).toContain("scale(1)");
  });

  test("the side pane's zoom-in zooms the side pane", () => {
    const { a, b, side } = twoPanes();
    a.session.ui.zoom = 1;
    b.session.ui.zoom = 2;

    // Exactly what the side pane's `+` runs: its own tab's zoom, times 1.2, on its own surface.
    setUserZoom((b.session.ui.zoom ?? 1) * 1.2, side);

    expect(b.session.ui.zoom).toBeCloseTo(2.4, 10);
    // It used to land HERE — the primary's document, at a factor computed from the side pane's.
    expect(a.session.ui.zoom).toBe(1);
  });

  test("the fit is per document, so the unfocused pod reports its own", () => {
    const { side } = twoPanes();
    resetFits();

    setFit("width", side);

    expect(getFit(side)).toBe("width");
    expect(hasDeclaredFit(side)).toBe(true);
    expect(getFit(primary())).toBe(DEFAULT_FIT);
    expect(hasDeclaredFit(primary())).toBe(false);
  });

  test("one pane entering Design does not re-fit the other", () => {
    const { a, b, side, sideWrap } = twoPanes();
    resetFits();
    a.session.ui.zoom = 1;
    b.session.ui.zoom = 1;
    defineMetric(side.wrap, "clientWidth", 700);
    defineMetric(side.wrap, "clientHeight", 600);
    stubRect(sideWrap, { height: 0, width: 1312 });
    side.panels.push({ _width: 1280 } as never);

    fitOnCanvasEntry(side);

    expect(b.session.ui.zoom).toBeCloseTo(700 / 1312, 10);
    // The reported failure: the side pane fitting itself snapped the PRIMARY to 16%.
    expect(a.session.ui.zoom).toBe(1);
  });

  test("edit zoom is per stage too, down to the coalescing frame", () => {
    const { a, b, side } = twoPanes();
    a.session.ui.canvasMode = "edit";
    b.session.ui.canvasMode = "edit";
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    }) as typeof requestAnimationFrame;

    a.session.ui.editZoom = 1;
    b.session.ui.editZoom = 1;

    setEditZoom(2, side);
    expect(b.session.ui.editZoom).toBe(2);
    // It opened `activeTab.value`, so the side pane's `+` wrote the PRIMARY's content zoom.
    expect(a.session.ui.editZoom).toBe(1);

    // `_editZoomRaf` was ONE global slot: a burst in one pane swallowed the other pane's frame.
    requestEditZoom(1.5, primary());
    requestEditZoom(2.5, side);
    expect(frames.length).toBe(2);
    expect(a.session.ui.editZoom).toBe(1.5);
    expect(b.session.ui.editZoom).toBe(2.5);
  });
});
