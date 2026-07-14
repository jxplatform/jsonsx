/**
 * Right panel orchestrator — mount/unmount lifecycle, tab routing (properties/events/style), the
 * sp-tabs change handler, the stale-"assistant" coercion (the Assistant tab moved to the persistent
 * chat sidebar), and the no-active-tab clear path.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initShellRefs, rightPanel, updateUi } from "../src/store";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";

const { mount, render, unmount } = await import("../src/panels/right-panel");

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
    <div id="canvas-wrap"></div><div id="right-panel"></div><div id="chat-panel"></div>
    <div id="statusbar"></div>
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
    expect(rightPanel.querySelectorAll("sp-tab").length).toBe(3);
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

  test("routes to events and style tabs", async () => {
    resetWorkspaceWithTab();
    const ctx = makeCtx();
    mount(ctx as never);
    for (const tabName of ["events", "style"]) {
      updateUi("rightTab", tabName);
      render();
      await flush(4);
      const containers = [...rightPanel.querySelectorAll(".panel-body")] as HTMLElement[];
      const visible = containers.filter((el) => el.style.display !== "none");
      expect(visible.length).toBe(1);
    }
    expect(ctx.getCanvasMode).toHaveBeenCalled();
  });

  test("a stale 'assistant' rightTab coerces to properties", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    updateUi("rightTab", "assistant");
    render();
    await flush(4);
    const tabs = rightPanel.querySelector("sp-tabs") as HTMLElement;
    expect(tabs.getAttribute("selected")).toBe("properties");
    // No fourth container appears for the retired tab.
    expect(rightPanel.querySelectorAll(".panel-body").length).toBe(3);
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
