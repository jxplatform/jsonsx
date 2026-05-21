import { effect } from "../src/reactivity.js";
import {
  workspace,
  activeTab,
  openTab,
  closeTab,
  activateTab,
} from "../src/workspace/workspace.js";
import { test, expect, describe, beforeEach } from "bun:test";

describe("Workspace primitive", () => {
  beforeEach(() => {
    for (const id of workspace.tabs.keys()) {
      closeTab(id);
    }
  });

  test("openTab creates and activates a tab", () => {
    const tab = openTab({ id: "t1", document: { tagName: "div" } });

    expect(workspace.tabs.has("t1")).toBe(true);
    expect(workspace.activeTabId).toBe("t1");
    expect(workspace.tabOrder).toEqual(["t1"]);
    expect(activeTab.value?.id).toBe(tab.id);
  });

  test("multiple tabs maintain order", () => {
    openTab({ id: "t1", document: { tagName: "div" } });
    openTab({ id: "t2", document: { tagName: "span" } });
    openTab({ id: "t3", document: { tagName: "p" } });

    expect(workspace.tabOrder).toEqual(["t1", "t2", "t3"]);
    expect(workspace.activeTabId).toBe("t3");
  });

  test("closeTab removes tab and activates last remaining", () => {
    openTab({ id: "t1", document: { tagName: "div" } });
    openTab({ id: "t2", document: { tagName: "span" } });
    openTab({ id: "t3", document: { tagName: "p" } });

    closeTab("t3");

    expect(workspace.tabs.has("t3")).toBe(false);
    expect(workspace.tabOrder).toEqual(["t1", "t2"]);
    expect(workspace.activeTabId).toBe("t2");
  });

  test("closeTab on non-active tab doesn't change activeTabId", () => {
    openTab({ id: "t1", document: { tagName: "div" } });
    openTab({ id: "t2", document: { tagName: "span" } });

    closeTab("t1");

    expect(workspace.activeTabId).toBe("t2");
    expect(workspace.tabOrder).toEqual(["t2"]);
  });

  test("closing last tab sets activeTabId to null", () => {
    openTab({ id: "t1", document: { tagName: "div" } });
    closeTab("t1");

    expect(workspace.activeTabId).toBe(null);
    expect(/** @type {any} */ (activeTab).value).toBe(null);
  });

  test("activateTab switches active tab", () => {
    openTab({ id: "t1", document: { tagName: "div" } });
    openTab({ id: "t2", document: { tagName: "span" } });

    activateTab("t1");
    expect(workspace.activeTabId).toBe("t1");
    expect(activeTab.value?.id).toBe("t1");
  });

  test("activateTab with invalid id is a no-op", () => {
    openTab({ id: "t1", document: { tagName: "div" } });
    activateTab("nonexistent");
    expect(workspace.activeTabId).toBe("t1");
  });

  test("activeTab computed updates reactively on tab switch", () => {
    openTab({ id: "t1", document: { tagName: "div" }, documentPath: "a.json" });
    openTab({ id: "t2", document: { tagName: "span" }, documentPath: "b.json" });

    /** @type {string | null} */
    let observedPath = null;
    const stop = effect(() => {
      observedPath = activeTab.value?.documentPath ?? null;
    });

    expect(/** @type {any} */ (observedPath)).toBe("b.json");
    activateTab("t1");
    expect(/** @type {any} */ (observedPath)).toBe("a.json");

    stop();
  });

  test("effect on activeTab.doc re-runs on tab switch", () => {
    openTab({ id: "t1", document: { tagName: "div" } });
    openTab({ id: "t2", document: { tagName: "span" } });

    /** @type {string | null} */
    let observedTag = null;
    const stop = effect(() => {
      observedTag = activeTab.value?.doc.document.tagName ?? null;
    });

    expect(/** @type {any} */ (observedTag)).toBe("span");
    activateTab("t1");
    expect(/** @type {any} */ (observedTag)).toBe("div");

    stop();
  });

  test("disposeTab stops effects within the tab scope", () => {
    const tab = openTab({ id: "t1", document: { tagName: "div" } });

    let runs = 0;
    tab.scope.run(() => {
      effect(() => {
        runs++;
        void tab.doc.dirty;
      });
    });

    expect(runs).toBe(1);
    tab.doc.dirty = true;
    expect(runs).toBe(2);

    closeTab("t1");
    tab.doc.dirty = false;
    expect(runs).toBe(2);
  });
});
