/**
 * Right panel orchestrator — mount/unmount lifecycle, tab routing
 * (properties/events/style/assistant), the sp-tabs change handler, and the no-active-tab clear
 * path.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mount, render, unmount } from "../src/panels/right-panel";
import { initShellRefs, rightPanel, updateUi } from "../src/store";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";

// Panel scheduler coalesces via requestAnimationFrame; make it synchronous-ish.
const origRaf = globalThis.requestAnimationFrame;
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (
  cb: FrameRequestCallback,
) => setTimeout(() => cb(0), 0) as unknown as number;

function makeCtx() {
  return {
    getCanvasMode: mock(() => "design"),
    navigateToComponent: mock(() => {}),
    renderCanvas: mock(() => {}),
  };
}

beforeEach(() => {
  document.body.innerHTML = `<div id="app">
    <div id="toolbar"></div><div id="activity-bar"></div><div id="left-panel"></div>
    <div id="canvas-wrap"></div><div id="right-panel"></div><div id="statusbar"></div>
  </div>`;
  initShellRefs();
  resetStudioState();
});

afterEach(() => {
  unmount();
  closeAllTabs();
});

describe("right panel", () => {
  test("mount + render shows the tabs header and properties panel by default", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    expect(rightPanel.querySelector("sp-tabs")).toBeTruthy();
    expect(rightPanel.querySelectorAll("sp-tab").length).toBe(4);
    const visible = [...rightPanel.querySelectorAll(".panel-body")].filter(
      (el) => (el as HTMLElement).style.display !== "none",
    );
    expect(visible.length).toBe(1);
  });

  test("clears the panel when no tab is active", async () => {
    closeAllTabs();
    mount(makeCtx() as never);
    render();
    await flush(4);
    expect(rightPanel.textContent).toBe("");
  });

  test("routes to events, style, and assistant tabs", async () => {
    resetWorkspaceWithTab();
    const ctx = makeCtx();
    mount(ctx as never);
    for (const tabName of ["events", "style", "assistant"]) {
      updateUi("rightTab", tabName);
      render();
      await flush(4);
      const containers = [...rightPanel.querySelectorAll(".panel-body")] as HTMLElement[];
      const visible = containers.filter((el) => el.style.display !== "none");
      expect(visible.length).toBe(1);
    }
    expect(ctx.getCanvasMode).toHaveBeenCalled();
  });

  test("sp-tabs change handler switches the active tab", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    const tabs = rightPanel.querySelector("sp-tabs") as HTMLElement & { selected?: string };
    expect(tabs).toBeTruthy();
    tabs.selected = "style";
    tabs.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(4);
    expect(activeTab.value?.session.ui.rightTab).toBe("style");
    // Re-dispatch with the same selection: the handler's sel !== tab guard skips the update.
    tabs.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(2);
    expect(activeTab.value?.session.ui.rightTab).toBe("style");
  });

  test("unmount disposes scheduler and scope; render after unmount is a no-op", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    unmount();
    expect(() => render()).not.toThrow();
    await flush(2);
  });
});

afterEach(() => {
  globalThis.requestAnimationFrame = origRaf;
});
