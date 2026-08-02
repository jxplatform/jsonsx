import "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import { html } from "lit-html";
import {
  getPanel,
  isPanelVisible,
  listPanels,
  panelContext,
  railDeclarations,
  railGroups,
  registerPanel,
  resetPanels,
  unregisterPanel,
} from "../src/panels/panel-registry";
import type { PanelRecord } from "../src/panels/panel-registry";
import {
  navigatorPanelSet,
  registerNavigatorPanels,
  resetNavigatorPanels,
} from "../src/panels/navigator-panels";
import { emptyContext } from "../src/commands/context";
import { DOCK_TABS } from "../src/commands/budget";
import {
  checkPanelPlacement,
  checkPanelPlacements,
  PANEL_PLACEMENT_MATRIX,
  panelPlacements,
} from "../src/commands/levels";
import { DEFAULT_PANEL_ID, migratePanelId, NAVIGATOR_PANEL_IDS, shell } from "../src/shell";

function record(over: Partial<PanelRecord> = {}): PanelRecord {
  return {
    id: "fixture",
    title: "Fixture",
    level: "project",
    dock: "navigator",
    icon: "sp-icon-folder",
    render: () => html`<p>body</p>`,
    ...over,
  };
}

afterEach(() => {
  resetPanels();
});

// ─── registerPanel ────────────────────────────────────────────────────────────

describe("registerPanel", () => {
  test("stores a record and returns it by id", () => {
    registerPanel(record());
    expect(getPanel("fixture")?.title).toBe("Fixture");
    expect(listPanels("navigator").map((p) => p.id)).toEqual(["fixture"]);
  });

  test("rejects a duplicate id — the second definition site is the defect", () => {
    registerPanel(record());
    expect(() => registerPanel(record())).toThrow(/already registered/);
  });

  test("rejects a malformed id, because the id is also the region", () => {
    expect(() => registerPanel(record({ id: "Files Panel" }))).toThrow(/malformed/);
  });

  test("rejects a rail panel whose level has no rail group", () => {
    // `application` and `selection` name no rail group, so a rail button for one is a placement
    // The matrix does not contain — the check that stops the rail re-accreting.
    expect(() => registerPanel(record({ level: "application" }))).toThrow(/not a panel placement/);
    expect(() => registerPanel(record({ level: "selection" }))).toThrow(/not a panel placement/);
  });

  test("accepts those levels off the rail, where they claim no group", () => {
    expect(() => registerPanel(record({ level: "application", rail: false }))).toThrow(
      /admits only project, document/,
    );
  });

  test("rejects a selection-level panel in the Navigator dock", () => {
    expect(() => registerPanel(record({ level: "selection", rail: false }))).toThrow(
      /"navigator" admits only project, document/,
    );
  });

  test("unregisterPanel removes it", () => {
    registerPanel(record());
    unregisterPanel("fixture");
    expect(getPanel("fixture")).toBeUndefined();
  });
});

// ─── the matrix ───────────────────────────────────────────────────────────────

describe("panel placement matrix", () => {
  test("a rail panel occupies its dock body and its level's rail group", () => {
    expect(panelPlacements({ id: "files", level: "project", dock: "navigator" })).toEqual([
      "navigator",
      "rail/project",
    ]);
  });

  test("rail: false drops the rail-group placement", () => {
    expect(
      panelPlacements({ id: "insert", level: "document", dock: "navigator", rail: false }),
    ).toEqual(["navigator"]);
  });

  test("the bottom dock's placement key is dotted", () => {
    expect(
      panelPlacements({ id: "problems", level: "project", dock: "bottom", rail: false }),
    ).toEqual(["dock.bottom"]);
  });

  test("each rail group admits exactly one level", () => {
    expect(PANEL_PLACEMENT_MATRIX["rail/project"].admits).toEqual(["project"]);
    expect(PANEL_PLACEMENT_MATRIX["rail/document"].admits).toEqual(["document"]);
  });

  test("a whole set is checked at once, and a clean set reports nothing", () => {
    expect(
      checkPanelPlacements([
        { id: "files", level: "project", dock: "navigator" },
        { id: "insert", level: "document", dock: "navigator", rail: false },
      ]),
    ).toEqual([]);
  });

  test("a whole set reports every offender, keyed by panel", () => {
    const violations = checkPanelPlacements([
      { id: "good", level: "document", dock: "navigator" },
      { id: "bad", level: "selection", dock: "navigator", rail: false },
    ]);
    expect(violations.map((v) => v.panelId)).toEqual(["bad"]);
  });

  test("an unknown level is reported before any placement is checked", () => {
    const violations = checkPanelPlacement({
      id: "bogus",
      level: "range" as never,
      dock: "navigator",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/unknown level "range"/);
  });
});

// ─── the composed set ─────────────────────────────────────────────────────────

describe("the Navigator's panel set", () => {
  test("registers ten records, in rail order", () => {
    expect(navigatorPanelSet().map((p) => p.id)).toEqual([
      "files",
      "search",
      "git",
      "problems",
      "layers",
      "page",
      "data",
      "packages",
      "insert",
      "state",
    ]);
  });

  test("agrees with NAVIGATOR_PANEL_IDS — the enum view.setActivity validates against", () => {
    // Two lists, because `shell.ts` must load in a bare Bun process for the CI checks. This is
    // What stops them drifting.
    expect(navigatorPanelSet().map((p) => p.id)).toEqual([...NAVIGATOR_PANEL_IDS]);
  });

  test("registerNavigatorPanels is idempotent — the app mounts once, a suite mounts per case", () => {
    registerNavigatorPanels();
    registerNavigatorPanels();
    expect(listPanels("navigator")).toHaveLength(10);
  });

  test("the three renamed ids are gone", () => {
    const ids = navigatorPanelSet().map((p) => p.id);
    expect(ids).not.toContain("blocks");
    expect(ids).not.toContain("head");
    expect(ids).not.toContain("imports");
  });

  test("a declared-but-unbuilt panel refuses to render, rather than drawing a stub", () => {
    // `when` is the guard; this is the second one, so deleting the predicate without building the
    // Surface fails loudly instead of shipping an empty panel with a real header.
    for (const id of ["search", "problems"]) {
      const panel = navigatorPanelSet().find((p) => p.id === id);
      expect(panel?.when?.(emptyContext())).toBe(false);
      expect(() => panel!.render({} as never)).toThrow(/declared but not built/);
    }
  });

  test("resetNavigatorPanels empties the registry so a suite can compose it again", () => {
    registerNavigatorPanels();
    resetNavigatorPanels();
    expect(listPanels()).toEqual([]);
  });

  test("every panel declares a level and an icon", () => {
    for (const panel of navigatorPanelSet()) {
      expect(["project", "document"]).toContain(panel.level);
      expect(panel.icon).toMatch(/^sp-icon-/);
      expect(panel.title.length).toBeGreaterThan(0);
    }
  });

  test("the default panel is one of them", () => {
    expect(navigatorPanelSet().map((p) => p.id)).toContain(DEFAULT_PANEL_ID);
  });
});

// ─── the rail, as data ────────────────────────────────────────────────────────

describe("railGroups", () => {
  test("two groups, PROJECT then DOCUMENT, hiding what does not exist yet", () => {
    registerNavigatorPanels();
    const groups = railGroups(emptyContext());
    expect(groups.map((g) => g.label)).toEqual(["Project", "Document"]);
    // Search and Problems declare `when: () => false` — registered, budgeted, not drawn.
    expect(groups[0]?.panels.map((p) => p.id)).toEqual(["files", "git"]);
    expect(groups[1]?.panels.map((p) => p.id)).toEqual(["layers", "page", "data", "packages"]);
  });

  test("Insert and State are off the rail but still reachable records", () => {
    registerNavigatorPanels();
    const railed = railGroups(emptyContext()).flatMap((g) => g.panels.map((p) => p.id));
    expect(railed).not.toContain("insert");
    expect(railed).not.toContain("state");
    expect(getPanel("insert")).toBeDefined();
    expect(getPanel("state")).toBeDefined();
  });

  test("an empty group is dropped so no divider is drawn against nothing", () => {
    registerPanel(record({ id: "only", level: "document" }));
    const groups = railGroups(emptyContext());
    expect(groups.map((g) => g.level)).toEqual(["document"]);
  });

  test("isPanelVisible defaults to true and honours `when`", () => {
    const ctx = emptyContext();
    expect(isPanelVisible(record(), ctx)).toBe(true);
    expect(isPanelVisible(record({ when: () => false }), ctx)).toBe(false);
  });
});

describe("railDeclarations", () => {
  test("matches the chrome budget's declared rail rows", () => {
    // `commands/budget.ts` wrote the rail out by hand because the registry did not exist. This is
    // The assertion that keeps the two in step until `check-chrome-budget.ts` queries the registry.
    registerNavigatorPanels();
    const declared = DOCK_TABS.filter((d) => d.dock.startsWith("rail/"));
    expect(railDeclarations()).toEqual(declared.map((d) => ({ dock: d.dock, tabs: [...d.tabs] })));
  });

  test("counts hidden panels — a slot spent is a slot spent", () => {
    registerNavigatorPanels();
    const project = railDeclarations().find((d) => d.dock === "rail/project");
    expect(project?.tabs).toEqual(["Files", "Search", "Source Control", "Problems"]);
  });

  test("stays inside the four-per-group cap", () => {
    registerNavigatorPanels();
    for (const declaration of railDeclarations()) {
      expect(declaration.tabs.length).toBeLessThanOrEqual(4);
    }
  });
});

// ─── the panel context ────────────────────────────────────────────────────────

describe("panelContext", () => {
  test("sources the Source Control badge from the project record, not the focused tab", () => {
    shell.git.status = { files: [{}, {}, {}] } as never;
    expect(panelContext().git.dirtyCount).toBe(3);
    shell.git.status = null;
    expect(panelContext().git.dirtyCount).toBe(0);
  });
});

// ─── the persisted-id migration ───────────────────────────────────────────────

describe("migratePanelId", () => {
  test("translates the three renamed ids", () => {
    expect(migratePanelId("blocks")).toBe("insert");
    expect(migratePanelId("head")).toBe("page");
    expect(migratePanelId("imports")).toBe("packages");
  });

  test("passes a current id through", () => {
    expect(migratePanelId("layers")).toBe("layers");
    expect(migratePanelId("packages")).toBe("packages");
  });

  test("returns null for anything else, so the caller chooses the fallback", () => {
    expect(migratePanelId("bogus")).toBeNull();
    expect(migratePanelId(null)).toBeNull();
    expect(migratePanelId(7)).toBeNull();
  });
});
