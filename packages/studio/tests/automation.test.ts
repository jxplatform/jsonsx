import { resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AutomationDeps } from "../src/services/automation";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };

const { createAutomationApi, installAutomationHook, shouldInstallAutomation } =
  await import("../src/services/automation");
const { initCanvasUtils } = await import("../src/canvas/canvas-utils");
const { view } = await import("../src/view");
const { activeTab, closeAllTabs } = await import("../src/workspace/workspace");
const { updateCanvas } = await import("../src/store");

function makeDeps(): AutomationDeps & {
  openBrowseModal: ReturnType<typeof mock>;
  openNewProjectModal: ReturnType<typeof mock>;
  openQuickSearchPalette: ReturnType<typeof mock>;
  openSettingsModal: ReturnType<typeof mock>;
  render: ReturnType<typeof mock>;
  renderActivityBar: ReturnType<typeof mock>;
  setCanvasMode: ReturnType<typeof mock>;
  statusMessage: ReturnType<typeof mock>;
} {
  return {
    getCanvasMode: () => "design",
    openBrowseModal: mock(() => {}),
    openNewProjectModal: mock(() => {}),
    openQuickSearchPalette: mock(() => {}),
    openSettingsModal: mock(() => {}),
    render: mock(() => {}),
    renderActivityBar: mock(() => {}),
    setCanvasMode: mock(() => {}),
    statusMessage: mock(() => {}),
  };
}

beforeEach(() => {
  closeAllTabs();
  delete (globalThis as Record<string, unknown>).__jxAutomation;
  // SetEditZoom runs the real canvas-utils path, which needs the module context initialized.
  initCanvasUtils({
    getCanvasMode: () => "edit",
    getZoom: () => 1,
    setZoomDirect: () => {},
  });
});

describe("shouldInstallAutomation", () => {
  test("true only for automation=1", () => {
    expect(shouldInstallAutomation("?automation=1")).toBe(true);
    expect(shouldInstallAutomation("?project=/x&automation=1")).toBe(true);
    expect(shouldInstallAutomation("")).toBe(false);
    expect(shouldInstallAutomation("?automation=0")).toBe(false);
    expect(shouldInstallAutomation("?project=/x")).toBe(false);
  });
});

describe("installAutomationHook", () => {
  test("does not install without the flag", () => {
    happyDOM.setURL("http://localhost:3000/packages/studio/index.html");
    expect(installAutomationHook(makeDeps())).toBe(false);
    expect((globalThis as Record<string, unknown>).__jxAutomation).toBeUndefined();
  });

  test("installs the api with the flag", () => {
    happyDOM.setURL("http://localhost:3000/packages/studio/index.html?automation=1");
    expect(installAutomationHook(makeDeps())).toBe(true);
    const api = (globalThis as Record<string, unknown>).__jxAutomation;
    expect(api).toBeDefined();
    expect(typeof (api as { getState: unknown }).getState).toBe("function");
  });
});

describe("createAutomationApi", () => {
  test("getState reflects tab, canvas, and view state", () => {
    resetWorkspaceWithTab(undefined, { id: "shot-tab" });
    view.leftTab = "files";
    const api = createAutomationApi(makeDeps());
    const state = api.getState();
    expect(state.activeTabId).toBe("shot-tab");
    expect(state.canvasMode).toBe("design");
    expect(state.canvasStatus).toBe("idle");
    expect(state.leftTab).toBe("files");
  });

  test("getState with no tab reports null canvas status", () => {
    const api = createAutomationApi(makeDeps());
    expect(api.getState().canvasStatus).toBeNull();
    expect(api.getState().activeTabId).toBeNull();
  });

  test("select mutates the active tab selection and rerenders", () => {
    resetWorkspaceWithTab();
    const deps = makeDeps();
    const api = createAutomationApi(deps);
    api.select(["children", 0]);
    expect(activeTab.value?.session.selection).toEqual(["children", 0]);
    api.select(null);
    expect(activeTab.value?.session.selection).toBeNull();
    expect(deps.render).toHaveBeenCalledTimes(2);
  });

  test("select without a tab is a no-op", () => {
    const api = createAutomationApi(makeDeps());
    expect(() => {
      api.select(["children", 0]);
    }).not.toThrow();
  });

  test("setActivity switches the left panel tab and uncollapses", () => {
    const deps = makeDeps();
    const api = createAutomationApi(deps);
    view.leftPanelCollapsed = true;
    api.setActivity("layers");
    expect(view.leftTab).toBe("layers");
    expect(view.leftPanelCollapsed).toBe(false);
    expect(deps.renderActivityBar).toHaveBeenCalledTimes(1);
  });

  test("setCanvasMode delegates to studio and rerenders", () => {
    const deps = makeDeps();
    const api = createAutomationApi(deps);
    api.setCanvasMode("preview");
    expect(deps.setCanvasMode).toHaveBeenCalledWith("preview");
    expect(deps.render).toHaveBeenCalledTimes(1);
  });

  test("setRightTab, setZoom, and editFunction mutate session ui", () => {
    resetWorkspaceWithTab();
    const api = createAutomationApi(makeDeps());
    api.setRightTab("style");
    api.setZoom(1.5);
    api.editFunction(["children", 1], "onclick");
    const ui = activeTab.value?.session.ui as unknown as Record<string, unknown>;
    expect(ui.rightTab).toBe("style");
    expect(ui.zoom).toBe(1.5);
    expect(ui.editingFunction).toEqual({
      eventKey: "onclick",
      path: ["children", 1],
      type: "event",
    });
  });

  test("setEditZoom clamps and persists the edit zoom without re-rendering the canvas", () => {
    resetWorkspaceWithTab();
    const deps = makeDeps();
    const api = createAutomationApi(deps);
    api.setEditZoom(2);
    expect(activeTab.value?.session.ui.editZoom).toBe(2);
    api.setEditZoom(99);
    expect(activeTab.value?.session.ui.editZoom).toBe(3);
    // Live edit zoom must never re-render (it would rebuild the iframe DOM mid-edit).
    expect(deps.render).not.toHaveBeenCalled();
  });

  test('setRightTab("assistant") opens the chat sidebar instead of a right-panel tab', () => {
    resetWorkspaceWithTab();
    const deps = makeDeps();
    const api = createAutomationApi(deps);
    api.setRightTab("style");
    view.chatPanelCollapsed = true;
    api.setRightTab("assistant");
    // The retired tab value maps to the persistent chat sidebar…
    expect(view.chatPanelCollapsed).toBe(false);
    // …and the right panel's own tab selection is untouched.
    const ui = activeTab.value?.session.ui as unknown as Record<string, unknown>;
    expect(ui.rightTab).toBe("style");
    expect(deps.render).toHaveBeenCalled();
  });

  test("editDef targets a named state function", () => {
    resetWorkspaceWithTab();
    const api = createAutomationApi(makeDeps());
    api.editDef("addItem");
    const ui = activeTab.value?.session.ui as unknown as Record<string, unknown>;
    expect(ui.editingFunction).toEqual({ defName: "addItem", type: "def" });
  });

  test("openBrowse delegates to the browse modal opener", () => {
    const deps = makeDeps();
    createAutomationApi(deps).openBrowse();
    expect(deps.openBrowseModal).toHaveBeenCalledTimes(1);
  });

  test("openQuickSearch delegates to the palette opener", () => {
    const deps = makeDeps();
    createAutomationApi(deps).openQuickSearch();
    expect(deps.openQuickSearchPalette).toHaveBeenCalledTimes(1);
  });

  test("openSettings delegates with the optional section", () => {
    const deps = makeDeps();
    const api = createAutomationApi(deps);
    api.openSettings();
    api.openSettings("css-variables");
    expect(deps.openSettingsModal).toHaveBeenCalledTimes(2);
    expect(deps.openSettingsModal.mock.calls).toEqual([[undefined], ["css-variables"]]);
  });

  test("openNewProject delegates to the new-project modal opener", () => {
    const deps = makeDeps();
    createAutomationApi(deps).openNewProject();
    expect(deps.openNewProjectModal).toHaveBeenCalledTimes(1);
  });

  test("setStatus delegates to statusMessage", () => {
    const deps = makeDeps();
    createAutomationApi(deps).setStatus("Ready");
    expect(deps.statusMessage).toHaveBeenCalledWith("Ready");
  });

  test("setTheme flips the sp-theme color attribute", () => {
    const theme = document.createElement("sp-theme");
    theme.setAttribute("color", "dark");
    document.body.append(theme);
    const api = createAutomationApi(makeDeps());
    api.setTheme("light");
    expect(theme.getAttribute("color")).toBe("light");
    theme.remove();
  });

  test("setTheme without an sp-theme element is a no-op", () => {
    const api = createAutomationApi(makeDeps());
    expect(() => {
      api.setTheme("light");
    }).not.toThrow();
  });

  test("waitForCanvasReady resolves once the canvas reports ready", async () => {
    resetWorkspaceWithTab();
    const api = createAutomationApi(makeDeps());
    setTimeout(() => {
      updateCanvas({ status: "ready" });
    }, 60);
    await api.waitForCanvasReady(5000);
    expect(activeTab.value?.session.canvas.status).toBe("ready");
  });

  test("waitForCanvasReady resolves immediately when already ready", async () => {
    resetWorkspaceWithTab();
    updateCanvas({ status: "ready" });
    const api = createAutomationApi(makeDeps());
    await api.waitForCanvasReady(10);
  });

  test("waitForCanvasReady rejects on timeout", async () => {
    resetWorkspaceWithTab();
    const api = createAutomationApi(makeDeps());
    expect(api.waitForCanvasReady(1)).rejects.toThrow("canvas not ready");
  });
});
