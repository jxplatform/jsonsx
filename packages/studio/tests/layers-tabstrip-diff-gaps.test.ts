/**
 * Three edges that the Outline, the overlay layers and the tab strip only reach when something is
 * MISSING — and where the honest answer is "do nothing", which is exactly the shape of code no test
 * arrives at by accident.
 *
 * - The Outline's walk runs off the END of its model: ↓ from the last row, → from a last row that is
 *   expandable but whose only child is a text node (not a tree item). Both answers are -1, and -1
 *   must not be treated as an index.
 * - A keyboard jump can name a row that the repaint it provoked STILL does not hold. The pending
 *   focus is spent either way, and spending it on nothing must leave the tree's single tab stop
 *   where the roving pass put it rather than clearing every one of them.
 * - A popover anchored inside the dialog layer belongs in the dialog layer, and `toastsAreHeld`
 *   answers "no" for a realm whose `location` cannot be read at all.
 * - The tab strip's drag carries a payload, and both of its menus close on an outside click — and the
 *   overflow menu reopened AFTER such a click is the live one, which is the reachable state a stale
 *   `_overflowHandle` would have to be visible in.
 */
import {
  flush,
  key,
  renderInto,
  resetWorkspaceWithTab,
  stubRect,
  mountOverlayLayers,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  activeTab,
  closeAllTabs,
  openTab,
  tabCommands,
  workspace,
} from "../src/workspace/workspace";
import { view } from "../src/view";
import { html } from "lit-html";
import { initLayers, popoverLayerFor, renderPopover, toastsAreHeld } from "../src/ui/layers";
import { createCommandRegistry } from "../src/commands/registry";
import { setActiveRegistry } from "../src/commands/active-registry";
import { makeContext } from "../src/commands/context";
import { defaultCommands, noopCommandDeps } from "../src/commands/defaults";
import { resetPanels } from "../src/panels/panel-registry";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../src/state";

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
  monitorForElements: () => () => {},
}));

const {
  OUTLINE_ROW_HEIGHT,
  applyRowSelection,
  clearHoverActions,
  renderLayersTemplate,
  startLayerTitleEdit,
} = await import("../src/panels/layers-panel");
const { dismissOverflowMenu, mount, unmount } = await import("../src/panels/tab-strip");

/** Errors happy-dom reports for a listener that threw — a dispatch never rethrows them. */
function captureErrors(): { messages: string[]; stop: () => void } {
  const messages: string[] = [];
  const onError = (e: Event) => messages.push((e as ErrorEvent).message ?? "error");
  window.addEventListener("error", onError);
  return { messages, stop: () => window.removeEventListener("error", onError) };
}

// ─── The Outline ──────────────────────────────────────────────────────────────

/** A Navigator tall enough for ten rows, which is a real one at 24px a row. */
const VIEWPORT = 240;

let scroller: HTMLElement;
let host: HTMLElement;
/** What the tree's top measures as, relative to the scroller. */
let treeTop: () => number;
/** What the panel's `rerender` does — a real repaint, or a spy that stands in for one. */
let onRerender: () => void;

/** Happy-dom performs no layout, so the box the window is computed from is stubbed by hand. */
function place(rowCount: number): void {
  const tree = host.querySelector<HTMLElement>(".layers-tree");
  if (tree) {
    (tree as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ height: rowCount * OUTLINE_ROW_HEIGHT, top: treeTop() }) as DOMRect;
  }
}

async function renderOutline(rowCount: number): Promise<void> {
  await renderInto(
    renderLayersTemplate({
      navigateToComponent: () => {},
      rerender: () => onRerender(),
    }),
    host,
  );
  place(rowCount);
}

function rowByKey(pathKey: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`.layer-row[data-path="${pathKey}"]`);
}

function rows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.layer-row[role="treeitem"]')];
}

function selection(): JxPath[] {
  return activeTab.value!.session.selection;
}

function setUpOutlineDom(): void {
  document.body.innerHTML = `
    <div id="scroller"><div id="host"></div></div>
    <div id="layer-popover"></div>
    <div id="layer-modal"></div>
    <div id="layer-dialog"></div>
  `;
  initLayers();
  scroller = document.querySelector("#scroller") as HTMLElement;
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: VIEWPORT });
  stubRect(scroller, { height: VIEWPORT, top: 0 });
  host = document.querySelector("#host") as HTMLElement;
  view._layersCollapsed = new Set();
  view.dndCleanups = [];
  clearHoverActions();
  treeTop = () => -scroller.scrollTop;
  onRerender = () => {};
}

describe("the Outline's walk off the end of its model", () => {
  /** The last row is expandable and its only child is TEXT — drawn, but never a tree item. */
  const TAIL_DOC = {
    children: [
      { tagName: "p", textContent: "One" },
      { children: ["just words"], tagName: "section" },
    ],
    tagName: "div",
  } as unknown as JxMutableNode;

  /** Root + p + section + the section's text row. */
  const ROW_COUNT = 4;

  beforeEach(async () => {
    setUpOutlineDom();
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: ROW_COUNT * OUTLINE_ROW_HEIGHT,
    });
    resetWorkspaceWithTab(TAIL_DOC);
    onRerender = () => {
      void renderOutline(ROW_COUNT);
    };
    await renderOutline(ROW_COUNT);
    await flush();
  });

  afterEach(() => {
    clearHoverActions();
    closeAllTabs();
    resetPanels();
    document.body.innerHTML = "";
  });

  test("↓ from the last tree item stays put — the text row below it is not a step", async () => {
    // The text row is drawn BELOW the last tree item, so the walk has something to skip before it
    // Runs out of model.
    const tail = [...host.querySelectorAll<HTMLElement>(".layer-row")].at(-1)!;
    expect(tail.textContent).toContain("just words");
    expect(tail.getAttribute("role")).toBeNull();

    const last = rowByKey("children/1")!;
    last.click();
    expect(selection()).toEqual([["children", 1]]);

    key(last, "ArrowDown");
    await flush();
    expect(selection()).toEqual([["children", 1]]);
  });

  test("→ on an expanded last row is a no-op, not an index of -1", async () => {
    const last = rowByKey("children/1")!;
    // It really is expanded: the branch under test is the one that DESCENDS, not the one that opens.
    expect(last.getAttribute("aria-expanded")).toBe("true");
    last.click();
    last.focus();
    const drawn = rows().length;
    const repaint = mock(() => {});
    onRerender = repaint;

    const errors = captureErrors();
    key(last, "ArrowRight");
    await flush();
    errors.stop();

    expect(errors.messages).toEqual([]);
    // Nothing moved: no collapse was toggled, no repaint asked for, the keyboard stayed here.
    expect(repaint).not.toHaveBeenCalled();
    expect(view._layersCollapsed!.size).toBe(0);
    expect(selection()).toEqual([["children", 1]]);
    expect(rows()).toHaveLength(drawn);
    expect(document.activeElement).toBe(last);
  });

  test("a row activation with no document open leaves the closed tab's selection alone", () => {
    const tab = activeTab.value!;
    applyRowSelection(["children", 0]);
    expect(tab.session.selection).toEqual([["children", 0]]);

    closeAllTabs();
    expect(activeTab.value).toBeNull();
    applyRowSelection(["children", 1]);
    expect(tab.session.selection).toEqual([["children", 0]]);
  });
});

describe("a keyboard jump the repaint still cannot draw", () => {
  const CHILD_COUNT = 200;
  const ROW_COUNT = CHILD_COUNT + 1;

  function makeDoc(): JxMutableNode {
    return {
      children: Array.from({ length: CHILD_COUNT }, (_v, index) => ({
        tagName: "p",
        textContent: `Row ${index}`,
      })),
      tagName: "div",
    } as JxMutableNode;
  }

  beforeEach(async () => {
    setUpOutlineDom();
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: ROW_COUNT * OUTLINE_ROW_HEIGHT,
    });
    resetWorkspaceWithTab(makeDoc());
    onRerender = () => {
      void renderOutline(ROW_COUNT);
    };
    // First paint draws everything (nothing is measurable yet); the watch asks for the windowed one.
    await renderOutline(ROW_COUNT);
    await flush();
    place(ROW_COUNT);
  });

  afterEach(() => {
    clearHoverActions();
    closeAllTabs();
    resetPanels();
    document.body.innerHTML = "";
  });

  test("End keeps the tree's single tab stop when the repaint lands short", async () => {
    // The window is frozen at the top of the list: the scroll happens, the paint does not follow.
    treeTop = () => 0;
    expect(rows().length).toBeLessThan(ROW_COUNT);

    const errors = captureErrors();
    key(rows()[1]!, "End");
    await flush();
    await flush();
    errors.stop();

    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(selection()).toEqual([["children", CHILD_COUNT - 1]]);
    // The row it wanted is still not drawn, so the pending focus was spent on nothing…
    expect(rowByKey(`children/${CHILD_COUNT - 1}`)).toBeNull();
    expect(errors.messages).toEqual([]);
    // …and the roving tab stop the repaint set is still the tree's one keyboard position.
    expect(rows().filter((row) => row.tabIndex === 0)).toHaveLength(1);
  });

  test("a rename aimed below the window scrolls to the row and asks for the repaint", async () => {
    const repaint = mock(() => {});
    onRerender = repaint;
    expect(rowByKey("children/180")).toBeNull();

    startLayerTitleEdit(["children", 180], repaint);

    expect(scroller.scrollTop).toBeGreaterThan(OUTLINE_ROW_HEIGHT * 100);
    expect(repaint).toHaveBeenCalledTimes(1);
    // The input is the NEXT pass's business — this one only made the row reachable.
    expect(document.querySelector(".layer-title-input")).toBeNull();

    // A path that is in no row at all asks for nothing: there is no row to scroll to.
    const scrolled = scroller.scrollTop;
    startLayerTitleEdit(["children", 999], repaint);
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(scrolled);
  });
});

// ─── The overlay layers ───────────────────────────────────────────────────────

describe("popoverLayerFor", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="layer-popover"><button id="in-popover"></button></div>
      <div id="layer-modal"><button id="in-modal"></button></div>
      <div id="layer-dialog"><button id="in-dialog"></button></div>
      <button id="in-app"></button>
    `;
    initLayers();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("a control inside a dialog opens its popover in the dialog layer", () => {
    expect(popoverLayerFor(document.querySelector("#in-dialog"))).toBe("dialog");
    expect(popoverLayerFor(document.querySelector("#in-modal"))).toBe("modal");
    expect(popoverLayerFor(document.querySelector("#in-app"))).toBe("popover");
    expect(popoverLayerFor(null)).toBe("popover");
  });
});

describe("toastsAreHeld", () => {
  test("a realm whose location cannot be read is not automation", () => {
    const search = Object.getOwnPropertyDescriptor(globalThis.location, "search");
    Object.defineProperty(globalThis.location, "search", {
      configurable: true,
      get: () => {
        throw new Error("no location in this realm");
      },
    });
    try {
      expect(toastsAreHeld()).toBe(false);
    } finally {
      if (search) {
        Object.defineProperty(globalThis.location, "search", search);
      }
    }
  });
});

// ─── The tab strip ────────────────────────────────────────────────────────────

describe("the tab strip", () => {
  let stripHost: HTMLElement;

  function open(id: string) {
    return openTab({
      document: { children: [], tagName: "div" } as JxMutableNode,
      documentPath: `/project/${id}.json`,
      id,
    });
  }

  function chips(): HTMLElement[] {
    return [...stripHost.querySelectorAll(".tab-strip-tab")] as HTMLElement[];
  }

  function strip(): HTMLElement {
    return stripHost.querySelector(".tab-strip") as HTMLElement;
  }

  /** Happy-dom performs no layout (scrollWidth/clientWidth are 0); stub them to fake overflow. */
  function stubMetrics(el: HTMLElement, scrollWidth: number, clientWidth: number) {
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
  }

  /**
   * Dispatch a dragstart carrying a DataTransfer, which happy-dom's own DragEvent does not. The two
   * fields the handler writes are the two this stub records.
   */
  function dragStart(el: HTMLElement): { effectAllowed: string; data: Map<string, string> } {
    const data = new Map<string, string>();
    const dataTransfer = {
      data,
      effectAllowed: "uninitialized",
      setData(type: string, value: string) {
        data.set(type, value);
      },
    };
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    el.dispatchEvent(event);
    return dataTransfer;
  }

  /** Let the popover's outside-click listener register — it waits a frame on purpose. */
  async function frame(): Promise<void> {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null));
    });
  }

  function popovers(): Element[] {
    return [...document.querySelectorAll("#layer-popover sp-popover")];
  }

  function publishRegistry() {
    const registry = createCommandRegistry({
      getContext: () => makeContext({ document: { open: workspace.activeTabId !== null } }),
    });
    registry.registerAll([
      ...defaultCommands(noopCommandDeps()),
      ...tabCommands({ openFile: () => {}, openFileInPane: () => {} }),
    ]);
    setActiveRegistry(registry);
  }

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="tab-strip"></div>
      <div id="layer-popover"></div>
      <div id="layer-modal"></div>
      <div id="layer-dialog"></div>
    `;
    initLayers();
    stripHost = document.querySelector("#tab-strip") as HTMLElement;
    closeAllTabs();
    workspace.closedTabs = [];
    mount(stripHost);
  });

  afterEach(() => {
    unmount();
    setActiveRegistry(null);
    closeAllTabs();
    document.body.innerHTML = "";
  });

  test("a chip's drag declares a move and carries the tab id", async () => {
    open("a");
    open("b");
    await flush();

    const dataTransfer = dragStart(chips()[0]!);
    await flush();

    expect(dataTransfer.effectAllowed).toBe("move");
    expect(dataTransfer.data.get("text/plain")).toBe("a");
    expect(chips()[0]!.classList.contains("dragging")).toBe(true);

    chips()[0]!.dispatchEvent(new Event("dragend", { bubbles: true }));
    await flush();
  });

  test("the overflow menu closes on a click outside it, and stays for one inside", async () => {
    open("a");
    open("b");
    await flush();
    stubMetrics(strip(), 500, 100);
    // Poke a re-render so the strip is measured again and the chevron is drawn.
    open("c");
    await flush();

    (stripHost.querySelector(".tab-strip-overflow") as HTMLElement).click();
    await flush();
    expect(popovers()).toHaveLength(1);
    await frame();

    // A mousedown inside the menu is not "outside": the menu is there to be clicked.
    const item = document.querySelector("#layer-popover sp-menu-item") as HTMLElement;
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();
    expect(popovers()).toHaveLength(1);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();
    expect(popovers()).toHaveLength(0);
  });

  /**
   * The reachable state a stale `_overflowHandle` would have to show itself in: the field is
   * written by the open, cleared by the outside-click hook, and read once more by the NEXT open.
   * What the strip owes here is a menu that lists the tabs as they are now, and a
   * {@link dismissOverflowMenu} that takes down the menu on screen rather than the one before it.
   */
  test("the overflow menu reopened after an outside click is the live one", async () => {
    open("a");
    open("b");
    await flush();
    stubMetrics(strip(), 500, 100);
    // Poke a re-render so the strip is measured again and the chevron is drawn.
    open("c");
    await flush();

    const chevron = () => stripHost.querySelector(".tab-strip-overflow") as HTMLElement;
    chevron().click();
    await flush();
    await frame();
    expect(document.querySelectorAll("#layer-popover sp-menu-item")).toHaveLength(3);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();
    expect(popovers()).toHaveLength(0);

    // A fourth tab arrives while no menu is up, so the reopened menu is only right if it was built
    // From the pane's order as it stands NOW.
    open("d");
    await flush();
    chevron().click();
    await flush();

    expect(popovers()).toHaveLength(1);
    expect(document.querySelectorAll("#layer-popover sp-menu-item")).toHaveLength(4);

    // And the strip's handle addresses THAT menu: the exported dismiss takes it off the screen.
    dismissOverflowMenu();
    expect(popovers()).toHaveLength(0);
  });

  test("the tab context menu closes on a click outside it", async () => {
    open("a");
    publishRegistry();
    await flush();

    chips()[0]!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    await flush();
    expect(popovers()).toHaveLength(1);
    await frame();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();
    expect(popovers()).toHaveLength(0);

    // The strip's own handle went with it: reopening draws one menu, not a second beside a stale one.
    chips()[0]!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    await flush();
    expect(popovers()).toHaveLength(1);
  });
});

// ─── ui/layers.ts — a popover dismissed inside its own arming frame ───────────

/**
 * `renderPopover` defers arming its outside-click listener by one frame, so the click that OPENED
 * the popover cannot immediately close it. A popover dismissed inside that frame — which a
 * double-click on any menu trigger produces — used to be armed anyway, one frame after its own
 * death: a document-wide capture listener belonging to a detached slot. The next mousedown then
 * counted as "outside" it and ran its owner's `onDismiss`, and owners null their handle field there
 * — so the corpse cleared the pointer to the LIVE popover and stranded it on screen.
 */
describe("a popover dismissed before its listener is armed", () => {
  beforeEach(() => {
    mountOverlayLayers(document.body);
    initLayers();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function frame(): Promise<void> {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null));
    });
  }

  test("is never armed, so it cannot dismiss the popover that replaced it", async () => {
    const dismissed: string[] = [];

    const first = renderPopover(html`<div id="first">one</div>`, {
      dismissOnOutsideClick: true,
      onDismiss: () => dismissed.push("first"),
    });
    // Same frame, before the arming rAF — the double-click case.
    first.dismiss();
    await frame();

    const second = renderPopover(html`<div id="second">two</div>`, {
      dismissOnOutsideClick: true,
      onDismiss: () => dismissed.push("second"),
    });
    await frame();

    const inside = second.host.querySelector("#second") as HTMLElement;
    inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();

    // A mousedown INSIDE the live popover dismisses nothing at all — least of all via the corpse,
    // Whose slot every target on the page is "outside" of.
    expect(dismissed).toEqual([]);
    expect(second.host.isConnected).toBe(true);
    expect(document.querySelector("#second")).toBe(inside);

    second.dismiss();
    expect(document.querySelector("#second")).toBeNull();
  });

  test("…while a popover that WAS armed still closes on an outside click", async () => {
    const dismissed: string[] = [];
    const only = renderPopover(html`<div id="only">one</div>`, {
      dismissOnOutsideClick: true,
      onDismiss: () => dismissed.push("only"),
    });
    await frame();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();

    expect(dismissed).toEqual(["only"]);
    expect(only.host.isConnected).toBe(false);
  });
});
