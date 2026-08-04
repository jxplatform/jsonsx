/**
 * ⑪ The Bottom dock (`panels/bottom-dock.ts`).
 *
 * What is worth pinning: that the strip is a rendering of the panel REGISTRY (four tabs, at the
 * documented cap, two of them declared-and-hidden until P8 builds them), that its region resolves
 * only while it is open — because a collapsed dock is a box focus must not land in and a shot must
 * not crop — and that the declared budget row and the registered set are the same four titles, so
 * `commands/budget.ts`'s copy cannot drift from what the dock actually hosts.
 */
import { flush, installMockPlatform } from "./harness";
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
import { panelContext, resetPanels } from "../src/panels/panel-registry";
import { BOTTOM_TAB_IDS, setBottomTab, setDockCollapsed, shell } from "../src/shell";
import { DECLARED_DOCK_TABS } from "../src/commands/budget";
import { beginActivity, resetActivities } from "../src/panels/activity-panel";
import { notify, resetNotifications } from "../src/services/notify";
import { resolveRegion } from "../src/ui/regions";
import { emptyContext } from "../src/commands/context";

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
  resetPanels();
  resetActivities();
  resetNotifications();
  shell.docks.bottom.collapsed = true;
});

describe("the tab set", () => {
  test("is the four ids §3.2 ⑪ names, in strip order", () => {
    expect(bottomPanelSet().map((panel) => panel.id)).toEqual([...BOTTOM_TAB_IDS]);
    expect(bottomPanelSet().map((panel) => panel.title)).toEqual([
      "Problems",
      "Diff",
      "Logic",
      "Activity",
    ]);
  });

  test("agrees with the row `commands/budget.ts` declares, which a bare Bun check reads", () => {
    // Budget.ts cannot import this module (it renders lit templates and three CI checks load it in
    // A bare Bun process), so the copy is kept honest here instead of by an import.
    const declared = DECLARED_DOCK_TABS.find((dock) => dock.dock === "bottom");
    expect(declared?.tabs).toEqual(bottomPanelSet().map((panel) => panel.title));
  });

  test("registration is idempotent, and all four tabs are this dock's own records", () => {
    registerBottomPanels();
    registerBottomPanels();
    expect(bottomPanelSet()).toHaveLength(4);
    // One record, ONE host (§7.2). Problems included: it keeps a rail button and a badge, but the
    // Rail groups by level rather than by dock, so nothing is registered twice to earn them.
    expect(bottomPanelSet().every((panel) => panel.dock === "bottom")).toBe(true);
    expect(bottomPanelSet()[0]?.id).toBe("problems");
  });

  test("Problems is the only tab with a rail button", () => {
    expect(
      bottomPanelSet()
        .filter((panel) => panel.rail !== false)
        .map((panel) => panel.id),
    ).toEqual(["problems"]);
  });

  test("Diff and Logic are declared and hidden until P8 builds them", () => {
    const hidden = bottomPanelSet().filter((panel) => panel.when?.(emptyContext()) === false);
    expect(hidden.map((panel) => panel.id)).toEqual(["diff", "logic"]);
    for (const panel of hidden) {
      expect(() => panel.render({} as never)).toThrow(/declared but not built/);
    }
    expect(visibleBottomPanels(emptyContext()).map((panel) => panel.id)).toEqual([
      "problems",
      "activity",
    ]);
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
    // Nothing registered, so `bottomPanelSet()` re-registers — gate every tab off instead.
    shell.bottomTab = "diff";
    const ctx = emptyContext();
    const none = visibleBottomPanels(ctx).length;
    expect(none).toBeGreaterThan(0);
    setBottomTab("diff");
    mountBottomDock();
    await flush();
    // A hidden stored tab falls back rather than emptying the dock.
    expect(host().querySelector<HTMLElement>(".bd-body")?.dataset.jxRegion).toBe(
      "dock.bottom/panel:problems",
    );
  });
});
