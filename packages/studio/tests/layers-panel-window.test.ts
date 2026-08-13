/**
 * The Outline draws a WINDOW, and every question about the tree is answered from the model.
 *
 * The hazard this file exists for is the shift-range. `visibleRowPaths` used to read the rows out
 * of the DOM, which was exact while the tree drew all of them and becomes a silent lie the moment
 * it draws eleven of five thousand: `rangeSelection` degenerates to `[target]` when the anchor is
 * absent from the row list it is given (`tabs/selection.ts`), so shift-clicking two rows with a
 * scrolled-past anchor would have quietly selected ONE row and reported nothing wrong. That is a
 * correctness bug wearing a performance change's clothes, and the first test below is its witness.
 *
 * Everything else here is the rest of the audit: the keyboard walk, the reveal that follows a
 * selection made somewhere else, the ARIA set counts, and the drag that must not have the rows
 * pulled out from under it.
 */
import { flush, renderInto, resetWorkspaceWithTab, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { view } from "../src/view";
import { initLayers } from "../src/ui/layers";
import { getPanel, resetPanels } from "../src/panels/panel-registry";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../src/state";
import type { NavigatorPanelContext } from "../src/panels/panel-registry";

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
  monitorForElements: () => () => {},
}));

const { OUTLINE_ROW_HEIGHT, clearHoverActions, registerLayersPanel, renderLayersTemplate } =
  await import("../src/panels/layers-panel");

/** Children of the root — enough that a window is a small fraction of the tree. */
const CHILD_COUNT = 200;
/** Model rows: the root plus one per child. */
const ROW_COUNT = CHILD_COUNT + 1;
/** A Navigator tall enough for ten rows, which is a real one at 24px a row. */
const VIEWPORT = 240;

let scroller: HTMLElement;
let host: HTMLElement;

/** A page with a long, flat body — the shape a real article's Outline has. */
function makeDoc(): JxMutableNode {
  return {
    children: Array.from({ length: CHILD_COUNT }, (_v, index) => ({
      tagName: "p",
      textContent: `Row ${index}`,
    })),
    tagName: "div",
  } as JxMutableNode;
}

/**
 * Happy-dom performs no layout, so the two boxes the window is computed from are stubbed: the
 * scroller's viewport, and the tree's top relative to it — which is what moves when you scroll.
 */
function place(): void {
  const tree = host.querySelector<HTMLElement>(".layers-tree");
  if (tree) {
    (tree as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ height: ROW_COUNT * OUTLINE_ROW_HEIGHT, top: -scroller.scrollTop }) as DOMRect;
  }
}

async function renderLayers(): Promise<void> {
  await renderInto(
    renderLayersTemplate({
      navigateToComponent: () => {},
      rerender: () => {
        void renderLayers();
      },
    }),
    host,
  );
  place();
}

/** Render until the tree has been adopted and the second, windowed pass has run. */
async function renderWindowed(): Promise<void> {
  await renderLayers();
  await flush();
  place();
}

async function scrollTo(top: number): Promise<void> {
  scroller.scrollTop = top;
  place();
  scroller.dispatchEvent(new Event("scroll"));
  await flush();
  await flush();
}

function rows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.layer-row[role="treeitem"]')];
}

function childPath(index: number): JxPath {
  return ["children", index];
}

function rowFor(index: number): HTMLElement | null {
  return host.querySelector<HTMLElement>(`.layer-row[data-path="children/${index}"]`);
}

function click(el: HTMLElement, opts: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...opts }));
}

function press(el: HTMLElement, key: string, opts: KeyboardEventInit = {}): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...opts }));
}

function selection(): JxPath[] {
  return activeTab.value!.session.selection;
}

/** The two spacers that stand in for the rows the window left out. */
function pads(): number[] {
  return [...host.querySelectorAll<HTMLElement>(".layers-tree > div[aria-hidden]")].map((el) =>
    Number(el.style.height.replace("px", "")),
  );
}

beforeEach(async () => {
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
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: ROW_COUNT * OUTLINE_ROW_HEIGHT,
  });
  stubRect(scroller, { height: VIEWPORT, top: 0 });
  host = document.querySelector("#host") as HTMLElement;
  view._layersCollapsed = new Set();
  view.dndCleanups = [];
  clearHoverActions();
  resetWorkspaceWithTab(makeDoc());
  await renderWindowed();
});

afterEach(() => {
  clearHoverActions();
  closeAllTabs();
  resetPanels();
  document.body.innerHTML = "";
});

describe("the shift-range is a range over the MODEL", () => {
  test("holds when the anchor has scrolled out of the window", async () => {
    click(rowFor(0)!);
    expect(selection()).toEqual([childPath(0)]);

    await scrollTo(OUTLINE_ROW_HEIGHT * 150);
    // The anchor is genuinely gone from the DOM — this is the state the DOM-derived range read as
    // "there is no anchor", and answered with a single row.
    expect(rowFor(0)).toBeNull();

    click(rowFor(149)!, { shiftKey: true });
    expect(selection()).toHaveLength(150);
    expect(selection()[0]).toEqual(childPath(0));
    expect(selection().at(-1)).toEqual(childPath(149));
  });

  test("holds when the TARGET is the row that scrolled away", async () => {
    await scrollTo(OUTLINE_ROW_HEIGHT * 150);
    click(rowFor(149)!);
    await scrollTo(0);
    expect(rowFor(149)).toBeNull();

    // Shift+↑ from a drawn row extends towards an anchor that is not drawn.
    press(rowFor(2)!, "ArrowUp", { shiftKey: true });
    expect(selection()).toHaveLength(149);
    expect(selection()[0]).toEqual(childPath(149));
    expect(selection().at(-1)).toEqual(childPath(1));
  });
});

describe("the window", () => {
  test("draws the viewport and its overscan, not the document", async () => {
    const drawn = rows();
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(20);
    expect(drawn.length).toBeLessThan(ROW_COUNT);
    expect(drawn[0]!.dataset.path).toBe("");
  });

  test("reserves the scroll height of every row it did not draw", () => {
    const [padTop, padBottom] = pads();
    expect(padTop).toBe(0);
    expect(padTop! + rows().length * OUTLINE_ROW_HEIGHT + padBottom!).toBe(
      ROW_COUNT * OUTLINE_ROW_HEIGHT,
    );
  });

  test("moves with the scroller, and still totals the whole document", async () => {
    await scrollTo(OUTLINE_ROW_HEIGHT * 100);
    expect(rowFor(0)).toBeNull();
    expect(rowFor(100)).not.toBeNull();
    const [padTop, padBottom] = pads();
    expect(padTop).toBeGreaterThan(0);
    expect(padTop! + rows().length * OUTLINE_ROW_HEIGHT + padBottom!).toBe(
      ROW_COUNT * OUTLINE_ROW_HEIGHT,
    );
  });

  test("reports each row's place in the DOCUMENT, not in the window", async () => {
    await scrollTo(OUTLINE_ROW_HEIGHT * 100);
    const row = rowFor(100)!;
    // 101st of 200 children, at depth 2 — a screen reader is told the same thing whether or not
    // The other 199 rows happen to be painted.
    expect(row.getAttribute("aria-posinset")).toBe("101");
    expect(row.getAttribute("aria-setsize")).toBe(String(CHILD_COUNT));
    expect(row.getAttribute("aria-level")).toBe("2");
  });
});

describe("the keyboard reaches rows the window does not hold", () => {
  test("End selects the last row of the document and scrolls to it", async () => {
    press(rowFor(1)!, "End");
    expect(selection()).toEqual([childPath(CHILD_COUNT - 1)]);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    await flush();
    await flush();
    expect(rowFor(CHILD_COUNT - 1)).not.toBeNull();
  });

  test("Home comes back to the root", async () => {
    await scrollTo(OUTLINE_ROW_HEIGHT * 150);
    press(rowFor(150)!, "Home");
    expect(selection()).toEqual([[]]);
    expect(scroller.scrollTop).toBe(0);
  });

  test("↓ walks past the last DRAWN row instead of stopping at it", async () => {
    const last = rows().at(-1)!;
    const lastIndex = Number(last.dataset.path!.split("/")[1]);
    press(last, "ArrowDown");
    expect(selection()).toEqual([childPath(lastIndex + 1)]);
  });
});

describe("the reveal that follows a selection made elsewhere", () => {
  test("scrolls to a row the canvas selected far below the window", async () => {
    registerLayersPanel();
    activeTab.value!.session.selection = [childPath(180)];
    await renderLayers();

    getPanel("layers")!.afterRender!(
      {
        deps: { getCanvasMode: () => "canvas", registerLayersDnD: () => {} },
        rerender: () => {},
      } as unknown as NavigatorPanelContext,
      host,
    );
    expect(scroller.scrollTop).toBeGreaterThan(OUTLINE_ROW_HEIGHT * 100);

    // A browser fires `scroll` after a programmatic `scrollTop`, and the watch repaints on it —
    // Which is why the reveal does not repaint itself. happy-dom does not, so the event is the one
    // Thing this test has to supply.
    place();
    scroller.dispatchEvent(new Event("scroll"));
    await flush();
    await flush();
    expect(rowFor(180)).not.toBeNull();
  });
});

describe("a drag keeps the window it started with", () => {
  test("a scroll mid-drag does not repaint the rows pragmatic-dnd is holding", async () => {
    const dragged = rows()[2]!;
    dragged.classList.add("dragging");
    const before = rows().length;

    scroller.scrollTop = OUTLINE_ROW_HEIGHT * 100;
    place();
    scroller.dispatchEvent(new Event("scroll"));
    await flush();

    expect(rows()).toHaveLength(before);
    expect(dragged.isConnected).toBe(true);
  });
});
