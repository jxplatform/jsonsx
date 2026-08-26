import { flush, mountOverlayLayers, renderInto, resetWorkspaceWithTab } from "./harness";
import { nothing } from "lit-html";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TemplateResult } from "lit-html";

const { listPanels, registerPanel } = await import("../src/panels/panel-registry");

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
const { activeRegistry, setActiveRegistry } = await import("../src/commands/active-registry");
const { initLayers } = await import("../src/ui/layers");
const { dismissSettingsMenu, isSettingsMenuOpen } = await import("../src/panels/settings-menu");
const { createCommandRegistry } = await import("../src/commands/registry");
const { emptyContext } = await import("../src/commands/context");

/**
 * The rail foot renders FROM the `settings/menu` PLACEMENT, so a rail whose registry declares
 * nothing for it has no foot — which is what the last case in `renderActivityBar` pins.
 *
 * Only these records: this file is about the rail, and pulling in the whole app command set would
 * make every rail assertion depend on every other module's registration.
 */
function installPreferencesRegistry() {
  const registry = createCommandRegistry({ getContext: () => emptyContext(), mac: true });
  registry.register({
    id: "app.preferences",
    title: "Preferences…",
    category: "View",
    level: "application",
    keybinding: "mod+,",
    menus: ["commandbar/overflow", "settings/menu", "palette"],
    group: "7_settings",
    run: () => {},
  });
  setActiveRegistry(registry);
  return registry;
}
const { registerNavigatorPanels } = await import("../src/panels/navigator-panels");
const { mount, renderActivityBar, tabIcon, unmount } = await import("../src/panels/activity-bar");

beforeAll(() => {
  const app = document.createElement("div");
  app.id = "app";
  const barEl = document.createElement("div");
  barEl.id = "activity-bar";
  app.append(barEl);
  document.body.append(app);
  /* A SIBLING host, never `document.body`: `mountOverlayLayers` clears the host it is handed, and
     handing it the body would take `#app` — and the rail — with it. The gear's menu renders into
     `#layer-popover`, so the layers have to exist before any case clicks it. */
  const overlays = document.createElement("div");
  document.body.append(overlays);
  mountOverlayLayers(overlays);
  initLayers();
  initShellRefs();
  // The rail draws whatever the registry holds, so the records have to be contributed first.
  // `mount()` does this in the app; the direct-render tests below do it here.
  registerNavigatorPanels();
});

beforeEach(() => {
  // The foot depends on a registry now, so one leaking forward from a previous case is a button
  // Appearing where that case never asked for it. Four cases below install their own.
  setActiveRegistry(null);
  closeAllTabs();
  shell.leftTab = "layers";
  shell.docks.left.collapsed = false;
  // Problems is a Bottom dock panel with a rail button (§7.2), so its pressed state is a fact
  // About THAT dock. Reset it here, or one case's open dock lights up the next case's rail.
  shell.bottomTab = "problems";
  shell.docks.bottom.collapsed = true;
  resetProjectShell();
  refreshGitStatus.mockClear();
  openSettingsModal.mockClear();
  openAboutModal.mockClear();
  // Note: never wipe bar().innerHTML — lit owns the container and caches its parts.
  document.querySelector("#app")?.classList.remove("left-collapsed", "right-collapsed");
});

afterEach(() => {
  // Belt and braces — `unmount()` dismisses too, but a case that never mounted still may have
  // Opened the menu, and a stranded document-level keydown listener would answer the next case.
  dismissSettingsMenu();
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

  /*
   * DERIVED FROM THE REGISTRY, not from a list.
   *
   * This test used to hold a hardcoded array of the map's own keys, which proves only that a row
   * renders what the row says — a tautology the map cannot fail. It said nothing about whether any
   * PANEL points at a row, and that is the whole failure mode: three rail buttons (Source Control,
   * Problems, Search) shipped pointing at keys with no row, drawing a 20px hole apiece, while this
   * suite stayed green. It stayed green for the sharpest possible reason — the list included
   * `sp-icon-git-branch`, whose row had been ORPHANED, so the test went on proving a glyph rendered
   * while the shipped panel pointed somewhere else entirely.
   *
   * Asking the registry means a new panel with an unmapped icon fails here, in its own PR.
   */
  test("every registered panel's icon key resolves to a real element", async () => {
    // `rail !== false` rather than `railGroups()`, so a panel hidden behind its own `when` is
    // Still checked: Search is `NOT_YET_BUILT` today, and the day it is built is not the day to
    // Discover its icon was never mapped.
    const panels = listPanels().filter((panel) => panel.rail !== false);
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      const container = await renderInto(tabIcon(panel.icon, "m") as TemplateResult);
      expect({ icon: panel.icon, id: panel.id, rendered: container.children.length }).toEqual({
        icon: panel.icon,
        id: panel.id,
        rendered: 1,
      });
    }
  });

  test("unknown tag renders nothing", async () => {
    const container = await renderInto(tabIcon("sp-icon-bogus") as TemplateResult);
    expect(container.children.length).toBe(0);
  });
});

// ─── renderActivityBar ────────────────────────────────────────────────────────

describe("renderActivityBar", () => {
  test("renders every rail-able panel, grouped by level", () => {
    renderActivityBar();
    expect(railIds()).toEqual(["files", "git", "layers", "page", "data", "packages"]);
    // The Bottom dock's FOUR rail-less tabs stay off it. Problems joined the other three when its
    // Button went: a rail control that opens a dock along the bottom points the wrong way, and it
    // Cost three per-dock branches to keep honest.
    for (const id of ["problems", "diff", "logic", "activity"]) {
      expect(railIds()).not.toContain(id);
    }
    // Elements/Insert left the rail entirely, and State gave up its slot to Data.
    expect(railIds()).not.toContain("insert");
    expect(railIds()).not.toContain("state");
    // Search is still declared-but-unbuilt, hidden by its own `when` rather than faked with a
    // Stub button. Problems was the other one until P4.2 built it.
    expect(railIds()).not.toContain("search");
  });

  test("no rail button paints an empty icon slot", () => {
    installPreferencesRegistry();
    renderActivityBar();
    const empty = [...bar().querySelectorAll(".rail-item")]
      .filter((item) => (item.querySelector(".rail-icon")?.childElementCount ?? 0) === 0)
      .map((item) => (item as HTMLElement).dataset.panel ?? item.textContent?.trim());
    // `.rail-icon` is `height: 20px` with no content and no background, so a miss is not a fallback
    // Glyph or a broken-image mark — it is twenty pixels of nothing above a label.
    expect(empty).toEqual([]);
  });

  test("the two groups are named and separated by exactly one divider", () => {
    renderActivityBar();
    const groups = [...bar().querySelectorAll(".rail-group")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Project", "Document"]);
    expect(bar().querySelectorAll(".rail-divider")).toHaveLength(1);
  });

  test("every rail button carries a visible text label, not just a tooltip", () => {
    installPreferencesRegistry();
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

  // ── the dock branch (§7.2): a rail button reveals its panel where the panel lives ──

  /*
   * PROBLEMS IS NOT ON THE RAIL, and these four cases are what used to prove it was.
   *
   * It held the fourth PROJECT slot while its body was drawn in the Bottom dock, so the rail
   * carried a per-dock branch in `toggleRailPanel`, another in `isRailPanelShowing` and a third in
   * `focusPanel` — three branches to make one button of eight behave like the other seven, and a
   * control on the far left that opened a dock along the bottom. It also made "things are wrong
   * here" permanent furniture. The count still reaches the user from the status bar.
   */
  test("Problems has no rail button, and the rail no longer reaches a second dock", () => {
    shell.docks.bottom.collapsed = true;
    shell.bottomTab = "activity";
    renderActivityBar();
    expect(railButton("problems")).toBeNull();
    expect(railIds()).not.toContain("problems");
    // Nothing the rail can be clicked on writes the Bottom dock any more.
    for (const id of railIds()) {
      if (id) {
        railButton(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    }
    expect(shell.docks.bottom.collapsed).toBe(true);
    expect(shell.bottomTab).toBe("activity");
  });

  test("its record is still registered, and still counts — it is the BUTTON that is gone", async () => {
    // `rail: false` is not deletion: the panel is a real Bottom-dock tab with a live badge, and
    // `view.setBottomTab { tab: "problems" }` is how it is reached.
    const { notify, resetNotifications } = await import("../src/services/notify");
    resetNotifications();
    const problems = listPanels().find((panel) => panel.id === "problems");
    expect(problems).toBeDefined();
    expect(problems!.dock).toBe("bottom");
    expect(problems!.rail).toBe(false);
    expect(problems!.badge?.(emptyContext())).toBeNull();
    notify.error("could not save");
    expect(problems!.badge?.(emptyContext())).toBe(1);
    resetNotifications();
  });

  /*
   * THE FOOT IS A MENU TRIGGER, and this is the case that used to say the opposite.
   *
   * It asserted that clicking the gear ran `app.preferences` directly, which was the right shape
   * for a pinned SLOT. A slot holds one thing; a menu holds a family and prints each row's own
   * name, chord and gate, which is what lets the rail's foot offer the project's configuration
   * without an application-level control lying about what it opens.
   */
  test("the foot is a menu trigger, not a command button", () => {
    installPreferencesRegistry();
    renderActivityBar();
    const gear = footerButton("Settings")!;
    expect(gear).toBeDefined();
    expect(gear.getAttribute("aria-haspopup")).toBe("menu");
    expect(gear.getAttribute("aria-expanded")).toBe("false");
    // It runs no single command any more, so it claims none.
    expect(gear.dataset.command).toBeUndefined();

    const ran: string[] = [];
    const registry = activeRegistry()!;
    const original = registry.run.bind(registry);
    registry.run = ((id: string) => {
      ran.push(id);
      return Promise.resolve();
    }) as typeof registry.run;
    gear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    registry.run = original;

    // Clicking the gear opens the menu and runs nothing.
    expect(ran).toEqual([]);
    expect(footerButton("Settings")?.getAttribute("aria-expanded")).toBe("true");
    expect(
      document.querySelector('#layer-popover sp-menu-item[data-command-id="app.preferences"]'),
    ).not.toBeNull();
  });

  test("the gear's first row is Preferences, and it runs the record", () => {
    installPreferencesRegistry();
    renderActivityBar();
    footerButton("Settings")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const ran: string[] = [];
    const registry = activeRegistry()!;
    const original = registry.run.bind(registry);
    registry.run = ((id: string) => {
      ran.push(id);
      return Promise.resolve();
    }) as typeof registry.run;
    const row = document.querySelector<HTMLElement>(
      '#layer-popover sp-menu-item[data-command-id="app.preferences"]',
    )!;
    // Title and chord come from the record, so neither can drift from the keymap.
    expect(row.textContent).toContain("Preferences…");
    expect(row.querySelector("kbd")?.textContent).toBe("⌘,");
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    registry.run = original;

    expect(ran).toEqual(["app.preferences"]);
    expect(document.querySelector("#layer-popover sp-menu-item")).toBeNull();
  });

  /*
   * The successor to "neither Settings nor About holds a rail slot any more". Settings is a slot
   * again — as a MENU — and the half that still holds is the half about About: a thing opened once
   * in an app's lifetime does not earn permanent chrome. `Preferences` is no longer a slot of its
   * own either; it is the menu's first row.
   */
  test("About still holds no rail slot, and Preferences is no longer one", () => {
    installPreferencesRegistry();
    renderActivityBar();
    expect(footerButton("About")).toBeUndefined();
    expect(footerButton("Preferences")).toBeUndefined();
  });

  test("either arrow opens the menu from the gear, and other keys fall through", () => {
    // The menu-button convention: an arrow opens and the menu takes the keyboard from there.
    // Enter and Space are the button's own activation and already reach `@click`, so they are not
    // Handled twice — and nothing else is swallowed from the rail.
    installPreferencesRegistry();
    renderActivityBar();
    const press = (key: string) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
      footerButton("Settings")!.dispatchEvent(event);
      return event;
    };
    expect(press("a").defaultPrevented).toBe(false);
    expect(isSettingsMenuOpen()).toBe(false);
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(isSettingsMenuOpen()).toBe(true);
    dismissSettingsMenu();
    expect(press("ArrowUp").defaultPrevented).toBe(true);
    expect(isSettingsMenuOpen()).toBe(true);
  });

  test("a registry that declares nothing for the gear renders no foot", () => {
    const registry = createCommandRegistry({ getContext: () => emptyContext(), mac: true });
    registry.register({
      id: "app.preferences",
      title: "Preferences…",
      category: "View",
      level: "application",
      menus: ["palette"],
      run: () => {},
    });
    setActiveRegistry(registry);
    renderActivityBar();
    expect(bar().querySelector(".rail-footer .rail-item")).toBeNull();
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
