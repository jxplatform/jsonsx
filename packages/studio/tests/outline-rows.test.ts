/**
 * The Outline as a tree: what a row SAYS, what a row COSTS, and how a keyboard walks it.
 *
 * `tests/layers-panel-gaps.test.ts` covers the rows' badges, collapse and rename. This file covers
 * the three things the audit found by driving the real app — a wall of rows all reading "div", five
 * always-visible action buttons on every one of them, and a tree no keyboard could reach.
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

const {
  OUTLINE_ROW_MAX_ITEMS,
  applyTreeRovingTabindex,
  clearHoverActions,
  indentWidth,
  outlineLabel,
  renderLayersTemplate,
} = await import("../src/panels/layers-panel");

// ─── Harness ─────────────────────────────────────────────────────────────────

let host: HTMLElement;
let rerenders = 0;

async function renderLayers(): Promise<HTMLElement> {
  const tpl = renderLayersTemplate({
    navigateToComponent: () => {},
    rerender: () => {
      rerenders += 1;
      void renderLayers();
    },
  });
  await renderInto(tpl, host);
  return host;
}

function row(path: JxPath): HTMLElement {
  const el = host.querySelector<HTMLElement>(`.layer-row[data-path="${pathKey(path)}"]`);
  if (!el) {
    throw new Error(`no row for ${pathKey(path)}`);
  }
  return el;
}

function tree(): HTMLElement {
  return host.querySelector(".layers-tree") as HTMLElement;
}

/** Rows in visual order, as the keyboard walks them. */
function rows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.layer-row[role="treeitem"]')];
}

function press(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
}

/** A section containing a heading and a paragraph, a bare div, and a nested chain. */
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
      { children: [{ children: [{ tagName: "span" }], tagName: "div" }], tagName: "div" },
      { tagName: "img" },
    ],
    tagName: "div",
  };
}

beforeEach(() => {
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
  rerenders = 0;
  clearHoverActions();
  resetWorkspaceWithTab(makeDoc());
});

afterEach(() => {
  clearHoverActions();
  closeAllTabs();
  document.body.innerHTML = "";
});

// ─── What a row says ─────────────────────────────────────────────────────────

describe("outlineLabel", () => {
  const label = (node: Partial<JxMutableNode>) => outlineLabel(node as JxMutableNode);

  test("a $title wins over everything", () => {
    expect(label({ $id: "hero", $title: "Hero band", tagName: "section" })).toBe("Hero band");
  });

  test("an $id reads as one", () => {
    expect(label({ $id: "hero", tagName: "section" })).toBe("#hero");
  });

  test("own text beats a class", () => {
    expect(label({ attributes: { class: "lede" }, tagName: "p", textContent: "Hello" })).toBe(
      "Hello",
    );
  });

  test("a class reads as one, and only the first", () => {
    expect(label({ attributes: { class: "card  card--wide" }, tagName: "div" })).toBe(".card");
  });

  test("a bound class attribute is not a name", () => {
    expect(label({ attributes: { class: { $ref: "#/state/cls" } }, tagName: "div" } as never)).toBe(
      "",
    );
  });

  test("a landmark gets its human name", () => {
    expect(label({ children: [], tagName: "nav" })).toBe("Navigation");
    expect(label({ children: [], tagName: "aside" })).toBe("Sidebar");
  });

  test("a container borrows the first text under it, quoted", () => {
    expect(
      label({
        children: [{ children: [{ tagName: "h2", textContent: "Opening hours" }], tagName: "div" }],
        tagName: "section",
      }),
    ).toBe("“Opening hours”");
  });

  test("a bare string child counts as text", () => {
    expect(label({ children: ["Just words"], tagName: "div" })).toBe("“Just words”");
  });

  test("the walk is bounded, so a deep wrapper falls back to its child count", () => {
    // Five levels of wrapper: past the depth bound, so the text is not borrowed.
    let node: JxMutableNode = { tagName: "span", textContent: "deep" };
    for (let i = 0; i < 5; i++) {
      node = { children: [node], tagName: "div" };
    }
    expect(label(node)).toBe("1 item");
  });

  test("a container with nothing to say counts its children instead of repeating the tag", () => {
    expect(label({ children: [{ tagName: "br" }, { tagName: "br" }], tagName: "div" })).toBe(
      "2 items",
    );
  });

  test("an empty node says nothing at all — the badge is the whole answer", () => {
    expect(label({ children: [], tagName: "div" })).toBe("");
    expect(label({ tagName: "img" })).toBe("");
  });

  test("repeaters and slots keep the composed name nodeLabel gives them", () => {
    expect(label({ $prototype: "Array", items: { $ref: "#/state/posts" } } as never)).toBe(
      "Repeater → #/state/posts",
    );
    expect(label({ attributes: { name: "footer" }, tagName: "slot" })).toContain("footer");
  });

  test("long text is trimmed and ellipsized to the column's budget", () => {
    const long = "a very long sentence that no 240 pixel column will ever manage to show in full";
    const out = label({ tagName: "p", textContent: long });
    expect(out.length).toBe(33);
    expect(out.endsWith("…")).toBe(true);
  });

  test("rows are what the panel actually renders", async () => {
    await renderLayers();
    const labels = rows().map((r) => r.querySelector(".layer-label")!.textContent);
    // The old tree printed "div" four times over; nothing here repeats its own badge.
    expect(labels).toEqual([
      "“Opening hours”", // The document root borrows the first words on the page…
      "“Opening hours”", // …as does the section wrapping them.
      "Opening hours",
      "Every day",
      "1 item",
      "1 item",
      "",
      "",
    ]);
  });
});

// ─── What a row costs, and where the verbs are ───────────────────────────────

describe("row actions", () => {
  test("only the selected row carries buttons; every other row's slot is empty", async () => {
    activeTab.value!.session.selection = ["children", 2];
    await renderLayers();
    expect(row(["children", 2]).querySelectorAll("sp-action-button").length).toBe(
      OUTLINE_ROW_MAX_ITEMS + 1, // The four moves plus ⋮.
    );
    for (const other of rows().filter((r) => r !== row(["children", 2]))) {
      expect(other.querySelectorAll("sp-action-button")).toHaveLength(0);
    }
  });

  test("hovering a row builds its cluster, and leaving the tree takes it down", async () => {
    activeTab.value!.session.selection = ["children", 2];
    await renderLayers();
    const hovered = row(["children", 0]);
    expect(hovered.querySelectorAll("sp-action-button")).toHaveLength(0);

    hovered.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(hovered.querySelectorAll("sp-action-button").length).toBeGreaterThan(0);
    // The verbs are the HOVERED row's, not the selection's: children/0 is first, so it cannot move up.
    expect(
      hovered
        .querySelector('sp-action-button[data-command="selection.moveUp"]')!
        .hasAttribute("disabled"),
    ).toBe(true);

    tree().dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    expect(hovered.querySelectorAll("sp-action-button")).toHaveLength(0);
  });

  test("moving the pointer to another row moves the cluster with it — one at a time", async () => {
    await renderLayers();
    const first = row(["children", 0]);
    const second = row(["children", 1]);
    first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    second.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(first.querySelectorAll("sp-action-button")).toHaveLength(0);
    expect(second.querySelectorAll("sp-action-button").length).toBeGreaterThan(0);

    // A second mouseover inside the SAME row (from a child element) is not a new mount.
    const before = second.querySelector("sp-action-button");
    second
      .querySelector(".layer-label")!
      .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(second.querySelector("sp-action-button") === before).toBe(true);
  });

  test("a mouseover outside any row leaves the current cluster alone", async () => {
    await renderLayers();
    const first = row(["children", 0]);
    first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    tree().dispatchEvent(new MouseEvent("mouseover", { bubbles: false }));
    expect(first.querySelectorAll("sp-action-button").length).toBeGreaterThan(0);
  });

  test("the hovered row's cluster is recomputed after a re-render", async () => {
    // Rows are keyed by path, so an edit can leave the pointer on a DOM row whose node — and whose
    // Answer to "can this move down" — has changed underneath it.
    await renderLayers();
    const hovered = row(["children", 2]);
    hovered.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const moveDown = () =>
      hovered
        .querySelector('sp-action-button[data-command="selection.moveDown"]')!
        .hasAttribute("disabled");
    expect(moveDown()).toBe(true); // Last child.

    (activeTab.value!.doc.document.children as JxMutableNode[]).push({ tagName: "hr" });
    await renderLayers();
    expect(hovered.isConnected).toBe(true);
    expect(moveDown()).toBe(false); // No longer last.
  });

  test("a row that becomes the selection keeps its verbs, and the hover mount steps aside", async () => {
    await renderLayers();
    const target = row(["children", 1]);
    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    activeTab.value!.session.selection = ["children", 1];
    await renderLayers();

    const now = row(["children", 1]);
    expect(now.classList.contains("selected")).toBe(true);
    expect(now.querySelectorAll("sp-action-button").length).toBe(OUTLINE_ROW_MAX_ITEMS + 1);
    // And exactly one cluster exists in the whole tree.
    expect(host.querySelectorAll(".layer-actions:not(:empty)")).toHaveLength(1);
  });

  test("the root row has no verbs at all — it is not a node you can move or delete", async () => {
    activeTab.value!.session.selection = [];
    await renderLayers();
    expect(row([]).querySelector(".layer-actions")).toBeNull();
    row([]).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(row([]).querySelectorAll("sp-action-button")).toHaveLength(0);
  });
});

// ─── The column, and the indent that broke it ────────────────────────────────

describe("indentWidth", () => {
  test("indent grows by a step per level", () => {
    expect(indentWidth(0)).toBe(0);
    expect(indentWidth(1)).toBe(16);
    expect(indentWidth(3)).toBe(48);
  });

  test("and stops, so a deep node cannot push the tree out of a 240px column", () => {
    expect(indentWidth(6)).toBe(96);
    expect(indentWidth(7)).toBe(96);
    expect(indentWidth(40)).toBe(96);
  });
});

// ─── The tree, as a keyboard surface ─────────────────────────────────────────

describe("role=tree and the keyboard model", () => {
  test("the container and its rows declare themselves", async () => {
    await renderLayers();
    expect(tree().getAttribute("role")).toBe("tree");
    expect(tree().getAttribute("aria-label")).toBe("Document outline");
    expect(row([]).getAttribute("role")).toBe("treeitem");
    expect(row([]).getAttribute("aria-level")).toBe("1");
    expect(row(["children", 0]).getAttribute("aria-level")).toBe("2");
    expect(row(["children", 0]).getAttribute("aria-expanded")).toBe("true");
    expect(row(["children", 2]).getAttribute("aria-expanded")).toBeNull(); // A leaf.
  });

  test("aria-selected follows the selection, and so does the single tab stop", async () => {
    activeTab.value!.session.selection = ["children", 2];
    await renderLayers();
    expect(row(["children", 2]).getAttribute("aria-selected")).toBe("true");
    const stops = rows().filter((r) => r.tabIndex === 0);
    expect(stops.map((r) => r.dataset.path)).toEqual(["children/2"]);
  });

  test("with nothing selected the first row is the way in", async () => {
    await renderLayers();
    applyTreeRovingTabindex(tree());
    expect(
      rows()
        .filter((r) => r.tabIndex === 0)
        .map((r) => r.dataset.path),
    ).toEqual([""]);
  });

  test("an empty tree has no tab stop to hand out", async () => {
    resetWorkspaceWithTab({ children: [], tagName: "div" } as JxMutableNode);
    activeTab.value!.doc.mode = "content";
    await renderLayers();
    expect(rows()).toHaveLength(0);
    expect(() => applyTreeRovingTabindex(tree())).not.toThrow();
  });

  test("↑ and ↓ walk the visible rows and take the selection with them", async () => {
    activeTab.value!.session.selection = [];
    await renderLayers();
    press(row([]), "ArrowDown");
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
    expect((document.activeElement as HTMLElement).dataset.path).toBe("children/0");

    press(row(["children", 0]), "ArrowUp");
    expect(activeTab.value!.session.selection).toEqual([]);
  });

  test("↓ at the last row and ↑ at the first stay put", async () => {
    await renderLayers();
    const before = rows().length;
    press(rows().at(-1)!, "ArrowDown");
    press(rows()[0]!, "ArrowUp");
    expect(rows()).toHaveLength(before);
    expect(activeTab.value!.session.selection).toBeNull();
  });

  test("→ expands a collapsed row, then descends into it", async () => {
    view._layersCollapsed = new Set([pathKey(["children", 0])]);
    await renderLayers();
    expect(row(["children", 0]).getAttribute("aria-expanded")).toBe("false");

    press(row(["children", 0]), "ArrowRight");
    expect(rerenders).toBe(1);
    expect(view._layersCollapsed!.has(pathKey(["children", 0]))).toBe(false);

    await renderLayers();
    press(row(["children", 0]), "ArrowRight");
    expect((document.activeElement as HTMLElement).dataset.path).toBe("children/0/children/0");
  });

  test("→ on a leaf does nothing", async () => {
    await renderLayers();
    press(row(["children", 2]), "ArrowRight");
    expect(rerenders).toBe(0);
  });

  test("← collapses an expanded row, then climbs to its parent", async () => {
    await renderLayers();
    press(row(["children", 0]), "ArrowLeft");
    expect(view._layersCollapsed!.has(pathKey(["children", 0]))).toBe(true);
    expect(rerenders).toBe(1);

    await renderLayers();
    press(row(["children", 0]), "ArrowLeft");
    expect(activeTab.value!.session.selection).toEqual([]);
    expect((document.activeElement as HTMLElement).dataset.path).toBe("");
  });

  test("← at the top of the tree has nowhere to go", async () => {
    await renderLayers();
    press(row([]), "ArrowLeft");
    expect(activeTab.value!.session.selection).toBeNull();
  });

  test("Home and End jump to the ends and select", async () => {
    await renderLayers();
    press(row(["children", 0]), "End");
    expect(activeTab.value!.session.selection).toEqual(["children", 2]);
    press(row(["children", 2]), "Home");
    expect(activeTab.value!.session.selection).toEqual([]);
  });

  test("Enter and F2 rename the row in place", async () => {
    await renderLayers();
    press(row(["children", 2]), "Enter");
    expect(row(["children", 2]).querySelector(".layer-title-input")).not.toBeNull();
    expect(activeTab.value!.session.selection).toEqual(["children", 2]);

    (row(["children", 2]).querySelector(".layer-title-input") as HTMLElement).remove();
    press(row(["children", 0]), "F2");
    expect(row(["children", 0]).querySelector(".layer-title-input")).not.toBeNull();
  });

  test("a key pressed outside a row is not the tree's business", async () => {
    await renderLayers();
    press(tree(), "ArrowDown");
    expect(activeTab.value!.session.selection).toBeNull();
  });

  test("an unhandled key falls through", async () => {
    activeTab.value!.session.selection = [];
    await renderLayers();
    press(row([]), "a");
    expect(activeTab.value!.session.selection).toEqual([]);
  });
});
