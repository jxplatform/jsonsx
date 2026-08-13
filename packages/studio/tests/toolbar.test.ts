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
import type { SiteBuildResult } from "../src/types";
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
      saveDocument: () => {
        ran.push("save");
      },
      undo: () => {
        ran.push("undo");
      },
      redo: () => {
        ran.push("redo");
      },
      openInBrowser: () => {
        ran.push("openInBrowser");
      },
      openProject: () => {
        ran.push("openProject");
      },
      toggleDock: (dock) => {
        ran.push(`toggleDock:${dock}`);
      },
      focusPanel: (id) => {
        ran.push(`focusPanel:${id}`);
      },
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
    run: () => {
      ran.push("gated");
    },
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
    tab.session.selection = [["children", 0]];
    toolbar.mount(root);
    await flush();

    // The selection segment is the Outline's own `nodeLabel`, so the two cannot disagree.
    expect(segments()).toEqual(["acme", "pages/blog/index.md", "p — Hi"]);
    expect(root.querySelector(".tb-center-chord")?.textContent).toBe("⌘K");
  });

  test("each segment opens the palette pre-scoped, and the gap opens the mode picker", async () => {
    stageProject();
    const tab = openTestTab("/acme/pages/index.md");
    tab.session.selection = [["children", 0]];
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

  test("one selected element is named by its node label, exactly as it always was", () => {
    const tab = openTestTab();
    tab.session.selection = [["children", 0]];
    expect(toolbar.selectionSegmentLabel(tab)).toBe("p — Hi");
  });

  test("a batch is not a place, so the address bar names its size (§6.5)", () => {
    const tab = openTestTab();
    tab.session.selection = [["children", 0], []];
    expect(toolbar.selectionSegmentLabel(tab)).toBe("2 elements");
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
  /*
   * `querySelector` PROVES NOTHING ABOUT AN ICON.
   *
   * These three assertions read `sp-icon-rail-left-open` / `-close` and passed for as long as the
   * Navigator's toggle rendered nothing at all: an unregistered custom element is still an element,
   * so lit puts the tag in the DOM and the query finds it, upgraded or not. Spectrum ships no
   * left-hand rail pair — only `rail-right-open`/`close` and a plain `IconRailLeft` — so those two
   * tags could never resolve, and the button was an empty box from the day it was written.
   *
   * So these assert WHICH glyph the bar renders, mirrored or not — a question this file can answer.
   * Whether that glyph is a registered element is a different question and a static one:
   * `scripts/check-icons.ts` asks it of the whole package, and `tests/icons.test.ts` pins it. It
   * cannot be asked here, because this file never loads `ui/spectrum.ts` and every icon would read
   * as unregistered, including the ones that work.
   */
  /**
   * A dock toggle's glyph, by tag.
   *
   * A tag name is a weak assertion when two glyphs are lookalikes — it is what let the mirrored
   * `rail-right-*` pair ship crossed, since both spellings named a real element and only the
   * arrow's direction differed. It is a fine assertion for `rail-left` / `rail-right` /
   * `rail-bottom`, which are three visibly distinct shapes; the STATE is `?selected`, asserted
   * separately on every one of them below.
   */
  function glyph(el: Element): string {
    const icon = el.querySelector("[slot='icon']");
    if (!icon) {
      return "none";
    }
    return icon.tagName.toLowerCase();
  }

  test("each dock's glyph and pressed state follow the record it renders", async () => {
    toolbar.mount(root);
    await flush();
    const navigatorToggle = btn("Toggle Navigator Dock");
    expect(navigatorToggle.hasAttribute("selected")).toBe(true);
    // Three regions, three distinct shipped glyphs — including the Bottom dock, which used to
    // Carry `align-bottom` and so named no region at all.
    expect(glyph(navigatorToggle)).toBe("sp-icon-rail-left");
    expect(glyph(btn("Toggle Inspector Dock"))).toBe("sp-icon-rail-right");
    expect(glyph(btn("Toggle Bottom Dock"))).toBe("sp-icon-rail-bottom");
    // …and no two of them are the same element, which is the property the mirrored pair lacked.
    const shapes = [
      glyph(navigatorToggle),
      glyph(btn("Toggle Inspector Dock")),
      glyph(btn("Toggle Bottom Dock")),
    ];
    expect(new Set(shapes).size).toBe(shapes.length);
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
    expect(glyph(btn("Toggle Bottom Dock"))).toBe("sp-icon-rail-bottom");

    // The Assistant is an Inspector tab now, and the Bottom dock does not answer for it.
    setInspectorTab("assistant");
    await flush();
    expect(btn("Toggle Bottom Dock").hasAttribute("selected")).toBe(true);

    shell.docks.right.collapsed = true;
    shell.docks.bottom.collapsed = true;
    await flush();
    expect(btn("Toggle Bottom Dock").hasAttribute("selected")).toBe(false);
    // Three docks in three different states at once: the glyph names the region, `selected` the
    // State, and the two must not be confused for one another.
    expect(glyph(btn("Toggle Inspector Dock"))).toBe("sp-icon-rail-right");
    expect(btn("Toggle Inspector Dock").hasAttribute("selected")).toBe(false);
    expect(glyph(btn("Toggle Navigator Dock"))).toBe("sp-icon-rail-left");
    expect(btn("Toggle Navigator Dock").hasAttribute("selected")).toBe(true);

    toolbar.unmount();
    setInspectorTab("properties");
    await flush();
    expect(btn("Toggle Bottom Dock").hasAttribute("selected")).toBe(false);
  });

  test("the navigator button reports a closed dock without changing what it names", async () => {
    shell.docks.left.collapsed = true;
    toolbar.mount(root);
    await flush();
    expect(btn("Toggle Navigator Dock").hasAttribute("selected")).toBe(false);
    expect(glyph(btn("Toggle Navigator Dock"))).toBe("sp-icon-rail-left");
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

/** The origin a backend reports the built site at — its own port, never the editor's. */
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
  /* These asserted the compiler's OUTPUT PATH — `/dist/blog/hello/index.html` — and passed against
     a URL no reader could use. A built page's own markup is root-absolute (`/components/demo.css`,
     a link to `/basics/counter`), so from a `/dist/…` URL the assets 404 against the server root
     and the first link leaves the site: measured on the running dev server as page 200, CSS 404,
     link 404. The answer is the page's ROUTE now — the one it will have when published, and the
     one its own links already point at. The ORIGIN is the backend's to report, because the built
     site is served on a port of its own. */
  test("a page resolves to the route it will be published at", () => {
    openSiteProject();
    expect(toolbar.openInBrowserTarget(pageTab("pages/blog/hello.md"))).toEqual({
      path: "/blog/hello/",
    });
  });

  test("the root page is the site root", () => {
    openSiteProject();
    expect(toolbar.openInBrowserTarget(pageTab("./pages/index.md"))).toEqual({ path: "/" });
  });

  test("trailingSlash: never drops the slash, as the published URL does", () => {
    openSiteProject("never");
    expect(toolbar.openInBrowserTarget(pageTab("pages/about.json"))).toEqual({ path: "/about" });
  });

  test("a dynamic route waits for its params, then resolves the chosen page", () => {
    openSiteProject();
    const tab = pageTab("pages/blog/[slug].json");
    expect(toolbar.openInBrowserTarget(tab)).toEqual({
      reason: "Pick a value for :slug to open one of this route's pages.",
    });
    tab.session.ui.previewParams = { slug: "getting started" };
    expect(toolbar.openInBrowserTarget(tab)).toEqual({ path: "/blog/getting%20started/" });
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
  });
});

describe("runOpenInBrowser", () => {
  /** A backend that builds and reports where the result is browsable. */
  function installBuildingPlatform(result: Partial<SiteBuildResult> = {}) {
    installMockPlatform({
      buildSite: async () => ({ errors: [], files: 3, routes: 2, url: SITE_ORIGIN, ...result }),
      canvasUrl: `${SITE_ORIGIN}/__studio__/canvas.html`,
    });
  }

  test("hands the URL to the preview-navigate seam, and falls back to a new tab", async () => {
    openSiteProject();
    pageTab("pages/index.md");
    installBuildingPlatform();
    const opened: string[] = [];
    setPreviewNavigateHandler((url) => opened.push(url));
    await toolbar.runOpenInBrowser();
    expect(opened).toEqual([`${SITE_ORIGIN}/`]);

    setPreviewNavigateHandler(null);
    const calls: unknown[][] = [];
    const originalOpen = window.open;
    (window as unknown as { open: unknown }).open = (...args: unknown[]) => {
      calls.push(args);
      return null;
    };
    try {
      await toolbar.runOpenInBrowser();
      expect(calls).toEqual([[`${SITE_ORIGIN}/`, "_blank", "noopener,noreferrer"]]);
    } finally {
      window.open = originalOpen;
    }
  });

  test("reports the blocking reason instead of opening nothing", () => {
    closeAllTabs();
    void toolbar.runOpenInBrowser();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0]![0]).toContain("Open a page to view it");
  });

  /* The other half of "as if published": what a reader opens is what the AUTHOR is looking at.
     Nothing in Studio had ever written the site's output, so before this the reader saw whatever
     the last `jx build` left on disk — for most projects nothing at all, which is a 404 dressed up
     as a feature. */
  test("builds before opening, and opens the origin the BUILD reports", async () => {
    /* Not the editor's origin. The two URL spaces collide: `/components/demo.js` is the formula
       module in the project's sources and the custom element in its output, and a reader handed
       the editor's origin gets whichever the editor resolves — measured as a page that rendered
       with `customElements.get(…)` null and nothing on it working. */
    openSiteProject();
    pageTab("pages/index.md");
    const built: string[] = [];
    installMockPlatform({
      buildSite: async () => {
        built.push("built");
        return { errors: [], files: 3, routes: 2, url: "http://127.0.0.1:5555" };
      },
      canvasUrl: `${SITE_ORIGIN}/__studio__/canvas.html`,
    });
    const opened: string[] = [];
    setPreviewNavigateHandler((url) => opened.push(url));
    await toolbar.runOpenInBrowser();
    expect(built).toEqual(["built"]);
    expect(opened).toEqual(["http://127.0.0.1:5555/"]);
    setPreviewNavigateHandler(null);
  });

  test("a build error is named, and the page still opens", async () => {
    // A partial build produced pages. Refusing to show the one the author asked for would trade a
    // Readable page plus a sentence for a sentence.
    openSiteProject();
    pageTab("pages/index.md");
    installBuildingPlatform({ errors: ["pages/broken.json: unknown tag"], files: 1, routes: 1 });
    const opened: string[] = [];
    setPreviewNavigateHandler((url) => opened.push(url));
    await toolbar.runOpenInBrowser();
    expect(opened).toEqual([`${SITE_ORIGIN}/`]);
    expect(notified.mock.calls.at(-1)![0]).toContain("unknown tag");
    setPreviewNavigateHandler(null);
  });

  test("a build that THROWS does not open a page that would be a lie", async () => {
    openSiteProject();
    pageTab("pages/index.md");
    installMockPlatform({
      buildSite: async () => {
        throw new Error("no disk space");
      },
      canvasUrl: `${SITE_ORIGIN}/__studio__/canvas.html`,
    });
    const opened: string[] = [];
    setPreviewNavigateHandler((url) => opened.push(url));
    await toolbar.runOpenInBrowser();
    expect(opened).toEqual([]);
    expect(notified.mock.calls.at(-1)![0]).toContain("no disk space");
    setPreviewNavigateHandler(null);
  });

  test("a backend that cannot build says so rather than opening the editor's origin", async () => {
    /* It used to open the canvas origin and call that graceful. It is not: that origin serves the
       project's SOURCES, so the reader would get a page whose scripts and styles are whichever
       source file shares the URL. A sentence beats a site that looks published and is not. */
    openSiteProject();
    pageTab("pages/index.md");
    installMockPlatform({ canvasUrl: `${SITE_ORIGIN}/__studio__/canvas.html` });
    const opened: string[] = [];
    setPreviewNavigateHandler((url) => opened.push(url));
    await toolbar.runOpenInBrowser();
    expect(opened).toEqual([]);
    expect(notified.mock.calls.at(-1)![0]).toContain("cannot build a preview");
    setPreviewNavigateHandler(null);
  });

  test("a build that reports no origin does not send the reader anywhere", async () => {
    // The build succeeded and the backend serves no preview of it — a real answer for a hosted
    // Backend, and one the reader must be told rather than shown a broken address for.
    openSiteProject();
    pageTab("pages/index.md");
    installMockPlatform({
      buildSite: async () => ({ errors: [], files: 3, routes: 2 }),
      canvasUrl: `${SITE_ORIGIN}/__studio__/canvas.html`,
    });
    const opened: string[] = [];
    setPreviewNavigateHandler((url) => opened.push(url));
    await toolbar.runOpenInBrowser();
    expect(opened).toEqual([]);
    expect(notified.mock.calls.at(-1)![0]).toContain("serves no preview");
    setPreviewNavigateHandler(null);
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
