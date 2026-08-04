/**
 * The Command Bar (region ①) — a rendering of the registry, and nothing else.
 *
 * The assertions are grouped by the claim each one defends:
 *
 * - **One definition site.** Every button's label, icon, tooltip, chord and disabled state is read
 *   off a record; there is no second template for the no-project case, so the tests that used to
 *   assert `minimalToolbarTemplate`'s hardcoded `disabled` attributes are gone with it.
 * - **The pill is the address.** `◈ project › document › selection`, each segment opening the palette
 *   pre-scoped — the one place Studio now states which project is open.
 * - **`openInBrowserTarget` is a pure function** and is tested as one, route by route.
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import type { Tab } from "../src/tabs/tab";
import type { PaletteMode } from "../src/commands/defaults";

// ─── Module mocks (must precede the toolbar import) ───────────────────────────

const openQuickSearch = mock((_mode?: PaletteMode) => {});
void mock.module("../src/panels/quick-search.js", () => ({ openQuickSearch }));

const notified = mock((_message: string) => {});
void mock.module("../src/services/notify.js", () => notifyModule((call) => notified(call.message)));

const toolbar = await import("../src/panels/toolbar");
const { shell, resetProjectShell } = await import("../src/shell");
// The assistant's toggle reports a TAB selection, so the bar reads it where the Inspector keeps it.
const { setInspectorTab } = await import("../src/panels/right-panel");
const { setProjectState } = await import("../src/state");
const { setPreviewNavigateHandler } = await import("../src/canvas/preview-navigate");
const { closeAllTabs, openTab } = await import("../src/workspace/workspace");
const { createCommandRegistry } = await import("../src/commands/registry");
const { defaultCommands, noopCommandDeps } = await import("../src/commands/defaults");
const { shellViewCommands } = await import("../src/shell");
const { makeContext } = await import("../src/commands/context");
const { setActiveRegistry } = await import("../src/commands/active-registry");

type CommandRegistry = ReturnType<typeof createCommandRegistry>;
type CommandContext = ReturnType<typeof makeContext>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ALL_MODES = ["edit", "design", "preview", "source", "stylebook"];

/** The context the registry's predicates read. Mutated per test, read on every evaluation. */
let ctx: CommandContext = makeContext();

/** Verbs the records reach, recorded so a click is observable. */
let ran: string[] = [];

/**
 * Publish a registry over the real default records.
 *
 * The point of using the REAL records rather than fixtures: the bar's job is to render whatever the
 * registry holds, so a test that invented its own commands would prove nothing about Save's icon or
 * ⌘B's tooltip.
 */
function installRegistry(): CommandRegistry {
  const registry = createCommandRegistry({ getContext: () => ctx, mac: true });
  registry.registerAll(
    defaultCommands({
      ...noopCommandDeps(),
      panelRoster: [{ id: "files", title: "Files" }],
      saveDocument: () => void ran.push("save"),
      undo: () => void ran.push("undo"),
      redo: () => void ran.push("redo"),
      openInBrowser: () => void ran.push("openInBrowser"),
      openProject: () => void ran.push("openProject"),
      toggleDock: (dock) => void ran.push(`toggleDock:${dock}`),
      focusPanel: (id) => void ran.push(`focusPanel:${id}`),
    }),
  );
  // The bar's third dock toggle is `shell.ts`'s record now — ⌘J flips `shell.docks.bottom`, which
  // Is a dock the shell owns, so the verb is declared beside the state rather than injected.
  registry.registerAll(
    shellViewCommands({ inspectorTab: () => "properties", setInspectorTab: () => {} }),
  );
  // A gated overflow record, so the ⬢ menu's hide-vs-disable behaviour has something to show: every
  // Default overflow command is ungated, which is a fact about the defaults, not about the menu.
  registry.register({
    id: "test.overflowGated",
    title: "Gated Overflow",
    category: "View",
    level: "application",
    menus: ["commandbar/overflow", "palette"],
    group: "9_test",
    when: (candidate) => candidate.project.open,
    enablement: (candidate) => candidate.document.open,
    requires: "an open document",
    run: () => void ran.push("gated"),
  });
  setActiveRegistry(registry);
  return registry;
}

function openTestTab(documentPath = "/project/index.json"): Tab {
  closeAllTabs();
  return openTab({
    capabilities: { modes: ALL_MODES },
    document: { children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" },
    documentPath,
    id: "toolbar-tab",
  });
}

/** Find the first sp-action-button whose accessible name is exactly `label`. */
function btn(label: string): HTMLElement {
  const match = [...root.querySelectorAll("sp-action-button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!match) {
    throw new Error(`no button labelled ${label}`);
  }
  return match as HTMLElement;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function segments(): string[] {
  return [...root.querySelectorAll(".tb-center-seg")].map((el) => el.textContent?.trim() ?? "");
}

function stageProject() {
  setProjectState({
    dirs: new Map(),
    expanded: new Set(),
    isSiteProject: true,
    name: "acme",
    projectConfig: null,
    projectRoot: "/acme",
    searchQuery: "",
    selectedPath: null,
  });
}

let root: HTMLElement;

beforeEach(() => {
  closeAllTabs();
  localStorage.clear();
  shell.docks.left.collapsed = false;
  shell.docks.right.collapsed = false;
  setInspectorTab("properties");
  resetProjectShell();
  ctx = makeContext();
  ran = [];
  openQuickSearch.mockClear();
  notified.mockClear();
  setProjectState(null);
  setPreviewNavigateHandler(null);
  installMockPlatform();
  installRegistry();
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  toolbar.unmount();
  root.remove();
  setActiveRegistry(null);
  setPreviewNavigateHandler(null);
  setProjectState(null);
  delete (globalThis as Record<string, unknown>).__jxPlatform;
});

// ─── tbCmd: the record IS the control ────────────────────────────────────────

describe("tbCmd", () => {
  test("with no project open the same bar renders, gated by `when`", async () => {
    toolbar.mount(root);
    await flush();
    // No second template: Save simply is not visible, because `file.save` needs a document.
    expect(root.querySelector("sp-action-button[aria-label='Save']")).toBeNull();
    expect(segments()).toEqual(["No project", "No document"]);
  });

  test("a live record renders its title, its icon and its chord in the tooltip", async () => {
    ctx = makeContext({ document: { open: true, canUndo: true } });
    toolbar.mount(root);
    await flush();

    const save = btn("Save");
    expect(save.getAttribute("title")).toBe("Save (⌘S)");
    expect(save.querySelector("sp-icon-save-floppy")).not.toBeNull();
    expect(save.textContent).toContain("Save");
    click(save);
    expect(ran).toEqual(["save"]);
  });

  test("a disabled record states WHY in the tooltip instead of vanishing", async () => {
    ctx = makeContext({ document: { open: true, canUndo: false } });
    toolbar.mount(root);
    await flush();
    const undo = btn("Undo");
    expect(undo.hasAttribute("disabled")).toBe(true);
    expect(undo.getAttribute("title")).toBe("Undo — requires a change to undo");
  });

  test("commandTooltip is empty for an id no registry declares", () => {
    const registry = installRegistry();
    expect(toolbar.commandTooltip(registry, "nope.missing")).toBe("");
  });

  test("a record with no chord prints just its name", () => {
    const registry = installRegistry();
    expect(toolbar.commandTooltip(registry, "palette.openNodes")).toBe(
      "Go to Symbol in Document… — requires an open document",
    );
    ctx = makeContext({ document: { open: true } });
    expect(toolbar.commandTooltip(registry, "palette.openNodes")).toBe("Go to Symbol in Document…");
  });

  test("an invisible command renders the same nothing as an unknown one", () => {
    const registry = installRegistry();
    expect(toolbar.tbCmd(registry, "file.save")).toBe(toolbar.tbCmd(registry, "nope.missing"));
  });

  test("the primary cluster is exactly what declares commandbar/primary", async () => {
    ctx = makeContext({
      project: { open: true, isSite: true },
      document: { open: true, canUndo: true, canRedo: true },
    });
    toolbar.mount(root);
    await flush();
    const cluster = root.querySelector("sp-action-group[compact]")!;
    const labels = [...cluster.querySelectorAll("sp-action-button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    // Sorted by `group` then title, which is the registry's ordering, not the template's.
    expect(labels).toEqual(["Save", "Redo", "Undo", "Open in Browser"]);
  });
});

// ─── ①a The Command Center pill ──────────────────────────────────────────────

describe("the Command Center pill", () => {
  test("names the project, the document and the selection, and prints ⌘K", async () => {
    stageProject();
    const tab = openTestTab("/acme/pages/blog/index.md");
    tab.session.selection = ["children", 0];
    toolbar.mount(root);
    await flush();

    // The selection segment is the Outline's own `nodeLabel`, so the two cannot disagree.
    expect(segments()).toEqual(["acme", "pages/blog/index.md", "p — Hi"]);
    expect(root.querySelector(".tb-center-chord")?.textContent).toBe("⌘K");
  });

  test("each segment opens the palette pre-scoped, and the gap opens the mode picker", async () => {
    stageProject();
    const tab = openTestTab("/acme/pages/index.md");
    tab.session.selection = ["children", 0];
    toolbar.mount(root);
    await flush();

    const [project, document_, selection] = [...root.querySelectorAll(".tb-center-seg")];
    click(project!);
    click(document_!);
    click(selection!);
    expect(openQuickSearch.mock.calls.map(([mode]) => mode)).toEqual([
      "projects",
      "files",
      "nodes",
    ]);

    // The segment click stops there — the pill's own handler must not also fire.
    openQuickSearch.mockClear();
    click(root.querySelector(".tb-center")!);
    expect(openQuickSearch.mock.calls.map(([mode]) => mode)).toEqual(["picker"]);
  });

  test("the selection segment is absent with nothing selected, and reads layout for chrome", async () => {
    openTestTab();
    toolbar.mount(root);
    await flush();
    expect(segments()).toHaveLength(2);

    shell.layoutSelection = { path: [], tagName: "header" } as never;
    await flush();
    expect(segments().at(-1)).toBe("layout");
    shell.layoutSelection = null;
  });

  test("the document label drops the project root, and says so when there is none", () => {
    expect(toolbar.documentSegmentLabel(null)).toBe("No document");
    stageProject();
    const tab = openTestTab("./pages/index.md");
    expect(toolbar.documentSegmentLabel(tab)).toBe("pages/index.md");
  });

  test("the selection label is empty with no tab and no selection", () => {
    expect(toolbar.selectionSegmentLabel(null)).toBe("");
    const tab = openTestTab();
    expect(toolbar.selectionSegmentLabel(tab)).toBe("");
  });
});

// ─── The ⬢ app menu ───────────────────────────────────────────────────────────

describe("the ⬢ overflow menu", () => {
  test("lists what declared commandbar/overflow, with chords, and runs the picked one", async () => {
    ctx = makeContext({ project: { open: true } });
    toolbar.mount(root);
    await flush();

    const values = [...root.querySelectorAll("sp-menu-item")].map((i) => i.getAttribute("value"));
    expect(values).toContain("project.open");
    expect(values).toContain("view.toggleNavigator");
    const zen = [...root.querySelectorAll("sp-menu-item")].find(
      (i) => i.getAttribute("value") === "view.zen",
    )!;
    expect(zen.querySelector("[slot='value']")?.textContent).toBe("⌘.");

    const menu = root.querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "project.open";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ran).toEqual(["openProject"]);
  });

  test("a gated row is listed disabled, then vanishes when `when` turns false", async () => {
    ctx = makeContext({ project: { open: true } });
    toolbar.mount(root);
    await flush();
    const gated = [...root.querySelectorAll("sp-menu-item")].find(
      (i) => i.getAttribute("value") === "test.overflowGated",
    )!;
    // Visible but disabled, with the `requires` sentence in the tooltip — never a silent absence.
    expect(gated.hasAttribute("disabled")).toBe(true);
    expect(gated.getAttribute("title")).toBe("Gated Overflow — requires an open document");

    const menu = root.querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "test.overflowGated";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ran).toEqual([]);

    ctx = makeContext();
    toolbar.render();
    expect(
      [...root.querySelectorAll("sp-menu-item")].some(
        (i) => i.getAttribute("value") === "test.overflowGated",
      ),
    ).toBe(false);
  });
});

// ─── Dock toggles ─────────────────────────────────────────────────────────────

describe("dock toggles", () => {
  test("each dock's glyph and pressed state follow the record it renders", async () => {
    toolbar.mount(root);
    await flush();
    const navigatorToggle = btn("Toggle Navigator Dock");
    expect(navigatorToggle.hasAttribute("selected")).toBe(true);
    expect(navigatorToggle.querySelector("sp-icon-rail-left-close")).not.toBeNull();
    expect(navigatorToggle.getAttribute("title")).toBe("Toggle Navigator Dock (⌘B)");

    click(navigatorToggle);
    expect(ran).toEqual(["toggleDock:navigator"]);
  });

  test("a flip made from outside the bar reaches its icons", async () => {
    toolbar.mount(root);
    await flush();
    expect(btn("Toggle Bottom Dock").hasAttribute("selected")).toBe(false);

    // A bare state write, with no repaint call beside it: the band's effect tracks all three dock
    // Records, so a flip made by the automation runner, a layout preset or the boot-time restore
    // Reaches the icons the same way a click does. The third toggle reports the BOTTOM dock —
    // Naming ⌘J while drawing a chat glyph and reporting the Assistant's tab selection was a
    // Control that announced one surface and answered for another.
    shell.docks.bottom.collapsed = false;
    await flush();
    expect(btn("Toggle Bottom Dock").hasAttribute("selected")).toBe(true);
    expect(root.querySelector("sp-icon-align-bottom")).not.toBeNull();

    // The Assistant is an Inspector tab now, and the Bottom dock does not answer for it.
    setInspectorTab("assistant");
    await flush();
    expect(btn("Toggle Bottom Dock").hasAttribute("selected")).toBe(true);

    shell.docks.right.collapsed = true;
    shell.docks.bottom.collapsed = true;
    await flush();
    expect(btn("Toggle Bottom Dock").hasAttribute("selected")).toBe(false);
    expect(root.querySelector("sp-icon-rail-right-open")).not.toBeNull();
    expect(root.querySelector("sp-icon-rail-left-close")).not.toBeNull();

    toolbar.unmount();
    setInspectorTab("properties");
    await flush();
    expect(btn("Toggle Bottom Dock").hasAttribute("selected")).toBe(false);
  });

  test("the navigator glyph flips when the dock closes", async () => {
    shell.docks.left.collapsed = true;
    toolbar.mount(root);
    await flush();
    expect(root.querySelector("sp-icon-rail-left-open")).not.toBeNull();
  });
});

// ─── Window controls ──────────────────────────────────────────────────────────

describe("window controls", () => {
  test("non-mac order is minimize, maximize, close — and they sit at the end", async () => {
    const controls = { close: mock(() => {}), maximize: mock(() => {}), minimize: mock(() => {}) };
    (globalThis as Record<string, unknown>).__jxPlatform = { windowControls: controls };
    toolbar.mount(root);
    await flush();

    expect(root.classList.contains("electrobun-webkit-app-region-drag")).toBe(true);
    const group = root.querySelector(".window-controls")!;
    expect(group.classList.contains("mac")).toBe(false);
    const buttons = [...group.querySelectorAll("sp-action-button")];
    expect(buttons.map((b) => b.getAttribute("title"))).toEqual(["Minimize", "Maximize", "Close"]);
    click(buttons[0]!);
    click(buttons[1]!);
    click(buttons[2]!);
    expect(controls.minimize).toHaveBeenCalledTimes(1);
    expect(controls.maximize).toHaveBeenCalledTimes(1);
    expect(controls.close).toHaveBeenCalledTimes(1);
    expect(root.lastElementChild?.classList.contains("window-controls")).toBe(true);
  });

  test("mac puts them first, close leading", async () => {
    toolbar.setMacPlatformForTests(true);
    try {
      const controls = {
        close: mock(() => {}),
        maximize: mock(() => {}),
        minimize: mock(() => {}),
      };
      (globalThis as Record<string, unknown>).__jxPlatform = { windowControls: controls };
      toolbar.mount(root);
      await flush();
      const group = root.querySelector(".window-controls")!;
      expect(group.classList.contains("mac")).toBe(true);
      expect(
        [...group.querySelectorAll("sp-action-button")].map((b) => b.getAttribute("title")),
      ).toEqual(["Close", "Minimize", "Maximize"]);
      expect(root.firstElementChild?.classList.contains("window-controls")).toBe(true);
    } finally {
      toolbar.setMacPlatformForTests(null);
    }
  });
});

// ─── View: Open in Browser ────────────────────────────────────────────────────

/** The origin the mock platform's canvas — and therefore the built site — is served from. */
const SITE_ORIGIN = "http://127.0.0.1:4321";

function openSiteProject(trailingSlash?: "always" | "never") {
  (globalThis as Record<string, unknown>).__jxPlatform = {
    canvasUrl: `${SITE_ORIGIN}/__studio__/canvas.html`,
  };
  setProjectState({
    dirs: new Map(),
    expanded: new Set(),
    isSiteProject: true,
    name: "acme",
    projectConfig: (trailingSlash ? { build: { trailingSlash } } : {}) as never,
    projectRoot: "/acme",
    searchQuery: "",
    selectedPath: null,
  });
}

function pageTab(documentPath: string): Tab {
  closeAllTabs();
  return openTab({
    capabilities: { modes: ALL_MODES },
    document: { children: [], tagName: "div" },
    documentPath,
    id: "page-tab",
  });
}

describe("openInBrowserTarget", () => {
  test("a page resolves to its built route", () => {
    openSiteProject();
    expect(toolbar.openInBrowserTarget(pageTab("pages/blog/hello.md"))).toEqual({
      url: `${SITE_ORIGIN}/dist/blog/hello/index.html`,
    });
  });

  test("the root page resolves to dist/index.html", () => {
    openSiteProject();
    expect(toolbar.openInBrowserTarget(pageTab("./pages/index.md"))).toEqual({
      url: `${SITE_ORIGIN}/dist/index.html`,
    });
  });

  test("trailingSlash: never asks for the flat .html the compiler emits", () => {
    openSiteProject("never");
    expect(toolbar.openInBrowserTarget(pageTab("pages/about.json"))).toEqual({
      url: `${SITE_ORIGIN}/dist/about.html`,
    });
  });

  test("a dynamic route waits for its params, then resolves the chosen page", () => {
    openSiteProject();
    const tab = pageTab("pages/blog/[slug].json");
    expect(toolbar.openInBrowserTarget(tab)).toEqual({
      reason: "Pick a value for :slug to open one of this route's pages.",
    });
    tab.session.ui.previewParams = { slug: "getting started" };
    expect(toolbar.openInBrowserTarget(tab)).toEqual({
      url: `${SITE_ORIGIN}/dist/blog/getting%20started/index.html`,
    });
  });

  test("every refusal is a sentence, not an absence", () => {
    expect(toolbar.openInBrowserTarget(null)).toEqual({
      reason: "Open a page to view it in a browser.",
    });
    const tab = pageTab("pages/index.md");
    expect(toolbar.openInBrowserTarget(tab)).toEqual({
      reason: "This project does not build a site.",
    });
    openSiteProject();
    expect(toolbar.openInBrowserTarget(pageTab("components/Card.json"))).toEqual({
      reason: "Only pages have a route — components/Card.json is not under pages/.",
    });
    expect(toolbar.openInBrowserTarget(pageTab("pages/docs/[...rest].json"))).toEqual({
      reason: "Catch-all routes match many pages — open a generated one instead.",
    });
    (globalThis as Record<string, unknown>).__jxPlatform = {
      canvasUrl: "views://studio/canvas.html",
    };
    expect(toolbar.openInBrowserTarget(pageTab("pages/index.md"))).toEqual({
      reason: "No local server is serving this project yet.",
    });
  });
});

describe("runOpenInBrowser", () => {
  test("hands the URL to the preview-navigate seam, and falls back to a new tab", () => {
    openSiteProject();
    pageTab("pages/index.md");
    const opened: string[] = [];
    setPreviewNavigateHandler((url) => opened.push(url));
    toolbar.runOpenInBrowser();
    expect(opened).toEqual([`${SITE_ORIGIN}/dist/index.html`]);

    setPreviewNavigateHandler(null);
    const calls: unknown[][] = [];
    const originalOpen = window.open;
    (window as unknown as { open: unknown }).open = (...args: unknown[]) => {
      calls.push(args);
      return null;
    };
    try {
      toolbar.runOpenInBrowser();
      expect(calls).toEqual([[`${SITE_ORIGIN}/dist/index.html`, "_blank", "noopener,noreferrer"]]);
    } finally {
      window.open = originalOpen;
    }
  });

  test("reports the blocking reason instead of opening nothing", () => {
    closeAllTabs();
    toolbar.runOpenInBrowser();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0]![0]).toContain("Open a page to view it");
  });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  test("render is a no-op before mount and after unmount", () => {
    toolbar.unmount();
    expect(() => {
      toolbar.render();
    }).not.toThrow();
  });

  test("the band paints a skeleton before the bootstrap composes the registry", async () => {
    setActiveRegistry(null);
    toolbar.mount(root);
    await flush();
    // The pill is still there — "where am I" does not depend on the registry — but no verbs are.
    expect(root.querySelector(".tb-center")).not.toBeNull();
    expect(root.querySelector("sp-action-button")).toBeNull();

    // Publishing the registry repaints, with no render() call beside it.
    ctx = makeContext({ document: { open: true } });
    installRegistry();
    await flush();
    expect(btn("Save")).toBeTruthy();
  });

  test("unmount stops the reactive effect", async () => {
    ctx = makeContext({ document: { open: true, canUndo: false } });
    toolbar.mount(root);
    await flush();
    expect(btn("Undo").hasAttribute("disabled")).toBe(true);

    toolbar.unmount();
    ctx = makeContext({ document: { open: true, canUndo: true } });
    openTestTab();
    await flush();
    expect(btn("Undo").hasAttribute("disabled")).toBe(true);
  });

  test("template errors are caught and logged, not thrown", async () => {
    const registry = installRegistry();
    setActiveRegistry({
      ...registry,
      forPlacement: () => {
        throw new Error("boom");
      },
    } as unknown as CommandRegistry);
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      expect(() => {
        toolbar.mount(root);
      }).not.toThrow();
      await flush();
      expect(errors.some(([first]) => first === "toolbar render error:")).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
