/**
 * Tab identity — the model half of P2 workstream 7.
 *
 * Covers the three things that used to be wrong at once: an id could be opened twice (leaking the
 * previous tab's effect scope and duplicating the id in `tabOrder`), activation told the file tree
 * nothing, and there was no MRU order for `⌃Tab` or closed-tab stack for `⌘⇧T` to read.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  activateTab,
  closeAllTabs,
  closeTab,
  cycleTab,
  endTabCycle,
  openTab,
  registerTabCommands,
  renameTab,
  replaceAllTabs,
  tabCommands,
  takeClosedTabPath,
  workspace,
} from "../src/workspace/workspace";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { checkPlacements } from "../src/commands/levels";
import { toRaw } from "../src/reactivity";
import { projectState, setProjectState } from "../src/state";
import type { ProjectState } from "../src/types";

function open(id: string, documentPath: string | null = `pages/${id}.json`) {
  return openTab({ document: { children: [], tagName: "div" }, documentPath, id });
}

beforeEach(() => {
  closeAllTabs();
  workspace.closedTabs = [];
  setProjectState({ expanded: new Set(), selectedPath: null } as unknown as ProjectState);
});

afterEach(() => {
  closeAllTabs();
  workspace.closedTabs = [];
  setProjectState(null);
});

describe("tab identity", () => {
  test("re-opening an id replaces the tab in place instead of duplicating it", () => {
    const first = open("a");
    let stopped = false;
    first.scope.run(() => {
      /* Claim the scope so its disposal is observable. */
    });
    const originalStop = first.scope.stop;
    first.scope.stop = () => {
      stopped = true;
      originalStop.call(first.scope);
    };
    open("b");

    const replacement = open("a");
    expect(stopped).toBe(true);
    expect(toRaw(workspace.tabs.get("a") as object)).toBe(toRaw(replacement as unknown as object));
    expect(workspace.tabOrder).toEqual(["a", "b"]);
    expect(workspace.tabOrder.filter((id) => id === "a")).toHaveLength(1);
  });

  test("openTab records the drill-in relationship when one is given", () => {
    const tab = openTab({
      document: { tagName: "div" },
      documentPath: "components/card.json",
      id: "components/card.json",
      openedFrom: { documentPath: "pages/index.md", tabId: "pages/index.md" },
    });
    expect(tab.session.openedFrom).toEqual({
      documentPath: "pages/index.md",
      tabId: "pages/index.md",
    });
  });

  test("a tab opened with no origin has none", () => {
    expect(open("a").session.openedFrom).toBeNull();
  });
});

describe("tree selection sync", () => {
  test("activating a tab points the file tree at its document", () => {
    open("a");
    open("b");
    activateTab("a");
    expect(projectState?.selectedPath).toBe("pages/a.json");
    activateTab("b");
    expect(projectState?.selectedPath).toBe("pages/b.json");
  });

  test("a tab with no document path leaves the tree selection alone", () => {
    open("a");
    open("grid", null);
    expect(projectState?.selectedPath).toBe("pages/a.json");
  });

  test("activation without a project state does not throw", () => {
    open("a");
    setProjectState(null);
    expect(() => activateTab("a")).not.toThrow();
  });

  test("activating an unknown id is a no-op", () => {
    open("a");
    activateTab("nope");
    expect(workspace.activeTabId).toBe("a");
  });
});

describe("MRU order", () => {
  test("opening and activating push to the front", () => {
    open("a");
    open("b");
    open("c");
    expect(workspace.mruOrder).toEqual(["c", "b", "a"]);
    activateTab("a");
    expect(workspace.mruOrder).toEqual(["a", "c", "b"]);
  });

  test("closing the active tab lands on the previously used one, not the rightmost", () => {
    open("a");
    open("b");
    open("c");
    activateTab("a");
    closeTab("a");
    expect(workspace.activeTabId).toBe("c");
  });

  test("closing a background tab drops it from the MRU list", () => {
    open("a");
    open("b");
    closeTab("a");
    expect(workspace.mruOrder).toEqual(["b"]);
    expect(workspace.activeTabId).toBe("b");
  });

  test("closing an unknown id is a no-op", () => {
    open("a");
    closeTab("nope");
    expect(workspace.tabs.size).toBe(1);
  });

  test("renaming a tab re-keys the MRU list", () => {
    open("a");
    open("b");
    renameTab("a", "renamed", "pages/renamed.json");
    expect(workspace.mruOrder).toEqual(["b", "renamed"]);
  });

  test("renaming an unknown id is a no-op", () => {
    open("a");
    renameTab("nope", "other", "pages/other.json");
    expect(workspace.mruOrder).toEqual(["a"]);
  });

  test("replaceAllTabs restarts the MRU list on the new tab", () => {
    open("a");
    open("b");
    replaceAllTabs({ document: { tagName: "div" }, documentPath: "pages/new.json", id: "new" });
    expect(workspace.mruOrder).toEqual(["new"]);
    expect(workspace.tabOrder).toEqual(["new"]);
  });

  test("closeAllTabs clears it", () => {
    open("a");
    open("b");
    closeAllTabs();
    expect(workspace.mruOrder).toEqual([]);
  });
});

describe("⌃Tab cycling", () => {
  test("walks the MRU list without reordering it mid-cycle", () => {
    open("a");
    open("b");
    open("c"); // MRU: c, b, a
    expect(cycleTab(1)).toBe("b");
    expect(cycleTab(1)).toBe("a");
    // The frozen snapshot is what makes the second press advance instead of coming straight back.
    expect(workspace.mruOrder).toEqual(["c", "b", "a"]);
    expect(workspace.activeTabId).toBe("a");
  });

  test("wraps in both directions", () => {
    open("a");
    open("b");
    expect(cycleTab(-1)).toBe("a");
    expect(cycleTab(-1)).toBe("b");
  });

  test("ending the cycle promotes the tab the author settled on", () => {
    open("a");
    open("b");
    open("c");
    cycleTab(1);
    endTabCycle();
    expect(workspace.mruOrder).toEqual(["b", "c", "a"]);
    // The next cycle starts from the new order.
    expect(cycleTab(1)).toBe("c");
  });

  test("ending a cycle with no tabs open promotes nothing", () => {
    endTabCycle();
    expect(workspace.mruOrder).toEqual([]);
  });

  test("a single tab has nothing to cycle to", () => {
    open("a");
    expect(cycleTab(1)).toBeUndefined();
  });

  test("an ordinary activation abandons the cycle", () => {
    open("a");
    open("b");
    open("c");
    cycleTab(1);
    activateTab("a");
    expect(workspace.mruOrder).toEqual(["a", "c", "b"]);
    expect(cycleTab(1)).toBe("c");
  });

  test("a tab closed during a cycle is not offered by the next one", () => {
    open("a");
    open("b");
    open("c");
    cycleTab(1);
    closeTab("a");
    // Closing resets the cycle, so the next press rebuilds the snapshot from the surviving tabs.
    expect([cycleTab(1), cycleTab(1)]).toEqual(["b", "c"]);
  });
});

describe("closed-tab stack", () => {
  test("closing a file-backed tab records it, newest first", () => {
    open("a");
    open("b");
    closeTab("a");
    closeTab("b");
    expect(workspace.closedTabs.map((entry) => entry.documentPath)).toEqual([
      "pages/b.json",
      "pages/a.json",
    ]);
  });

  test("a virtual tab with no path is not recorded — there is nothing to re-read", () => {
    open("grid", null);
    closeTab("grid");
    expect(workspace.closedTabs).toEqual([]);
  });

  test("re-closing the same path moves it to the front rather than duplicating it", () => {
    open("a");
    closeTab("a");
    open("b");
    closeTab("b");
    open("a");
    closeTab("a");
    expect(workspace.closedTabs.map((entry) => entry.documentPath)).toEqual([
      "pages/a.json",
      "pages/b.json",
    ]);
  });

  test("the stack is bounded", () => {
    for (let i = 0; i < 25; i++) {
      open(`t${i}`);
      closeTab(`t${i}`);
    }
    expect(workspace.closedTabs).toHaveLength(20);
    expect(workspace.closedTabs[0]!.documentPath).toBe("pages/t24.json");
  });

  test("takeClosedTabPath pops the newest, then reports empty", () => {
    open("a");
    closeTab("a");
    expect(takeClosedTabPath()).toBe("pages/a.json");
    expect(takeClosedTabPath()).toBeUndefined();
  });
});

describe("tab commands", () => {
  function build() {
    const opened: string[] = [];
    const registry = createCommandRegistry({
      getContext: () => makeContext({ document: { open: workspace.tabs.size > 0 } }),
      mac: true,
    });
    registerTabCommands(registry, {
      openFile: (path) => {
        opened.push(path);
      },
      openFileInPane: () => {},
    });
    return { opened, registry };
  }

  test("every declared placement satisfies the level × placement matrix", () => {
    expect(checkPlacements(tabCommands({ openFile: () => {}, openFileInPane: () => {} }))).toEqual(
      [],
    );
  });

  test("⌃Tab and ⌃⇧Tab cycle, and are disabled with one tab open", () => {
    const { registry } = build();
    open("a");
    expect(registry.isEnabled("document.nextTab")).toBe(false);
    expect(registry.disabledReason("document.nextTab")).toBe("a second open document");
    open("b");
    open("c");
    expect(registry.isEnabled("document.nextTab")).toBe(true);
    void registry.run("document.nextTab");
    expect(workspace.activeTabId).toBe("b");
    void registry.run("document.previousTab");
    expect(workspace.activeTabId).toBe("c");
  });

  test("the cycle commands are hidden with no document open", () => {
    const { registry } = build();
    expect(registry.isVisible("document.nextTab")).toBe(false);
    expect(registry.isVisible("document.previousTab")).toBe(false);
  });

  test("both ⌃Tab spellings resolve, so one gesture works on either platform", () => {
    const { registry } = build();
    expect(registry.keymap.bindingsFor("document.nextTab")).toEqual(["ctrl+tab", "mod+tab"]);
    expect(registry.keymap.bindingsFor("document.previousTab")).toEqual([
      "ctrl+shift+tab",
      "mod+shift+tab",
    ]);
  });

  test("⌘⇧T reopens the most recently closed document", async () => {
    const { opened, registry } = build();
    open("a");
    open("b");
    expect(registry.isEnabled("document.reopenClosed")).toBe(false);
    expect(registry.disabledReason("document.reopenClosed")).toBe(
      "a document closed in this session",
    );
    closeTab("a");
    expect(registry.isEnabled("document.reopenClosed")).toBe(true);
    expect(registry.keymap.formatBinding("document.reopenClosed")).toBe("⌘⇧T");
    await registry.run("document.reopenClosed");
    expect(opened).toEqual(["pages/a.json"]);
    expect(workspace.closedTabs).toEqual([]);
  });

  test("reopen does nothing when the stack empties between the gate and the run", async () => {
    const opened: string[] = [];
    const command = tabCommands({
      openFile: (path) => {
        opened.push(path);
      },
      openFileInPane: () => {},
    }).find((record) => record.id === "document.reopenClosed")!;
    open("a");
    closeTab("a");
    takeClosedTabPath();
    // Invoked past its own gate (an automation step, a stale palette row): it must no-op, not throw.
    await command.run(makeContext(), undefined as never);
    expect(opened).toEqual([]);
  });
});
