/**
 * The command-addressed automation surface: `run(id, args)` and the id→handler table behind it.
 *
 * The screenshot manifest names command ids and nothing else, so two things must hold or the docs
 * build silently rots: every id the manifest names has to exist, and an id that does NOT exist has
 * to throw rather than no-op (a skipped step captures the wrong state and CI accepts it).
 */
import { resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import type { AutomationArgs, AutomationDeps } from "../src/services/automation";

const { AUTOMATION_COMMANDS, createAutomationApi } = await import("../src/services/automation");
const { initCanvasUtils } = await import("../src/canvas/canvas-utils");
const { view } = await import("../src/view");
const { activeTab, closeAllTabs } = await import("../src/workspace/workspace");

function makeDeps(): AutomationDeps {
  return {
    getCanvasMode: () => "design",
    openBrowseModal: mock(() => {}),
    openConnectorGrid: mock(() => {}),
    openNewProjectModal: mock(() => {}),
    openQuickSearchPalette: mock(() => {}),
    openSettingsModal: mock(() => {}),
    render: mock(() => {}),
    renderActivityBar: mock(() => {}),
    seedAssistantMessages: mock(() => {}),
    seedPublishConnected: mock(() => {}),
    setCanvasMode: mock(() => {}),
    statusMessage: mock(() => {}),
  };
}

/** One representative argument set per command id — the loop below runs every entry with these. */
const ARGS: Record<string, AutomationArgs> = {
  "canvas.setEditZoom": { zoom: 1.5 },
  "canvas.setMode": { mode: "preview" },
  "canvas.setZoom": { zoom: 0.8 },
  "canvas.togglePreview": {},
  "collection.editInGrid": {},
  "data.expandRow": { name: "count" },
  "data.openGrid": { connection: "main", table: "comments" },
  "element.convertToComponent": {},
  "element.insertData": {},
  "element.repeat": {},
  "file.contextMenu": { path: "content/posts" },
  "formula.browseCatalog": {},
  "formula.editDef": { defName: "addItem" },
  "formula.editEvent": { eventKey: "onclick", path: ["children", 0] },
  "formula.openWorkspace": {},
  "inspector.toggleSection": { section: "Element" },
  "layers.contextMenu": { label: "article" },
  "media.browse": {},
  "project.browse": {},
  "project.new": {},
  "project.setBrowseCategory": { category: "media" },
  "project.showWelcome": {},
  "search.openPalette": {},
  "seed.assistant": { messages: [{ content: "hi", role: "user" }] },
  "seed.collab": { peers: [] },
  "seed.publish": {
    deployment: {
      createdOn: "2026-07-01T00:00:00Z",
      environment: "production",
      id: "d1",
      stage: "deploy",
      status: "success",
      url: "https://demo.pages.dev",
    },
  },
  "selection.set": { path: ["children", 0] },
  "settings.open": { section: "data" },
  "settings.selectEntry": { name: "posts" },
  "settings.setSection": { section: "content" },
  "state.selectSignal": { name: "posts" },
  "style.openSelectorMenu": {},
  "view.setActivity": { tab: "layers" },
  "view.setRightTab": { tab: "style" },
  "view.setStatus": { text: "Ready" },
  "view.setTheme": { color: "light" },
  "view.toggleActivity": { tab: "layers" },
  "view.setAssistant": { open: false },
  "view.setRightPanel": { open: false },
};

beforeEach(() => {
  closeAllTabs();
  resetWorkspaceWithTab();
  initCanvasUtils({ getCanvasMode: () => "edit", getZoom: () => 1, setZoomDirect: () => {} });
});

describe("run", () => {
  test("an unknown id throws, naming the id", () => {
    const api = createAutomationApi(makeDeps());
    expect(() => api.run("view.doesNotExist")).toThrow(
      'unknown automation command "view.doesNotExist"',
    );
  });

  test("a state-driven command executes in-page and asks the runner for nothing", () => {
    const api = createAutomationApi(makeDeps());
    view.leftTab = "files";
    expect(api.run("view.setActivity", { tab: "state" })).toEqual({});
    expect(view.leftTab).toBe("state");
  });

  test("an INTERIM command hands its control back for a real mouse press", () => {
    const api = createAutomationApi(makeDeps());
    expect(api.run("element.repeat")).toEqual({
      click: { selector: 'xpath///sp-menu-item[normalize-space()="Repeat..."]' },
    });
    expect(api.run("file.contextMenu", { path: "content/posts" })).toEqual({
      click: { button: "right", selector: "[data-path='content/posts']" },
    });
  });

  test("args default to an empty object", () => {
    const api = createAutomationApi(makeDeps());
    expect(api.run("collection.editInGrid")).toEqual({
      click: { selector: 'xpath///sp-menu-item[normalize-space()="Edit Collection in Grid"]' },
    });
  });

  test("every table entry runs with its representative args", () => {
    for (const id of Object.keys(AUTOMATION_COMMANDS)) {
      closeAllTabs();
      resetWorkspaceWithTab();
      const api = createAutomationApi(makeDeps());
      const args = ARGS[id];
      expect(args, `no test args declared for "${id}"`).toBeDefined();
      const result = api.run(id, args);
      const entry = AUTOMATION_COMMANDS[id]!;
      expect(Boolean(result.click), `"${id}" click-vs-run mismatch`).toBe(Boolean(entry.press));
      if (result.click) {
        expect(result.click.selector.length, `"${id}" resolved an empty selector`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  test("the optional-argument branches of the arg-bearing commands", () => {
    const deps = makeDeps();
    const api = createAutomationApi(deps);
    api.run("data.openGrid", { table: "posts" });
    api.run("settings.open");
    api.run("selection.set", { path: null });
    api.run("project.showWelcome", { projects: [{ name: "demo", root: "/tmp/demo" }] });
    api.run("seed.assistant", {});
    api.run("seed.collab", {});
    api.run("seed.publish", { accountId: "acct-1", deployment: ARGS["seed.publish"]!.deployment });
    expect(deps.openConnectorGrid).toHaveBeenCalledWith(undefined, "posts");
    expect(deps.openSettingsModal).toHaveBeenCalledWith(undefined);
    expect(deps.seedPublishConnected).toHaveBeenCalledWith({
      accountId: "acct-1",
      deployment: ARGS["seed.publish"]!.deployment,
    });
  });
});

describe("argument coercion", () => {
  test("a missing or mistyped argument fails the step loudly", () => {
    const api = createAutomationApi(makeDeps());
    expect(() => api.run("view.setActivity", {})).toThrow('"tab" must be a string');
    expect(() => api.run("canvas.setZoom", { zoom: "0.8" })).toThrow('"zoom" must be a number');
    expect(() => api.run("settings.open", { section: 7 })).toThrow('"section" must be a string');
    expect(() => api.run("formula.editEvent", { eventKey: "onclick", path: "children" })).toThrow(
      '"path" must be an array',
    );
    expect(() => api.run("selection.set", { path: "children" })).toThrow(
      '"path" must be an array or null',
    );
  });

  test("an unknown settings section or browse category is rejected, not guessed", () => {
    const api = createAutomationApi(makeDeps());
    expect(() => api.run("settings.setSection", { section: "nope" })).toThrow(
      'unknown settings section "nope"',
    );
    expect(() => api.run("project.setBrowseCategory", { category: "nope" })).toThrow(
      'unknown browse category "nope"',
    );
  });
});

describe("view toggles", () => {
  test("the chat and right-panel commands are idempotent setters, not blind toggles", () => {
    // These were `press` shims driving the real button, because the toolbar could not see
    // View.*PanelCollapsed. It now subscribes via onPanelCollapse, so they set state directly —
    // And they take `open` rather than toggling, so flipping a default cannot silently invert
    // Every manifest step that used them (which is exactly what happened to 23 of them).
    const api = createAutomationApi(makeDeps());

    api.run("view.setAssistant", { open: true });
    expect(view.chatPanelCollapsed).toBe(false);
    api.run("view.setAssistant", { open: true });
    expect(view.chatPanelCollapsed).toBe(false);
    api.run("view.setAssistant", { open: false });
    expect(view.chatPanelCollapsed).toBe(true);

    api.run("view.setRightPanel", { open: false });
    expect(view.rightPanelCollapsed).toBe(true);
    api.run("view.setRightPanel", { open: true });
    expect(view.rightPanelCollapsed).toBe(false);
  });

  test("a non-boolean `open` fails the shot rather than capturing the wrong state", () => {
    const api = createAutomationApi(makeDeps());
    expect(() => api.run("view.setAssistant", { open: "yes" })).toThrow(/must be a boolean/);
    expect(() => api.run("view.setAssistant")).toThrow(/must be a boolean/);
  });

  test("togglePreview flips the tab bar's preview flag without a forced rerender", () => {
    const deps = makeDeps();
    const api = createAutomationApi(deps);
    api.togglePreview();
    expect(activeTab.value?.session.ui.preview).toBe(true);
    api.togglePreview();
    expect(activeTab.value?.session.ui.preview).toBe(false);
    expect(deps.render).not.toHaveBeenCalled();
  });

  test("toggleActivity opens another tab, then collapses the panel when re-picked", () => {
    const deps = makeDeps();
    const api = createAutomationApi(deps);
    view.leftTab = "files";
    view.leftPanelCollapsed = true;
    api.toggleActivity("layers");
    expect(view.leftTab).toBe("layers");
    expect(view.leftPanelCollapsed).toBe(false);
    api.toggleActivity("layers");
    expect(view.leftPanelCollapsed).toBe(true);
    // Re-picking a collapsed tab reopens it rather than toggling again.
    api.toggleActivity("layers");
    expect(view.leftPanelCollapsed).toBe(false);
    expect(deps.renderActivityBar).toHaveBeenCalledTimes(3);
  });
});

describe("the screenshot manifest", () => {
  const manifestPath = resolve(import.meta.dir, "../../../scripts/screenshots/manifest.json");

  interface Step {
    do: string;
    id?: string;
    args?: AutomationArgs;
    selector?: string;
  }

  async function steps(): Promise<Step[]> {
    const manifest = (await Bun.file(manifestPath).json()) as {
      shots: { actions?: Step[]; variants?: { actions?: Step[] }[] }[];
    };
    const all: Step[] = [];
    for (const shot of manifest.shots) {
      all.push(...(shot.actions ?? []));
      for (const variant of shot.variants ?? []) {
        all.push(...(variant.actions ?? []));
      }
    }
    return all;
  }

  test("addresses the shell by command id, never by selector", async () => {
    const all = await steps();
    expect(all.filter((step) => step.do === "click")).toEqual([]);
  });

  test("every command id it names resolves, with arguments the handler accepts", async () => {
    const all = await steps();
    const runs = all.filter((step) => step.do === "run");
    expect(runs.length).toBeGreaterThan(0);
    const api = createAutomationApi(makeDeps());
    for (const step of runs) {
      expect(
        AUTOMATION_COMMANDS[step.id!],
        `manifest names unknown command "${step.id}"`,
      ).toBeDefined();
      const entry = AUTOMATION_COMMANDS[step.id!]!;
      if (entry.press) {
        expect(() => entry.press!(step.args ?? {})).not.toThrow();
      }
    }
    expect(api.run("view.setStatus", { text: "Ready" })).toEqual({});
  });
});
