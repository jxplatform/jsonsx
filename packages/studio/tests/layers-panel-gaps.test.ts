/**
 * Layers panel — renderLayersTemplate rows (badges, visibility, move actions, collapse) and
 * startLayerTitleEdit inline rename.
 */
import { flush, key, renderInto, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderLayersTemplate, startLayerTitleEdit } from "../src/panels/layers-panel";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { pathKey } from "../src/store";
import { view } from "../src/view";
import { initLayers } from "../src/ui/layers";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../src/state";

const LONG_TEXT = "this is a very long text node well beyond forty characters of content";

function makeDoc(): JxMutableNode {
  return {
    children: [
      {
        children: [
          { tagName: "h2", textContent: "Title" },
          { children: [LONG_TEXT, { tagName: "span", textContent: "inline" }], tagName: "p" },
        ],
        tagName: "section",
      },
      { tagName: "p", textContent: "First" },
      {
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/things" },
          map: { tagName: "li", textContent: "item" },
        } as unknown as JxMutableNode[],
        tagName: "ul",
      },
      {
        $switch: "${mode}",
        cases: {
          alpha: { tagName: "p", textContent: "A" },
          beta: { $ref: "./beta.json" },
        },
        tagName: "div",
      } as unknown as JxMutableNode,
      { tagName: "img" },
    ],
    tagName: "div",
  };
}

let host: HTMLElement;

async function renderLayers(opts: { rerender?: () => void; nav?: (p: string) => void } = {}) {
  const tpl = renderLayersTemplate({
    navigateToComponent: opts.nav ?? (() => {}),
    rerender: opts.rerender ?? (() => {}),
  });
  await renderInto(tpl, host);
  return host;
}

function rowByKey(path: JxPath): HTMLElement | null {
  return host.querySelector(`.layer-row[data-path="${pathKey(path)}"]`);
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
  resetWorkspaceWithTab(makeDoc());
});

afterEach(() => {
  closeAllTabs();
  document.body.innerHTML = "";
});

describe("renderLayersTemplate — rows and badges", () => {
  test("renders element rows with tag badges and labels", async () => {
    await renderLayers();
    const root = rowByKey([]);
    expect(root).not.toBeNull();
    expect(root!.querySelector(".layer-tag")!.textContent).toBe("div");

    const section = rowByKey(["children", 0]);
    expect(section).not.toBeNull();
    expect(section!.querySelector(".layer-tag")!.textContent).toBe("section");
  });

  test("text node children render truncated italic preview rows", async () => {
    await renderLayers();
    const labels = [...host.querySelectorAll(".layer-label")].map((el) => el.textContent ?? "");
    const preview = labels.find((t) => t.endsWith("…"));
    expect(preview).toBeDefined();
    expect(preview!.length).toBe(41); // 40 chars + ellipsis
    expect(preview!.startsWith(LONG_TEXT.slice(0, 40))).toBe(true);
  });

  test("inline elements (span inside p) are skipped", async () => {
    await renderLayers();
    expect(rowByKey(["children", 0, "children", 1, "children", 1])).toBeNull();
  });

  test("map node renders repeater badge and template child", async () => {
    await renderLayers();
    // The repeater is now a first-class member of the <ul>'s children (normalized on load).
    const mapRow = rowByKey(["children", 2, "children", 0]);
    expect(mapRow).not.toBeNull();
    expect(mapRow!.querySelector(".map-tag")!.textContent).toBe("↻");
    expect(mapRow!.querySelector(".layer-label")!.textContent).toContain("Repeater");
    // The map node is draggable/structural like any element.
    expect(mapRow!.dataset.dndRow).toBe(pathKey(["children", 2, "children", 0]));
    expect(mapRow!.querySelector(".layer-drag-handle")).not.toBeNull();
    // The map template li renders as a normal element row.
    expect(rowByKey(["children", 2, "children", 0, "map"])).not.toBeNull();
  });

  test("$switch node gets switch badge; cases get case and case-ref badges", async () => {
    await renderLayers();
    const switchRow = rowByKey(["children", 3]);
    expect(switchRow!.querySelector(".switch-tag")!.textContent).toBe("⇄");

    const caseRow = rowByKey(["children", 3, "cases", "alpha"]);
    expect(caseRow!.querySelector(".case-tag")!.textContent).toBe("alpha");

    const refRow = rowByKey(["children", 3, "cases", "beta"]);
    expect(refRow!.querySelector(".case-tag")!.textContent).toBe("beta");
    const refLabel = refRow!.querySelector(".layer-label") as HTMLElement;
    expect(refLabel.textContent).toBe("./beta.json");
    expect(refLabel.getAttribute("style")).toContain("italic");
  });

  test("content mode skips the root row", async () => {
    activeTab.value!.doc.mode = "content";
    await renderLayers();
    expect(rowByKey([])).toBeNull();
    expect(rowByKey(["children", 0])).not.toBeNull();
  });

  test("root row has no move actions", async () => {
    await renderLayers();
    expect(rowByKey([])!.querySelector(".layer-actions")).toBeNull();
  });
});

describe("renderLayersTemplate — selection and collapse", () => {
  test("clicking a row selects its path", async () => {
    await renderLayers();
    rowByKey(["children", 1])!.click();
    expect(activeTab.value!.session.selection).toEqual(["children", 1]);
  });

  test("selected row gets the selected class", async () => {
    activeTab.value!.session.selection = ["children", 0];
    await renderLayers();
    expect(rowByKey(["children", 0])!.classList.contains("selected")).toBe(true);
  });

  test("clicking the toggle collapses and hides descendants", async () => {
    const rerender = mock(() => {});
    await renderLayers({ rerender });
    const toggle = rowByKey(["children", 0])!.querySelector(".layer-toggle") as HTMLElement;
    expect(toggle.querySelector("sp-icon-chevron-down")).not.toBeNull();
    toggle.click();
    expect(rerender).toHaveBeenCalledTimes(1);
    expect(view._layersCollapsed!.has("children/0")).toBe(true);

    await renderLayers({ rerender });
    expect(rowByKey(["children", 0, "children", 0])).toBeNull();
    const toggleNow = rowByKey(["children", 0])!.querySelector(".layer-toggle") as HTMLElement;
    expect(toggleNow.querySelector("sp-icon-chevron-right")).not.toBeNull();

    // Toggle back open
    toggleNow.click();
    expect(view._layersCollapsed!.has("children/0")).toBe(false);
  });

  test("non-expandable rows render no chevron", async () => {
    await renderLayers();
    const imgToggle = rowByKey(["children", 4])!.querySelector(".layer-toggle") as HTMLElement;
    expect(imgToggle.children.length).toBe(0);
  });

  test("tree click outside a toggle is a no-op for collapse state", async () => {
    const rerender = mock(() => {});
    await renderLayers({ rerender });
    (host.querySelector(".layer-label") as HTMLElement).click();
    expect(view._layersCollapsed!.size).toBe(0);
  });

  test("contextmenu on an element row selects it", async () => {
    await renderLayers();
    const row = rowByKey(["children", 1]) as HTMLElement;
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
    expect(activeTab.value!.session.selection).toEqual(["children", 1]);
  });
});

describe("renderLayersTemplate — move and delete actions", () => {
  function buttons(path: JxPath): Record<string, HTMLElement> {
    const out: Record<string, HTMLElement> = {};
    for (const btn of rowByKey(path)!.querySelectorAll("sp-action-button")) {
      out[btn.getAttribute("title") ?? ""] = btn as HTMLElement;
    }
    return out;
  }

  test("first child cannot move up, last cannot move down", async () => {
    await renderLayers();
    expect(buttons(["children", 0])["Move up"]).toBeUndefined();
    expect(buttons(["children", 0])["Move down"]).toBeDefined();
    expect(buttons(["children", 4])["Move down"]).toBeUndefined();
    expect(buttons(["children", 4])["Move up"]).toBeDefined();
  });

  test("move down reorders siblings", async () => {
    await renderLayers();
    buttons(["children", 0])["Move down"]!.click();
    const children = activeTab.value!.doc.document.children as JxMutableNode[];
    expect(children[0]!.tagName).toBe("p");
    expect(children[1]!.tagName).toBe("section");
  });

  test("move up reorders siblings", async () => {
    await renderLayers();
    buttons(["children", 1])["Move up"]!.click();
    const children = activeTab.value!.doc.document.children as JxMutableNode[];
    expect(children[0]!.tagName).toBe("p");
    expect(children[1]!.tagName).toBe("section");
  });

  test("move into previous sibling appends the node to that sibling's children", async () => {
    await renderLayers();
    const btn = buttons(["children", 1])["Move into previous sibling"];
    expect(btn).toBeDefined();
    btn!.click();
    const children = activeTab.value!.doc.document.children as JxMutableNode[];
    expect(children.length).toBe(4);
    const section = children[0] as JxMutableNode;
    const sectionChildren = section.children as JxMutableNode[];
    expect(sectionChildren.length).toBe(3);
    expect(sectionChildren[2]!.textContent).toBe("First");
    expect(children.map((c) => c.textContent)).not.toContain("First");
  });

  test("move-in is unavailable when previous sibling is not a container", async () => {
    await renderLayers();
    // Children[2] (ul with $map children) follows children[1] (p with no children array)
    expect(buttons(["children", 2])["Move into previous sibling"]).toBeUndefined();
  });

  test("move out of parent lifts node after its parent", async () => {
    await renderLayers();
    const btn = buttons(["children", 0, "children", 0])["Move out of parent"];
    expect(btn).toBeDefined();
    btn!.click();
    const children = activeTab.value!.doc.document.children as JxMutableNode[];
    expect(children[1]!.tagName).toBe("h2");
    const section = children[0] as JxMutableNode;
    expect((section.children as JxMutableNode[]).length).toBe(1);
  });

  test("delete removes the node", async () => {
    await renderLayers();
    buttons(["children", 1])["Delete"]!.click();
    const children = activeTab.value!.doc.document.children as JxMutableNode[];
    expect(children.length).toBe(4);
    expect(children.map((c) => c.tagName)).not.toContain("p");
  });

  test("dnd cleanups run and reset on each render", async () => {
    const cleanup = mock(() => {});
    view.dndCleanups = [cleanup];
    await renderLayers();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(view.dndCleanups).toEqual([]);
  });
});

describe("startLayerTitleEdit", () => {
  test("dblclick starts editing; Enter-blur commits $title", async () => {
    const rerender = mock(() => {});
    await renderLayers({ rerender });
    const row = rowByKey(["children", 1]) as HTMLElement;
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await flush();

    const input = row.querySelector(".layer-title-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    const label = row.querySelector(".layer-label") as HTMLElement;
    expect(label.style.display).toBe("none");

    input.value = "Hero paragraph";
    key(input, "Enter");
    input.dispatchEvent(new Event("blur"));
    await flush();

    const node = (activeTab.value!.doc.document.children as JxMutableNode[])[1]!;
    expect(node.$title).toBe("Hero paragraph");
    expect(rerender).toHaveBeenCalled();
    expect(row.querySelector(".layer-title-input")).toBeNull();
    expect(label.style.display).toBe("");
  });

  test("empty value commits undefined (clears $title)", async () => {
    const node = (activeTab.value!.doc.document.children as JxMutableNode[])[1]!;
    node.$title = "Old";
    await renderLayers();
    const row = rowByKey(["children", 1]) as HTMLElement;
    startLayerTitleEdit(["children", 1], () => {});
    const input = row.querySelector(".layer-title-input") as HTMLInputElement;
    expect(input.value).toBe("Old");
    input.value = "   ";
    input.dispatchEvent(new Event("blur"));
    expect(node.$title).toBeUndefined();
  });

  test("Escape cancels without mutating", async () => {
    const rerender = mock(() => {});
    await renderLayers();
    const row = rowByKey(["children", 1]) as HTMLElement;
    startLayerTitleEdit(["children", 1], rerender);
    const input = row.querySelector(".layer-title-input") as HTMLInputElement;
    input.value = "Should not stick";
    key(input, "Escape");
    const node = (activeTab.value!.doc.document.children as JxMutableNode[])[1]!;
    expect(node.$title).toBeUndefined();
    expect(rerender).toHaveBeenCalledTimes(1);
    expect(row.querySelector(".layer-title-input")).toBeNull();
    // A late blur after cancel is a no-op (committed guard)
    input.dispatchEvent(new Event("blur"));
    expect(node.$title).toBeUndefined();
  });

  test("returns silently when row is missing", async () => {
    await renderLayers();
    expect(() => {
      startLayerTitleEdit(["children", 99], () => {});
    }).not.toThrow();
    expect(document.querySelector(".layer-title-input")).toBeNull();
  });

  test("returns silently when no active tab", async () => {
    await renderLayers();
    closeAllTabs();
    expect(() => {
      startLayerTitleEdit(["children", 1], () => {});
    }).not.toThrow();
    expect(document.querySelector(".layer-title-input")).toBeNull();
  });
});

describe("renderLayersTemplate — keyed rows", () => {
  test("a stale display:none does not leak to a stable-key sibling after a structural move", async () => {
    // Two sibling containers: `wrap` holds a repeater, `target` holds a paragraph. Mirrors the
    // Real bug: dragging the repeater into `target` left `display:none` on the dragged subtree,
    // Which — under positional (unkeyed) reuse — leaked onto `target`'s paragraph row.
    resetWorkspaceWithTab({
      children: [
        {
          $props: {},
          children: [
            {
              $prototype: "Array",
              items: { $ref: "#/state/things" },
              map: { tagName: "li", textContent: "item" },
            },
          ],
          tagName: "wrap",
        },
        { $props: {}, children: [{ tagName: "p", textContent: "keep me" }], tagName: "target" },
      ],
      tagName: "div",
    } as unknown as JxMutableNode);

    await renderLayers();
    // Simulate hideDescendantRows leaving display:none on the dragged repeater's template row.
    const template = rowByKey(["children", 0, "children", 0, "map"]);
    expect(template).not.toBeNull();
    template!.style.display = "none";

    // Move the Array node into `target` (append) — the repeater's key changes, but the paragraph's
    // Key (children/1/children/0) stays stable, so its keyed DOM node is reused untouched.
    const doc = activeTab.value!.doc.document as unknown as {
      children: { children: unknown[] }[];
    };
    const arr = doc.children[0]!.children.splice(0, 1)[0]!;
    doc.children[1]!.children.push(arr);
    await renderLayers();

    const para = rowByKey(["children", 1, "children", 0]);
    expect(para).not.toBeNull();
    expect(para!.textContent).toContain("keep me");
    expect(para!.style.display).not.toBe("none");
  });
});
