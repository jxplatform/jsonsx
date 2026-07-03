/**
 * Tab-bar panel tests. The tab bar is the standardized per-tab contextual action bar that sits
 * between the tab strip and the edit content. It owns Back/breadcrumb navigation (component stack
 * and function editor), media feature toggles, and the Code-mode Export action — and collapses to
 * nothing when there is no context to show. These cases were relocated here from the toolbar,
 * editors, and canvas-render suites when the bar was unified.
 */
import {
  flush,
  installMockPlatform,
  pointer,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Tab } from "../src/tabs/tab";

const tabBar = await import("../src/panels/tab-bar");
const { closeAllTabs } = await import("../src/workspace/workspace");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type TabBarCtx = Parameters<typeof tabBar.mount>[1];

function makeCtx(overrides: Partial<TabBarCtx> = {}): TabBarCtx {
  return {
    closeFunctionEditor: mock(() => {}),
    exportFile: mock(() => {}),
    getCanvasMode: mock(() => "edit"),
    navigateBack: mock(() => {}),
    navigateToLevel: mock((_level: number) => {}),
    parseMediaEntries: mock(() => ({
      baseWidth: 1200,
      featureQueries: [] as { name: string; query: string }[],
      sizeBreakpoints: [],
    })),
    ...overrides,
  } as TabBarCtx;
}

function openTestTab(): Tab {
  return resetWorkspaceWithTab(
    { children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" },
    { documentPath: "/project/index.json", id: "tab-bar-tab" },
  );
}

/** Find the first sp-action-button whose text content includes the given label. */
function btn(root: HTMLElement, label: string): HTMLElement {
  const match = [...root.querySelectorAll("sp-action-button")].find((b) =>
    (b.textContent || "").includes(label),
  );
  if (!match) {
    throw new Error(`No button with label "${label}"`);
  }
  return match as HTMLElement;
}

/** True when any button in the bar carries the given label. */
function hasBtn(root: HTMLElement, label: string): boolean {
  return [...root.querySelectorAll("sp-action-button")].some((b) =>
    (b.textContent || "").includes(label),
  );
}

let root: HTMLElement;

beforeEach(() => {
  closeAllTabs();
  resetStudioState();
  installMockPlatform();
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  tabBar.unmount();
  root.remove();
});

// ─── Persistence ──────────────────────────────────────────────────────────────

describe("persistence", () => {
  test("renders the settings bar (with the Preview toggle) for any active editor tab", async () => {
    openTestTab();
    tabBar.mount(root, makeCtx());
    await flush();
    expect(root.querySelector(".tab-bar")).not.toBeNull();
    expect(hasBtn(root, "Preview")).toBe(true);
  });

  test("renders nothing when there is no active tab", async () => {
    tabBar.mount(root, makeCtx());
    await flush();
    expect(root.querySelector(".tab-bar")).toBeNull();
  });
});

// ─── View settings cluster ───────────────────────────────────────────────────

describe("view settings", () => {
  test("Preview toggle flips tab.session.ui.preview and reflects selection", async () => {
    const tab = openTestTab();
    tabBar.mount(root, makeCtx());
    await flush();

    const preview = btn(root, "Preview");
    expect(preview.hasAttribute("selected")).toBe(false);
    pointer(preview, "click");
    await flush();
    expect(tab.session.ui.preview).toBe(true);
    expect(btn(root, "Preview").hasAttribute("selected")).toBe(true);

    pointer(btn(root, "Preview"), "click");
    await flush();
    expect(tab.session.ui.preview).toBe(false);
  });

  test("settings cluster is hidden outside the edit/design base modes", async () => {
    const tab = openTestTab();
    tabBar.mount(root, makeCtx());
    tab.session.ui.canvasMode = "source";
    await flush();
    expect(hasBtn(root, "Preview")).toBe(false);
  });

  test("settings cluster is hidden while the function editor is open", async () => {
    const tab = openTestTab();
    tabBar.mount(root, makeCtx());
    tab.session.ui.editingFunction = { defName: "greet", type: "def" };
    await flush();
    expect(hasBtn(root, "Preview")).toBe(false);
  });

  test("Preview toggle is hidden when the tab's modes do not include preview", async () => {
    const tab = openTestTab();
    tab.capabilities.modes = ["edit", "source"];
    tabBar.mount(root, makeCtx());
    await flush();
    expect(hasBtn(root, "Preview")).toBe(false);
  });

  test("Layout toggle shows only for a site page with an effective layout and flips showLayout", async () => {
    resetStudioState({ isSiteProject: true });
    const tab = resetWorkspaceWithTab(
      { $layout: "./layouts/base.json", children: [], tagName: "div" } as any,
      { documentPath: "pages/about.json", id: "layout-tab" },
    );
    tabBar.mount(root, makeCtx());
    await flush();

    const layout = btn(root, "Layout");
    expect(layout.hasAttribute("selected")).toBe(true);
    pointer(layout, "click");
    await flush();
    expect(tab.session.ui.showLayout).toBe(false);
    expect(btn(root, "Layout").hasAttribute("selected")).toBe(false);

    pointer(btn(root, "Layout"), "click");
    await flush();
    expect(tab.session.ui.showLayout).toBe(true);
  });

  test("no Layout toggle for a non-page document or a page without a layout", async () => {
    resetStudioState({ isSiteProject: true });
    resetWorkspaceWithTab({ children: [], tagName: "div" }, { documentPath: "pages/plain.json" });
    tabBar.mount(root, makeCtx());
    await flush();
    expect(hasBtn(root, "Layout")).toBe(false);
  });
});

// ─── Dynamic route-param pickers ──────────────────────────────────────────────

describe("param pickers", () => {
  test("renders a picker per param, auto-selects the first value, and applies changes", async () => {
    resetStudioState({ isSiteProject: true });
    const tab = resetWorkspaceWithTab(
      {
        $paths: { param: "sku", values: ["alpha", "beta"] },
        children: [],
        tagName: "div",
      } as any,
      { documentPath: "pages/products/[sku].json", id: "param-tab" },
    );
    tabBar.mount(root, makeCtx());
    await flush();

    const picker = root.querySelector("sp-picker.tab-bar-param") as HTMLElement & {
      value: string;
    };
    expect(picker).not.toBeNull();
    const options = [...root.querySelectorAll("sp-menu-item")].map((o) => o.textContent?.trim());
    expect(options).toEqual(["alpha", "beta"]);
    // First candidate auto-selected once values load.
    expect(tab.session.ui.previewParams).toEqual({ sku: "alpha" });

    picker.value = "beta";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(tab.session.ui.previewParams).toEqual({ sku: "beta" });
  });

  test("no pickers for a page without params or a non-page document", async () => {
    resetStudioState({ isSiteProject: true });
    resetWorkspaceWithTab({ children: [], tagName: "div" }, { documentPath: "pages/simple.json" });
    tabBar.mount(root, makeCtx());
    await flush();
    expect(root.querySelector("sp-picker.tab-bar-param")).toBeNull();
  });
});

// ─── Component navigation ───────────────────────────────────────────────────────

describe("component navigation", () => {
  test("shows Back + breadcrumb trail with a document stack and navigates", async () => {
    const tab = openTestTab();
    const ctx = makeCtx();
    tabBar.mount(root, ctx);
    await flush();
    expect(root.querySelector(".breadcrumb")).toBeNull();

    tab.session.documentStack.push({ documentPath: "/project/parent.json" } as any);
    await flush();

    expect(root.querySelector(".tab-bar")).not.toBeNull();
    const clickable = root.querySelector(".breadcrumb-item.clickable")!;
    expect(clickable.textContent).toBe("parent.json");
    expect(root.querySelector(".breadcrumb-item.current")?.textContent).toContain("index.json");

    pointer(btn(root, "Back"), "click");
    expect(ctx.navigateBack).toHaveBeenCalledTimes(1);

    pointer(clickable, "click");
    expect(ctx.navigateToLevel).toHaveBeenCalledWith(0);
  });

  test("breadcrumb frames without a path fall back to 'untitled'", async () => {
    const tab = openTestTab();
    tabBar.mount(root, makeCtx());
    tab.session.documentStack.push({} as any);
    await flush();
    expect(root.querySelector(".breadcrumb-item.clickable")?.textContent).toBe("untitled");
  });
});

// ─── Function editor ────────────────────────────────────────────────────────────

describe("function editor", () => {
  test("shows a Back button + ƒ breadcrumb and closes via ctx.closeFunctionEditor", async () => {
    const tab = openTestTab();
    const ctx = makeCtx();
    tabBar.mount(root, ctx);
    tab.session.ui.editingFunction = { defName: "greet", type: "def" };
    await flush();

    expect(root.querySelector(".breadcrumb-item.current")?.textContent).toBe("ƒ greet");
    pointer(btn(root, "Back"), "click");
    expect(ctx.closeFunctionEditor).toHaveBeenCalledTimes(1);
    expect(ctx.navigateBack).not.toHaveBeenCalled();
  });

  test("uses the event key for the breadcrumb label", async () => {
    const tab = openTestTab();
    tabBar.mount(root, makeCtx());
    tab.session.ui.editingFunction = { eventKey: "onclick", type: "event" };
    await flush();
    expect(root.querySelector(".breadcrumb-item.current")?.textContent).toBe("ƒ onclick");
  });

  test("falls back to the document tagName when the tab has no path", async () => {
    const tab = resetWorkspaceWithTab(
      { children: [], tagName: "section" },
      { documentPath: "", id: "no-path" },
    );
    tabBar.mount(root, makeCtx());
    tab.session.ui.editingFunction = { defName: "greet", type: "def" };
    await flush();
    const crumbs = [...root.querySelectorAll(".breadcrumb-item")].map((el) => el.textContent);
    expect(crumbs[0]).toBe("section");
  });

  test("takes precedence over the document stack and hides Export in source mode", async () => {
    const tab = openTestTab();
    tabBar.mount(root, makeCtx({ getCanvasMode: mock(() => "source") }));
    tab.session.documentStack.push({ documentPath: "/project/parent.json" } as any);
    tab.session.ui.editingFunction = { defName: "greet", type: "def" };
    await flush();

    // The function breadcrumb wins; the stack crumb is not shown, and Export is suppressed.
    expect(root.querySelector(".breadcrumb-item.current")?.textContent).toBe("ƒ greet");
    expect(root.querySelector(".breadcrumb-item.clickable")).toBeNull();
    expect(hasBtn(root, "Export")).toBe(false);
  });
});

// ─── Export (Code mode) ─────────────────────────────────────────────────────────

describe("export", () => {
  test("shows in source mode and invokes ctx.exportFile", async () => {
    openTestTab();
    const ctx = makeCtx({ getCanvasMode: mock(() => "source") });
    tabBar.mount(root, ctx);
    await flush();

    pointer(btn(root, "Export"), "click");
    expect(ctx.exportFile).toHaveBeenCalledTimes(1);
  });

  test("is hidden outside source mode even when the bar is shown", async () => {
    const tab = openTestTab();
    tabBar.mount(root, makeCtx({ getCanvasMode: mock(() => "design") }));
    tab.session.documentStack.push({ documentPath: "/project/parent.json" } as any);
    await flush();
    expect(root.querySelector(".tab-bar")).not.toBeNull();
    expect(hasBtn(root, "Export")).toBe(false);
  });

  test("renders breadcrumbs and Export together in a navigated source-mode tab", async () => {
    const tab = openTestTab();
    tabBar.mount(root, makeCtx({ getCanvasMode: mock(() => "source") }));
    tab.session.documentStack.push({ documentPath: "/project/parent.json" } as any);
    await flush();
    expect(root.querySelector(".breadcrumb")).not.toBeNull();
    expect(hasBtn(root, "Export")).toBe(true);
  });
});

// ─── Media feature toggles ──────────────────────────────────────────────────────

describe("media feature toggles", () => {
  test("render from media queries and flip session toggles", async () => {
    const tab = openTestTab();
    const ctx = makeCtx({
      parseMediaEntries: mock(() => ({
        baseWidth: 1200,
        featureQueries: [{ name: "--dark-mode", query: "(prefers-color-scheme: dark)" }],
        sizeBreakpoints: [],
      })),
    });
    tabBar.mount(root, ctx);
    await flush();

    const toggle = root.querySelector(
      "sp-action-button[title='(prefers-color-scheme: dark)']",
    ) as HTMLElement;
    expect(toggle.textContent).toContain("Dark Mode");
    expect(toggle.hasAttribute("selected")).toBe(false);

    pointer(toggle, "click");
    await flush();
    expect(tab.session.ui.featureToggles["--dark-mode"]).toBe(true);
    expect(
      root
        .querySelector("sp-action-button[title='(prefers-color-scheme: dark)']")
        ?.hasAttribute("selected"),
    ).toBe(true);

    pointer(root.querySelector("sp-action-button[title='(prefers-color-scheme: dark)']")!, "click");
    await flush();
    expect(tab.session.ui.featureToggles["--dark-mode"]).toBe(false);
  });

  test("no media toggle group when the document has no feature queries", async () => {
    openTestTab();
    tabBar.mount(root, makeCtx());
    await flush();
    // Only the settings-cluster Preview toggle remains — no media feature toggles.
    const toggles = [...root.querySelectorAll("sp-action-button[toggles]")];
    expect(toggles.map((b) => b.textContent?.trim())).toEqual(["Preview"]);
  });
});
