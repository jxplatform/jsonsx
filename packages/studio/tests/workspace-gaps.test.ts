/**
 * Workspace gaps (C7): closeTab early return, closeAllTabs, and replaceAllTabs — paths not covered
 * by tests/workspace.test.ts.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { effect } from "../src/reactivity";
import {
  activeTab,
  closeAllTabs,
  closeTab,
  openTab,
  replaceAllTabs,
  tabIsLive,
  workspace,
} from "../src/workspace/workspace";
import type { Tab } from "../src/tabs/tab";

beforeEach(() => {
  closeAllTabs();
});

/**
 * The question a CAPTURED tab owes before anything is written into it.
 *
 * Both Monaco surfaces commit on a debounce, and a debounce is a promise to write into a tab that
 * was open half a second ago. `null` is one of the answers callers rely on: `commitTabBuffers`
 * flushes a buffer whose `_editingTab` may be nothing at all.
 */
describe("tabIsLive", () => {
  test("is false for no tab, for a closed one, and for a stale object of the same id", () => {
    const nothing = undefined as Tab | undefined;
    expect(tabIsLive(null)).toBe(false);
    expect(tabIsLive(nothing)).toBe(false);

    const tab = openTab({ document: { tagName: "div" }, id: "t1" });
    expect(tabIsLive(tab)).toBe(true);

    // Same id, different object: a tab that was closed and reopened is not the tab a commit was
    // Promised to, and writing into it would push history onto a document nobody asked about.
    const stale = { ...tab, id: "t1" } as typeof tab;
    expect(tabIsLive(stale)).toBe(false);

    closeTab("t1");
    expect(tabIsLive(tab)).toBe(false);
  });
});

describe("closeTab early return", () => {
  test("closing a nonexistent tab id is a no-op", () => {
    openTab({ document: { tagName: "div" }, id: "t1" });
    closeTab("does-not-exist");
    expect(workspace.tabs.size).toBe(1);
    expect(workspace.activeTabId).toBe("t1");
    expect(workspace.tabOrder).toEqual(["t1"]);
  });
});

describe("closeAllTabs", () => {
  test("clears tabs, order, and active id", () => {
    openTab({ document: { tagName: "div" }, id: "a" });
    openTab({ document: { tagName: "span" }, id: "b" });

    closeAllTabs();

    expect(workspace.tabs.size).toBe(0);
    expect(workspace.tabOrder).toEqual([]);
    expect(workspace.activeTabId).toBeNull();
    expect(activeTab.value).toBeNull();
  });

  test("disposes every tab scope", () => {
    const t1 = openTab({ document: { tagName: "div" }, id: "a" });
    const t2 = openTab({ document: { tagName: "span" }, id: "b" });
    let runs1 = 0;
    let runs2 = 0;
    t1.scope.run(() => {
      effect(() => {
        runs1 += 1;
        void t1.doc.dirty;
      });
    });
    t2.scope.run(() => {
      effect(() => {
        runs2 += 1;
        void t2.doc.dirty;
      });
    });

    closeAllTabs();
    t1.doc.dirty = true;
    t2.doc.dirty = true;

    expect(runs1).toBe(1);
    expect(runs2).toBe(1);
  });
});

describe("replaceAllTabs", () => {
  test("replaces multiple tabs with a single new active tab", () => {
    openTab({ document: { tagName: "div" }, id: "a" });
    openTab({ document: { tagName: "span" }, id: "b" });

    const tab = replaceAllTabs({
      document: { tagName: "main" },
      documentPath: "pages/new.json",
      id: "fresh",
    });

    expect(workspace.tabs.size).toBe(1);
    expect(workspace.tabOrder).toEqual(["fresh"]);
    expect(workspace.activeTabId).toBe("fresh");
    // Note: workspace is a Vue reactive proxy, so map lookups return wrapped objects — compare
    // Observable state rather than identity.
    expect(activeTab.value?.id).toBe(tab.id);
    expect(activeTab.value?.doc.document.tagName).toBe("main");
    expect(tab.doc.document.tagName).toBe("main");
    expect(tab.documentPath).toBe("pages/new.json");
  });

  test("disposes the scopes of replaced tabs", () => {
    const old = openTab({ document: { tagName: "div" }, id: "old" });
    let runs = 0;
    old.scope.run(() => {
      effect(() => {
        runs += 1;
        void old.doc.dirty;
      });
    });

    replaceAllTabs({ document: { tagName: "p" }, id: "new" });
    old.doc.dirty = true;

    expect(runs).toBe(1);
    expect(workspace.tabs.has("old")).toBe(false);
  });

  test("reusing an existing tab id keeps the new tab, disposing the old one", () => {
    const old = openTab({ document: { tagName: "div" }, id: "same" });
    let runs = 0;
    old.scope.run(() => {
      effect(() => {
        runs += 1;
        void old.doc.dirty;
      });
    });

    const fresh = replaceAllTabs({ document: { tagName: "article" }, id: "same" });

    expect(workspace.tabs.size).toBe(1);
    // The map entry now holds the replacement document, not the old tab's.
    expect(workspace.tabs.get("same")?.doc.document.tagName).toBe("article");
    expect(old.doc.document.tagName).toBe("div");
    expect(fresh.doc.document.tagName).toBe("article");
    expect(workspace.tabOrder).toEqual(["same"]);

    // The old tab object's scope was disposed despite sharing the id.
    old.doc.dirty = true;
    expect(runs).toBe(1);
  });

  test("activeTab is never null after the swap", () => {
    openTab({ document: { tagName: "div" }, id: "x" });
    replaceAllTabs({ document: { tagName: "p" }, id: "y" });
    expect(activeTab.value).not.toBeNull();
    expect(activeTab.value?.id).toBe("y");
  });
});
