/**
 * The minimal pane model (§4.1) — panes as the unit of split, focus and zoom; the workspace-level
 * `activeTabId` / `tabOrder` as DERIVED reads over the focused pane; the non-Canvas cap on the
 * second pane; pin, drag reorder and preview tabs; and the five `pane.*` command records.
 */
import "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_PANES,
  PRIMARY_PANE,
  SECONDARY_PANE,
  activePane,
  activateTab,
  canOpenInSecondPane,
  closeAllTabs,
  closePane,
  closeTab,
  focusOtherPane,
  focusPane,
  moveTab,
  openTab,
  paneById,
  paneCommands,
  paneOfTab,
  promoteDirtyPreviewTabs,
  promoteTab,
  setTabPinned,
  splitRight,
  tabCommands,
  togglePaneZoom,
  workspace,
} from "../src/workspace/workspace";
import { editorKindOf, editorKindsOf, modeForEditorKind } from "../src/tabs/tab";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext, makeContext } from "../src/commands/context";

function open(id: string, opts: Record<string, unknown> = {}) {
  return openTab({ document: { tagName: "div" }, documentPath: `${id}.json`, id, ...opts });
}

/** A tab whose only modes are Canvas ones — the case the second pane must refuse. */
function openCanvasOnly(id: string) {
  return openTab({
    capabilities: { modes: ["edit", "design", "preview"] },
    document: { tagName: "div" },
    documentPath: `${id}.md`,
    id,
  });
}

function registryWith(commands: ReturnType<typeof paneCommands>) {
  const registry = createCommandRegistry({
    getContext: () => makeContext({ document: { open: workspace.tabs.size > 0 } }),
  });
  registry.registerAll(commands);
  return registry;
}

afterEach(() => {
  closeAllTabs();
});

describe("the store boots with one pane", () => {
  test("primary always exists and answers `activePane`", () => {
    expect(workspace.panes.length).toBe(1);
    expect(activePane().id).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBeNull();
    expect(workspace.tabOrder).toEqual([]);
  });

  test("the workspace reads are DERIVED — the pane is where a tab actually lives", () => {
    open("a");
    open("b");
    expect(activePane().tabOrder).toEqual(["a", "b"]);
    expect(workspace.tabOrder).toEqual(["a", "b"]);
    expect(workspace.activeTabId).toBe("b");
    expect(paneOfTab("a")?.id).toBe(PRIMARY_PANE);
    expect(paneOfTab("nope")).toBeUndefined();
  });
});

describe("editor kinds", () => {
  test("the base mode names the editor; preview is a Canvas VIEW, not a kind", () => {
    const tab = open("a");
    expect(editorKindOf(tab)).toBe("canvas");
    tab.session.ui.canvasMode = "source";
    expect(editorKindOf(tab)).toBe("code");
    tab.session.ui.canvasMode = "stylebook";
    expect(editorKindOf(tab)).toBe("config");
    tab.session.ui.canvasMode = "something-new";
    expect(editorKindOf(tab)).toBe("canvas");
  });

  test("the kind list is deduplicated and never contains a dead entry", () => {
    const tab = open("a", { capabilities: { modes: ["edit", "design", "preview", "source"] } });
    expect(editorKindsOf(tab)).toEqual(["canvas", "code"]);
    expect(modeForEditorKind(tab, "code")).toBe("source");
    expect(modeForEditorKind(tab, "diff")).toBeUndefined();
  });
});

describe("splitting", () => {
  test(String.raw`⌘\ moves the focused tab into a second pane and focuses it`, () => {
    open("a");
    open("b");
    const target = splitRight();
    expect(target?.id).toBe(SECONDARY_PANE);
    expect(workspace.panes.length).toBe(MAX_PANES);
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a"]);
    expect(paneById(SECONDARY_PANE)!.tabOrder).toEqual(["b"]);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    expect(workspace.activeTabId).toBe("b");
  });

  test("the second pane caps the tab to a non-Canvas kind rather than opening a second host", () => {
    const tab = open("a", { capabilities: { modes: ["edit", "design", "source"] } });
    expect(editorKindOf(tab)).toBe("canvas");
    splitRight();
    expect(editorKindOf(workspace.tabs.get("a")!)).toBe("code");
    expect(workspace.tabs.get("a")!.session.ui.preview).toBe(false);
  });

  test("a Canvas-only document is refused, and says so", () => {
    const tab = openCanvasOnly("only");
    expect(canOpenInSecondPane(tab)).toBe(false);
    expect(splitRight()).toBeNull();
    expect(workspace.panes.length).toBe(1);
  });

  test("splitting with nothing open is a no-op", () => {
    expect(splitRight()).toBeNull();
    expect(workspace.panes.length).toBe(1);
  });

  test("splitting back from the side pane returns the tab to the primary unchanged", () => {
    open("a");
    open("b");
    splitRight();
    const back = splitRight();
    expect(back?.id).toBe(PRIMARY_PANE);
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a", "b"]);
    expect(workspace.panes.find((p) => p.id === SECONDARY_PANE)?.tabOrder).toEqual([]);
  });
});

describe("focus and zoom", () => {
  test("focusPane moves the keyboard and the MRU; an unknown id is ignored", () => {
    open("a");
    open("b");
    splitRight();
    focusPane(PRIMARY_PANE);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBe("a");
    expect(workspace.mruOrder[0]).toBe("a");
    focusPane("nope");
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
  });

  test("focusOtherPane flips between the two, and does nothing with one", () => {
    open("a");
    focusOtherPane();
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    open("b");
    splitRight();
    focusOtherPane();
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
  });

  test("zoom is a view of the grid — it moves no tab and closes nothing", () => {
    open("a");
    open("b");
    splitRight();
    togglePaneZoom();
    expect(workspace.zoomedPaneId).toBe(SECONDARY_PANE);
    expect(paneById(SECONDARY_PANE)!.tabOrder).toEqual(["b"]);
    togglePaneZoom();
    expect(workspace.zoomedPaneId).toBeNull();
  });
});

describe("collapsing", () => {
  test("closePane hands its documents back rather than closing them", () => {
    open("a");
    open("b");
    splitRight();
    togglePaneZoom();
    closePane(SECONDARY_PANE);
    expect(workspace.panes.length).toBe(1);
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a", "b"]);
    expect(workspace.tabs.size).toBe(2);
    expect(workspace.zoomedPaneId).toBeNull();
  });

  test("closing the last tab in the side pane collapses it", () => {
    open("a");
    open("b");
    splitRight();
    closeTab("b");
    expect(workspace.panes.length).toBe(1);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBe("a");
  });

  test("the primary is never collapsed", () => {
    open("a");
    closePane(PRIMARY_PANE);
    expect(workspace.panes.length).toBe(1);
  });
});

describe("pinning and reorder", () => {
  test("pinning moves a tab to the head; unpinning drops it behind the pinned set", () => {
    open("a");
    open("b");
    open("c");
    setTabPinned("c", true);
    expect(activePane().tabOrder).toEqual(["c", "a", "b"]);
    setTabPinned("b", true);
    expect(activePane().tabOrder).toEqual(["c", "b", "a"]);
    setTabPinned("c", false);
    expect(activePane().tabOrder).toEqual(["b", "c", "a"]);
  });

  test("a drag can never interleave a pinned tab with an unpinned one", () => {
    open("a");
    open("b");
    open("c");
    setTabPinned("a", true);
    moveTab("c", 0); // Asks for the head, which is pinned territory
    expect(activePane().tabOrder).toEqual(["a", "c", "b"]);
    moveTab("a", 5); // A pinned tab cannot leave the prefix either
    expect(activePane().tabOrder).toEqual(["a", "c", "b"]);
  });

  test("reorder inside the unpinned region does what it says", () => {
    open("a");
    open("b");
    open("c");
    moveTab("a", 2);
    expect(activePane().tabOrder).toEqual(["b", "c", "a"]);
  });

  test("pin and reorder ignore ids no pane holds", () => {
    open("a");
    setTabPinned("ghost", true);
    moveTab("ghost", 0);
    expect(activePane().tabOrder).toEqual(["a"]);
  });
});

describe("preview tabs", () => {
  test("a preview open takes the previous preview's slot instead of adding a chip", () => {
    open("keep");
    open("p1", { preview: true });
    expect(activePane().tabOrder).toEqual(["keep", "p1"]);
    open("p2", { preview: true });
    expect(activePane().tabOrder).toEqual(["keep", "p2"]);
    expect(workspace.tabs.has("p1")).toBe(false);
  });

  test("committing — a pin, a promote, an edit — makes the tab permanent", () => {
    open("p1", { preview: true });
    promoteTab("p1");
    expect(workspace.tabs.get("p1")!.preview).toBe(false);
    open("p2", { preview: true });
    expect(activePane().tabOrder).toEqual(["p1", "p2"]);

    setTabPinned("p2", true);
    expect(workspace.tabs.get("p2")!.preview).toBe(false);

    const p3 = open("p3", { preview: true });
    p3.doc.dirty = true;
    promoteDirtyPreviewTabs();
    expect(workspace.tabs.get("p3")!.preview).toBe(false);
  });

  test("re-opening a pinned id never turns it back into a preview", () => {
    open("a");
    setTabPinned("a", true);
    open("a", { preview: true });
    expect(workspace.tabs.get("a")!.preview).toBe(false);
    expect(workspace.tabs.get("a")!.pinned).toBe(true);
  });

  test("promoting an id nothing holds is a no-op", () => {
    promoteTab("ghost");
    expect(workspace.tabs.size).toBe(0);
  });
});

describe("activation across panes", () => {
  test("activating a tab in the other pane focuses that pane too", () => {
    open("a");
    open("b");
    splitRight();
    activateTab("a");
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    activateTab("b");
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
  });
});

describe("the pane commands", () => {
  test("all six are declared at document level in the View category", () => {
    const ids = paneCommands().map((c) => c.id);
    expect(ids).toEqual([
      "pane.splitRight",
      "pane.focusPrimary",
      "pane.focusSecondary",
      "pane.toggleZoom",
      "pane.setZoomed",
      "pane.unsplit",
    ]);
    for (const command of paneCommands()) {
      expect(command.level).toBe("document");
      expect(command.category).toBe("View");
    }
  });

  test("pane.setZoomed is idempotent where pane.toggleZoom is a delta", () => {
    // The pairing the app-commands guard asserts, exercised: a script says what it wants and can
    // Say it twice; the chord flips whatever is there because a human can see which state that is.
    const byId = new Map(paneCommands().map((c) => [c.id, c]));
    const setZoomed = byId.get("pane.setZoomed")!;
    const ctx = emptyContext();
    open("a");
    splitRight();

    setZoomed.run(ctx, { zoomed: true } as never);
    const zoomed = workspace.zoomedPaneId;
    expect(zoomed).not.toBeNull();
    setZoomed.run(ctx, { zoomed: true } as never);
    expect(workspace.zoomedPaneId).toBe(zoomed);

    setZoomed.run(ctx, { zoomed: false } as never);
    expect(workspace.zoomedPaneId).toBeNull();
    setZoomed.run(ctx, { zoomed: false } as never);
    expect(workspace.zoomedPaneId).toBeNull();

    expect(() => setZoomed.run(ctx, { zoomed: "yes" } as never)).toThrow(/expected a boolean/);
  });

  test(String.raw`⌘\ is the split chord and ⌘⌥0 focuses the side pane`, () => {
    const byId = new Map(paneCommands().map((c) => [c.id, c]));
    expect(byId.get("pane.splitRight")!.keybinding).toBe("mod+\\");
    expect(byId.get("pane.focusSecondary")!.keybinding).toBe("mod+alt+0");
    // ⌘0 is `canvas.zoomReset` in the same registry; claiming it here would throw at bootstrap.
    expect(byId.get("pane.focusPrimary")!.keybinding).toBeUndefined();
  });

  test("the four grid commands refuse with a sentence until the grid is split", () => {
    const registry = registryWith(paneCommands());
    open("a");
    for (const id of [
      "pane.focusPrimary",
      "pane.focusSecondary",
      "pane.toggleZoom",
      "pane.unsplit",
    ]) {
      expect(registry.isEnabled(id)).toBe(false);
      expect(registry.disabledReason(id)).toBe("a split pane grid");
    }
    open("b");
    splitRight();
    expect(registry.isEnabled("pane.unsplit")).toBe(true);
  });

  test("Split Right refuses a Canvas-only document by name", () => {
    const registry = registryWith(paneCommands());
    openCanvasOnly("only");
    expect(registry.isEnabled("pane.splitRight")).toBe(false);
    expect(registry.disabledReason("pane.splitRight")).toBe(
      "a document that can open as Code, Config, Diff, Grid or Library beside the canvas",
    );
  });

  test("running them drives the model", async () => {
    const registry = registryWith(paneCommands());
    open("a");
    open("b");
    await registry.run("pane.splitRight");
    expect(workspace.panes.length).toBe(2);
    await registry.run("pane.focusPrimary");
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    await registry.run("pane.focusSecondary");
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    await registry.run("pane.toggleZoom");
    expect(workspace.zoomedPaneId).toBe(SECONDARY_PANE);
    await registry.run("pane.unsplit");
    expect(workspace.panes.length).toBe(1);
  });

  test("Unsplit from the primary collapses the side pane, not the primary", async () => {
    const registry = registryWith(paneCommands());
    open("a");
    open("b");
    splitRight();
    focusPane(PRIMARY_PANE);
    await registry.run("pane.unsplit");
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
  });
});

describe("the two new tab commands", () => {
  const deps = { openFile: () => {} };

  test("Pin / Unpin toggles the focused tab", async () => {
    const registry = registryWith(tabCommands(deps) as ReturnType<typeof paneCommands>);
    open("a");
    await registry.run("document.togglePinned");
    expect(workspace.tabs.get("a")!.pinned).toBe(true);
    await registry.run("document.togglePinned");
    expect(workspace.tabs.get("a")!.pinned).toBe(false);
  });

  test("Keep Document Open is available only for a preview tab", async () => {
    const registry = registryWith(tabCommands(deps) as ReturnType<typeof paneCommands>);
    open("a");
    expect(registry.isEnabled("document.keepOpen")).toBe(false);
    expect(registry.disabledReason("document.keepOpen")).toBe(
      "a preview document — one opened by a single click",
    );
    open("p", { preview: true });
    expect(registry.isEnabled("document.keepOpen")).toBe(true);
    await registry.run("document.keepOpen");
    expect(workspace.tabs.get("p")!.preview).toBe(false);
  });

  test("⌃Tab is offered whenever a second document is open in EITHER pane", () => {
    const registry = registryWith(tabCommands(deps) as ReturnType<typeof paneCommands>);
    open("a");
    expect(registry.isEnabled("document.nextTab")).toBe(false);
    open("b");
    splitRight();
    expect(activePane().tabOrder.length).toBe(1);
    expect(registry.isEnabled("document.nextTab")).toBe(true);
  });
});

describe("the empty context still describes one pane", () => {
  test("`pane.count` defaults to 1 — the grid is never zero panes", () => {
    expect(emptyContext().pane.count).toBe(1);
  });
});

describe("closing lands on the MRU tab, not the rightmost", () => {
  test("the tab you were in before is the one you land on", () => {
    open("a");
    open("b");
    open("c");
    activateTab("a");
    activateTab("b");
    closeTab("b");
    expect(workspace.activeTabId).toBe("a");
  });

  test("closing a background tab leaves the focus where it was", () => {
    open("a");
    open("b");
    closeTab("a");
    expect(workspace.activeTabId).toBe("b");
  });
});
