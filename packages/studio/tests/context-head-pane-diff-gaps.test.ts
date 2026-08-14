/**
 * Diff-gap coverage for four surfaces a recent change touched and no test executed.
 *
 * Each block asserts the OBSERVABLE consequence of the guarded line rather than merely walking it:
 *
 * - `editor/context-menu.ts` — the target fallback answering "nothing" (no tab, or a tab with an
 *   empty selection), `contextMenuRegistry()` handing back the APP's registry once the bootstrap
 *   has composed one, the fallback registry's Edit Component routing through the navigate hook the
 *   host publishes, and the document keydown listener being UNBOUND on both teardown paths rather
 *   than merely disarmed by the handler's own `_ctxHandle` guard;
 * - `panels/head-panel.ts` — a second render riding the layout read already in flight, the Page
 *   panel's door to Search appearance, and `applyContentMutation` with no tab to commit into;
 * - `panels/pane-context.ts` — the preset menu's outside-click dismissal, and a route-param load that
 *   lands after its tab has left the panes;
 * - `panels/pane-grid.ts` — a second `mount()` leaving the live grid (and everything inside its
 *   cells) exactly where it is, and a `reconcile()` after `unmount()` writing neither a cell nor a
 *   track into the element the module has let go of.
 */
import {
  flush,
  installMockPlatform,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AnyCommand } from "../src/commands/registry";
import type { JxPath } from "../src/state";
import type { Tab } from "../src/tabs/tab";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── Module mocks ─────────────────────────────────────────────────────────────

/** Every `loadParamValues` the context bar asked for, in order. */
const paramLoads: string[] = [];
/** When true the loader hands back a promise this file resolves by hand. */
let holdParams = false;
let releaseParams: ((values: Record<string, string[]>) => void) | null = null;

const realPageParams = await import("../src/page-params");

void mock.module("../src/page-params", () => ({
  ...realPageParams,
  loadParamValues: (documentPath: string | null) => {
    paramLoads.push(String(documentPath));
    if (holdParams) {
      return new Promise<Record<string, string[]>>((resolve) => {
        releaseParams = resolve;
      });
    }
    return Promise.resolve({ sku: ["alpha", "beta"] });
  },
}));

const {
  contextMenuRegistry,
  dismissContextMenu,
  liveElementCommands,
  setContextMenuNavigate,
  showContextMenu,
} = await import("../src/editor/context-menu");
const {
  applyContentMutation,
  invalidateLayoutHeadCache,
  invalidateLayoutPickerCache,
  layoutHeadEntries,
  renderHeadTemplate,
} = await import("../src/panels/head-panel");
const paneContext = await import("../src/panels/pane-context");
const paneGrid = await import("../src/panels/pane-grid");
const { activeRegistry, setActiveRegistry } = await import("../src/commands/active-registry");
const { createCommandRegistry } = await import("../src/commands/registry");
const { emptyContext, makeContext } = await import("../src/commands/context");
const { componentRegistry } = await import("../src/files/components");
const { invalidateLayoutCache } = await import("../src/site-context");
const { derivationCommands, noopDerivationDeps } = await import("../src/workspace/pane-derive");
const { PRIMARY_PANE, activateTab, closeAllTabs, openTab, paneCommands, workspace } =
  await import("../src/workspace/workspace");

type PaneCtx = Parameters<typeof paneContext.mount>[1];

function makeCtx(): PaneCtx {
  return {
    exportFile: () => {},
    parseMediaEntries: () => ({
      baseWidth: 1200,
      featureQueries: [] as { name: string; query: string }[],
      sizeBreakpoints: [] as { name: string; query: string; width: number; type: string }[],
    }),
    setCanvasMode: () => {},
  } as unknown as PaneCtx;
}

// ─── editor/context-menu.ts · the target fallback ────────────────────────────

describe("the element records' target falls back to the SELECTION", () => {
  /** One live record, bound to the live modules — the shape the app registry holds. */
  function record(id: string): AnyCommand {
    const found = liveElementCommands().find((command) => command.id === id);
    if (!found) {
      throw new Error(`no live element record "${id}"`);
    }
    return found;
  }

  const styled = (): JxMutableNode => ({
    children: [{ style: { color: "red" }, tagName: "p", textContent: "A" }],
    tagName: "div",
  });

  beforeEach(() => {
    setActiveRegistry(null);
    componentRegistry.length = 0;
    resetStudioState();
    installMockPlatform();
  });

  afterEach(() => {
    closeAllTabs();
  });

  test("a selected node IS the target when no menu is open", () => {
    const tab = resetWorkspaceWithTab(styled());
    tab.session.selection = [["children", 0] as JxPath];
    const ctx = emptyContext();
    expect(record("edit.copyStyles").when!(ctx)).toBe(true);
    expect(record("edit.copyStyles").enablement!(ctx)).toBe(true);
  });

  test("a tab with an EMPTY selection has no target — the row is not offered", () => {
    const tab = resetWorkspaceWithTab(styled());
    tab.session.selection = [];
    expect(record("edit.copyStyles").when!(emptyContext())).toBe(false);
  });

  test("no tab at all has none either, rather than reading a document that is not there", () => {
    closeAllTabs();
    expect(workspace.tabs.size).toBe(0);
    expect(record("edit.copyStyles").when!(emptyContext())).toBe(false);
    expect(record("selection.wrap").when!(emptyContext())).toBe(false);
  });
});

// ─── editor/context-menu.ts · which registry the menu renders ────────────────

describe("contextMenuRegistry prefers the app's registry", () => {
  beforeEach(() => {
    setActiveRegistry(null);
    componentRegistry.length = 0;
    resetStudioState();
    installMockPlatform();
  });

  afterEach(() => {
    setActiveRegistry(null);
    setContextMenuNavigate(null);
    componentRegistry.length = 0;
    closeAllTabs();
  });

  test("the composed registry is returned outright, records and all", () => {
    const app = createCommandRegistry({ getContext: emptyContext });
    app.register({
      category: "Selection",
      group: "1_clipboard",
      id: "test.appOnly",
      level: "selection",
      menus: ["context/element"],
      run: () => {},
      title: "App Only",
      undo: "none",
    });
    setActiveRegistry(app);

    expect(contextMenuRegistry()).toBe(app);
    // The menu therefore renders a record contributed AFTER this file loaded, which is the whole
    // Point of preferring the app's registry over the private fallback.
    expect(
      contextMenuRegistry()
        .forPlacement("context/element")
        .map((c) => c.id),
    ).toEqual(["test.appOnly"]);

    setActiveRegistry(null);
    const fallback = contextMenuRegistry();
    expect(fallback).not.toBe(app);
    expect(fallback.get("test.appOnly")).toBeUndefined();
    expect(fallback.get("edit.copyStyles")).toBeDefined();
  });

  test("the fallback's Edit Component runs the navigation the host published", () => {
    setActiveRegistry(null);
    const navigated: string[] = [];
    setContextMenuNavigate((path) => {
      navigated.push(path);
    });
    componentRegistry.push({ path: "components/card.json", tagName: "x-card" } as never);
    const tab = resetWorkspaceWithTab({
      children: [{ children: [], tagName: "x-card" }],
      tagName: "div",
    });
    tab.session.selection = [["children", 0] as JxPath];

    const registry = contextMenuRegistry();
    expect(registry.isVisible("selection.editComponent")).toBe(true);
    void registry.run("selection.editComponent");
    expect(navigated).toEqual(["components/card.json"]);
  });

  test("…and with no hook published the same row is inert rather than a throw", () => {
    setActiveRegistry(null);
    setContextMenuNavigate(null);
    componentRegistry.push({ path: "components/card.json", tagName: "x-card" } as never);
    const tab = resetWorkspaceWithTab({
      children: [{ children: [], tagName: "x-card" }],
      tagName: "div",
    });
    tab.session.selection = [["children", 0] as JxPath];
    expect(() => contextMenuRegistry().run("selection.editComponent")).not.toThrow();
  });
});

// ─── editor/context-menu.ts · the keyboard listener's lifetime ───────────────

/** One `document.addEventListener` / `removeEventListener` call, as the spy recorded it. */
interface Registration {
  capture: unknown;
  handler: EventListenerOrEventListenerObject;
  op: "add" | "remove";
  type: string;
}

/**
 * Record every document-level listener registration, passing each through to the real DOM.
 *
 * The menu's own `if (!_ctxHandle) return;` makes a listener that OUTLIVED its menu behave exactly
 * like one that was unbound, so no dispatched key can tell the two apart. The registration itself
 * is the only observable that can, which is why this reads the arguments rather than the effect.
 */
function recordDocumentListeners(log: Registration[]): () => void {
  const realAdd = document.addEventListener.bind(document);
  const realRemove = document.removeEventListener.bind(document);
  document.addEventListener = ((
    type: string,
    handler: EventListenerOrEventListenerObject,
    capture?: unknown,
  ) => {
    log.push({ capture, handler, op: "add", type });
    realAdd(type, handler, capture as AddEventListenerOptions | boolean);
  }) as Document["addEventListener"];
  document.removeEventListener = ((
    type: string,
    handler: EventListenerOrEventListenerObject,
    capture?: unknown,
  ) => {
    log.push({ capture, handler, op: "remove", type });
    realRemove(type, handler, capture as EventListenerOptions | boolean);
  }) as Document["removeEventListener"];
  return () => {
    document.addEventListener = realAdd as Document["addEventListener"];
    document.removeEventListener = realRemove as Document["removeEventListener"];
  };
}

describe("the element menu's document keydown listener", () => {
  /** The capture-phase `keydown` bindings the menu took, in order. */
  function keyBindings(log: Registration[], op: "add" | "remove"): Registration[] {
    return log.filter(
      (entry) => entry.op === op && entry.type === "keydown" && entry.capture === true,
    );
  }

  /** The rows of the element menu, addressed by the menu's own accessible name. */
  function menuRows(): HTMLElement[] {
    const menu = document.querySelector('sp-menu[aria-label="Element actions"]');
    return menu ? [...menu.querySelectorAll<HTMLElement>("sp-menu-item[data-command-id]")] : [];
  }

  function openMenu(): void {
    const tab = resetWorkspaceWithTab({
      children: [{ style: { color: "red" }, tagName: "p", textContent: "A" }],
      tagName: "div",
    });
    tab.session.selection = [["children", 0] as JxPath];
    showContextMenu(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }),
      ["children", 0] as JxPath,
    );
  }

  /** Press ↓ the way the document-level capture listener would see it. */
  function arrowDown(): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" });
    document.dispatchEvent(e);
    return e;
  }

  /** Let the popover's outside-click listener register — it waits a frame on purpose. */
  async function frame(): Promise<void> {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null));
    });
  }

  beforeEach(() => {
    setActiveRegistry(null);
    componentRegistry.length = 0;
    resetStudioState();
    installMockPlatform();
  });

  afterEach(() => {
    dismissContextMenu();
    setActiveRegistry(null);
    closeAllTabs();
  });

  test("the programmatic dismiss unbinds it — it is not left on the document, disarmed", async () => {
    const log: Registration[] = [];
    const stop = recordDocumentListeners(log);
    try {
      openMenu();
      await flush();
      expect(menuRows().length).toBeGreaterThan(0);

      const bound = keyBindings(log, "add");
      expect(bound).toHaveLength(1);
      // While the menu is up it owns ↓, so the canvas's own nudge does not also fire.
      expect(arrowDown().defaultPrevented).toBe(true);

      dismissContextMenu();

      // The SAME function, with the same capture flag: the menu handed the key back to the app
      // Rather than staying on the document behind its own null check.
      const released = keyBindings(log, "remove").filter(
        (entry) => entry.handler === bound[0]!.handler,
      );
      expect(released).toHaveLength(1);
      expect(menuRows()).toHaveLength(0);
      expect(arrowDown().defaultPrevented).toBe(false);
    } finally {
      stop();
    }
  });

  test("…and so does the outside click, which tears down through the popover's own hook", async () => {
    const log: Registration[] = [];
    const stop = recordDocumentListeners(log);
    try {
      openMenu();
      await flush();
      await frame();
      const bound = keyBindings(log, "add");
      expect(bound).toHaveLength(1);
      expect(keyBindings(log, "remove")).toHaveLength(0);

      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

      expect(menuRows()).toHaveLength(0);
      expect(
        keyBindings(log, "remove").filter((entry) => entry.handler === bound[0]!.handler),
      ).toHaveLength(1);
      expect(arrowDown().defaultPrevented).toBe(false);
    } finally {
      stop();
    }
  });
});

// ─── panels/head-panel.ts · the layout layer, and the two document seams ─────

describe("the layout `$head` read", () => {
  const LAYOUT = JSON.stringify({
    $head: [{ attributes: { content: "from the layout", name: "description" }, tagName: "meta" }],
    tagName: "div",
  });

  beforeEach(() => {
    resetStudioState();
    closeAllTabs();
    invalidateLayoutCache();
    invalidateLayoutHeadCache();
    invalidateLayoutPickerCache();
  });

  afterEach(() => {
    invalidateLayoutCache();
    invalidateLayoutHeadCache();
    closeAllTabs();
  });

  test("two renders in one tick share ONE read — the second rides the request in flight", async () => {
    const { state } = installMockPlatform({}, { "layouts/main-layout.json": LAYOUT });
    resetStudioState({
      isSiteProject: true,
      projectConfig: { defaults: { layout: "./layouts/main-layout.json" } },
    });
    const tab = resetWorkspaceWithTab(undefined, { documentPath: "pages/about.json" }) as Tab;

    // Both calls happen before the first read lands, so both see an empty middle layer…
    expect(layoutHeadEntries(tab)).toEqual({ entries: [], name: "Main Layout" });
    expect(layoutHeadEntries(tab)).toEqual({ entries: [], name: "Main Layout" });
    await flush();

    // …and the file was opened exactly once for the two of them.
    const reads = state.calls.filter(
      (call) => call[0] === "readFile" && call[1] === "layouts/main-layout.json",
    );
    expect(reads).toHaveLength(1);
    // The one read did land, so the guard dropped a duplicate rather than the answer.
    expect(layoutHeadEntries(tab).entries).toHaveLength(1);
  });
});

describe("the Page panel's door to Search appearance", () => {
  beforeEach(() => {
    installMockPlatform();
    resetStudioState();
    closeAllTabs();
    invalidateLayoutPickerCache();
    setActiveRegistry(null);
  });

  afterEach(() => {
    setActiveRegistry(null);
    closeAllTabs();
  });

  test("the button runs the shared command rather than opening the modal itself", async () => {
    const ran: string[] = [];
    const registry = createCommandRegistry({ getContext: emptyContext });
    registry.register({
      category: "Document",
      id: "document.openSeo",
      level: "document",
      run: () => {
        ran.push("document.openSeo");
      },
      title: "Search Appearance",
      undo: "none",
    });
    setActiveRegistry(registry);

    const container = await renderInto(
      renderHeadTemplate({
        applyMutation: () => {},
        document: { tagName: "html" } as JxMutableNode,
        renderLeftPanel: () => {},
      }),
    );
    const button = container.querySelector(".head-seo-btn") as HTMLElement;
    expect(button.textContent?.trim()).toBe("Search appearance…");

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ran).toEqual(["document.openSeo"]);
    expect(activeRegistry()).toBe(registry);
  });
});

describe("applyContentMutation", () => {
  beforeEach(() => {
    installMockPlatform();
    resetStudioState();
    closeAllTabs();
  });

  afterEach(() => {
    closeAllTabs();
  });

  function contentTab(): Tab {
    const tab = resetWorkspaceWithTab(undefined, {
      documentPath: "posts/hello.json",
      id: "fm-tab",
    }) as Tab;
    tab.doc.mode = "content";
    tab.doc.content.frontmatter = { title: "Old" };
    return tab;
  }

  test("commits the mutation into the tab's frontmatter and repaints", () => {
    const tab = contentTab();
    let repaints = 0;
    applyContentMutation(
      tab,
      () => {
        repaints += 1;
      },
      (doc) => {
        doc.title = "New";
      },
    );
    expect(tab.doc.content.frontmatter.title).toBe("New");
    expect(repaints).toBe(1);
  });

  test("with NO tab it writes nothing and does not even repaint", () => {
    let repaints = 0;
    let mutations = 0;
    applyContentMutation(
      null,
      () => {
        repaints += 1;
      },
      () => {
        mutations += 1;
      },
    );
    expect(mutations).toBe(0);
    expect(repaints).toBe(0);
  });
});

// ─── panels/pane-context.ts · the preset menu, and a late param load ─────────

describe("the preset menu's outside-click dismissal", () => {
  let host: HTMLElement;

  /** The rows of the popover the ⟲ trigger opened, addressed by its own aria-label. */
  function menuItems(): HTMLElement[] {
    const menu = document.querySelector('[aria-label="Show beside this pane"]');
    return menu ? [...menu.querySelectorAll<HTMLElement>("sp-menu-item")] : [];
  }

  beforeEach(() => {
    closeAllTabs();
    resetStudioState();
    installMockPlatform();
    const registry = createCommandRegistry({
      getContext: () => makeContext({ document: { open: workspace.tabs.size > 0 } }),
    });
    registry.registerAll([
      ...paneCommands({ openFile: () => {}, openFileInPane: () => {} }),
      ...derivationCommands(noopDerivationDeps()),
    ]);
    setActiveRegistry(registry);
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    paneContext.dismissPresetMenu();
    paneContext.unmount();
    setActiveRegistry(null);
    host.remove();
    closeAllTabs();
  });

  async function openMenu(): Promise<void> {
    resetWorkspaceWithTab(
      { children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" },
      { documentPath: "pages/index.json", id: "pages/index.json" },
    );
    paneContext.mount(host, makeCtx());
    await flush();
    const trigger = host.querySelector(".pc-derive-trigger") as HTMLElement;
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // A frame later the popover has taken its outside-click listener.
    await flush();
  }

  test("a mousedown inside keeps it; one outside takes it down", async () => {
    await openMenu();
    const opened = menuItems();
    expect(opened.length).toBeGreaterThan(0);

    // Pressing INSIDE the menu is how a row is activated — it must not dismiss first.
    opened[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menuItems().length).toBe(opened.length);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menuItems()).toHaveLength(0);
  });

  test("…and the trigger opens a fresh one afterwards, exactly one at a time", async () => {
    await openMenu();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menuItems()).toHaveLength(0);

    const trigger = host.querySelector(".pc-derive-trigger") as HTMLElement;
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(menuItems().length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[aria-label="Show beside this pane"]')).toHaveLength(1);
  });
});

describe("a route-param load that lands after its tab left the panes", () => {
  let host: HTMLElement;

  beforeEach(() => {
    paramLoads.length = 0;
    holdParams = true;
    releaseParams = null;
    closeAllTabs();
    resetStudioState({ isSiteProject: true });
    installMockPlatform();
    paneContext.resetParamValues();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    holdParams = false;
    paneContext.unmount();
    paneContext.resetParamValues();
    host.remove();
    closeAllTabs();
  });

  test("the answer is discarded — nothing auto-selected, nothing cached", async () => {
    const dyn = resetWorkspaceWithTab(
      { children: [], tagName: "div" },
      { documentPath: "pages/products/[sku].json", id: "dyn" },
    );
    openTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/about.json",
      id: "static",
    });
    activateTab("dyn");
    paneContext.mount(host, makeCtx());
    await flush();
    expect(paramLoads).toEqual(["pages/products/[sku].json"]);
    const resolve = releaseParams!;

    // The pane moves to another document while the read is still in flight.
    activateTab("static");
    paneContext.render();
    await flush();

    resolve({ sku: ["alpha", "beta"] });
    await flush();

    // Not auto-selected: the candidates belong to a picker no pane is showing.
    expect(dyn.session.ui.previewParams?.sku).toBeUndefined();

    // Nor cached — the pane that comes back has to ask again, which is the honest state.
    activateTab("dyn");
    paneContext.render();
    await flush();
    expect(paramLoads).toEqual(["pages/products/[sku].json", "pages/products/[sku].json"]);
    expect(dyn.session.ui.previewParams?.sku).toBeUndefined();

    /* …and the answer that lands while the pane IS showing the tab is auto-selected. The positive
       control: without it, "nothing was selected" could just as well mean a loader that never
       answers, and the refusal above would prove nothing. */
    releaseParams!({ sku: ["alpha", "beta"] });
    await flush();
    expect(dyn.session.ui.previewParams?.sku).toBe("alpha");
  });
});

// ─── panels/pane-grid.ts · mounting twice ────────────────────────────────────

describe("mounting the pane grid twice", () => {
  let gridA: HTMLElement;
  let gridB: HTMLElement | null = null;

  beforeEach(() => {
    resetStudioState();
    closeAllTabs();
    installMockPlatform();
    gridA = document.createElement("div");
    gridA.id = "pane-grid";
    document.body.append(gridA);
  });

  afterEach(() => {
    paneGrid.unmount();
    paneContext.unmount();
    gridA.remove();
    gridB?.remove();
    gridB = null;
    closeAllTabs();
  });

  test("the second mount is inert — the live grid keeps its cells", () => {
    paneGrid.mount();
    const cell = paneGrid.cellForPane(PRIMARY_PANE);
    expect(cell).not.toBeNull();
    expect(gridA.querySelectorAll(".pane")).toHaveLength(1);

    /* A second `#pane-grid` appears and `mount()` is called again — a project switch that forgot to
       unmount. Re-rendering the cells into it would re-parent every stage, and an `<iframe>` that
       changes parent reloads: the pane the author was not touching goes blank. */
    gridA.id = "pane-grid-live";
    gridB = document.createElement("div");
    gridB.id = "pane-grid";
    document.body.append(gridB);

    paneGrid.mount();

    expect(gridB.childElementCount).toBe(0);
    expect(gridA.querySelectorAll(".pane")).toHaveLength(1);
    expect(cell!.root.parentElement).toBe(gridA);
    expect(cell!.stage.isConnected).toBe(true);
  });

  test("a reconcile after unmount lays neither a cell nor a track into the grid it let go of", () => {
    paneGrid.mount();
    expect(gridA.querySelectorAll(".pane")).toHaveLength(1);
    expect(gridA.style.gridTemplateColumns).toBe("minmax(0, 1fr)");

    paneGrid.unmount();
    expect(gridA.childElementCount).toBe(0);

    /* A sentinel no code path here would ever write. `reconcile()` stops at its own `_grid` check,
       so the element the shell has taken back keeps whatever the next owner put on it — the track
       writer is never reached with a grid the module no longer holds. */
    gridA.style.gridTemplateColumns = "13px";
    paneGrid.reconcile();

    expect(gridA.style.gridTemplateColumns).toBe("13px");
    expect(gridA.childElementCount).toBe(0);
    expect(paneGrid.cellForPane(PRIMARY_PANE)).toBeNull();
  });
});
