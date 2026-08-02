import { flush, renderInto, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TemplateResult } from "lit-html";

const refreshGitStatus = mock(async () => {});
void mock.module("../src/panels/git-panel.js", () => ({
  refreshGitStatus,
}));

const openSettingsModal = mock(() => {});
void mock.module("../src/settings/settings-modal.js", () => ({
  openSettingsModal,
}));

const openAboutModal = mock(() => {});
void mock.module("../src/about/about-modal.js", () => ({
  openAboutModal,
}));

const store = await import("../src/store");
const { initShellRefs } = store;
// `activityBar` is an `export let` populated by initShellRefs — read it via the namespace
// Object so the live binding is preserved.
const bar = () => store.activityBar;
const { mountShell, resetProjectShell, shell, unmountShell } = await import("../src/shell");
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
  shell.leftTab = "layers";
  shell.docks.left.collapsed = false;
  resetProjectShell();
  refreshGitStatus.mockClear();
  openSettingsModal.mockClear();
  openAboutModal.mockClear();
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
    expect(bar().querySelector("sp-action-button[title='About']")).not.toBeNull();
  });

  test("each rail tab is named exactly once", () => {
    renderActivityBar();
    const tabs = [...bar().querySelectorAll("sp-tab")];
    // Title is both the tooltip and (sp-tab keeps its text label hidden) the accessible name.
    expect(tabs.map((t) => t.getAttribute("title"))).toEqual([
      "Files",
      "Layers",
      "Imports",
      "Elements",
      "State",
      "Data",
      "Document",
      "Source Control",
    ]);
    // A duplicate aria-label carrying the same string made every tab announce itself twice.
    expect(tabs.every((t) => !t.hasAttribute("aria-label"))).toBe(true);
  });

  test("selects the current left tab when panel is open", () => {
    shell.leftTab = "files";
    renderActivityBar();
    expect(bar().querySelector("sp-tabs")?.getAttribute("selected")).toBe("files");
  });

  test("selects nothing when left panel is collapsed", () => {
    shell.docks.left.collapsed = true;
    renderActivityBar();
    expect(bar().querySelector("sp-tabs")?.getAttribute("selected")).toBe("");
  });

  test("shows git badge with changed file count", () => {
    shell.git.status = { files: [{}, {}, {}] } as any;
    renderActivityBar();
    const badge = bar().querySelector(".activity-badge");
    expect(badge?.textContent).toBe("3");
  });

  test("omits git badge when there are no changed files", () => {
    shell.git.status = { files: [] } as any;
    renderActivityBar();
    expect(bar().querySelector(".activity-badge")).toBeNull();
  });

  test("the badge survives closing the last tab", () => {
    // Source Control is PROJECT state. Sourcing the badge from `activeTab` is what made it vanish
    // The moment the last document closed, and what would make a level:"project" rail group lie.
    resetWorkspaceWithTab();
    shell.git.status = { files: [{}, {}] } as any;
    renderActivityBar();
    expect(bar().querySelector(".activity-badge")?.textContent).toBe("2");

    closeAllTabs();
    renderActivityBar();
    expect(bar().querySelector(".activity-badge")?.textContent).toBe("2");
  });

  test("change to a different tab opens it", () => {
    // No renderOnly("leftPanel") assertion any more: the panel tracks `shell.leftTab` itself, and
    // A manual repaint beside the state write is exactly what the split removes.
    mountShell();
    shell.leftTab = "layers";
    renderActivityBar();
    const tabsEl = bar().querySelector("sp-tabs") as HTMLElement & { selected: string };
    tabsEl.selected = "files";
    tabsEl.dispatchEvent(new Event("change", { bubbles: true }));

    expect(shell.leftTab).toBe("files");
    expect(shell.docks.left.collapsed).toBe(false);
    expect(document.querySelector("#app")?.classList.contains("left-collapsed")).toBe(false);
    unmountShell();
  });

  test("change to the already-open tab collapses the panel", () => {
    mountShell();
    shell.leftTab = "files";
    shell.docks.left.collapsed = false;
    renderActivityBar();
    const tabsEl = bar().querySelector("sp-tabs") as HTMLElement & { selected: string };
    tabsEl.selected = "files";
    tabsEl.dispatchEvent(new Event("change", { bubbles: true }));

    expect(shell.docks.left.collapsed).toBe(true);
    expect(document.querySelector("#app")?.classList.contains("left-collapsed")).toBe(true);
    unmountShell();
  });

  test("change to current tab while collapsed re-opens it", () => {
    shell.leftTab = "files";
    shell.docks.left.collapsed = true;
    renderActivityBar();
    const tabsEl = bar().querySelector("sp-tabs") as HTMLElement & { selected: string };
    tabsEl.selected = "files";
    tabsEl.dispatchEvent(new Event("change", { bubbles: true }));

    expect(shell.docks.left.collapsed).toBe(false);
    expect(shell.leftTab).toBe("files");
  });

  test("settings button opens the settings modal", () => {
    renderActivityBar();
    const btn = bar().querySelector("sp-action-button[title='Settings']") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openSettingsModal).toHaveBeenCalledTimes(1);
  });

  test("about button opens the about modal", () => {
    renderActivityBar();
    const btn = bar().querySelector("sp-action-button[title='About']") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openAboutModal).toHaveBeenCalledTimes(1);
  });
});

// ─── mount / unmount ──────────────────────────────────────────────────────────

describe("mount", () => {
  test("renders immediately and requests git status once", async () => {
    resetWorkspaceWithTab();
    expect(shell.git.status).toBeNull();
    mount();
    await flush();
    expect(refreshGitStatus).toHaveBeenCalled();
    expect(bar().querySelector("sp-tabs")).not.toBeNull();
  });

  test("does not refresh git status while loading or already loaded", async () => {
    shell.git.loading = true;
    mount();
    await flush();
    expect(refreshGitStatus).not.toHaveBeenCalled();

    // Set status first — effects trigger synchronously, so clearing the loading flag while
    // Status is still null would legitimately re-probe.
    shell.git.status = { files: [] } as any;
    shell.git.loading = false;
    await flush();
    expect(refreshGitStatus).not.toHaveBeenCalled();
  });

  test("re-renders the badge when git status changes", async () => {
    shell.git.status = { files: [] } as any;
    mount();
    await flush();
    expect(bar().querySelector(".activity-badge")).toBeNull();

    shell.git.status = { files: [{}] } as any;
    await flush();
    expect(bar().querySelector(".activity-badge")?.textContent).toBe("1");
  });

  test("probes for status with no tab open — the panel level is project, not document", async () => {
    closeAllTabs();
    mount();
    await flush();
    expect(refreshGitStatus).toHaveBeenCalled();
    expect(bar().querySelector("sp-tabs")).not.toBeNull();
  });

  test("unmount stops reactive updates", async () => {
    shell.git.status = { files: [] } as any;
    mount();
    await flush();
    unmount();

    shell.git.status = { files: [{}, {}] } as any;
    await flush();
    expect(bar().querySelector(".activity-badge")).toBeNull();
  });
});
