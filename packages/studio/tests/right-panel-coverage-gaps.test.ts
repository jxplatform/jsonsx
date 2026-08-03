/**
 * Coverage-gap tests for src/panels/right-panel.ts: the scheduled-render-after-unmount guard and
 * the style-panel render catch (a throwing style template must not take down the panel).
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let styleThrows = false;
void mock.module("../src/panels/style-panel", () => ({
  renderStylePanelTemplate: () => {
    if (styleThrows) {
      throw new Error("style template exploded");
    }
    return null;
  },
}));

// Namespace import: `rightPanel` is a mutable binding populated by initShellRefs in beforeEach.
const store = await import("../src/store");
const { initShellRefs, updateUi } = store;
const { mount, render, unmount } = await import("../src/panels/right-panel");
const { closeAllTabs } = await import("../src/workspace/workspace");

// Panel scheduler coalesces via requestAnimationFrame; make it a plain macrotask so a pending
// Frame survives unmount (cancelAnimationFrame cannot cancel a timeout id).
const origRaf = globalThis.requestAnimationFrame;
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (
  cb: FrameRequestCallback,
) => setTimeout(() => cb(0), 0) as unknown as number;

function makeCtx() {
  return {
    getCanvasMode: mock(() => "design"),
    mountAssistant: mock(() => {}),
    navigateToComponent: mock(() => {}),
    renderCanvas: mock(() => {}),
  };
}

beforeEach(() => {
  document.body.innerHTML = `<div id="app">
    <div id="toolbar"></div><div id="activity-bar"></div><div id="left-panel"></div>
    <div id="canvas-wrap"></div><div id="right-panel"></div>
    <div id="statusbar"></div>
  </div>`;
  initShellRefs();
  resetStudioState();
  styleThrows = false;
});

afterEach(() => {
  unmount();
  closeAllTabs();
});

describe("right panel gaps", () => {
  test("a frame scheduled before unmount lands harmlessly after it", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render(); // Schedules a flush on the stubbed (uncancelable) frame.
    unmount(); // Nulls the ctx before the frame fires.
    await flush(4);
    expect(store.rightPanel.querySelector("sp-tabs")).toBeNull();
  });

  test("the events tab consults the custom-element predicate once a node is selected", async () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "button", textContent: "Go" }],
      state: { greet: { $prototype: "Function", body: "return 1" } },
      tagName: "my-widget",
    } as never);
    tab.session.selection = ["children", 0];
    mount(makeCtx() as never);
    updateUi("rightTab", "events");
    render();
    await flush(4);
    const visible = [...store.rightPanel.querySelectorAll(".panel-body")].filter(
      (el) => (el as HTMLElement).style.display !== "none",
    );
    expect(visible).toHaveLength(1);
    // The events body rendered content for the selected node (not the empty state).
    expect(visible[0]!.textContent).not.toContain("Select an element");
  });

  test("a throwing style template is caught without breaking the panel", async () => {
    resetWorkspaceWithTab();
    styleThrows = true;
    mount(makeCtx() as never);
    updateUi("rightTab", "style");
    render();
    await flush(4);
    // The tabs header still rendered; the style body simply stayed empty.
    expect(store.rightPanel.querySelector("sp-tabs")).not.toBeNull();
    const visible = [...store.rightPanel.querySelectorAll(".panel-body")].filter(
      (el) => (el as HTMLElement).style.display !== "none",
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]!.textContent).toBe("");
  });
});

afterEach(() => {
  globalThis.requestAnimationFrame = origRaf;
});
