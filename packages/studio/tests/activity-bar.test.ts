import { flush, renderInto, resetWorkspaceWithTab } from "./harness";
import { nothing } from "lit-html";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TemplateResult } from "lit-html";

const { registerPanel } = await import("../src/panels/panel-registry");

const refreshGitStatus = mock(async () => {});
// The rail is a rendering of the panel registry, so a mocked git-panel still has to contribute its
// Record — otherwise the Source Control button (and its badge) simply is not there to assert on.
void mock.module("../src/panels/git-panel.js", () => ({
  refreshGitStatus,
  cleanupGitPanel: () => {},
  cloneRepository: () => {},
  renderGitPanel: () => nothing,
  registerGitPanel: () => {
    registerPanel({
      id: "git",
      title: "Source Control",
      level: "project",
      dock: "navigator",
      icon: "sp-icon-git-branch",
      badge: (ctx) => ctx.git.dirtyCount || null,
      render: () => nothing,
    });
  },
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
/** The rail's panel buttons, in rendered order. */
const railIds = () =>
  [...bar().querySelectorAll(".rail-item[data-panel]")].map(
    (el) => (el as HTMLElement).dataset.panel,
  );
const railButton = (id: string) =>
  bar().querySelector(`.rail-item[data-panel="${id}"]`) as HTMLElement | null;
/** A footer button, addressed by its visible label. */
const footerButton = (label: string) =>
  [...bar().querySelectorAll(".rail-footer .rail-item")].find(
    (el) => el.querySelector(".rail-label")?.textContent?.trim() === label,
  ) as HTMLElement | undefined;
const { mountShell, resetProjectShell, shell, unmountShell } = await import("../src/shell");
const { closeAllTabs } = await import("../src/workspace/workspace");
const { registerNavigatorPanels } = await import("../src/panels/navigator-panels");
const { mount, renderActivityBar, tabIcon, unmount } = await import("../src/panels/activity-bar");

beforeAll(() => {
  const app = document.createElement("div");
  app.id = "app";
  const barEl = document.createElement("div");
  barEl.id = "activity-bar";
  app.append(barEl);
  document.body.append(app);
  initShellRefs();
  // The rail draws whatever the registry holds, so the records have to be contributed first.
  // `mount()` does this in the app; the direct-render tests below do it here.
  registerNavigatorPanels();
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
  test("renders the registry's visible panels, grouped by level", () => {
    renderActivityBar();
    expect(railIds()).toEqual(["files", "git", "layers", "page", "data", "packages"]);
    // Elements/Insert left the rail entirely, and State gave up its slot to Data.
    expect(railIds()).not.toContain("insert");
    expect(railIds()).not.toContain("state");
    // Declared-but-unbuilt surfaces are hidden by their own `when`, not faked with a stub button.
    expect(railIds()).not.toContain("search");
    expect(railIds()).not.toContain("problems");
  });

  test("the two groups are named and separated by exactly one divider", () => {
    renderActivityBar();
    const groups = [...bar().querySelectorAll(".rail-group")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Project", "Document"]);
    expect(bar().querySelectorAll(".rail-divider")).toHaveLength(1);
  });

  test("every rail button carries a visible text label, not just a tooltip", () => {
    renderActivityBar();
    const labels = [...bar().querySelectorAll(".rail-item .rail-label")].map((el) =>
      el.textContent?.trim(),
    );
    expect(labels).toEqual([
      "Files",
      "Source Control",
      "Outline",
      "Page",
      "Data",
      "Packages",
      "About",
      "Settings",
    ]);
  });

  test("marks the current left tab pressed when the dock is open", () => {
    shell.leftTab = "files";
    renderActivityBar();
    expect(railButton("files")?.getAttribute("aria-pressed")).toBe("true");
    expect(railButton("layers")?.getAttribute("aria-pressed")).toBe("false");
    expect(railButton("files")?.classList.contains("selected")).toBe(true);
  });

  test("marks nothing pressed when the Navigator dock is collapsed", () => {
    shell.leftTab = "files";
    shell.docks.left.collapsed = true;
    renderActivityBar();
    expect([...bar().querySelectorAll(".rail-item[aria-pressed='true']")]).toEqual([]);
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

  test("clicking a different panel opens it", () => {
    // No renderOnly("leftPanel") assertion any more: the panel tracks `shell.leftTab` itself, and
    // A manual repaint beside the state write is exactly what the split removes.
    mountShell();
    shell.leftTab = "layers";
    renderActivityBar();
    railButton("files")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(shell.leftTab).toBe("files");
    expect(shell.docks.left.collapsed).toBe(false);
    expect(document.querySelector("#app")?.classList.contains("left-collapsed")).toBe(false);
    unmountShell();
  });

  test("clicking the already-open panel collapses the dock", () => {
    mountShell();
    shell.leftTab = "files";
    shell.docks.left.collapsed = false;
    renderActivityBar();
    railButton("files")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(shell.docks.left.collapsed).toBe(true);
    expect(document.querySelector("#app")?.classList.contains("left-collapsed")).toBe(true);
    unmountShell();
  });

  test("clicking the current panel while collapsed re-opens it", () => {
    shell.leftTab = "files";
    shell.docks.left.collapsed = true;
    renderActivityBar();
    railButton("files")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(shell.docks.left.collapsed).toBe(false);
    expect(shell.leftTab).toBe("files");
  });

  test("settings button opens the settings modal", () => {
    renderActivityBar();
    footerButton("Settings")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openSettingsModal).toHaveBeenCalledTimes(1);
  });

  test("about button opens the about modal", () => {
    renderActivityBar();
    footerButton("About")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    expect(bar().querySelector(".rail-groups")).not.toBeNull();
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
    expect(bar().querySelector(".rail-groups")).not.toBeNull();
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
