/**
 * Coverage-gap tests for src/panels/block-action-bar.ts:
 *
 * - OnCanvasScroll guards (no ctx / open link popover / no selection)
 * - The reposition fast path resurrecting a missing bar
 * - Anchor-out-of-canvas hiding via barPosition + canvasWrap bounds
 * - Window-edge clamping
 * - Bar mousedown skipping sp-textfield targets
 * - IsLinkPopoverOpen()
 * - Stale Move up/down clicks after the selection is gone
 * - The drag handle's onGenerateDragPreview suppressor
 */
import { flush, registerPrimaryStage, resetWorkspaceWithTab, stubRect } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../src/state";
import { surfaceForPane } from "../src/canvas/surface-registry";

type AnyRec = Record<string, any>;

const draggables: AnyRec[] = [];
let previewsDisabled = 0;

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: (cfg: AnyRec) => {
    draggables.push(cfg);
    return () => {};
  },
}));
void mock.module("@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview", () => ({
  disableNativeDragPreview: () => {
    previewsDisabled += 1;
  },
}));

const host: {
  anchor: { left: number; top: number; width: number; height: number } | null;
  editing: boolean;
  posted: AnyRec[];
} = { anchor: null, editing: false, posted: [] };

void mock.module("../src/canvas/iframe-host", () => ({
  getEditBarAnchorRect: () => host.anchor,
  getEditSnapshot: () => ({ editing: host.editing, editingProp: null, snapshot: null }),
  postApplyFormat: (intent: AnyRec) => host.posted.push(intent),
  requestCanvasEval: () => Promise.resolve(null),
}));

const {
  dismissBlockActionBar,
  dismissLinkPopover,
  initBlockActionBar,
  isLinkPopoverOpen,
  onCanvasScroll,
  openLinkPopoverFromShortcut,
  renderBlockActionBar,
} = await import("../src/panels/block-action-bar");
const { initLayers } = await import("../src/ui/layers");
// Namespace import: `canvasWrap` is a mutable binding populated by initShellRefs below.
const store = await import("../src/store");
const { view } = await import("../src/view");
const { closeAllTabs } = await import("../src/workspace/workspace");

document.body.innerHTML = `<div id="app">
  <div id="toolbar"></div><div id="activity-bar"></div><div id="left-panel"></div>
  <div class="pane-stage" data-jx-region="pane.primary"></div><div id="right-panel"></div><div id="chat-panel"></div>
  <div id="statusbar"></div>
  <div id="layer-popover"></div><div id="layer-modal"></div><div id="layer-dialog"></div>
</div>`;
initLayers();
store.initShellRefs();
registerPrimaryStage();

let canvasMode = "design";

function setup(docNode: JxMutableNode, selection: JxPath | null) {
  const tab = resetWorkspaceWithTab(docNode);
  tab.session.selection = selection ? [selection] : [];
  host.anchor = { height: 20, left: 30, top: 200, width: 100 };
  return tab;
}

function bar(): HTMLElement | null {
  return (view.blockActionBarEl?.querySelector(".block-action-bar") as HTMLElement) ?? null;
}

const raf = () =>
  new Promise((resolve) => {
    requestAnimationFrame(resolve);
  });

const scrollDoc = () => {
  const e = new Event("scroll");
  Object.defineProperty(e, "target", { configurable: true, value: document });
  onCanvasScroll(e);
};

describe("onCanvasScroll guards (pre-init)", () => {
  test("scrolls before initBlockActionBar are ignored", () => {
    expect(() => {
      scrollDoc();
    }).not.toThrow();
    expect(bar()).toBeNull();
  });
});

describe("block action bar gaps", () => {
  beforeEach(() => {
    initBlockActionBar({
      getCanvasMode: () => canvasMode,
      navigateToComponent: () => {},
    });
    canvasMode = "design";
    host.editing = false;
    host.posted = [];
    draggables.length = 0;
    previewsDisabled = 0;
    dismissLinkPopover();
    dismissBlockActionBar();
    // Reset canvas-wrap geometry to a tall area so barPosition's bounds check stays inert
    // Unless a test narrows it deliberately.
    stubRect(surfaceForPane("primary").wrap, { height: 2000, left: 0, top: 0, width: 1600 });
  });

  test("scrolls without a selection are ignored", () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, null);
    expect(() => {
      scrollDoc();
    }).not.toThrow();
    expect(bar()).toBeNull();
  });

  test("scrolls while the link popover is open never reposition (typed URL survives)", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    host.editing = true;
    renderBlockActionBar();
    await flush();
    expect(bar()).toBeTruthy();
    openLinkPopoverFromShortcut();
    expect(isLinkPopoverOpen()).toBe(true);
    const before = bar()!.style.top;
    host.anchor = { height: 20, left: 90, top: 900, width: 100 };
    scrollDoc();
    await raf();
    expect(bar()!.style.top).toBe(before);
    dismissLinkPopover();
    expect(isLinkPopoverOpen()).toBe(false);
  });

  test("a scroll with no live bar falls back to a full render", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    expect(bar()).toBeNull();
    scrollDoc();
    await raf();
    await flush();
    expect(bar()).toBeTruthy();
  });

  test("an anchor scrolled out of the canvas area hides the bar", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    stubRect(surfaceForPane("primary").wrap, { height: 400, left: 0, top: 100, width: 1600 });
    renderBlockActionBar();
    await flush();
    expect(bar()).toBeTruthy();

    // Below the canvas area → reposition hides via visibility.
    host.anchor = { height: 20, left: 30, top: 900, width: 100 };
    scrollDoc();
    await raf();
    expect(bar()!.style.visibility).toBe("hidden");

    // Above the canvas area → same.
    host.anchor = { height: 20, left: 30, top: 10, width: 100 };
    scrollDoc();
    await raf();
    expect(bar()!.style.visibility).toBe("hidden");

    // Back inside → visible again.
    host.anchor = { height: 20, left: 30, top: 250, width: 100 };
    scrollDoc();
    await raf();
    expect(bar()!.style.visibility).toBe("");
  });

  test("a bar wider than the window is clamped back inside the right edge", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    await flush();
    const el = bar()!;
    stubRect(el, { height: 30, left: window.innerWidth - 10, top: 200, width: 300 });
    host.anchor = { height: 20, left: window.innerWidth - 10, top: 300, width: 100 };
    scrollDoc();
    await raf();
    expect(el.style.left).toBe(`${Math.max(0, window.innerWidth - 300)}px`);
  });

  test("mousedown on an embedded text field is not focus-guarded", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    await flush();
    const field = document.createElement("sp-textfield");
    bar()!.append(field);
    const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    field.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);

    // A plain bar press IS prevented (keeps the iframe selection).
    const e2 = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    bar()!.dispatchEvent(e2);
    expect(e2.defaultPrevented).toBe(true);
  });

  test("stale Move up/down clicks after the selection clears are no-ops", async () => {
    const tab = setup(
      {
        children: [
          { tagName: "p", textContent: "a" },
          { tagName: "p", textContent: "b" },
          { tagName: "p", textContent: "c" },
        ],
        tagName: "div",
      },
      ["children", 1],
    );
    renderBlockActionBar();
    await flush();
    const up = bar()!.querySelector(
      'sp-action-button[data-command="selection.moveUp"]',
    ) as HTMLElement;
    const down = bar()!.querySelector(
      'sp-action-button[data-command="selection.moveDown"]',
    ) as HTMLElement;
    const before = JSON.stringify(tab.doc.document);
    tab.session.selection = [];
    up.click();
    down.click();
    expect(JSON.stringify(tab.doc.document)).toBe(before);
  });

  test("the drag handle registers a draggable that suppresses the native preview", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    await flush();
    expect(draggables.length).toBeGreaterThan(0);
    const handle = draggables.at(-1)!;
    expect(handle.getInitialData()).toEqual({ path: ["children", 0], type: "tree-node" });
    handle.onGenerateDragPreview({ nativeSetDragImage: null });
    expect(previewsDisabled).toBe(1);
  });

  test("re-rendering replaces the drag-handle registration through the cleanup seam", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    await flush();
    const first = draggables.length;
    expect(view.selDragCleanup).not.toBeNull();
    renderBlockActionBar();
    await flush();
    expect(draggables.length).toBeGreaterThan(first);
    expect(view.selDragCleanup).not.toBeNull();
    closeAllTabs();
  });
});
