import { flush, installMockPlatform } from "./harness";
import type { MockPlatformState } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Tab } from "../src/tabs/tab";

// ─── Module mocks (must precede the toolbar import) ───────────────────────────

const openQuickSearch = mock(() => {});
void mock.module("../src/panels/quick-search.js", () => ({
  openQuickSearch,
}));

const refreshGitStatus = mock(async () => {});
void mock.module("../src/panels/git-panel.js", () => ({
  refreshGitStatus,
}));

const openBrowseModal = mock(() => {});
void mock.module("../src/browse/browse-modal.js", () => ({
  openBrowseModal,
}));

let newProjectResult: { root: string } | null = null;
const openNewProjectModal = mock(async () => newProjectResult);
void mock.module("../src/new-project/new-project-modal.js", () => ({
  openNewProjectModal,
}));

const toolbar = await import("../src/panels/toolbar");
const { view } = await import("../src/view");
const { closeAllTabs, openTab } = await import("../src/workspace/workspace");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type ToolbarCtx = Parameters<typeof toolbar.mount>[1];

function makeCtx(overrides: Partial<ToolbarCtx> = {}): ToolbarCtx {
  return {
    closeFunctionEditor: mock(() => {}),
    getCanvasMode: mock(() => "edit"),
    openProject: mock(() => {}),
    openRecentProject: mock(async (_root: string) => {}),
    renderCanvas: mock(() => {}),
    safeRenderRightPanel: mock(() => {}),
    saveFile: mock(() => {}),
    setCanvasMode: mock((_mode: string) => {}),
    ...overrides,
  } as ToolbarCtx;
}

const ALL_MODES = ["edit", "design", "preview", "source", "stylebook"];

function openTestTab(modes: string[] = ALL_MODES): Tab {
  closeAllTabs();
  return openTab({
    capabilities: { modes },
    document: { children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" },
    documentPath: "/project/index.json",
    id: "toolbar-tab",
  });
}

/** Find the first sp-action-button whose text content includes the given label. */
function btn(root: HTMLElement, label: string): HTMLElement {
  const match = [...root.querySelectorAll("sp-action-button")].find((b) =>
    (b.textContent || "").includes(label),
  );
  if (!match) {
    throw new Error(`no button labeled ${label}`);
  }
  return match as HTMLElement;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

let root: HTMLElement;
let platformState: MockPlatformState;

beforeEach(() => {
  closeAllTabs();
  localStorage.clear();
  view.rightPanelCollapsed = false;
  view.panX = 0;
  view.panY = 0;
  view.functionEditor = null;
  newProjectResult = null;
  openQuickSearch.mockClear();
  refreshGitStatus.mockClear();
  openBrowseModal.mockClear();
  openNewProjectModal.mockClear();
  ({ state: platformState } = installMockPlatform());
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  toolbar.unmount();
  root.remove();
  delete (globalThis as any).__jxPlatform;
});

// ─── Minimal toolbar (no tab) ─────────────────────────────────────────────────

describe("minimal toolbar (no open tab)", () => {
  test("renders Open Project, disabled file ops, and disabled modes", async () => {
    toolbar.mount(root, makeCtx());
    await flush();

    expect(root.textContent).toContain("Open Project");
    expect(btn(root, "Save").hasAttribute("disabled")).toBe(true);
    expect(btn(root, "Undo").hasAttribute("disabled")).toBe(true);
    expect(btn(root, "Redo").hasAttribute("disabled")).toBe(true);
    for (const label of ["Edit", "Design", "Code", "Stylebook"]) {
      expect(btn(root, label).hasAttribute("disabled")).toBe(true);
    }
    // Preview is a tab-bar toggle now, not a switchable mode.
    expect(root.textContent).not.toContain("Preview");
    expect(btn(root, "Design").hasAttribute("selected")).toBe(true);
    expect(btn(root, "Edit").hasAttribute("selected")).toBe(false);
  });

  test("Open Project invokes ctx.openProject", async () => {
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();
    click(root.querySelector(".tb-split-main")!);
    expect(ctx.openProject).toHaveBeenCalledTimes(1);
  });

  test("Manage opens the browse modal", async () => {
    toolbar.mount(root, makeCtx());
    await flush();
    click(btn(root, "Manage"));
    expect(openBrowseModal).toHaveBeenCalledTimes(1);
  });

  test("search trigger opens quick search", async () => {
    toolbar.mount(root, makeCtx());
    await flush();
    click(root.querySelector(".tb-search-trigger")!);
    expect(openQuickSearch).toHaveBeenCalledTimes(1);
  });

  test("recent projects menu lists stored projects and opens one on change", async () => {
    localStorage.setItem(
      "jx-studio-recent-projects",
      JSON.stringify([
        { name: "Proj A", root: "/a", timestamp: 2 },
        { name: "Proj B", root: "/b", timestamp: 1 },
      ]),
    );
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();

    const items = [...root.querySelectorAll("sp-menu-item")];
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      "New Project…",
      "Proj A",
      "Proj B",
      "Clear recent projects",
    ]);

    const menu = root.querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "/b";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ctx.openRecentProject).toHaveBeenCalledWith("/b");
  });

  test("a recent project's remove button drops just that entry", async () => {
    localStorage.setItem(
      "jx-studio-recent-projects",
      JSON.stringify([
        { name: "Proj A", root: "/a", timestamp: 2 },
        { name: "Proj B", root: "/b", timestamp: 1 },
      ]),
    );
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();

    const removeBtns = [...root.querySelectorAll("sp-action-button[title='Remove from recent']")];
    expect(removeBtns).toHaveLength(2);
    click(removeBtns[0]!); // Proj A is newest-first
    await flush();
    expect(ctx.openRecentProject).not.toHaveBeenCalled();
    const names = [...root.querySelectorAll("sp-menu-item")].map((i) => i.textContent?.trim());
    expect(names).toEqual(["New Project…", "Proj B", "Clear recent projects"]);
  });

  test("Clear recent projects empties the list", async () => {
    localStorage.setItem(
      "jx-studio-recent-projects",
      JSON.stringify([{ name: "Proj A", root: "/a", timestamp: 1 }]),
    );
    toolbar.mount(root, makeCtx());
    await flush();

    const menu = root.querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "__clear__";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const items = [...root.querySelectorAll("sp-menu-item")];
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent?.trim()).toBe("New Project…");
  });

  test("menu without stored projects only offers New Project", async () => {
    toolbar.mount(root, makeCtx());
    await flush();
    const items = [...root.querySelectorAll("sp-menu-item")];
    expect(items).toHaveLength(1);
    expect(root.querySelector("sp-menu-divider")).toBeNull();
  });

  test("New Project menu entry opens modal and loads the created project", async () => {
    newProjectResult = { root: "/created" };
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();

    const menu = root.querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "__new__";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(openNewProjectModal).toHaveBeenCalledTimes(1);
    expect(ctx.openRecentProject).toHaveBeenCalledWith("/created");
  });

  test("cancelled New Project modal does not open anything", async () => {
    newProjectResult = null;
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();

    const menu = root.querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "__new__";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(openNewProjectModal).toHaveBeenCalledTimes(1);
    expect(ctx.openRecentProject).not.toHaveBeenCalled();
  });

  test("right panel toggle flips collapse state and icon", async () => {
    toolbar.mount(root, makeCtx());
    await flush();

    expect(root.querySelector("sp-icon-rail-right-close")).not.toBeNull();
    click(root.querySelector("sp-action-button[title='Toggle Right Panel']")!);
    await flush();
    expect(view.rightPanelCollapsed).toBe(true);
    expect(root.querySelector("sp-icon-rail-right-open")).not.toBeNull();

    click(root.querySelector("sp-action-button[title='Toggle Right Panel']")!);
    await flush();
    expect(view.rightPanelCollapsed).toBe(false);
  });

  test("window controls render and dispatch when the platform provides them", async () => {
    const controls = { close: mock(() => {}), maximize: mock(() => {}), minimize: mock(() => {}) };
    (globalThis as any).__jxPlatform = { windowControls: controls };
    toolbar.mount(root, makeCtx());
    await flush();

    expect(root.classList.contains("electrobun-webkit-app-region-drag")).toBe(true);
    const group = root.querySelector(".window-controls")!;
    click(group.querySelector("sp-action-button[title='Minimize']")!);
    click(group.querySelector("sp-action-button[title='Maximize']")!);
    click(group.querySelector("sp-action-button[title='Close']")!);
    expect(controls.minimize).toHaveBeenCalledTimes(1);
    expect(controls.maximize).toHaveBeenCalledTimes(1);
    expect(controls.close).toHaveBeenCalledTimes(1);
  });

  test("no window controls group without a desktop platform", async () => {
    toolbar.mount(root, makeCtx());
    await flush();
    expect(root.querySelector(".window-controls")).toBeNull();
    expect(root.classList.contains("electrobun-webkit-app-region-drag")).toBe(false);
  });
});

// ─── Full toolbar (active tab) ────────────────────────────────────────────────

describe("full toolbar (active tab)", () => {
  test("Save enables when the document is dirty and calls ctx.saveFile", async () => {
    const tab = openTestTab();
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();
    expect(btn(root, "Save").hasAttribute("disabled")).toBe(true);

    tab.doc.dirty = true;
    await flush();
    const save = btn(root, "Save");
    expect(save.hasAttribute("disabled")).toBe(false);
    click(save);
    expect(ctx.saveFile).toHaveBeenCalledTimes(1);
  });

  test("Undo/Redo follow history position and drive the transact pipeline", async () => {
    const tab = openTestTab();
    toolbar.mount(root, makeCtx());
    await flush();
    expect(btn(root, "Undo").hasAttribute("disabled")).toBe(true);
    expect(btn(root, "Redo").hasAttribute("disabled")).toBe(true);

    tab.history.snapshots.push({
      document: { children: [], tagName: "div" },
      selection: null,
    });
    tab.history.index = 1;
    await flush();
    expect(btn(root, "Undo").hasAttribute("disabled")).toBe(false);
    expect(btn(root, "Redo").hasAttribute("disabled")).toBe(true);

    click(btn(root, "Undo"));
    await flush();
    expect(tab.history.index).toBe(0);
    expect(btn(root, "Undo").hasAttribute("disabled")).toBe(true);
    expect(btn(root, "Redo").hasAttribute("disabled")).toBe(false);

    click(btn(root, "Redo"));
    await flush();
    expect(tab.history.index).toBe(1);
    expect(tab.doc.document).toEqual({ children: [], tagName: "div" });
  });

  test("mode switcher selects the current canvas mode and switches modes", async () => {
    const tab = openTestTab();
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();

    expect(btn(root, "Edit").hasAttribute("selected")).toBe(true);
    expect(btn(root, "Design").hasAttribute("disabled")).toBe(false);

    view.panX = 50;
    view.panY = 60;
    click(btn(root, "Design"));
    expect(ctx.setCanvasMode).toHaveBeenCalledWith("design");
    expect(ctx.renderCanvas).toHaveBeenCalledTimes(1);
    expect(ctx.safeRenderRightPanel).toHaveBeenCalledTimes(1);
    expect(view.panX).toBe(0);
    expect(view.panY).toBe(0);
    expect(tab.session.ui.editingFunction).toBeNull();
  });

  test("switcher has no Preview button and keeps the base mode highlighted while previewing", async () => {
    const tab = openTestTab();
    toolbar.mount(root, makeCtx());
    tab.session.ui.canvasMode = "design";
    tab.session.ui.preview = true;
    await flush();

    expect(root.textContent).not.toContain("Preview");
    expect(btn(root, "Design").hasAttribute("selected")).toBe(true);
    expect(btn(root, "Edit").hasAttribute("selected")).toBe(false);
  });

  test("clicking the current mode is a no-op", async () => {
    openTestTab();
    const ctx = makeCtx({ getCanvasMode: mock(() => "edit") });
    toolbar.mount(root, ctx);
    await flush();
    click(btn(root, "Edit"));
    expect(ctx.setCanvasMode).not.toHaveBeenCalled();
    expect(ctx.renderCanvas).not.toHaveBeenCalled();
  });

  test("disallowed modes are disabled and ignore clicks", async () => {
    openTestTab(["edit", "source"]);
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();

    const design = btn(root, "Design");
    expect(design.hasAttribute("disabled")).toBe(true);
    expect(btn(root, "Code").hasAttribute("disabled")).toBe(false);
    click(design);
    expect(ctx.setCanvasMode).not.toHaveBeenCalled();
  });

  test("switching to stylebook also activates the style right tab", async () => {
    const tab = openTestTab();
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();
    tab.session.ui.rightTab = "properties";

    click(btn(root, "Stylebook"));
    expect(ctx.setCanvasMode).toHaveBeenCalledWith("stylebook");
    expect(tab.session.ui.rightTab).toBe("style");
  });

  test("switching modes disposes an open function editor", async () => {
    const tab = openTestTab();
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();

    const dispose = mock(() => {});
    tab.session.ui.editingFunction = { name: "onClick" } as any;
    view.functionEditor = { dispose } as any;
    await flush();

    click(btn(root, "Design"));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(view.functionEditor).toBeNull();
    expect(tab.session.ui.editingFunction).toBeNull();
  });

  test("recent projects menu also works with a tab open", async () => {
    localStorage.setItem(
      "jx-studio-recent-projects",
      JSON.stringify([{ name: "Proj A", root: "/a", timestamp: 1 }]),
    );
    openTestTab();
    const ctx = makeCtx();
    toolbar.mount(root, ctx);
    await flush();

    const menu = root.querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "/a";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ctx.openRecentProject).toHaveBeenCalledWith("/a");

    newProjectResult = { root: "/fresh" };
    menu.value = "__new__";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(openNewProjectModal).toHaveBeenCalledTimes(1);
    expect(ctx.openRecentProject).toHaveBeenCalledWith("/fresh");
  });

  test("right panel toggle also works with a tab open", async () => {
    openTestTab();
    toolbar.mount(root, makeCtx());
    await flush();

    expect(root.querySelector("sp-icon-rail-right-close")).not.toBeNull();
    click(root.querySelector("sp-action-button[title='Toggle Right Panel']")!);
    await flush();
    expect(view.rightPanelCollapsed).toBe(true);
    expect(root.querySelector("sp-icon-rail-right-open")).not.toBeNull();
  });

  test("Sync Project appears when behind upstream and pulls then refreshes", async () => {
    const tab = openTestTab();
    toolbar.mount(root, makeCtx());
    await flush();
    expect(root.textContent).not.toContain("Sync Project");

    tab.session.ui.gitStatus = { behind: 2 } as any;
    await flush();
    const sync = btn(root, "Sync Project");
    click(sync);
    await flush();
    expect(platformState.calls.some(([name]) => name === "gitPull")).toBe(true);
    expect(refreshGitStatus).toHaveBeenCalledTimes(1);
  });

  test("no Sync Project when up to date", async () => {
    const tab = openTestTab();
    tab.session.ui.gitStatus = { behind: 0 } as any;
    toolbar.mount(root, makeCtx());
    await flush();
    expect(root.textContent).not.toContain("Sync Project");
  });

  test("window controls render in non-mac order with a tab open", async () => {
    const controls = { close: mock(() => {}), maximize: mock(() => {}), minimize: mock(() => {}) };
    (globalThis as any).__jxPlatform = { windowControls: controls };
    openTestTab();
    toolbar.mount(root, makeCtx());
    await flush();

    const group = root.querySelector(".window-controls")!;
    expect(group.classList.contains("mac")).toBe(false);
    const buttons = [...group.querySelectorAll("sp-action-button")];
    expect(buttons.map((b) => b.getAttribute("title"))).toEqual(["Minimize", "Maximize", "Close"]);
    click(buttons[2]!);
    expect(controls.close).toHaveBeenCalledTimes(1);
    // Non-mac CSD renders at the end of the toolbar.
    expect(root.lastElementChild?.classList.contains("window-controls")).toBe(true);
  });

  test("mac platforms put window controls first with close leading", async () => {
    toolbar.setMacPlatformForTests(true);
    try {
      const controls = {
        close: mock(() => {}),
        maximize: mock(() => {}),
        minimize: mock(() => {}),
      };
      (globalThis as any).__jxPlatform = { windowControls: controls };
      openTestTab();
      toolbar.mount(root, makeCtx());
      await flush();

      const group = root.querySelector(".window-controls")!;
      expect(group.classList.contains("mac")).toBe(true);
      const buttons = [...group.querySelectorAll("sp-action-button")];
      expect(buttons.map((b) => b.getAttribute("title"))).toEqual([
        "Close",
        "Minimize",
        "Maximize",
      ]);
      click(buttons[0]!);
      expect(controls.close).toHaveBeenCalledTimes(1);
      click(buttons[1]!);
      expect(controls.minimize).toHaveBeenCalledTimes(1);
      click(buttons[2]!);
      expect(controls.maximize).toHaveBeenCalledTimes(1);
      // Mac CSD renders at the START of the toolbar.
      expect(root.firstElementChild?.classList.contains("window-controls")).toBe(true);
    } finally {
      toolbar.setMacPlatformForTests(null);
    }
  });
});

// ─── Lifecycle and error handling ─────────────────────────────────────────────

describe("lifecycle", () => {
  test("render is a no-op before mount and after unmount", () => {
    toolbar.unmount();
    expect(() => {
      toolbar.render();
    }).not.toThrow();
  });

  test("unmount stops the reactive effect", async () => {
    const tab = openTestTab();
    toolbar.mount(root, makeCtx());
    await flush();
    expect(btn(root, "Save").hasAttribute("disabled")).toBe(true);

    toolbar.unmount();
    tab.doc.dirty = true;
    await flush();
    // Stale DOM is left in place but no longer updates.
    expect(btn(root, "Save").hasAttribute("disabled")).toBe(true);
  });

  test("template errors are caught and logged, not thrown", async () => {
    const tab = openTestTab();
    // Poison the tab capabilities (read only inside the template, not the mount effect) so the
    // AllowedModes read throws during render.
    (tab as unknown as { capabilities: unknown }).capabilities = null;
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const ctx = makeCtx();
      expect(() => {
        toolbar.mount(root, ctx);
      }).not.toThrow();
      await flush();
      expect(errors.some(([first]) => first === "toolbar render error:")).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
