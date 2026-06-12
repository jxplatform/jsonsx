/**
 * Overlays panel — hover/selection overlay boxes per canvas panel, pointer-event gating per canvas
 * mode, and block-action-bar delegation.
 */
import { flush, resetWorkspaceWithTab, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mount, render, unmount } from "../src/panels/overlays";
import { canvasPanels, elToPath } from "../src/store";
import { initCanvasHelpers } from "../src/canvas/canvas-helpers";
import { layoutElements } from "../src/canvas/canvas-live-render";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { view } from "../src/view";
import type { CanvasPanel } from "../src/types";

let canvasMode = "design";
let zoom = 1;
let isEditingFlag = false;
let renderBlockActionBar: ReturnType<typeof mock>;

interface FakePanel {
  panel: CanvasPanel;
  rootEl: HTMLElement;
  childEl: HTMLElement;
}

function makePanel(mediaName = "base"): FakePanel {
  const element = document.createElement("div");
  const canvas = document.createElement("div");
  const overlay = document.createElement("div");
  const overlayClk = document.createElement("div");
  const viewport = document.createElement("div");
  const dropLine = document.createElement("div");
  dropLine.className = "drop-line";

  const rootEl = document.createElement("div");
  const childEl = document.createElement("p");
  rootEl.append(childEl);
  canvas.append(rootEl);
  viewport.append(canvas);
  element.append(viewport, overlay, overlayClk);
  document.body.append(element);

  elToPath.set(rootEl, []);
  elToPath.set(childEl, ["children", 0]);

  stubRect(viewport, { height: 600, left: 100, top: 50, width: 800 });
  stubRect(rootEl, { height: 500, left: 110, top: 60, width: 700 });
  stubRect(childEl, { height: 40, left: 130, top: 90, width: 200 });

  const panel = {
    canvas,
    dropLine,
    element,
    mediaName,
    overlay,
    overlayClk,
    viewport,
  } as unknown as CanvasPanel;
  canvasPanels.push(panel);
  return { childEl, panel, rootEl };
}

async function mountAndFlush() {
  mount({
    getCanvasMode: () => canvasMode,
    isEditing: () => isEditingFlag,
    renderBlockActionBar: renderBlockActionBar as unknown as () => void,
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  canvasMode = "design";
  zoom = 1;
  isEditingFlag = false;
  view.componentInlineEdit = null;
  view.selDragCleanup = null;
  renderBlockActionBar = mock(() => {});
  initCanvasHelpers({ getCanvasMode: () => canvasMode, getZoom: () => zoom });
  resetWorkspaceWithTab({
    children: [{ tagName: "p", textContent: "Hello" }],
    tagName: "div",
  });
});

afterEach(() => {
  unmount();
  canvasPanels.length = 0;
  closeAllTabs();
  document.body.innerHTML = "";
});

describe("overlays — design mode boxes", () => {
  test("renders a selection box on the active panel with scaled geometry", async () => {
    const { panel } = makePanel();
    activeTab.value!.session.selection = ["children", 0];
    await mountAndFlush();

    const box = panel.overlay.querySelector(".overlay-selection") as HTMLElement;
    expect(box).not.toBeNull();
    const style = box.getAttribute("style") ?? "";
    expect(style).toContain("top:40px");
    expect(style).toContain("left:30px");
    expect(style).toContain("width:200px");
    expect(style).toContain("height:40px");
    expect(panel.overlay.querySelector(".drop-line")).not.toBeNull();
    expect(renderBlockActionBar).toHaveBeenCalled();
    expect(panel.overlayClk.style.pointerEvents).toBe("");
  });

  test("zoom scales overlay box geometry", async () => {
    zoom = 2;
    const { panel } = makePanel();
    activeTab.value!.session.selection = ["children", 0];
    await mountAndFlush();
    const style = panel.overlay.querySelector(".overlay-selection")!.getAttribute("style") ?? "";
    expect(style).toContain("top:20px");
    expect(style).toContain("left:15px");
    expect(style).toContain("width:100px");
    expect(style).toContain("height:20px");
  });

  test("hover distinct from selection renders a hover box", async () => {
    const { panel } = makePanel();
    activeTab.value!.session.selection = ["children", 0];
    activeTab.value!.session.hover = [];
    await mountAndFlush();
    const hover = panel.overlay.querySelector(".overlay-hover") as HTMLElement;
    expect(hover).not.toBeNull();
    expect(hover.getAttribute("style")).toContain("width:700px");
    expect(panel.overlay.querySelector(".overlay-selection")).not.toBeNull();
  });

  test("hover equal to selection renders no hover box", async () => {
    const { panel } = makePanel();
    activeTab.value!.session.selection = ["children", 0];
    activeTab.value!.session.hover = ["children", 0];
    await mountAndFlush();
    expect(panel.overlay.querySelector(".overlay-hover")).toBeNull();
  });

  test("layout elements get the layout class and badge", async () => {
    const { panel, childEl } = makePanel();
    layoutElements.add(childEl);
    activeTab.value!.session.selection = ["children", 0];
    activeTab.value!.session.hover = ["children", 0];
    await mountAndFlush();
    const box = panel.overlay.querySelector(".overlay-selection") as HTMLElement;
    expect(box.classList.contains("overlay-layout")).toBe(true);
    expect(box.querySelector(".overlay-layout-badge")!.textContent).toBe("Layout");
  });

  test("editing mode hides the selection border and disables overlay clicks", async () => {
    isEditingFlag = true;
    const { panel } = makePanel();
    activeTab.value!.session.selection = ["children", 0];
    await mountAndFlush();
    expect(panel.overlayClk.style.pointerEvents).toBe("none");
    const style = panel.overlay.querySelector(".overlay-selection")!.getAttribute("style") ?? "";
    expect(style).toContain("border:none");
  });

  test("componentInlineEdit also disables overlay clicks", async () => {
    view.componentInlineEdit = {} as never;
    const { panel } = makePanel();
    await mountAndFlush();
    expect(panel.overlayClk.style.pointerEvents).toBe("none");
  });

  test("selection on a non-active panel renders no selection box there", async () => {
    const first = makePanel("base");
    const second = makePanel("--tablet");
    activeTab.value!.session.selection = ["children", 0];
    activeTab.value!.session.ui.activeMedia = "--tablet";
    await mountAndFlush();
    expect(first.panel.overlay.querySelector(".overlay-selection")).toBeNull();
    expect(second.panel.overlay.querySelector(".overlay-selection")).not.toBeNull();
  });

  test("panels without a viewport are skipped", async () => {
    const { panel } = makePanel();
    (panel as unknown as { viewport: null }).viewport = null;
    activeTab.value!.session.selection = ["children", 0];
    await mountAndFlush();
    expect(panel.overlay.querySelector(".overlay-selection")).toBeNull();
    expect(renderBlockActionBar).toHaveBeenCalled();
  });

  test("selection path that resolves to no canvas element renders no box", async () => {
    const { panel } = makePanel();
    activeTab.value!.session.selection = ["children", 99];
    await mountAndFlush();
    expect(panel.overlay.querySelector(".overlay-selection")).toBeNull();
  });

  test("design render runs a pending selDragCleanup", async () => {
    makePanel();
    const cleanup = mock(() => {});
    view.selDragCleanup = cleanup as unknown as () => void;
    await mountAndFlush();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(view.selDragCleanup).toBeNull();
  });
});

describe("overlays — mode gating", () => {
  test("preview mode clears overlays, disables clicks, and runs selDragCleanup", async () => {
    const { panel } = makePanel();
    activeTab.value!.session.selection = ["children", 0];
    await mountAndFlush();
    expect(panel.overlay.querySelector(".overlay-selection")).not.toBeNull();

    canvasMode = "preview";
    const cleanup = mock(() => {});
    view.selDragCleanup = cleanup as unknown as () => void;
    renderBlockActionBar.mockClear();
    render();
    await flush();
    expect(panel.overlay.querySelector(".overlay-selection")).toBeNull();
    expect(panel.overlayClk.style.pointerEvents).toBe("none");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(view.selDragCleanup).toBeNull();
    expect(renderBlockActionBar).not.toHaveBeenCalled();
  });

  test("stylebook mode enables clicks only on the elements tab", async () => {
    canvasMode = "stylebook";
    const { panel } = makePanel();
    activeTab.value!.session.ui.stylebookTab = "elements";
    await mountAndFlush();
    expect(panel.overlayClk.style.pointerEvents).toBe("");

    activeTab.value!.session.ui.stylebookTab = "tokens";
    render();
    await flush();
    expect(panel.overlayClk.style.pointerEvents).toBe("none");
    expect(renderBlockActionBar).not.toHaveBeenCalled();
  });
});

describe("overlays — lifecycle", () => {
  test("reactive effect re-renders when selection changes", async () => {
    const { panel } = makePanel();
    await mountAndFlush();
    expect(panel.overlay.querySelector(".overlay-selection")).toBeNull();
    activeTab.value!.session.selection = ["children", 0];
    await flush();
    expect(panel.overlay.querySelector(".overlay-selection")).not.toBeNull();
  });

  test("render after unmount is a no-op", async () => {
    const { panel } = makePanel();
    activeTab.value!.session.selection = ["children", 0];
    await mountAndFlush();
    unmount();
    panel.overlay.innerHTML = "";
    render();
    await flush();
    expect(panel.overlay.querySelector(".overlay-selection")).toBeNull();
  });

  test("unmount between schedule and flush aborts the paint", async () => {
    makePanel();
    activeTab.value!.session.selection = ["children", 0];
    await mountAndFlush();
    render();
    unmount();
    await flush();
    expect(renderBlockActionBar.mock.calls.length).toBeGreaterThan(0);
  });

  test("no active tab makes the flush a no-op", async () => {
    makePanel();
    await mountAndFlush();
    closeAllTabs();
    renderBlockActionBar.mockClear();
    render();
    await flush();
    expect(renderBlockActionBar).not.toHaveBeenCalled();
  });

  test("multiple render calls coalesce into one flush", async () => {
    makePanel();
    activeTab.value!.session.selection = ["children", 0];
    await mountAndFlush();
    renderBlockActionBar.mockClear();
    render();
    render();
    render();
    await flush();
    expect(renderBlockActionBar).toHaveBeenCalledTimes(1);
  });
});
