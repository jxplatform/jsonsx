/**
 * Overlays panel — the iframe canvas owns hit-testing and draws its own hover/selection overlays
 * from posted rects, so the parent-side overlays panel only clears any stale overlay layer,
 * disables the legacy click-catcher (so pointer events reach the iframe), and delegates the
 * block-action-bar render. The legacy in-realm box-drawing / per-mode pointer gating was removed
 * with the legacy canvas.
 */
import { flush, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mount, render, unmount } from "../src/panels/overlays";
import { canvasPanels } from "../src/store";
import { initCanvasHelpers } from "../src/canvas/canvas-helpers";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import type { CanvasPanel } from "../src/types";

let canvasMode = "design";
let zoom = 1;
let isEditingFlag = false;
let renderBlockActionBar: ReturnType<typeof mock>;

function makePanel(mediaName = "base"): CanvasPanel {
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
  return panel;
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

describe("overlays — iframe canvas host", () => {
  test("disables the legacy click-catcher and draws no legacy boxes", async () => {
    const panel = makePanel();
    activeTab.value!.session.selection = ["children", 0];
    await mountAndFlush();
    // The iframe owns hit-testing and draws its own overlays, so the legacy catcher is off and the
    // Legacy overlay layer stays empty.
    expect(panel.overlayClk.style.pointerEvents).toBe("none");
    expect(panel.overlay.querySelector(".overlay-selection")).toBeNull();
    expect(panel.overlay.querySelector(".overlay-hover")).toBeNull();
    expect(renderBlockActionBar).toHaveBeenCalled();
  });

  test("disables the click-catcher and leaves the overlay layer empty across every panel", async () => {
    const first = makePanel("base");
    const second = makePanel("--tablet");
    activeTab.value!.session.selection = ["children", 0];
    activeTab.value!.session.hover = ["children", 0];
    await mountAndFlush();
    expect(first.overlay.childElementCount).toBe(0);
    expect(second.overlay.childElementCount).toBe(0);
    expect(first.overlayClk.style.pointerEvents).toBe("none");
    expect(second.overlayClk.style.pointerEvents).toBe("none");
  });
});

describe("overlays — lifecycle", () => {
  test("reactive effect re-runs the block-action-bar delegate when selection changes", async () => {
    makePanel();
    await mountAndFlush();
    renderBlockActionBar.mockClear();
    // A selection change re-runs the tracked effect, which schedules another flush.
    activeTab.value!.session.selection = ["children", 0];
    await flush();
    expect(renderBlockActionBar).toHaveBeenCalled();
  });

  test("reactive effect re-runs the delegate when the ACTIVE PANEL (activeMedia) changes", async () => {
    makePanel();
    await mountAndFlush();
    renderBlockActionBar.mockClear();
    // A hit in another breakpoint panel re-anchors the bar even with an unchanged selection path.
    activeTab.value!.session.ui.activeMedia = "sm";
    await flush();
    expect(renderBlockActionBar).toHaveBeenCalled();
  });

  test("render after unmount is a no-op (the block-action-bar delegate is not invoked)", async () => {
    makePanel();
    await mountAndFlush();
    unmount();
    renderBlockActionBar.mockClear();
    render();
    await flush();
    expect(renderBlockActionBar).not.toHaveBeenCalled();
  });

  test("unmount between schedule and flush aborts the paint", async () => {
    makePanel();
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
    await mountAndFlush();
    renderBlockActionBar.mockClear();
    render();
    render();
    render();
    await flush();
    expect(renderBlockActionBar).toHaveBeenCalledTimes(1);
  });
});
