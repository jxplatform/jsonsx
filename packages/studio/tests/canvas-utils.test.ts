import { renderInto, resetStudioState, resetWorkspaceWithTab, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  applyTransform,
  canvasPanelTemplate,
  centerCanvas,
  fitToScreen,
  initCanvasUtils,
  observeCenterUntilStable,
  panToElement,
  panToParentRect,
  positionZoomIndicator,
  renderZoomIndicator,
  resetZoom,
  resetZoomIndicator,
  updateActivePanelHeaders,
} from "../src/canvas/canvas-utils";
import { canvasPanels, canvasWrap, initShellRefs, registerRenderer } from "../src/store";
import { view } from "../src/view";
import type { CanvasPanel } from "../src/types";

// ─── Test context plumbing ────────────────────────────────────────────────────

let zoom = 1;
let canvasMode = "design";
const setZoomDirect = mock((z: number) => {
  zoom = z;
});
const overlaysRenderer = mock(() => {});
registerRenderer("overlays", overlaysRenderer);

function setupShell() {
  document.body.innerHTML = "";
  for (const id of [
    "canvas-wrap",
    "activity-bar",
    "left-panel",
    "right-panel",
    "toolbar",
    "statusbar",
  ]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
}

/** Define a read-only layout metric on an element (happy-dom does no layout). */
function defineMetric(el: Element, prop: string, value: number) {
  Object.defineProperty(el, prop, { configurable: true, value });
}

function makePanzoomWrap() {
  const el = document.createElement("div");
  canvasWrap.append(el);
  view.panzoomWrap = el;
  return el;
}

const originalRaf = globalThis.requestAnimationFrame;
const OriginalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  setupShell();
  resetStudioState();
  zoom = 1;
  canvasMode = "design";
  setZoomDirect.mockClear();
  overlaysRenderer.mockClear();
  canvasPanels.length = 0;
  view.panzoomWrap = null;
  view.centerObserver = null;
  view.needsCenter = true;
  view.panX = 0;
  view.panY = 0;
  initCanvasUtils({
    getCanvasMode: () => canvasMode,
    getZoom: () => zoom,
    setZoomDirect,
  });
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

  test("header click sets activeMedia from panel media", async () => {
    const tab = resetWorkspaceWithTab();
    const { tpl, panel } = canvasPanelTemplate("md", "Tablet (768px)", false, 768);
    await renderInto(tpl);
    const header = panel.element?.querySelector(".canvas-panel-header") as HTMLElement;
    header.click();
    expect(tab.session.ui.activeMedia).toBe("md");
  });

  test("base panel header click resets activeMedia to null", async () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.activeMedia = "md";
    const { tpl, panel } = canvasPanelTemplate("base", "Base (320px)", false, 320);
    await renderInto(tpl);
    const header = panel.element?.querySelector(".canvas-panel-header") as HTMLElement;
    header.click();
    expect(tab.session.ui.activeMedia).toBeNull();
  });
});

// ─── centerCanvas ─────────────────────────────────────────────────────────────

describe("centerCanvas", () => {
  test("no-op when there is no panzoom wrapper", () => {
    view.panX = 123;
    centerCanvas();
    expect(view.panX).toBe(123);
  });

  test("centers content horizontally and resets panY", () => {
    const wrap = makePanzoomWrap();
    defineMetric(canvasWrap, "clientWidth", 1000);
    defineMetric(wrap, "scrollWidth", 800);
    view.panY = 99;
    centerCanvas();
    expect(view.panX).toBe(100); // (1000 - 800) / 2
    expect(view.panY).toBe(0);
  });

  test("clamps panX to 16 when content is wider than the viewport", () => {
    const wrap = makePanzoomWrap();
    defineMetric(canvasWrap, "clientWidth", 500);
    defineMetric(wrap, "scrollWidth", 800);
    zoom = 2;
    centerCanvas();
    expect(view.panX).toBe(16);
  });
});

// ─── applyTransform ───────────────────────────────────────────────────────────

describe("applyTransform", () => {
  test("no-op without panzoom wrapper", () => {
    applyTransform();
    expect(overlaysRenderer).not.toHaveBeenCalled();
  });

  test("applies translate + scale and re-renders overlays", () => {
    const wrap = makePanzoomWrap();
    view.panX = 10;
    view.panY = 20;
    zoom = 2;
    applyTransform();
    expect(wrap.style.transform).toBe("translate(10px, 20px) scale(2)");
    expect(overlaysRenderer).toHaveBeenCalled();
  });

  test("stylebook mode needs no per-mode overlay redraw (iframe overlays live in the wrap)", () => {
    makePanzoomWrap();
    canvasMode = "stylebook";
    overlaysRenderer.mockClear();
    applyTransform();
    expect(overlaysRenderer).toHaveBeenCalled();
  });
});

// ─── fitToScreen / resetZoom ──────────────────────────────────────────────────

describe("fitToScreen", () => {
  test("no-op without panzoom wrapper", () => {
    fitToScreen();
    expect(setZoomDirect).not.toHaveBeenCalled();
  });

  test("fits panels to the viewport and centers", () => {
    const wrap = makePanzoomWrap();
    defineMetric(canvasWrap, "clientWidth", 1000);
    defineMetric(canvasWrap, "clientHeight", 600);
    stubRect(wrap, { height: 300, width: 1056 });
    canvasPanels.push({ _width: 400 } as never, { _width: 600 } as never);

    fitToScreen();

    // Total width = 400 + 600 + 24 gap + 32 padding = 1056; height fit = 600/332
    const expectedZoom = Math.min(1000 / 1056, 600 / 332);
    expect(setZoomDirect).toHaveBeenCalledWith(expectedZoom);
    expect(view.panX).toBeCloseTo(Math.max(0, (1000 - 1056 * expectedZoom) / 2));
    expect(view.panY).toBeCloseTo(Math.max(0, (600 - 332 * expectedZoom) / 2));
    expect(wrap.style.transform).toContain(`scale(${expectedZoom}`);
  });

  test("defaults panel width to 800 and clamps zoom to at least 0.05", () => {
    const wrap = makePanzoomWrap();
    defineMetric(canvasWrap, "clientWidth", 1);
    defineMetric(canvasWrap, "clientHeight", 600);
    stubRect(wrap, { height: 300 });
    canvasPanels.push({} as never);
    fitToScreen();
    expect(setZoomDirect).toHaveBeenCalledWith(0.05);
  });
});

describe("resetZoom", () => {
  test("no-op without panzoom wrapper", () => {
    resetZoom();
    expect(setZoomDirect).not.toHaveBeenCalled();
  });

  test("resets zoom to 1 and re-centers", () => {
    const wrap = makePanzoomWrap();
    defineMetric(canvasWrap, "clientWidth", 1000);
    defineMetric(wrap, "scrollWidth", 500);
    zoom = 3;
    resetZoom();
    expect(setZoomDirect).toHaveBeenCalledWith(1);
    expect(view.panX).toBe(250);
    expect(wrap.style.transform).toBe("translate(250px, 0px) scale(1)");
  });
});

// ─── Zoom indicator ───────────────────────────────────────────────────────────

describe("zoom indicator", () => {
  test("renderZoomIndicator shows the rounded zoom percentage", () => {
    zoom = 1.5;
    renderZoomIndicator();
    const label = document.querySelector(".zoom-indicator-label");
    expect(label?.textContent).toBe("150%");
  });

  test("reset action resets zoom to 100%", () => {
    makePanzoomWrap();
    zoom = 2;
    renderZoomIndicator();
    const reset = document.querySelector('[title="Reset to 100%"]') as HTMLElement;
    reset.click();
    expect(setZoomDirect).toHaveBeenCalledWith(1);
    expect(zoom).toBe(1);
  });

  test("fit action triggers fitToScreen", () => {
    const wrap = makePanzoomWrap();
    stubRect(wrap, { height: 100 });
    renderZoomIndicator();
    const fit = document.querySelector('[title="Fit to screen"]') as HTMLElement;
    fit.click();
    expect(setZoomDirect).toHaveBeenCalled();
  });

  test("positionZoomIndicator centers indicator over canvas-wrap", () => {
    renderZoomIndicator();
    stubRect(canvasWrap, { height: 600, left: 100, top: 0, width: 400 });
    positionZoomIndicator();
    const indicator = document.querySelector(".zoom-indicator") as HTMLElement;
    expect(indicator.style.left).toBe("300px");
    expect(indicator.style.top).toBe("568px");
    expect(indicator.style.transform).toBe("translateX(-50%)");
  });

  test("resetZoomIndicator clears the indicator and disables positioning", () => {
    renderZoomIndicator();
    expect(document.querySelector(".zoom-indicator")).not.toBeNull();
    resetZoomIndicator();
    expect(document.querySelector(".zoom-indicator")).toBeNull();
    // Early return when the indicator element is gone
    expect(() => positionZoomIndicator()).not.toThrow();
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
    observeCenterUntilStable();
    expect(view.centerObserver).toBeNull();
    expect(FakeResizeObserver.instances.length).toBe(0);
  });

  test("observes the wrapper and re-centers on resize while needed", () => {
    const wrap = makePanzoomWrap();
    defineMetric(canvasWrap, "clientWidth", 1000);
    defineMetric(wrap, "scrollWidth", 600);
    observeCenterUntilStable();
    expect(view.needsCenter).toBe(true);
    const ro = FakeResizeObserver.instances[0]!;
    expect(ro.observed).toEqual([wrap]);
    expect(view.panX).toBe(200);

    view.panX = 0;
    ro.cb();
    expect(view.panX).toBe(200);
    expect(wrap.style.transform).toContain("translate(200px, 0px)");
  });

  test("disconnects once the user pans (needsCenter false)", () => {
    makePanzoomWrap();
    observeCenterUntilStable();
    const ro = FakeResizeObserver.instances[0]!;
    view.needsCenter = false;
    ro.cb();
    expect(ro.disconnected).toBe(true);
    expect(view.centerObserver).toBeNull();
  });

  test("replaces a previous observer", () => {
    makePanzoomWrap();
    observeCenterUntilStable();
    observeCenterUntilStable();
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
    view.panY = 7;
    panToElement(["children", 0]);
    expect(view.panY).toBe(7);
  });

  test("no-op when the panel has no canvas", () => {
    canvasPanels.push({ canvas: null, mediaName: "base" } as never);
    view.panY = 7;
    panToElement(["children", 0]);
    expect(view.panY).toBe(7);
  });

  test("no-op when the element is not found", () => {
    makeRenderedPanel();
    view.panY = 7;
    panToElement(["children", 99]);
    expect(view.panY).toBe(7);
  });

  test("scrolls the scroll container smoothly in content mode", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.scrollTop = 100;
    const scrollTo = mock((_opts: ScrollToOptions) => {});
    (scrollContainer as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
    const { target } = makeRenderedPanel({ scrollContainer });

    stubRect(canvasWrap, { height: 600, top: 0 });
    stubRect(target, { height: 50, top: 100 });
    panToElement(["children", 0]);

    // ElCenterY = 125, vpCenterY = 300, offsetY = 175 → top = 100 - 175
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: -75 });
  });

  test("animates panY via requestAnimationFrame without a scroll container", () => {
    const { target } = makeRenderedPanel();
    makePanzoomWrap();
    stubRect(canvasWrap, { height: 600, top: 0 });
    stubRect(target, { height: 0, top: 500 });

    // Drive the animation deterministically: one mid-flight frame, one final frame
    const frames = [100, 1000];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const dt = frames.shift() ?? 1000;
      cb(performance.now() + dt);
      return 0;
    }) as typeof requestAnimationFrame;

    view.panY = 0;
    panToElement(["children", 0]);

    // OffsetY = 300 - 500 = -200; final eased value lands on the target
    expect(view.panY).toBeCloseTo(-200);
  });
});

describe("panToParentRect", () => {
  test("pans by the parent-viewport rect (the stylebook pan-to-card entry point)", () => {
    makePanzoomWrap();
    stubRect(canvasWrap, { height: 600, top: 0 });

    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(performance.now() + 1000);
      return 0;
    }) as typeof requestAnimationFrame;

    view.panY = 50;
    panToParentRect({ height: 0, top: 0 });
    // OffsetY = 300 → target = 350
    expect(view.panY).toBeCloseTo(350);
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
