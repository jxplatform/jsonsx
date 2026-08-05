/**
 * Multi-select in the Outline — shift-range and ctrl/cmd-accumulate (§6.5, P5 item 4).
 *
 * The Outline goes first because it is the one surface where "the range between these two" has an
 * unambiguous answer: its rows are a flat, ordered, expansion-aware list, and `data-jx-path` on
 * every row is exactly what makes that list readable at click time.
 *
 * Every gesture is asserted against the UNMODIFIED click first, because the unmodified click is
 * what every existing caller and every screenshot step makes, and it must still replace the
 * selection with exactly one path.
 */
import { renderInto, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { pathKey } from "../src/store";
import { view } from "../src/view";
import { initLayers } from "../src/ui/layers";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../src/state";

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
  monitorForElements: () => () => {},
}));

const { clearHoverActions, renderLayersTemplate } = await import("../src/panels/layers-panel");

let host: HTMLElement;

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
}

function row(path: JxPath): HTMLElement {
  const el = host.querySelector<HTMLElement>(`.layer-row[data-path="${pathKey(path)}"]`);
  if (!el) {
    throw new Error(`no row for ${pathKey(path)}`);
  }
  return el;
}

function click(path: JxPath, opts: MouseEventInit = {}): void {
  row(path).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...opts }));
}

function press(target: HTMLElement, key: string, opts: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...opts }),
  );
}

function selection(): JxPath[] {
  return activeTab.value!.session.selection;
}

/** Three top-level siblings, the first with two children — enough for a range that spans depths. */
function makeDoc(): JxMutableNode {
  return {
    children: [
      {
        children: [
          { tagName: "h2", textContent: "Opening hours" },
          { tagName: "p", textContent: "Every day" },
        ],
        tagName: "section",
      },
      { tagName: "img" },
      { tagName: "hr" },
    ],
    tagName: "div",
  };
}

const SECTION = ["children", 0];
const H2 = ["children", 0, "children", 0];
const P = ["children", 0, "children", 1];
const IMG = ["children", 1];
const HR = ["children", 2];

beforeEach(async () => {
  document.body.innerHTML = `
    <div id="host"></div>
    <div id="layer-popover"></div>
    <div id="layer-modal"></div>
    <div id="layer-dialog"></div>
  `;
  initLayers();
  host = document.querySelector("#host") as HTMLElement;
  view._layersCollapsed = new Set();
  view.dndCleanups = [];
  clearHoverActions();
  resetWorkspaceWithTab(makeDoc());
  await renderLayers();
});

afterEach(() => {
  clearHoverActions();
  closeAllTabs();
  document.body.innerHTML = "";
});

describe("the unmodified click is unchanged", () => {
  test("selects exactly one path, replacing whatever was selected", async () => {
    click(IMG);
    expect(selection()).toEqual([IMG]);
    click(HR);
    expect(selection()).toEqual([HR]);
    await renderLayers();
  });

  test("clicking an already-selected row leaves it selected rather than toggling it off", () => {
    click(IMG);
    click(IMG);
    expect(selection()).toEqual([IMG]);
  });
});

describe("ctrl/cmd-click accumulates", () => {
  test("adds the clicked path and makes it the primary", () => {
    click(IMG);
    click(HR, { ctrlKey: true });
    expect(selection()).toEqual([IMG, HR]);
  });

  test("cmd is the same gesture as ctrl", () => {
    click(IMG);
    click(HR, { metaKey: true });
    expect(selection()).toEqual([IMG, HR]);
  });

  test("clicking a selected row again removes it from the set", () => {
    click(IMG);
    click(HR, { ctrlKey: true });
    click(IMG, { ctrlKey: true });
    expect(selection()).toEqual([HR]);
  });

  test("a plain click after accumulating collapses back to one", () => {
    click(IMG);
    click(HR, { ctrlKey: true });
    click(SECTION);
    expect(selection()).toEqual([SECTION]);
  });
});

describe("shift-click selects the visible range", () => {
  test("spans depths, in the order the rows are drawn", () => {
    click(SECTION);
    click(IMG, { shiftKey: true });
    expect(selection()).toEqual([SECTION, H2, P, IMG]);
  });

  test("the anchor survives, so a second shift-click re-extends from it", () => {
    click(SECTION);
    click(HR, { shiftKey: true });
    expect(selection()).toEqual([SECTION, H2, P, IMG, HR]);
    click(H2, { shiftKey: true });
    expect(selection()).toEqual([SECTION, H2]);
  });

  test("a collapsed branch is not in the range, because it is not on screen", async () => {
    view._layersCollapsed = new Set([pathKey(SECTION)]);
    await renderLayers();
    click(SECTION);
    click(HR, { shiftKey: true });
    expect(selection()).toEqual([SECTION, IMG, HR]);
  });

  test("shift with nothing selected is a plain click", () => {
    activeTab.value!.session.selection = [];
    click(IMG, { shiftKey: true });
    expect(selection()).toEqual([IMG]);
  });
});

describe("every selected row draws selected; one carries the tab stop", () => {
  test("aria-selected is true for the whole set, tabindex 0 only on the primary", async () => {
    click(IMG);
    click(HR, { ctrlKey: true });
    await renderLayers();
    expect(row(IMG).getAttribute("aria-selected")).toBe("true");
    expect(row(HR).getAttribute("aria-selected")).toBe("true");
    expect(row(HR).getAttribute("tabindex")).toBe("0");
    expect(row(IMG).getAttribute("tabindex")).toBe("-1");
  });
});

describe("the keyboard", () => {
  test("a bare arrow walk still replaces the selection", async () => {
    click(IMG);
    await renderLayers();
    press(row(IMG), "ArrowDown");
    expect(selection()).toEqual([HR]);
  });

  test("Shift+Arrow extends the range through the same helper the mouse uses", async () => {
    click(SECTION);
    await renderLayers();
    press(row(SECTION), "ArrowDown", { shiftKey: true });
    expect(selection()).toEqual([SECTION, H2]);
  });
});
