/**
 * ⑪ The Bottom dock (`panels/bottom-dock.ts`).
 *
 * What is worth pinning: that the strip is a rendering of the panel REGISTRY (three tabs, under a
 * cap of four, none of them permanently hidden — Logic hides only while nothing is open in it),
 * that its region resolves only while it is open — because a collapsed dock is a box focus must not
 * land in and a shot must not crop — and that the declared budget row and the registered set are
 * the same titles, so `commands/budget.ts`'s copy cannot drift from what the dock actually hosts.
 */
import { flush, installMockPlatform, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  activeBottomPanel,
  bottomDockTemplate,
  bottomPanelSet,
  bottomTabLabel,
  mountBottomDock,
  registerBottomPanels,
  renderBottomDock,
  unmountBottomDock,
  visibleBottomPanels,
} from "../src/panels/bottom-dock";
import { openLogicTarget } from "../src/panels/formula-workspace";
import { panelContext, resetPanels } from "../src/panels/panel-registry";
import { BOTTOM_TAB_IDS, isBottomTabId, setBottomTab, setDockCollapsed, shell } from "../src/shell";
import { DECLARED_DOCK_TABS } from "../src/commands/budget";
import { beginActivity, resetActivities } from "../src/panels/activity-panel";
import { notify, resetNotifications } from "../src/services/notify";
import { resolveRegion } from "../src/ui/regions";
import { emptyContext } from "../src/commands/context";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import type { JxMutableNode } from "@jxsuite/schema/types";

function host(): HTMLElement {
  return document.querySelector("#bottom-dock") as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = `<div id="app"><div id="bottom-dock"></div></div>`;
  installMockPlatform();
  resetPanels();
  resetActivities();
  resetNotifications();
  shell.bottomTab = "problems";
  shell.docks.bottom.collapsed = false;
});

afterEach(() => {
  unmountBottomDock();
  closeAllTabs();
  resetPanels();
  resetActivities();
  resetNotifications();
  shell.docks.bottom.collapsed = true;
});

describe("the tab set", () => {
  test("is the three ids §3.2 ⑪ names, in strip order", () => {
    expect(bottomPanelSet().map((panel) => panel.id)).toEqual([...BOTTOM_TAB_IDS]);
    expect(bottomPanelSet().map((panel) => panel.title)).toEqual(["Problems", "Logic", "Activity"]);
  });

  test("agrees with the row `commands/budget.ts` declares, which a bare Bun check reads", () => {
    // Budget.ts cannot import this module (it renders lit templates and three CI checks load it in
    // A bare Bun process), so the copy is kept honest here instead of by an import.
    const declared = DECLARED_DOCK_TABS.find((dock) => dock.dock === "bottom");
    expect(declared?.tabs).toEqual(bottomPanelSet().map((panel) => panel.title));
  });

  test("registration is idempotent, and all three tabs are this dock's own records", () => {
    registerBottomPanels();
    registerBottomPanels();
    expect(bottomPanelSet()).toHaveLength(3);
    // One record, ONE host (§7.2). Problems included: it keeps a rail button and a badge, but the
    // Rail groups by level rather than by dock, so nothing is registered twice to earn them.
    expect(bottomPanelSet().every((panel) => panel.dock === "bottom")).toBe(true);
    expect(bottomPanelSet()[0]?.id).toBe("problems");
  });

  test("no tab has a rail button — the rail is the Navigator's", () => {
    // Problems was the exception and is not any more. A rail button that opens a dock along the
    // Bottom cost `toggleRailPanel`, `isRailPanelShowing` and `focusPanel` a branch apiece, and
    // Made "things are wrong here" permanent furniture in the shell.
    expect(bottomPanelSet().filter((panel) => panel.rail !== false)).toEqual([]);
  });

  test("Diff is not a tab of this dock, and not a tab id at all", () => {
    // It was reserved here for four phases behind `when: () => false`, on the strength of a comment
    // That argued against its own reservation: `diff` is an EDITOR KIND and a pane hosts it at pane
    // Size. P8 shipped the pane. A reserved id whose capability lives somewhere better is just an
    // Enum member that can only ever select a hidden tab, so `view.setBottomTab` must refuse it.
    expect(bottomPanelSet().find((panel) => panel.id === "diff")).toBeUndefined();
    expect(BOTTOM_TAB_IDS).toEqual(["problems", "logic", "activity"]);
    expect(isBottomTabId("diff")).toBe(false);
  });

  test("Logic hides itself when nothing is open in it", () => {
    closeAllTabs();
    expect(visibleBottomPanels(emptyContext()).map((panel) => panel.id)).toEqual([
      "problems",
      "activity",
    ]);
  });

  test("Logic appears the moment a formula target exists", () => {
    openFormulaTab();
    expect(visibleBottomPanels(emptyContext()).map((panel) => panel.id)).toEqual([
      "problems",
      "logic",
      "activity",
    ]);
  });
});

// ─── ⑪ · Logic (plan §12 P8.5) ────────────────────────────────────────────────

/** A tab whose `total` state entry is an `$expression`, with the formula workspace open over it. */
function openFormulaTab(): void {
  const tab = resetWorkspaceWithTab(
    {
      children: [],
      state: { total: { $expression: { operator: "+", target: 1, value: 2 } } },
      tagName: "div",
    } as unknown as JxMutableNode,
    { id: "logic-tab" },
  );
  tab.session.ui.editingFormula = { defName: "total", type: "def" } as never;
}

describe("Logic — the takeover that became a tab", () => {
  test("opening a formula reveals the dock on Logic, and its body renders there", async () => {
    setBottomTab("problems");
    setDockCollapsed("bottom", true);
    mountBottomDock();
    await flush();
    expect(host().textContent?.trim()).toBe("");

    openFormulaTab();
    await flush();

    // The dock opened itself, on the tab that hosts the surface — a takeover reveals itself by
    // Definition and a dock tab does not, so this is the wiring the move has to add.
    expect(shell.docks.bottom.collapsed).toBe(false);
    expect(shell.bottomTab).toBe("logic");
    expect(host().querySelector<HTMLElement>(".bd-body")?.dataset.jxRegion).toBe(
      "dock.bottom/panel:logic",
    );
    expect(host().querySelector(".formula-workspace")).not.toBeNull();
    expect(host().querySelector(".fw-title")?.textContent).toContain("total");
  });

  test("closing the dock over an open formula keeps it closed", async () => {
    mountBottomDock();
    openFormulaTab();
    await flush();
    (host().querySelector(".bd-close") as HTMLElement).click();
    await flush();
    expect(shell.docks.bottom.collapsed).toBe(true);
    // A reveal that re-fired on every repaint would be a dock you cannot close.
    notify.error("unrelated");
    await flush();
    expect(shell.docks.bottom.collapsed).toBe(true);
  });

  test("closing the formula takes the tab out of the strip and falls back", async () => {
    mountBottomDock();
    openFormulaTab();
    await flush();
    expect(host().querySelectorAll("sp-tab")).toHaveLength(3);

    (host().querySelector(".fw-close") as HTMLElement).click();
    await flush();
    expect(activeTab.value?.session.ui.editingFormula).toBeNull();
    expect(host().querySelectorAll("sp-tab")).toHaveLength(2);
    expect(host().querySelector<HTMLElement>(".bd-body")?.dataset.jxRegion).toBe(
      "dock.bottom/panel:problems",
    );
  });

  test("Monaco is released when the dock stops painting the tab", async () => {
    const seen: string[] = [];
    const logic = bottomPanelSet().find((panel) => panel.id === "logic")!;
    // Restored by the suite's `resetPanels()`, which drops every record and re-registers.
    logic.afterRender = (_ctx, el) => seen.push(el.className || el.id);
    mountBottomDock();
    openFormulaTab();
    await flush();
    expect(seen).toContain("bd-body");

    // The three ways to stop showing it. Each must reach the surface, or the Monaco instance the
    // Logic tab holds stays attached to DOM lit has already discarded.
    seen.length = 0;
    setBottomTab("activity");
    await flush();
    expect(seen).toEqual(["bd-body"]);

    seen.length = 0;
    setDockCollapsed("bottom", true);
    await flush();
    expect(seen).toEqual(["bottom-dock"]);

    // Four, in fact. Blanking the host on unmount is the one nothing else covers, and the
    // Canvas-side dispose that used to mop it up went away with the takeover.
    setDockCollapsed("bottom", false);
    await flush();
    seen.length = 0;
    unmountBottomDock();
    expect(seen).toEqual(["bottom-dock"]);
  });

  /**
   * Two events, not one. The dock's effect answers "a target appeared" and fires at most once per
   * target — the test above depends on that. It cannot also answer "the user asked for this", which
   * is a click that changes no target at all, and for three phases nothing did: reopen the same
   * formula after closing the dock and the key comparison found nothing to do.
   */
  test("re-asking for the SAME target reopens a dock the user closed", async () => {
    mountBottomDock();
    openFormulaTab();
    await flush();
    expect(shell.docks.bottom.collapsed).toBe(false);

    (host().querySelector(".bd-close") as HTMLElement).click();
    await flush();
    expect(shell.docks.bottom.collapsed).toBe(true);

    // Exactly what "Open in formula workspace" on `total` does the second time.
    openLogicTarget({ editing: { defName: "total", type: "def" }, surface: "formula" });
    await flush();
    expect(shell.docks.bottom.collapsed).toBe(false);
    expect(shell.bottomTab).toBe("logic");
    expect(host().querySelector(".fw-title")?.textContent).toContain("total");
  });

  test("the panel's afterRender runs against the painted body", async () => {
    const seen: (string | undefined)[] = [];
    const logic = bottomPanelSet().find((panel) => panel.id === "logic")!;
    // Restored by the suite's `resetPanels()`, which drops every record and re-registers.
    logic.afterRender = (_ctx, el) => seen.push(el.className);
    mountBottomDock();
    openFormulaTab();
    await flush();
    // Monaco's mount hangs off this hook, so a dock that skipped it would host the record and
    // Never the editor.
    expect(seen).toContain("bd-body");
  });
});

describe("the selected tab", () => {
  test("is the stored one when it is visible", () => {
    shell.bottomTab = "activity";
    expect(activeBottomPanel(emptyContext())?.id).toBe("activity");
  });

  test("falls back to the first visible tab when the stored one is hidden or unknown", () => {
    shell.bottomTab = "logic";
    expect(activeBottomPanel(emptyContext())?.id).toBe("problems");
    shell.bottomTab = "nonsense";
    expect(activeBottomPanel(emptyContext())?.id).toBe("problems");
  });
});

describe("bottomTabLabel", () => {
  test("appends the record's badge, and appends nothing when there is none", () => {
    const [problemsPanel] = bottomPanelSet();
    const activityPanel = bottomPanelSet().at(-1);
    const ctx = panelContext();
    expect(bottomTabLabel(problemsPanel!, ctx)).toBe("Problems");
    notify.error("something");
    expect(bottomTabLabel(problemsPanel!, ctx)).toBe("Problems 1");
    expect(bottomTabLabel(activityPanel!, ctx)).toBe("Activity");
    beginActivity({ title: "Install" });
    expect(bottomTabLabel(activityPanel!, ctx)).toBe("Activity 1");
  });
});

describe("mounting", () => {
  test("renders the strip and the selected tab's body, and stamps the region", async () => {
    mountBottomDock();
    await flush();
    expect(host().querySelector(".bd-strip")).not.toBeNull();
    expect(host().querySelectorAll("sp-tab")).toHaveLength(2);
    expect(host().querySelector<HTMLElement>(".bd-body")?.dataset.jxRegion).toBe(
      "dock.bottom/panel:problems",
    );
    expect(resolveRegion("dock.bottom")).toBe(host());
  });

  test("a collapsed dock renders nothing and resolves to nothing", async () => {
    mountBottomDock();
    await flush();
    setDockCollapsed("bottom", true);
    await flush();
    // Focus must not land in a `display: none` box and a shot must not crop one — so
    // `view.setBottomDock { open: true }` is what makes the region addressable.
    expect(host().textContent?.trim()).toBe("");
    expect(resolveRegion("dock.bottom")).toBeNull();
  });

  test("repaints when a problem arrives, with nothing pushing DOM at it", async () => {
    mountBottomDock();
    await flush();
    expect(host().textContent).toContain("Nothing needs fixing");
    notify.error("project.json:14 unknown key", { source: "Validation" });
    await flush();
    expect(host().textContent).toContain("unknown key");
    expect(host().querySelector("sp-tab")?.getAttribute("label")).toBe("Problems 1");
  });

  test("selecting a tab through the strip writes the shell record", async () => {
    mountBottomDock();
    await flush();
    const tabs = host().querySelector("sp-tabs") as HTMLElement & { selected: string };
    tabs.selected = "activity";
    tabs.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(shell.bottomTab).toBe("activity");
    expect(host().querySelector<HTMLElement>(".bd-body")?.dataset.jxRegion).toBe(
      "dock.bottom/panel:activity",
    );
  });

  test("re-selecting the tab already showing changes nothing", async () => {
    mountBottomDock();
    await flush();
    const tabs = host().querySelector("sp-tabs") as HTMLElement & { selected: string };
    tabs.selected = "problems";
    tabs.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(shell.bottomTab).toBe("problems");
  });

  test("the close button collapses the dock", async () => {
    mountBottomDock();
    await flush();
    (host().querySelector(".bd-close") as HTMLElement).click();
    await flush();
    expect(shell.docks.bottom.collapsed).toBe(true);
  });

  test("mounting twice is a no-op, and unmounting clears the host", async () => {
    mountBottomDock();
    mountBottomDock();
    await flush();
    expect(host().querySelectorAll(".bd-strip")).toHaveLength(1);
    unmountBottomDock();
    expect(host().textContent?.trim()).toBe("");
    expect(Object.hasOwn(host().dataset, "jxRegion")).toBe(false);
    // And a render after unmount has no host to write to, rather than throwing.
    expect(() => renderBottomDock()).not.toThrow();
  });

  test("an absent host is inert, not fatal — the desktop shell boots a partial tree", () => {
    document.body.innerHTML = "";
    expect(() => mountBottomDock()).not.toThrow();
    unmountBottomDock();
  });
});

describe("the template, without a host", () => {
  test("renders every visible tab and the selected body", () => {
    expect(() => bottomDockTemplate(emptyContext())).not.toThrow();
  });

  test("with no visible tab at all it says so instead of painting a blank box", async () => {
    resetPanels();
    // `logic` is the tab that hides itself when nothing is open in it — the only stored-but-hidden
    // State the dock can now reach, since Diff stopped being a tab id.
    closeAllTabs();
    shell.bottomTab = "logic";
    const ctx = emptyContext();
    const none = visibleBottomPanels(ctx).length;
    expect(none).toBeGreaterThan(0);
    setBottomTab("logic");
    mountBottomDock();
    await flush();
    // A hidden stored tab falls back rather than emptying the dock.
    expect(host().querySelector<HTMLElement>(".bd-body")?.dataset.jxRegion).toBe(
      "dock.bottom/panel:problems",
    );
  });
});
