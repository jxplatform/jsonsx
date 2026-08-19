import { flush, installMockPlatform, renderInto, resetStudioState } from "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import { html } from "lit-html";
import {
  getPanel,
  isPanelVisible,
  listPanels,
  panelContext,
  railDeclarations,
  railGroups,
  railPanelSet,
  registerPanel,
  resetPanels,
  unregisterPanel,
} from "../src/panels/panel-registry";
import type { NavigatorPanelDeps, PanelRecord } from "../src/panels/panel-registry";
import { setProjectState } from "../src/store";
import { closeAllTabs } from "../src/workspace/workspace";
import { renderFilesTemplate } from "../src/files/files";
import { cleanupGitPanel, renderGitPanel } from "../src/panels/git-panel";
import {
  navigatorPanelSet,
  registerNavigatorPanels,
  resetNavigatorPanels,
} from "../src/panels/navigator-panels";
import { emptyContext } from "../src/commands/context";
import {
  checkPanelPlacement,
  checkPanelPlacements,
  PANEL_PLACEMENT_MATRIX,
  panelPlacements,
} from "../src/commands/levels";
import {
  DEFAULT_PANEL_ID,
  migratePanelId,
  NAVIGATOR_PANEL_IDS,
  resetProjectShell,
  shell,
} from "../src/shell";

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
  test("registers nine records, in registration order — and Problems is not one of them", () => {
    expect(navigatorPanelSet().map((p) => p.id)).toEqual([
      "files",
      "search",
      "git",
      // Languages is registered with the PROJECT group and draws no rail button, so it sits here
      // Rather than beside Insert at the end — registration order is roster order, and this list
      // Is what `view.setActivity` and the shot manifest address the panel by.
      "i18n",
      "layers",
      "page",
      "data",
      "packages",
      "insert",
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
    expect(listPanels("navigator")).toHaveLength(9);
    // …and it composes the Bottom dock's tabs in the same pass, still exactly once each. There is
    // No `diff` among them: it was a reserved id with no record behind it, so it could only ever
    // Select a hidden tab.
    expect(listPanels("bottom").map((p) => p.id)).toEqual(["problems", "logic", "activity"]);
  });

  test("the three renamed ids are gone", () => {
    const ids = navigatorPanelSet().map((p) => p.id);
    expect(ids).not.toContain("blocks");
    expect(ids).not.toContain("head");
    expect(ids).not.toContain("imports");
  });

  test("a declared-but-unbuilt panel refuses to render, rather than drawing a stub", () => {
    // `when` is the guard, so deleting the predicate without building the surface fails loudly
    // Instead of shipping an empty panel with a real header. Search is the one left: Problems was
    // The other, and P4.2 deleted its predicate in the same commit that gave it a body.
    const panel = navigatorPanelSet().find((p) => p.id === "search");
    expect(panel?.when?.(emptyContext())).toBe(false);
    expect(() => panel!.render({} as never)).toThrow(/declared but not built/);
  });

  test("Problems is built, and it is the Bottom dock's — one record, one host (§7.2)", () => {
    registerNavigatorPanels();
    const panel = getPanel("problems");
    expect(panel?.dock).toBe("bottom");
    expect(panel?.level).toBe("project");
    expect(panel?.when).toBeUndefined();
    expect(panel?.badge).toBeDefined();
    expect(() => panel!.render({ deps: {} as never, doc: null, rerender: () => {} })).not.toThrow();
    expect(navigatorPanelSet().map((p) => p.id)).not.toContain("problems");
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

// ─── principle 3's corollary ──────────────────────────────────────────────────

/**
 * The deps a PROJECT-level panel may touch, and a tripwire for everything else.
 *
 * Only the two renderers project-level records delegate to are real. Every other member of
 * {@link NavigatorPanelDeps} is a document-level renderer or a document-level gesture registration,
 * so reaching for one IS the violation this suite is looking for — and the error names which.
 */
function projectPanelDeps(): NavigatorPanelDeps {
  const provided: Partial<NavigatorPanelDeps> = {
    renderFilesTemplate: () =>
      renderFilesTemplate({
        openFileFromTree: () => {},
        openProject: () => {},
        renderLeftPanel: () => {},
      }),
    renderGitPanel,
  };
  return new Proxy(provided, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop in target) {
        return target[prop as keyof NavigatorPanelDeps];
      }
      throw new Error(
        `a level: "project" panel read deps.${prop}, which only exists for a focused document`,
      );
    },
  }) as NavigatorPanelDeps;
}

/**
 * Principle 3's corollary, asserted as the loop `panel-registry.ts` says it is.
 *
 * The docstring on {@link import("../src/panels/panel-registry").NavigatorDocument} has claimed
 * since P3 that this file "renders every project-level panel with `doc: null`". It rendered exactly
 * one — Problems — so the claim was a promise rather than a check, and the defect it names (the
 * Source Control badge vanishing when the last tab closed) could have come back through any of the
 * others without a test moving.
 *
 * Three paints, because "renders" is not one body. The first is what kicks off `refreshGitStatus()`
 * and `loadDirectory(".")`; the second is the empty state those resolve into; the third is the full
 * Source Control body a real repository draws, which is the biggest surface any project-level panel
 * has and the one whose badge used to come off the focused tab. A panel that only reaches for the
 * document once it has something to show is still a panel that reaches.
 */
describe("every project-level panel renders with no document open", () => {
  afterEach(() => {
    cleanupGitPanel();
    resetProjectShell();
    setProjectState(null as never);
    closeAllTabs();
  });

  test("no tab, no throw — cold, empty, and with a working tree to draw", async () => {
    installMockPlatform();
    setProjectState({
      dirs: new Map(),
      expanded: new Set(),
      isSiteProject: true,
      name: "Demo",
      projectConfig: { name: "Demo" },
      projectDirs: [],
      projectRoot: ".",
      searchQuery: "",
      selectedPath: null,
    } as never);
    closeAllTabs();
    registerNavigatorPanels();

    const ctx = panelContext();
    const panels = listPanels().filter((p) => p.level === "project" && isPanelVisible(p, ctx));
    // Search is registered, `when`-hidden and deliberately unbuilt (its render throws), so the
    // Set under test is the four that DRAW — two Navigator panels and two Bottom-dock tabs, since
    // The corollary is about a panel's LEVEL and not about which dock hosts it. Named rather than
    // Counted: a panel that quietly stopped being project-level would otherwise shrink this loop
    // To nothing and still pass.
    expect(panels.map((p) => p.id)).toEqual(["files", "git", "problems", "activity"]);

    const deps = projectPanelDeps();
    const paint = async (): Promise<Map<string, HTMLElement>> => {
      const painted = new Map<string, HTMLElement>();
      for (const panel of panels) {
        const body = panel.render({ deps, doc: null, rerender: () => {} });
        // `nothing` is a legal body (PanelBody says so); a TemplateResult is committed for real,
        // Because a directive that throws does it on commit rather than on construction.
        if (typeof body === "object" && "strings" in body) {
          painted.set(panel.id, await renderInto(body));
        }
      }
      await flush();
      return painted;
    };

    // Each pass asserts WHICH body it drew, so "renders three times without throwing" cannot
    // Quietly become "renders the same placeholder three times without throwing".
    const cold = await paint();
    expect(cold.get("git")?.textContent).toContain("Loading");

    const settled = await paint();
    expect(settled.get("git")?.textContent).toContain("not tracked by git");
    expect(settled.get("files")?.querySelector(".file-tree")).not.toBeNull();

    shell.git.branches = { branches: ["main"], current: "main" } as never;
    shell.git.status = {
      ahead: 1,
      behind: 0,
      branch: "main",
      files: [{ path: "pages/index.json", staged: false, status: "M" }],
      isRepo: true,
      remotes: ["origin"],
    } as never;
    const tracked = await paint();
    expect(tracked.get("git")?.querySelector(".git-branch-name")?.textContent).toBe("main");
    expect(tracked.get("git")?.querySelector(".git-file-name")?.textContent).toBe("index.json");
  });
});

// ─── the rail, as data ────────────────────────────────────────────────────────

describe("railGroups", () => {
  test("two groups, PROJECT then DOCUMENT, hiding what does not exist yet", () => {
    registerNavigatorPanels();
    const groups = railGroups(emptyContext());
    expect(groups.map((g) => g.label)).toEqual(["Project", "Document"]);
    // Search declares `when: () => false` — registered, budgeted, not drawn.
    expect(groups[0]?.panels.map((p) => p.id)).toEqual(["files", "git"]);
    expect(groups[1]?.panels.map((p) => p.id)).toEqual(["layers", "page", "data", "packages"]);
  });

  test("Insert is off the rail but still a reachable record", () => {
    registerNavigatorPanels();
    const railed = railGroups(emptyContext()).flatMap((g) => g.panels.map((p) => p.id));
    expect(railed).not.toContain("insert");
    expect(getPanel("insert")).toBeDefined();
  });

  test("State is not a record at all — its editor is part of Data", () => {
    // It used to be registered `rail: false` pending plan §11.2's merge, which left the ONE way to
    // Declare a state variable behind a palette search. Data renders that editor now, so there is
    // No second record to find, and a stored `state` id migrates rather than 404s.
    registerNavigatorPanels();
    expect(getPanel("state")).toBeUndefined();
    expect(getPanel("data")).toBeDefined();
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

  test("the rail spans docks: a rail-able bottom panel gets a button, a rail-less one does not", () => {
    registerPanel(record({ id: "shouted", title: "Shouted", dock: "bottom" }));
    registerPanel(record({ id: "silent", title: "Silent", dock: "bottom", rail: false }));
    const project = railGroups(emptyContext())[0]?.panels.map((p) => p.id);
    expect(project).toContain("shouted");
    expect(project).not.toContain("silent");
    // The same basis `panelPlacements()` has always used — the dock is a separate placement.
    expect(panelPlacements({ id: "shouted", level: "project", dock: "bottom" })).toEqual([
      "dock.bottom",
      "rail/project",
    ]);
  });
});

describe("railPanelSet", () => {
  test("is the rail flattened in group order — PROJECT then DOCUMENT, ⌘1–8's order", () => {
    registerNavigatorPanels();
    expect(railPanelSet().map((p) => p.id)).toEqual([
      "files",
      "search",
      "git",
      "layers",
      "page",
      "data",
      "packages",
    ]);
  });

  test("ignores `when`, so a hidden panel does not shuffle the chords after it", () => {
    registerNavigatorPanels();
    expect(railPanelSet().map((p) => p.id)).toContain("search");
    expect(railGroups(emptyContext()).flatMap((g) => g.panels.map((p) => p.id))).not.toContain(
      "search",
    );
  });

  test("orders by level group, not by registration order", () => {
    /* A SYNTHETIC panel, because the shipped set no longer proves this on its own.
       Problems used to: it registered last, from the Bottom dock's module, and still landed in the
       PROJECT group ahead of every DOCUMENT one. With it off the rail, registration order and rail
       order happen to coincide, and a test that only reads the real set would pass whether or not
       the sort existed. The property is still load-bearing — a panel is filed by its LEVEL, and the
       module that registers it is free to be loaded whenever — so it is asserted deliberately. */
    registerNavigatorPanels();
    registerPanel({
      id: "late-project-panel",
      title: "Late",
      level: "project",
      dock: "navigator",
      icon: "sp-icon-folder",
      render: () => html``,
    });
    const registration = listPanels().map((p) => p.id);
    const rail = railPanelSet().map((p) => p.id);
    // Registered after every DOCUMENT panel…
    expect(registration.indexOf("late-project-panel")).toBeGreaterThan(
      registration.indexOf("packages"),
    );
    // …and drawn before all of them.
    expect(rail.indexOf("late-project-panel")).toBeLessThan(rail.indexOf("layers"));
  });
});

describe("railDeclarations", () => {
  test("names the two rail groups, in shell order", () => {
    // `commands/budget.ts` used to write these rows out by hand and this test asserted the two
    // Agreed. The duplication is gone — `check-chrome-budget.ts` queries this function — so what
    // Is left to assert is the shape the budget check consumes.
    registerNavigatorPanels();
    expect(railDeclarations()).toEqual([
      { dock: "rail/project", tabs: ["Files", "Search", "Source Control"] },
      { dock: "rail/document", tabs: ["Outline", "Page", "Data", "Packages"] },
    ]);
  });

  test("counts hidden panels — a slot spent is a slot spent", () => {
    registerNavigatorPanels();
    const project = railDeclarations().find((d) => d.dock === "rail/project");
    // Search declares `when: () => false` and still spends a slot; Problems no longer spends one
    // At all, because it has no rail button to spend it on.
    expect(project?.tabs).toEqual(["Files", "Search", "Source Control"]);
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

  /*
   * A key a panel gates on has to be computed here, and this one was not: `isMultilingual` was
   * declared, assigned in `live-context.ts`, and left at its `emptyContext()` default in this
   * subset — so the Languages panel's `when` was false on a project declaring three languages and
   * the Navigator answered "No Navigator panel is registered as i18n". Nothing threw; the panel was
   * simply never visible.
   */
  test("computes isMultilingual, which a panel gates on", () => {
    resetStudioState({
      projectConfig: { i18n: { defaultLocale: "en", locales: ["en", "fr-CA"] } },
    });
    expect(panelContext().project.isMultilingual).toBe(true);
    // Counted after canonicalization, so a duplicate or a typo declares one language, not two.
    resetStudioState({ projectConfig: { i18n: { locales: ["en", "EN"] } } });
    expect(panelContext().project.isMultilingual).toBe(false);
    resetStudioState({ projectConfig: {} });
    expect(panelContext().project.isMultilingual).toBe(false);
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

  test('a persisted leftTab of "problems" lands on the default, not in a wedged shell', () => {
    // §7.2 moved Problems to the Bottom dock, so a build from before it could have persisted an id
    // The Navigator can no longer show. There is no alias to add — it is not a Navigator panel
    // Under any name — so it migrates to nothing and the boot path's `?? DEFAULT_PANEL_ID` runs.
    expect(migratePanelId("problems")).toBeNull();
    expect(migratePanelId("problems") ?? DEFAULT_PANEL_ID).toBe(DEFAULT_PANEL_ID);
    expect(NAVIGATOR_PANEL_IDS as readonly string[]).not.toContain("problems");
  });
});
