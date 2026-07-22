/**
 * Coverage-gap tests for panel modules:
 *
 * - Stylebook-doc: nested `@` blocks stripped during media hoisting, and top-level non-tag selector
 *   passthrough.
 * - Tab-bar: the render catch when the template throws.
 * - Layers-panel: slot badges, move-in container detection (void / legacy array-object / non-array
 *   children), stray-toggle clicks, and startLayerTitleEdit guards.
 * - Dnd: the onGenerateDragPreview suppressors for layer and component drags.
 */
import { flush, renderInto, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../src/state";

type AnyRec = Record<string, any>;

const draggables: AnyRec[] = [];
let previewsDisabled = 0;

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: (cfg: AnyRec) => {
    draggables.push(cfg);
    return () => {};
  },
  dropTargetForElements: () => () => {},
  monitorForElements: () => () => {},
}));
void mock.module("@atlaskit/pragmatic-drag-and-drop/combine", () => ({
  combine:
    (...fns: (() => void)[]) =>
    () => {
      for (const fn of fns) {
        fn();
      }
    },
}));
void mock.module("@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview", () => ({
  disableNativeDragPreview: () => {
    previewsDisabled += 1;
  },
}));
void mock.module("@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item", () => ({
  attachInstruction: (data: AnyRec) => data,
  extractInstruction: (data: AnyRec) => data.__instr ?? null,
}));
void mock.module("../src/panels/component-preview", () => ({
  renderComponentPreview: async (comp: AnyRec) => {
    const el = document.createElement(comp.tagName);
    el.textContent = "preview";
    return el;
  },
}));

const { buildStylebookDoc, hasTagStyle, transposeStylebookStyle } =
  await import("../src/panels/stylebook-doc");
const tabBar = await import("../src/panels/tab-bar");
const { renderLayersTemplate, startLayerTitleEdit } = await import("../src/panels/layers-panel");
const dnd = await import("../src/panels/dnd");
const { initShellRefs } = await import("../src/store");
const { componentRegistry } = await import("../src/files/components");
const { view } = await import("../src/view");
const { activeTab, closeAllTabs } = await import("../src/workspace/workspace");
const { initLayers } = await import("../src/ui/layers");

// ─── Stylebook doc transforms ────────────────────────────────────────────────

describe("transposeStylebookStyle gaps", () => {
  test("media blocks nested inside a hoisted tag-media rule are stripped", () => {
    const out = transposeStylebookStyle({
      p: {
        "@--sm": {
          color: "red",
          "@--nested": { color: "blue" }, // Already-hoisted media can't nest deeper.
        },
        margin: "0",
      },
    } as never) as Record<string, any>;
    expect(out["& .element-card-preview p"]).toEqual({ margin: "0" });
    expect(out["@--sm"]["& .element-card-preview p"]).toEqual({ color: "red" });
    expect(JSON.stringify(out)).not.toContain("@--nested");
  });

  test("top-level non-tag selectors pass through untransformed", () => {
    const out = transposeStylebookStyle({
      ":hover": { color: "red" },
      ".brand": { color: "blue" },
      p: { margin: "0" },
    } as never) as Record<string, any>;
    expect(out[":hover"]).toEqual({ color: "red" });
    expect(out[".brand"]).toEqual({ color: "blue" });
    expect(out["& .element-card-preview p"]).toEqual({ margin: "0" });
  });

  test("hasTagStyle sees customizations under media blocks", () => {
    expect(hasTagStyle({ "@--sm": { p: { margin: "0" } } } as never, "p")).toBe(true);
    expect(hasTagStyle({ "@--sm": { p: {} } } as never, "p")).toBe(false);
  });
});

describe("buildStylebookDoc component filtering", () => {
  const meta = { $sections: [{ elements: [{ tag: "p", text: "Para" }], label: "Text" }] };
  const components = [
    { path: "components/my-card.json", tagName: "my-card" },
    { path: "components/other.json", tagName: "other-thing" },
  ] as never;

  test("the filter narrows the Components section by tag name", () => {
    const { doc, tagToCardPath } = buildStylebookDoc({
      components,
      customizedOnly: false,
      effectiveMedia: {},
      effectiveStyle: {},
      filter: "card",
      meta: meta as never,
      projectRoot: null,
    });
    expect(tagToCardPath.has("my-card")).toBe(true);
    expect(tagToCardPath.has("other-thing")).toBe(false);
    expect((doc as Record<string, unknown>).$elements).toEqual([
      { $ref: "/components/my-card.json" },
    ]);
  });

  test("customizedOnly keeps only components the effective style touches", () => {
    const { tagToCardPath } = buildStylebookDoc({
      components,
      customizedOnly: true,
      effectiveMedia: {},
      effectiveStyle: { "my-card": { color: "red" } } as never,
      filter: "",
      meta: meta as never,
      projectRoot: null,
    });
    expect(tagToCardPath.has("my-card")).toBe(true);
    expect(tagToCardPath.has("other-thing")).toBe(false);
    expect(tagToCardPath.has("p")).toBe(false); // Uncustomized element sections drop too.
  });
});

// ─── Tab bar render catch ────────────────────────────────────────────────────

describe("tab-bar interaction gaps", () => {
  function makeTabBarCtx(overrides: Partial<Parameters<typeof tabBar.mount>[1]> = {}) {
    return {
      closeFormulaWorkspace: mock(() => {}),
      closeFunctionEditor: mock(() => {}),
      exportFile: mock(() => {}),
      getCanvasMode: mock(() => "design"),
      navigateBack: mock(() => {}),
      navigateToLevel: mock((_level: number) => {}),
      parseMediaEntries: () => ({ baseWidth: 1280, featureQueries: [], sizeBreakpoints: [] }),
      ...overrides,
    };
  }

  afterEach(() => {
    tabBar.unmount();
    closeAllTabs();
    document.body.innerHTML = "";
  });

  function btnByText(root: HTMLElement, text: string): HTMLElement {
    return [...root.querySelectorAll("sp-action-button")].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLElement;
  }

  test("design-mode zoom out / reset / Fit run their panzoom actions", async () => {
    resetStudioState();
    const tab = resetWorkspaceWithTab();
    tab.session.ui.zoom = 2.4;
    view.panzoomWrap = null; // Canvas-utils actions guard on this and no-op cleanly.
    const root = document.createElement("div");
    document.body.append(root);
    tabBar.mount(root, makeTabBarCtx() as never);
    await flush();

    btnByText(root, "−").click();
    await flush();
    expect(tab.session.ui.zoom).toBeCloseTo(2);

    (root.querySelector(".tb-zoom-label") as HTMLElement).click();
    btnByText(root, "Fit").click();
    await flush();
    expect(tab.session.ui.zoom).toBeCloseTo(2); // Guarded no-ops without a panzoom surface.
  });

  test("document-stack breadcrumbs navigate to their level", async () => {
    resetStudioState();
    const tab = resetWorkspaceWithTab(undefined, { documentPath: "components/card.json" });
    tab.session.documentStack = [{ documentPath: "pages/index.json" }] as never;
    const ctx = makeTabBarCtx();
    const root = document.createElement("div");
    document.body.append(root);
    tabBar.mount(root, ctx as never);
    await flush();

    const crumb = root.querySelector(".breadcrumb-item.clickable") as HTMLElement;
    expect(crumb.textContent?.trim()).toBe("index.json");
    crumb.click();
    expect(ctx.navigateToLevel).toHaveBeenCalledWith(0);
  });

  test("render after unmount is a guarded no-op", () => {
    expect(() => {
      tabBar.render();
    }).not.toThrow();
  });
});

describe("tab-bar render failure", () => {
  test("a throwing template is caught and does not break mount", async () => {
    resetStudioState();
    resetWorkspaceWithTab();
    const host = document.createElement("div");
    document.body.append(host);
    expect(() => {
      tabBar.mount(host, {
        closeFormulaWorkspace: () => {},
        closeFunctionEditor: () => {},
        exportFile: () => {},
        getCanvasMode: () => {
          throw new Error("mode exploded");
        },
        navigateBack: () => {},
        navigateToLevel: () => {},
        parseMediaEntries: () => ({ baseWidth: 1280, featureQueries: [], sizeBreakpoints: [] }),
      });
    }).not.toThrow();
    await flush();
    expect(() => {
      tabBar.render();
    }).not.toThrow();
    tabBar.unmount();
    host.remove();
  });
});

// ─── Layers panel ────────────────────────────────────────────────────────────

describe("layers-panel gaps", () => {
  let host: HTMLElement;

  function makeDoc(): JxMutableNode {
    return {
      children: [
        { tagName: "img" },
        { tagName: "p", textContent: "after-img" },
        { children: [{ tagName: "li", textContent: "x" }], tagName: "ul" },
        { tagName: "p", textContent: "after-ul" },
        { children: [{ tagName: "em", textContent: "y" }], tagName: "div" },
        { tagName: "p", textContent: "after-ref" },
        { attributes: { name: "header" }, tagName: "slot" },
        { tagName: "slot" },
      ],
      tagName: "div",
    };
  }

  async function renderLayers() {
    const tpl = renderLayersTemplate({ navigateToComponent: () => {}, rerender: () => {} });
    await renderInto(tpl, host);
    return host;
  }

  function rowByKey(path: JxPath): HTMLElement | null {
    return host.querySelector(`.layer-row[data-path="${path.join("/")}"]`);
  }

  function moveInButton(path: JxPath): HTMLElement | undefined {
    return [...(rowByKey(path)?.querySelectorAll("sp-action-button") ?? [])].find(
      (b) => b.getAttribute("title") === "Move into previous sibling",
    ) as HTMLElement | undefined;
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

  test("slot rows get the slot badge with named and default titles", async () => {
    await renderLayers();
    const named = rowByKey(["children", 6])!.querySelector(".slot-tag")!;
    expect(named.textContent).toBe("▣");
    expect(named.getAttribute("title")).toBe('Slot "header"');
    const anonymous = rowByKey(["children", 7])!.querySelector(".slot-tag")!;
    expect(anonymous.getAttribute("title")).toBe("Default slot");
  });

  test("move-in is unavailable after a void sibling", async () => {
    await renderLayers();
    expect(moveInButton(["children", 1])).toBeUndefined();
  });

  test("a legacy array-object children sibling still counts as a container", async () => {
    const doc = activeTab.value!.doc.document as AnyRec;
    doc.children[2].children = {
      $prototype: "Array",
      items: { $ref: "#/state/things" },
      map: { tagName: "li", textContent: "item" },
    };
    await renderLayers();
    expect(moveInButton(["children", 3])).toBeDefined();
  });

  test("non-array object children (a $ref) do not count as a container", async () => {
    const doc = activeTab.value!.doc.document as AnyRec;
    doc.children[4].children = { $ref: "#/state/body" };
    await renderLayers();
    expect(moveInButton(["children", 5])).toBeUndefined();
  });

  test("clicking a stray toggle outside any row is a no-op", async () => {
    await renderLayers();
    const tree = host.querySelector(".layers-tree") as HTMLElement;
    const stray = document.createElement("span");
    stray.className = "layer-toggle";
    tree.append(stray);
    stray.click();
    expect(view._layersCollapsed!.size).toBe(0);
  });

  test("startLayerTitleEdit returns silently when the row has no label", async () => {
    await renderLayers();
    const bare = document.createElement("div");
    bare.className = "layer-row";
    bare.dataset.path = "children/0";
    host.querySelector(".layer-row")!.replaceWith(bare);
    expect(() => {
      startLayerTitleEdit(["children", 0], () => {});
    }).not.toThrow();
    expect(document.querySelector(".layer-title-input")).toBeNull();
  });

  test("startLayerTitleEdit returns silently when the node is gone from the doc", async () => {
    await renderLayers();
    const ghost = document.createElement("div");
    ghost.className = "layer-row";
    ghost.dataset.path = "children/99";
    const label = document.createElement("span");
    label.className = "layer-label";
    ghost.append(label);
    host.append(ghost);
    expect(() => {
      startLayerTitleEdit(["children", 99], () => {});
    }).not.toThrow();
    expect(ghost.querySelector(".layer-title-input")).toBeNull();
  });

  test("Escape after a commit is a no-op (committed guard)", async () => {
    await renderLayers();
    const rerender = mock(() => {});
    startLayerTitleEdit(["children", 1], rerender);
    const input = document.querySelector(".layer-title-input") as HTMLInputElement;
    input.value = "Committed";
    input.dispatchEvent(new Event("blur"));
    expect(rerender).toHaveBeenCalledTimes(1);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
    );
    expect(rerender).toHaveBeenCalledTimes(1);
    const node = (activeTab.value!.doc.document.children as JxMutableNode[])[1]!;
    expect(node.$title).toBe("Committed");
  });
});

// ─── DnD drag-preview suppression ────────────────────────────────────────────

describe("dnd drag previews", () => {
  const raf = () =>
    new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });

  beforeEach(() => {
    draggables.length = 0;
    previewsDisabled = 0;
    componentRegistry.length = 0;
    view.dndCleanups = [];
    document.body.innerHTML = `<div id="left-panel"></div>`;
    initShellRefs();
  });

  test("layer-row drags suppress the native drag image", async () => {
    const leftPanel = document.querySelector("#left-panel") as HTMLElement;
    leftPanel.innerHTML = `<div class="layers-container">
      <div data-dnd-row data-path="children/0" data-dnd-depth="0"></div>
    </div>`;
    dnd.registerLayersDnD();
    await raf();
    await flush();
    expect(draggables).toHaveLength(1);
    draggables[0]!.onGenerateDragPreview({ nativeSetDragImage: null });
    expect(previewsDisabled).toBe(1);
  });

  test("component-card drags suppress the native drag image", async () => {
    const leftPanel = document.querySelector("#left-panel") as HTMLElement;
    leftPanel.innerHTML = `<div class="components-section">
      <div data-component-tag="my-card"><div class="element-card-preview"></div></div>
    </div>`;
    componentRegistry.push({ tagName: "my-card" } as never);
    dnd.registerComponentsDnD();
    await raf();
    await flush();
    expect(draggables).toHaveLength(1);
    draggables[0]!.onGenerateDragPreview({ nativeSetDragImage: null });
    expect(previewsDisabled).toBe(1);
  });
});
