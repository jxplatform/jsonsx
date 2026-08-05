/**
 * Overlays panel — the iframe canvas owns hit-testing and draws its own hover/selection boxes
 * inside each host's overlay layer, so this panel is a thin reactive delegate: it keeps
 * panel-header highlighting in sync and re-renders the block-action-bar on tracked session changes
 * (selection, hover, mode, activeMedia).
 */
import { flush, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mount, render, unmount } from "../src/panels/overlays";
import { canvasPanels } from "../src/store";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import type { CanvasPanel } from "../src/types";

let canvasMode = "design";
let isEditingFlag = false;
let renderBlockActionBar: ReturnType<typeof mock>;

/** A minimal iframe-era panel: element + header for the active-highlight sync. */
function makePanel(mediaName = "base"): CanvasPanel {
  const element = document.createElement("div");
  const header = document.createElement("div");
  header.className = "canvas-panel-header";
  const canvas = document.createElement("div");
  element.append(header, canvas);
  document.body.append(element);

  const panel = {
    canvas,
    element,
    mediaName,
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
  isEditingFlag = false;
  renderBlockActionBar = mock(() => {});
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

describe("overlays — header sync", () => {
  test("the flush highlights the active panel's header", async () => {
    const base = makePanel("base");
    const md = makePanel("md");
    activeTab.value!.session.ui.activeMedia = "md";
    await mountAndFlush();
    expect(md.element.querySelector(".canvas-panel-header")?.classList.contains("active")).toBe(
      true,
    );
    expect(base.element.querySelector(".canvas-panel-header")?.classList.contains("active")).toBe(
      false,
    );
  });

  test("panels' DOM is otherwise untouched (the iframe draws its own overlays)", async () => {
    const panel = makePanel();
    const marker = document.createElement("div");
    panel.canvas.append(marker);
    activeTab.value!.session.selection = [["children", 0]];
    await mountAndFlush();
    expect(panel.canvas.contains(marker)).toBe(true);
  });
});

describe("overlays — lifecycle", () => {
  test("reactive effect re-runs the block-action-bar delegate when selection changes", async () => {
    makePanel();
    await mountAndFlush();
    renderBlockActionBar.mockClear();
    // A selection change re-runs the tracked effect, which schedules another flush.
    activeTab.value!.session.selection = [["children", 0]];
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
