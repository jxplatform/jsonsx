import "./with-dom.js";
import { effect } from "../src/reactivity";
import {
  activateTab,
  activeTab,
  closeTab,
  openTab,
  renameTab,
  workspace,
} from "../src/workspace/workspace";
import { beforeEach, describe, expect, test } from "bun:test";

describe("Workspace primitive", () => {
  beforeEach(() => {
    for (const id of workspace.tabs.keys()) {
      closeTab(id);
    }
  });

  test("openTab creates and activates a tab", () => {
    const tab = openTab({ document: { tagName: "div" }, id: "t1" });

    expect(workspace.tabs.has("t1")).toBe(true);
    expect(workspace.activeTabId).toBe("t1");
    expect(workspace.tabOrder).toEqual(["t1"]);
    expect(activeTab.value?.id).toBe(tab.id);
  });

  test("multiple tabs maintain order", () => {
    openTab({ document: { tagName: "div" }, id: "t1" });
    openTab({ document: { tagName: "span" }, id: "t2" });
    openTab({ document: { tagName: "p" }, id: "t3" });

    expect(workspace.tabOrder).toEqual(["t1", "t2", "t3"]);
    expect(workspace.activeTabId).toBe("t3");
  });

  test("closeTab removes tab and activates last remaining", () => {
    openTab({ document: { tagName: "div" }, id: "t1" });
    openTab({ document: { tagName: "span" }, id: "t2" });
    openTab({ document: { tagName: "p" }, id: "t3" });

    closeTab("t3");

    expect(workspace.tabs.has("t3")).toBe(false);
    expect(workspace.tabOrder).toEqual(["t1", "t2"]);
    expect(workspace.activeTabId).toBe("t2");
  });

  test("closeTab on non-active tab doesn't change activeTabId", () => {
    openTab({ document: { tagName: "div" }, id: "t1" });
    openTab({ document: { tagName: "span" }, id: "t2" });

    closeTab("t1");

    expect(workspace.activeTabId).toBe("t2");
    expect(workspace.tabOrder).toEqual(["t2"]);
  });

  test("closing last tab sets activeTabId to null", () => {
    openTab({ document: { tagName: "div" }, id: "t1" });
    closeTab("t1");

    expect(workspace.activeTabId).toBe(null);
    expect((activeTab as any).value).toBe(null);
  });

  test("activateTab switches active tab", () => {
    openTab({ document: { tagName: "div" }, id: "t1" });
    openTab({ document: { tagName: "span" }, id: "t2" });

    activateTab("t1");
    expect(workspace.activeTabId).toBe("t1");
    expect(activeTab.value?.id).toBe("t1");
  });

  test("activateTab with invalid id is a no-op", () => {
    openTab({ document: { tagName: "div" }, id: "t1" });
    activateTab("nonexistent");
    expect(workspace.activeTabId).toBe("t1");
  });

  test("activeTab computed updates reactively on tab switch", () => {
    openTab({ document: { tagName: "div" }, documentPath: "a.json", id: "t1" });
    openTab({
      document: { tagName: "span" },
      documentPath: "b.json",
      id: "t2",
    });

    let observedPath: string | null = null;
    const stop = effect(() => {
      observedPath = activeTab.value?.documentPath ?? null;
    });

    expect(observedPath as string | null).toBe("b.json");
    activateTab("t1");
    expect(observedPath as string | null).toBe("a.json");

    stop();
  });

  test("effect on activeTab.doc re-runs on tab switch", () => {
    openTab({ document: { tagName: "div" }, id: "t1" });
    openTab({ document: { tagName: "span" }, id: "t2" });

    let observedTag: string | null = null;
    const stop = effect(() => {
      observedTag = activeTab.value?.doc.document.tagName ?? null;
    });

    expect(observedTag as string | null).toBe("span");
    activateTab("t1");
    expect(observedTag as string | null).toBe("div");

    stop();
  });

  test("disposeTab stops effects within the tab scope", () => {
    const tab = openTab({ document: { tagName: "div" }, id: "t1" });

    let runs = 0;
    tab.scope.run(() => {
      effect(() => {
        runs += 1;
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

describe("renameTab", () => {
  beforeEach(() => {
    for (const id of workspace.tabs.keys()) {
      closeTab(id);
    }
  });

  test("re-keys tab in the tabs map", () => {
    openTab({
      document: { tagName: "div" },
      documentPath: "pages/old.md",
      id: "pages/old.md",
    });

    renameTab("pages/old.md", "pages/new.md", "pages/new.md");

    expect(workspace.tabs.has("pages/old.md")).toBe(false);
    expect(workspace.tabs.has("pages/new.md")).toBe(true);
    const tab = workspace.tabs.get("pages/new.md") as any;
    expect(tab.id).toBe("pages/new.md");
    expect(tab.documentPath).toBe("pages/new.md");
  });

  test("preserves document content and dirty state", () => {
    const tab = openTab({
      document: { children: [{ tagName: "p" }], tagName: "div" },
      documentPath: "pages/old.md",
      id: "pages/old.md",
    });
    tab.doc.dirty = true;

    renameTab("pages/old.md", "pages/new.md", "pages/new.md");

    const renamed = workspace.tabs.get("pages/new.md") as any;
    expect(renamed.doc.document.children).toEqual([{ tagName: "p" }]);
    expect(renamed.doc.dirty).toBe(true);
  });

  test("updates tabOrder preserving position", () => {
    openTab({
      document: { tagName: "div" },
      documentPath: "a.json",
      id: "a.json",
    });
    openTab({
      document: { tagName: "p" },
      documentPath: "pages/old.md",
      id: "pages/old.md",
    });
    openTab({
      document: { tagName: "span" },
      documentPath: "c.json",
      id: "c.json",
    });

    renameTab("pages/old.md", "pages/new.md", "pages/new.md");

    expect(workspace.tabOrder).toEqual(["a.json", "pages/new.md", "c.json"]);
  });

  test("updates activeTabId when renaming the active tab", () => {
    openTab({
      document: { tagName: "div" },
      documentPath: "pages/old.md",
      id: "pages/old.md",
    });
    expect(workspace.activeTabId).toBe("pages/old.md");

    renameTab("pages/old.md", "pages/new.md", "pages/new.md");

    expect(workspace.activeTabId).toBe("pages/new.md");
    expect(activeTab.value?.id).toBe("pages/new.md");
  });

  test("does not change activeTabId when renaming a non-active tab", () => {
    openTab({
      document: { tagName: "div" },
      documentPath: "pages/old.md",
      id: "pages/old.md",
    });
    openTab({
      document: { tagName: "span" },
      documentPath: "active.json",
      id: "active.json",
    });

    renameTab("pages/old.md", "pages/new.md", "pages/new.md");

    expect(workspace.activeTabId).toBe("active.json");
  });

  test("no-op for nonexistent tab id", () => {
    openTab({
      document: { tagName: "div" },
      documentPath: "a.json",
      id: "a.json",
    });

    renameTab("nonexistent", "new-id", "new-path");

    expect(workspace.tabs.size).toBe(1);
    expect(workspace.tabs.has("a.json")).toBe(true);
  });

  test("handles moving into a subdirectory", () => {
    openTab({
      document: { tagName: "div" },
      documentPath: "index.md",
      id: "index.md",
    });

    renameTab("index.md", "pages/index.md", "pages/index.md");

    expect(workspace.tabs.has("index.md")).toBe(false);
    expect(workspace.tabs.has("pages/index.md")).toBe(true);
    expect((workspace.tabs.get("pages/index.md") as any).documentPath).toBe("pages/index.md");
  });
});
