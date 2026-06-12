import { flush, renderInto, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TemplateResult } from "lit-html";

const refreshGitStatus = mock(async () => {});
mock.module("../src/panels/git-panel.js", () => ({
  refreshGitStatus,
}));

const openSettingsModal = mock(() => {});
mock.module("../src/settings/settings-modal.js", () => ({
  openSettingsModal,
}));

const store = await import("../src/store");
const { initShellRefs, registerRenderer } = store;
// `activityBar` is an `export let` populated by initShellRefs — read it via the namespace
// Object so the live binding is preserved.
const bar = () => store.activityBar;
const { view } = await import("../src/view");
const { closeAllTabs } = await import("../src/workspace/workspace");
const { mount, renderActivityBar, tabIcon, unmount } = await import("../src/panels/activity-bar");

beforeAll(() => {
  const app = document.createElement("div");
  app.id = "app";
  const barEl = document.createElement("div");
  barEl.id = "activity-bar";
  app.append(barEl);
  document.body.append(app);
  initShellRefs();
});

beforeEach(() => {
  closeAllTabs();
  view.leftTab = "layers";
  view.leftPanelCollapsed = false;
  refreshGitStatus.mockClear();
  openSettingsModal.mockClear();
  // Note: never wipe bar().innerHTML — lit owns the container and caches its parts.
  document.querySelector("#app")?.classList.remove("left-collapsed", "right-collapsed");
});

afterEach(() => {
  unmount();
});

// ─── tabIcon ──────────────────────────────────────────────────────────────────

describe("tabIcon", () => {
  test("returns a renderable template for known sp icons", async () => {
    const container = await renderInto(tabIcon("sp-icon-folder", "m") as TemplateResult);
    const icon = container.querySelector("sp-icon-folder");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("size")).toBe("m");
    expect(icon?.getAttribute("slot")).toBe("icon");
  });

  test("defaults the size to s", async () => {
    const container = await renderInto(tabIcon("sp-icon-layers") as TemplateResult);
    expect(container.querySelector("sp-icon-layers")?.getAttribute("size")).toBe("s");
  });

  test("git branch icon is an inline svg sized by the size flag", async () => {
    const medium = await renderInto(tabIcon("sp-icon-git-branch", "m") as TemplateResult);
    expect(medium.querySelector("svg")?.getAttribute("width")).toBe("20");
    const small = await renderInto(tabIcon("sp-icon-git-branch", "s") as TemplateResult);
    expect(small.querySelector("svg")?.getAttribute("width")).toBe("16");
  });

  test("every mapped icon tag renders its element", async () => {
    for (const tag of [
      "sp-icon-artboard",
      "sp-icon-box",
      "sp-icon-brackets",
      "sp-icon-brush",
      "sp-icon-chat",
      "sp-icon-data",
      "sp-icon-event",
      "sp-icon-file-single-web-page",
      "sp-icon-folder",
      "sp-icon-layers",
      "sp-icon-properties",
      "sp-icon-view-all-tags",
      "sp-icon-view-grid",
    ]) {
      const container = await renderInto(tabIcon(tag, "s") as TemplateResult);
      expect(container.querySelector(tag)).not.toBeNull();
    }
  });

  test("unknown tag renders nothing", async () => {
    const container = await renderInto(tabIcon("sp-icon-bogus") as TemplateResult);
    expect(container.children.length).toBe(0);
  });
});

// ─── renderActivityBar ────────────────────────────────────────────────────────

describe("renderActivityBar", () => {
  test("renders all eight panel tabs plus settings button", () => {
    renderActivityBar();
    const tabs = [...bar().querySelectorAll("sp-tab")];
    expect(tabs.map((t) => t.getAttribute("value"))).toEqual([
      "files",
      "layers",
      "imports",
      "blocks",
      "state",
      "data",
      "head",
      "git",
    ]);
    expect(bar().querySelector("sp-action-button[title='Settings']")).not.toBeNull();
  });

  test("selects the current left tab when panel is open", () => {
    view.leftTab = "files";
    renderActivityBar();
    expect(bar().querySelector("sp-tabs")?.getAttribute("selected")).toBe("files");
  });

  test("selects nothing when left panel is collapsed", () => {
    view.leftPanelCollapsed = true;
    renderActivityBar();
    expect(bar().querySelector("sp-tabs")?.getAttribute("selected")).toBe("");
  });

  test("shows git badge with changed file count", () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.gitStatus = { files: [{}, {}, {}] } as any;
    renderActivityBar();
    const badge = bar().querySelector(".activity-badge");
    expect(badge?.textContent).toBe("3");
  });

  test("omits git badge when there are no changed files", () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.gitStatus = { files: [] } as any;
    renderActivityBar();
    expect(bar().querySelector(".activity-badge")).toBeNull();
  });

  test("change to a different tab opens it and re-renders the left panel", () => {
    const leftPanelRenderer = mock(() => {});
    registerRenderer("leftPanel", leftPanelRenderer);
    view.leftTab = "layers";
    renderActivityBar();
    const tabsEl = bar().querySelector("sp-tabs") as HTMLElement & { selected: string };
    tabsEl.selected = "files";
    tabsEl.dispatchEvent(new Event("change", { bubbles: true }));

    expect(view.leftTab).toBe("files");
    expect(view.leftPanelCollapsed).toBe(false);
    expect(leftPanelRenderer).toHaveBeenCalled();
    expect(document.querySelector("#app")?.classList.contains("left-collapsed")).toBe(false);
  });

  test("change to the already-open tab collapses the panel", () => {
    view.leftTab = "files";
    view.leftPanelCollapsed = false;
    renderActivityBar();
    const tabsEl = bar().querySelector("sp-tabs") as HTMLElement & { selected: string };
    tabsEl.selected = "files";
    tabsEl.dispatchEvent(new Event("change", { bubbles: true }));

    expect(view.leftPanelCollapsed).toBe(true);
    expect(document.querySelector("#app")?.classList.contains("left-collapsed")).toBe(true);
  });

  test("change to current tab while collapsed re-opens it", () => {
    view.leftTab = "files";
    view.leftPanelCollapsed = true;
    renderActivityBar();
    const tabsEl = bar().querySelector("sp-tabs") as HTMLElement & { selected: string };
    tabsEl.selected = "files";
    tabsEl.dispatchEvent(new Event("change", { bubbles: true }));

    expect(view.leftPanelCollapsed).toBe(false);
    expect(view.leftTab).toBe("files");
  });

  test("settings button opens the settings modal", () => {
    renderActivityBar();
    const btn = bar().querySelector("sp-action-button[title='Settings']") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openSettingsModal).toHaveBeenCalledTimes(1);
  });
});

// ─── mount / unmount ──────────────────────────────────────────────────────────

describe("mount", () => {
  test("renders immediately and requests git status for a fresh tab", async () => {
    const tab = resetWorkspaceWithTab();
    expect(tab.session.ui.gitStatus).toBeNull();
    mount();
    await flush();
    expect(refreshGitStatus).toHaveBeenCalled();
    expect(bar().querySelector("sp-tabs")).not.toBeNull();
  });

  test("does not refresh git status while loading or already loaded", async () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.gitLoading = true;
    mount();
    await flush();
    expect(refreshGitStatus).not.toHaveBeenCalled();

    // Set status first — effects trigger synchronously, so clearing the loading flag while
    // Status is still null would legitimately re-probe.
    tab.session.ui.gitStatus = { files: [] } as any;
    tab.session.ui.gitLoading = false;
    await flush();
    expect(refreshGitStatus).not.toHaveBeenCalled();
  });

  test("re-renders the badge when git status changes", async () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.gitStatus = { files: [] } as any;
    mount();
    await flush();
    expect(bar().querySelector(".activity-badge")).toBeNull();

    tab.session.ui.gitStatus = { files: [{}] } as any;
    await flush();
    expect(bar().querySelector(".activity-badge")?.textContent).toBe("1");
  });

  test("renders without a tab (no git probe)", async () => {
    closeAllTabs();
    mount();
    await flush();
    expect(refreshGitStatus).not.toHaveBeenCalled();
    expect(bar().querySelector("sp-tabs")).not.toBeNull();
  });

  test("unmount stops reactive updates", async () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.gitStatus = { files: [] } as any;
    mount();
    await flush();
    unmount();

    tab.session.ui.gitStatus = { files: [{}, {}] } as any;
    await flush();
    expect(bar().querySelector(".activity-badge")).toBeNull();
  });
});
