/**
 * Tab strip — reactive rendering of open tabs, activation, dirty indicator, and close flow
 * (including the unsaved-changes confirm dialog).
 */
import { flush } from "./harness";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mount, unmount } from "../src/panels/tab-strip";
import { collabState } from "../src/collab/collab-state";
import { closeAllTabs, openTab, workspace } from "../src/workspace/workspace";
import { initLayers } from "../src/ui/layers";
import type { JxMutableNode } from "@jxsuite/schema/types";

let host: HTMLElement;

function open(id: string, documentPath: string | null = `/project/${id}.json`) {
  return openTab({
    document: { children: [], tagName: "div" } as JxMutableNode,
    documentPath,
    id,
  });
}

function tabs(): HTMLElement[] {
  return [...host.querySelectorAll(".tab-strip-tab")] as HTMLElement[];
}

function strip(): HTMLElement {
  return host.querySelector(".tab-strip") as HTMLElement;
}

// Happy-dom performs no layout (scrollWidth/clientWidth are 0); stub them to fake overflow.
function stubMetrics(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
}

function wheel(target: HTMLElement, init: WheelEventInit = {}) {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  // Happy-dom's WheelEvent constructor drops modifier-key init fields; force them.
  if (init.ctrlKey) {
    Object.defineProperty(e, "ctrlKey", { value: true });
  }
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="tab-strip"></div>
    <div id="layer-popover"></div>
    <div id="layer-modal"></div>
    <div id="layer-dialog"></div>
  `;
  initLayers();
  host = document.querySelector("#tab-strip") as HTMLElement;
  closeAllTabs();
  mount(host);
});

afterEach(() => {
  unmount();
  closeAllTabs();
  document.body.innerHTML = "";
});

describe("tab strip rendering", () => {
  test("renders nothing with no tabs", async () => {
    await flush();
    expect(host.querySelector(".tab-strip")).toBeNull();
  });

  test("renders a tab per open document with file-name labels", async () => {
    open("a", "/project/pages/home.json");
    open("b", "/project/about.json");
    await flush();
    const els = tabs();
    expect(els.length).toBe(2);
    expect(els[0]!.querySelector(".tab-strip-label")!.textContent).toBe("home.json");
    expect(els[1]!.querySelector(".tab-strip-label")!.textContent).toBe("about.json");
    expect(els[0]!.getAttribute("title")).toBe("/project/pages/home.json");
  });

  test("tab without a documentPath is labeled Untitled", async () => {
    open("untitled", null);
    await flush();
    expect(tabs()[0]!.querySelector(".tab-strip-label")!.textContent).toBe("Untitled");
    expect(tabs()[0]!.getAttribute("title")).toBe("Untitled");
  });

  test("active tab gets the active class and dirty tabs get the dot", async () => {
    const a = open("a");
    open("b");
    await flush();
    expect(tabs()[1]!.classList.contains("active")).toBe(true);
    expect(tabs()[0]!.classList.contains("active")).toBe(false);
    expect(host.querySelector(".tab-strip-dirty")).toBeNull();

    a.doc.dirty = true;
    await flush();
    expect(tabs()[0]!.querySelector(".tab-strip-dirty")).not.toBeNull();
    expect(tabs()[1]!.querySelector(".tab-strip-dirty")).toBeNull();
  });

  test("rerenders when tabs open and close", async () => {
    open("a");
    await flush();
    expect(tabs().length).toBe(1);
    open("b");
    await flush();
    expect(tabs().length).toBe(2);
    closeAllTabs();
    await flush();
    expect(host.querySelector(".tab-strip")).toBeNull();
  });

  test("unmount stops reactive rendering", async () => {
    open("a");
    await flush();
    unmount();
    open("b");
    await flush();
    expect(tabs().length).toBe(1);
  });
});

describe("tab strip interactions", () => {
  test("clicking a tab activates it", async () => {
    open("a");
    open("b");
    await flush();
    tabs()[0]!.click();
    expect(workspace.activeTabId).toBe("a");
    await flush();
    expect(tabs()[0]!.classList.contains("active")).toBe(true);
  });

  test("close button closes a clean tab without confirmation", async () => {
    open("a");
    open("b");
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    expect(workspace.tabs.has("a")).toBe(false);
    expect(tabs().length).toBe(1);
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
  });

  test("middle-click (auxclick) closes the tab", async () => {
    open("a");
    open("b");
    await flush();
    tabs()[0]!.dispatchEvent(
      new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true }),
    );
    await flush();
    expect(workspace.tabs.has("a")).toBe(false);
  });

  test("auxclick with a non-middle button does not close", async () => {
    open("a");
    await flush();
    tabs()[0]!.dispatchEvent(
      new MouseEvent("auxclick", { bubbles: true, button: 2, cancelable: true }),
    );
    await flush();
    expect(workspace.tabs.has("a")).toBe(true);
  });

  test("dirty tab prompts; cancel keeps it open", async () => {
    const a = open("a");
    a.doc.dirty = true;
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("headline")).toBe("Unsaved Changes");
    expect(dialog.textContent).toContain("a.json");
    dialog.dispatchEvent(new Event("cancel"));
    await flush();
    expect(workspace.tabs.has("a")).toBe(true);
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
  });

  test("dirty tab prompts; confirm closes it", async () => {
    const a = open("a");
    a.doc.dirty = true;
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
    expect(dialog.classList.contains("dialog-destructive")).toBe(true);
    expect(dialog.getAttribute("confirm-label")).toBe("Close");
    dialog.dispatchEvent(new Event("confirm"));
    await flush();
    expect(workspace.tabs.has("a")).toBe(false);
  });

  test("a co-edited dirty tab with peers still on the doc closes without a prompt", async () => {
    const a = open("a");
    a.doc.dirty = true;
    const state = collabState(a);
    state.active = true;
    state.peers = [{ clientId: 2, state: { focusedPath: "/project/a.json" } as never }];
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    // The shared session lives on with the remaining peer — closing is safe, no prompt.
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
    expect(workspace.tabs.has("a")).toBe(false);
  });

  test("the last collaborator on a dirty doc is still prompted before closing", async () => {
    const a = open("a");
    a.doc.dirty = true;
    const state = collabState(a);
    state.active = true;
    // A peer exists but is focused on a different doc — nobody else holds THIS doc.
    state.peers = [{ clientId: 2, state: { focusedPath: "/project/other.json" } as never }];
    await flush();
    (tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement).click();
    await flush();
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).not.toBeNull();
    expect(workspace.tabs.has("a")).toBe(true);
  });

  test("requestClose on a vanished tab id is a no-op", async () => {
    const a = open("a");
    a.doc.dirty = true;
    await flush();
    const closeBtn = tabs()[0]!.querySelector(".tab-strip-close") as HTMLElement;
    // Remove the tab out from under the strip, then click the stale button.
    workspace.tabs.delete("a");
    closeBtn.click();
    await flush();
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
  });
});

describe("tab strip wheel scrolling", () => {
  test("vertical wheel scrolls the strip horizontally when tabs overflow", async () => {
    open("a");
    open("b");
    await flush();
    const el = strip();
    stubMetrics(el, 500, 100);
    el.scrollLeft = 0;
    const e = wheel(el, { deltaY: 50 });
    expect(el.scrollLeft).toBe(50);
    expect(e.defaultPrevented).toBe(true);
    wheel(el, { deltaY: -30 });
    expect(el.scrollLeft).toBe(20);
  });

  test("the dominant axis wins when both deltas are present", async () => {
    open("a");
    await flush();
    const el = strip();
    stubMetrics(el, 500, 100);
    el.scrollLeft = 0;
    wheel(el, { deltaX: 80, deltaY: 10 });
    expect(el.scrollLeft).toBe(80);
  });

  test("wheel is ignored when the strip does not overflow", async () => {
    open("a");
    await flush();
    const el = strip();
    stubMetrics(el, 100, 100);
    el.scrollLeft = 0;
    const e = wheel(el, { deltaY: 50 });
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  test("ctrl+wheel (zoom gesture) is left alone", async () => {
    open("a");
    await flush();
    const el = strip();
    stubMetrics(el, 500, 100);
    el.scrollLeft = 0;
    const e = wheel(el, { ctrlKey: true, deltaY: 50 });
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  test("a wheel event with no delta does nothing", async () => {
    open("a");
    await flush();
    const el = strip();
    stubMetrics(el, 500, 100);
    el.scrollLeft = 0;
    const e = wheel(el);
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("active tab reveal", () => {
  test("activating a different tab scrolls it into view", async () => {
    open("a");
    open("b");
    await flush();
    const revealed: Element[] = [];
    const spy = spyOn(Element.prototype, "scrollIntoView").mockImplementation(
      function captureReveal(this: Element) {
        revealed.push(this);
      },
    );
    tabs()[0]!.click();
    await flush();
    expect(revealed.length).toBe(1);
    expect(revealed[0]!.classList.contains("active")).toBe(true);
    expect(revealed[0]!.querySelector(".tab-strip-label")!.textContent).toBe("a.json");
    spy.mockRestore();
  });

  test("a re-render without an activation change does not re-reveal", async () => {
    const a = open("a");
    await flush();
    const spy = spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    a.doc.dirty = true;
    await flush();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
