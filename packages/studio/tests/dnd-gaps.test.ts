/**
 * Gap tests for src/panels/dnd.ts — the registration half of the layers/components/elements
 * drag-and-drop (tests/dnd.test.ts already covers the applyDropInstruction mutations).
 *
 * The pragmatic-drag-and-drop adapter is mocked so registrations are captured and their callbacks
 * invoked directly with synthetic payloads. The tree-item hitbox is mocked so instructions can be
 * injected via a plain `__instr` key.
 */
import { flush, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";

type AnyRec = Record<string, any>;

const draggables: AnyRec[] = [];
const dropTargets: AnyRec[] = [];
const monitors: AnyRec[] = [];

mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: (cfg: AnyRec) => {
    draggables.push(cfg);
    return () => {};
  },
  dropTargetForElements: (cfg: AnyRec) => {
    dropTargets.push(cfg);
    return () => {};
  },
  monitorForElements: (cfg: AnyRec) => {
    monitors.push(cfg);
    return () => {};
  },
}));

mock.module("@atlaskit/pragmatic-drag-and-drop/combine", () => ({
  combine:
    (...fns: (() => void)[]) =>
    () => {
      for (const fn of fns) {
        fn();
      }
    },
}));

mock.module("@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item", () => ({
  attachInstruction: (data: AnyRec, opts: AnyRec) => ({ ...data, __opts: opts }),
  extractInstruction: (data: AnyRec) => data.__instr ?? null,
}));

let previewRenders = 0;
mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async (comp: AnyRec) => {
    previewRenders += 1;
    const el = document.createElement(comp.tagName);
    el.textContent = "preview";
    return el;
  },
}));

const { initShellRefs, registerRenderer } = await import("../src/store");
const { view } = await import("../src/view");
const { componentRegistry } = await import("../src/files/components");
const dnd = await import("../src/panels/dnd");

// Shell refs: dnd reads store.leftPanel which initShellRefs populates from #left-panel.
document.body.innerHTML = `<div id="left-panel"></div>`;
initShellRefs();
const leftPanel = document.querySelector("#left-panel") as HTMLElement;

let renderedPanels: string[] = [];
registerRenderer("leftPanel", () => renderedPanels.push("leftPanel"));

const raf = () =>
  new Promise((resolve) => {
    requestAnimationFrame(resolve);
  });

function makeDoc(): JxMutableNode {
  return {
    children: [
      { children: [{ tagName: "h2", textContent: "title" }], tagName: "section" },
      { tagName: "p", textContent: "first" },
      { tagName: "p", textContent: "second" },
    ],
    tagName: "div",
  };
}

/** Build a layer row whose dataset is a plain object (happy-dom's proxy breaks Object.hasOwn). */
function makeRow(path: string, depth: number, flags: { void?: boolean; expanded?: boolean } = {}) {
  const row = document.createElement("div");
  row.className = "layer-row";
  row.dataset.dndRow = "";
  row.dataset.path = path;
  const dataset: AnyRec = { dndDepth: String(depth), dndRow: "", path };
  if (flags.void) {
    dataset.dndVoid = "";
  }
  if (flags.expanded) {
    dataset.dndExpanded = "";
  }
  Object.defineProperty(row, "dataset", { configurable: true, value: dataset });
  return row;
}

/** Standard layers DOM: expanded section with a child, a void row, and a plain row. */
async function setupLayers() {
  leftPanel.innerHTML = "";
  const container = document.createElement("div");
  container.className = "layers-container";
  const tree = document.createElement("div");
  tree.className = "layers-tree";
  const rows = [
    makeRow("children/0", 0, { expanded: true }),
    makeRow("children/0/children/0", 1),
    makeRow("children/1", 0, { void: true }),
    makeRow("children/2", 0),
  ];
  tree.append(...rows);
  container.append(tree);
  leftPanel.append(container);
  dnd.registerLayersDnD();
  await raf();
  await flush();
  return { container, rows };
}

const dragFor = (el: Element) => draggables.find((d) => d.element === el)!;
const dropFor = (el: Element) => dropTargets.find((d) => d.element === el)!;

beforeEach(() => {
  draggables.length = 0;
  dropTargets.length = 0;
  monitors.length = 0;
  renderedPanels = [];
  previewRenders = 0;
  componentRegistry.length = 0;
  view.dndCleanups = [];
  view._currentDropTargetRow = null;
  view._layersCollapsed = null;
  view.layerDragSourceHeight = 0;
});

afterEach(() => {
  leftPanel.innerHTML = "";
});

describe("registerLayersDnD — registration", () => {
  test("no .layers-container is a no-op", async () => {
    leftPanel.innerHTML = "";
    dnd.registerLayersDnD();
    await raf();
    await flush();
    expect(draggables).toHaveLength(0);
    expect(monitors).toHaveLength(0);
  });

  test("registers a draggable + drop target per row and one monitor", async () => {
    const { rows } = await setupLayers();
    expect(draggables).toHaveLength(4);
    expect(dropTargets).toHaveLength(4);
    expect(monitors).toHaveLength(1);
    expect(view.dndCleanups).toHaveLength(5);
    // Combined cleanups run both halves without throwing
    for (const cleanup of view.dndCleanups) {
      cleanup();
    }
    expect(dragFor(rows[0]).getInitialData()).toEqual({
      path: ["children", 0],
      type: "tree-node",
    });
    expect(dragFor(rows[1]).getInitialData()).toEqual({
      path: ["children", 0, "children", 0],
      type: "tree-node",
    });
  });

  test("canDrag rejects drags starting on layer action buttons", async () => {
    const { rows } = await setupLayers();
    const actions = document.createElement("div");
    actions.className = "layer-actions";
    const button = document.createElement("button");
    actions.append(button);
    rows[0].append(actions);
    const orig = document.elementFromPoint;
    try {
      (document as AnyRec).elementFromPoint = () => button;
      expect(
        dragFor(rows[0]).canDrag({ element: rows[0], input: { clientX: 1, clientY: 1 } }),
      ).toBe(false);
      (document as AnyRec).elementFromPoint = () => rows[0];
      expect(
        dragFor(rows[0]).canDrag({ element: rows[0], input: { clientX: 1, clientY: 1 } }),
      ).toBe(true);
    } finally {
      (document as AnyRec).elementFromPoint = orig;
    }
  });

  test("onDragStart marks the row dragging, records its height, and hides descendants when expanded", async () => {
    const { rows } = await setupLayers();
    Object.defineProperty(rows[0], "offsetHeight", { value: 24 });
    dragFor(rows[0]).onDragStart();
    expect(rows[0].classList.contains("dragging")).toBe(true);
    expect(view.layerDragSourceHeight).toBe(24);
    expect(rows[1].style.display).toBe("none"); // Descendant of children/0
    expect(rows[2].style.display).toBe("");
    dragFor(rows[0]).onDrop();
    expect(rows[0].classList.contains("dragging")).toBe(false);
    expect(renderedPanels).toEqual(["leftPanel"]); // Expanded rows trigger a re-render
  });

  test("onDragStart/onDrop on a collapsed row neither hides rows nor re-renders", async () => {
    const { rows } = await setupLayers();
    dragFor(rows[3]).onDragStart();
    expect(rows[1].style.display).toBe("");
    dragFor(rows[3]).onDrop();
    expect(renderedPanels).toEqual([]);
  });

  test("canDrop blocks dropping a node into its own descendant", async () => {
    const { rows } = await setupLayers();
    const child = dropFor(rows[1]);
    expect(child.canDrop({ source: { data: { path: ["children", 0] } } })).toBe(false);
    expect(child.canDrop({ source: { data: { path: ["children", 2] } } })).toBe(true);
    expect(child.canDrop({ source: { data: { fragment: { tagName: "hr" } } } })).toBe(true);
  });

  test("getData attaches hitbox options reflecting depth, void, and expanded flags", async () => {
    const { rows } = await setupLayers();
    const expanded = dropFor(rows[0]).getData({ element: rows[0], input: {} });
    expect(expanded.path).toEqual(["children", 0]);
    expect(expanded.__opts.mode).toBe("expanded");
    expect(expanded.__opts.block).toEqual([]);
    expect(expanded.__opts.currentLevel).toBe(0);
    expect(expanded.__opts.indentPerLevel).toBe(16);

    const voidRow = dropFor(rows[2]).getData({ element: rows[2], input: {} });
    expect(voidRow.__opts.block).toEqual(["make-child"]);
    expect(voidRow.__opts.mode).toBe("standard");

    const nested = dropFor(rows[1]).getData({ element: rows[1], input: {} });
    expect(nested.__opts.currentLevel).toBe(1);
  });
});

describe("showLayerDropGap / clearLayerDropGap", () => {
  test("reorder-above shifts the target row and everything below it", async () => {
    const { rows } = await setupLayers();
    view.layerDragSourceHeight = 24;
    dropFor(rows[2]).onDragEnter({ self: { data: { __instr: { type: "reorder-above" } } } });
    expect(rows[0].style.transform).toBe("");
    expect(rows[1].style.transform).toBe("");
    expect(rows[2].style.transform).toBe("translateY(24px)");
    expect(rows[3].style.transform).toBe("translateY(24px)");
    expect(view._currentDropTargetRow).toBe(rows[2]);
  });

  test("reorder-below shifts only rows after the target and skips the dragging row", async () => {
    const { rows } = await setupLayers();
    view.layerDragSourceHeight = 10;
    rows[3].classList.add("dragging");
    dropFor(rows[1]).onDrag({ self: { data: { __instr: { type: "reorder-below" } } } });
    expect(rows[1].style.transform).toBe("");
    expect(rows[2].style.transform).toBe("translateY(10px)");
    expect(rows[3].style.transform).toBe(""); // Dragging row never shifts
  });

  test("make-child highlights the row and clears any gap", async () => {
    const { rows } = await setupLayers();
    view.layerDragSourceHeight = 24;
    dropFor(rows[2]).onDrag({ self: { data: { __instr: { type: "reorder-above" } } } });
    dropFor(rows[2]).onDrag({ self: { data: { __instr: { type: "make-child" } } } });
    expect(rows[2].classList.contains("drop-target")).toBe(true);
    expect(rows[3].style.transform).toBe("");
    expect(view._currentDropTargetRow).toBe(rows[2]);
  });

  test("moving to a new row clears the previous highlight", async () => {
    const { rows } = await setupLayers();
    dropFor(rows[2]).onDrag({ self: { data: { __instr: { type: "make-child" } } } });
    dropFor(rows[3]).onDrag({ self: { data: { __instr: { type: "make-child" } } } });
    expect(rows[2].classList.contains("drop-target")).toBe(false);
    expect(rows[3].classList.contains("drop-target")).toBe(true);
  });

  test("a blocked or missing instruction clears the gap", async () => {
    const { rows } = await setupLayers();
    view.layerDragSourceHeight = 24;
    dropFor(rows[2]).onDrag({ self: { data: { __instr: { type: "reorder-above" } } } });
    dropFor(rows[2]).onDrag({
      self: { data: { __instr: { type: "instruction-blocked" } } },
    });
    expect(rows[3].style.transform).toBe("");
    expect(view._currentDropTargetRow).toBeNull();

    dropFor(rows[2]).onDrag({ self: { data: { __instr: { type: "reorder-above" } } } });
    dropFor(rows[2]).onDrag({ self: { data: {} } });
    expect(rows[3].style.transform).toBe("");
  });

  test("drop-target onDrop clears the gap", async () => {
    const { rows } = await setupLayers();
    view.layerDragSourceHeight = 24;
    dropFor(rows[2]).onDragEnter({ self: { data: { __instr: { type: "reorder-above" } } } });
    dropFor(rows[2]).onDrop();
    expect(rows[3].style.transform).toBe("");
    expect(view._currentDropTargetRow).toBeNull();
  });

  test("clearLayerDropGap restores display hidden by hideDescendantRows", async () => {
    const { container, rows } = await setupLayers();
    // Simulate hideDescendantRows hiding the dragged subtree during a drag.
    rows[1].style.display = "none";
    rows[1].style.transform = "translateY(24px)";
    dnd.clearLayerDropGap(container);
    // Without the display reset, lit would reuse this node (display:none) for whatever row lands
    // On it after the post-drop re-render — silently hiding an unrelated sibling.
    expect(rows[1].style.display).toBe("");
    expect(rows[1].style.transform).toBe("");
  });
});

describe("registerLayersDnD — monitor", () => {
  test("onDrop without a target, instruction, or with a blocked one is a no-op", async () => {
    await setupLayers();
    const tab = resetWorkspaceWithTab(makeDoc());
    const before = JSON.stringify(tab.doc.document);
    const [monitor] = monitors;
    monitor.onDrop({
      location: { current: { dropTargets: [] } },
      source: { data: {}, element: document.createElement("div") },
    });
    monitor.onDrop({
      location: { current: { dropTargets: [{ data: { path: ["children", 0] } }] } },
      source: {
        data: { path: ["children", 2], type: "tree-node" },
        element: document.createElement("div"),
      },
    });
    monitor.onDrop({
      location: {
        current: {
          dropTargets: [
            { data: { __instr: { type: "instruction-blocked" }, path: ["children", 0] } },
          ],
        },
      },
      source: {
        data: { path: ["children", 2], type: "tree-node" },
        element: document.createElement("div"),
      },
    });
    expect(JSON.stringify(tab.doc.document)).toBe(before);
  });

  test("onDrop applies the instruction and persists collapse for expanded sources", async () => {
    const { rows } = await setupLayers();
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = ["children", 2];
    monitors[0].onDrop({
      location: {
        current: {
          dropTargets: [{ data: { __instr: { type: "make-child" }, path: ["children", 0] } }],
        },
      },
      // Rows[0] carries dndExpanded in its (overridden) dataset
      source: { data: { path: ["children", 2], type: "tree-node" }, element: rows[0] },
    });
    const [section] = tab.doc.document.children as JxMutableNode[];
    expect((section.children as JxMutableNode[]).map((c) => c.textContent)).toEqual([
      "title",
      "second",
    ]);
    expect(view._layersCollapsed?.has("children/0/children/1")).toBe(true);
  });

  test("onDrop from a non-expanded source does not touch the collapsed set", async () => {
    const { rows } = await setupLayers();
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = ["children", 2];
    monitors[0].onDrop({
      location: {
        current: {
          dropTargets: [{ data: { __instr: { type: "reorder-above" }, path: ["children", 0] } }],
        },
      },
      source: { data: { path: ["children", 2], type: "tree-node" }, element: rows[3] },
    });
    expect(view._layersCollapsed).toBeNull();
    expect((tab.doc.document.children as JxMutableNode[])[0].textContent).toBe("second");
  });

  test("onDropTargetChange clears the gap only when over a non-tree target", async () => {
    const { rows } = await setupLayers();
    view.layerDragSourceHeight = 24;
    dropFor(rows[2]).onDrag({ self: { data: { __instr: { type: "reorder-above" } } } });
    // Still over a tree target — gap persists
    monitors[0].onDropTargetChange({
      location: {
        current: { dropTargets: [{ data: { __instr: { type: "reorder-above" } } }] },
      },
    });
    expect(rows[3].style.transform).toBe("translateY(24px)");
    // No target at all — gap also persists
    monitors[0].onDropTargetChange({ location: { current: { dropTargets: [] } } });
    expect(rows[3].style.transform).toBe("translateY(24px)");
    // Over a non-tree target (no instruction) — gap clears
    monitors[0].onDropTargetChange({
      location: { current: { dropTargets: [{ data: {} }] } },
    });
    expect(rows[3].style.transform).toBe("");
  });
});

describe("registerComponentsDnD", () => {
  function componentsDom(tags: string[]) {
    leftPanel.innerHTML = `<div class="components-section">${tags
      .map((t) => `<div data-component-tag="${t}"><div class="element-card-preview"></div></div>`)
      .join("")}</div>`;
  }

  test("no .components-section is a no-op", async () => {
    leftPanel.innerHTML = "";
    dnd.registerComponentsDnD();
    await raf();
    await flush();
    expect(draggables).toHaveLength(0);
  });

  test("registers known components with live previews and prop defaults", async () => {
    componentsDom(["my-card", "ghost-comp"]);
    componentRegistry.push({
      props: [{ name: "title", default: "Hello" }, { name: "count" }],
      tagName: "my-card",
    } as never);
    dnd.registerComponentsDnD();
    await raf();
    await flush();

    // Ghost-comp is not in the registry — skipped
    expect(draggables).toHaveLength(1);
    expect(previewRenders).toBe(1);
    const preview = leftPanel.querySelector(
      "[data-component-tag='my-card'] .element-card-preview",
    )!;
    expect(preview.querySelector("my-card")).not.toBeNull();

    const data = draggables[0].getInitialData();
    expect(data.type).toBe("block");
    expect(data.fragment).toEqual({
      $props: { count: "", title: "Hello" },
      tagName: "my-card",
    });
    // Fragment is cloned per call
    expect(draggables[0].getInitialData().fragment).not.toBe(data.fragment);
  });

  test("rows with an empty tag are skipped and existing previews are not re-rendered", async () => {
    componentsDom(["my-card"]);
    leftPanel
      .querySelector("[data-component-tag='my-card'] .element-card-preview")!
      .append(document.createElement("my-card"));
    const empty = document.createElement("div");
    empty.dataset.componentTag = "";
    leftPanel.querySelector(".components-section")!.append(empty);
    componentRegistry.push({ tagName: "my-card" } as never);
    dnd.registerComponentsDnD();
    await raf();
    await flush();
    expect(previewRenders).toBe(0);
    expect(draggables).toHaveLength(1);
    // No props array → empty $props
    expect(draggables[0].getInitialData().fragment).toEqual({ $props: {}, tagName: "my-card" });
  });
});

describe("registerElementsDnD", () => {
  test("no .panel-body is a no-op", async () => {
    leftPanel.innerHTML = "";
    dnd.registerElementsDnD();
    await raf();
    await flush();
    expect(draggables).toHaveLength(0);
  });

  test("fills previews (span for unsafe tags) and serves default definitions", async () => {
    leftPanel.innerHTML = `<div class="panel-body">
      <div data-block-tag="p"><div class="element-card-preview"></div></div>
      <div data-block-tag="script"><div class="element-card-preview"></div></div>
      <div data-block-tag="h1"><div class="element-card-preview"><span>keep</span></div></div>
    </div>`;
    dnd.registerElementsDnD();
    await raf();
    await flush();

    expect(draggables).toHaveLength(3);
    const previews = leftPanel.querySelectorAll(".element-card-preview");
    expect(previews[0].firstElementChild?.tagName.toLowerCase()).toBe("p");
    expect(previews[0].textContent).toBe("p");
    expect(previews[1].firstElementChild?.tagName.toLowerCase()).toBe("span"); // Unsafe tag
    expect(previews[1].textContent).toBe("script");
    expect(previews[2].textContent).toBe("keep"); // Already filled

    const data = draggables[0].getInitialData();
    expect(data).toEqual({
      fragment: { tagName: "p", textContent: "Paragraph text" },
      type: "block",
    });
  });
});

describe("applyDropInstruction — uncovered branches", () => {
  test("block reorder-below inserts after the target", () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    dnd.applyDropInstruction(
      { type: "reorder-below" },
      { fragment: { tagName: "hr" }, type: "block" },
      ["children", 1],
    );
    const children = tab.doc.document.children as JxMutableNode[];
    expect(children.map((c) => c.tagName)).toEqual(["section", "p", "hr", "p"]);
  });

  test("unknown instruction types are no-ops for both source kinds", () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    const before = JSON.stringify(tab.doc.document);
    dnd.applyDropInstruction({ type: "mystery" }, { path: ["children", 1], type: "tree-node" }, [
      "children",
      2,
    ]);
    dnd.applyDropInstruction({ type: "mystery" }, { fragment: { tagName: "hr" }, type: "block" }, [
      "children",
      2,
    ]);
    expect(JSON.stringify(tab.doc.document)).toBe(before);
  });

  test("npm component drop auto-imports its specifier once", () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    componentRegistry.push({
      modulePath: "button.js",
      package: "@acme/ui",
      source: "npm",
      tagName: "x-button",
    } as never);
    const src = { fragment: { tagName: "x-button" }, type: "block" };
    dnd.applyDropInstruction({ type: "make-child" }, src, ["children", 0]);
    expect(tab.doc.document.$elements).toEqual(["@acme/ui/button.js"]);
    dnd.applyDropInstruction({ type: "make-child" }, src, ["children", 0]);
    expect(tab.doc.document.$elements).toEqual(["@acme/ui/button.js"]);
  });

  test("npm component without modulePath imports the bare package", () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    componentRegistry.push({ package: "@acme/ui", source: "npm", tagName: "x-chip" } as never);
    dnd.applyDropInstruction(
      { type: "reorder-above" },
      { fragment: { tagName: "x-chip" }, type: "block" },
      ["children", 1],
    );
    expect(tab.doc.document.$elements).toEqual(["@acme/ui"]);
  });

  test("npm component without a package is left unimported", () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    componentRegistry.push({ source: "npm", tagName: "x-naked" } as never);
    dnd.applyDropInstruction(
      { type: "make-child" },
      { fragment: { tagName: "x-naked" }, type: "block" },
      ["children", 0],
    );
    expect(tab.doc.document.$elements).toBeUndefined();
  });

  test("local component drop imports a relative $ref", () => {
    const tab = resetWorkspaceWithTab(makeDoc(), { documentPath: "pages/index.json" });
    componentRegistry.push({ path: "components/card.json", tagName: "my-card" } as never);
    dnd.applyDropInstruction(
      { type: "make-child" },
      { fragment: { tagName: "my-card" }, type: "block" },
      ["children", 0],
    );
    expect(tab.doc.document.$elements).toEqual([{ $ref: "../components/card.json" }]);
  });

  test("local component already imported by exact ref or filename is not duplicated", () => {
    const doc = makeDoc();
    doc.$elements = [{ $ref: "./components/card.json" }];
    let tab = resetWorkspaceWithTab(doc);
    componentRegistry.push({ path: "components/card.json", tagName: "my-card" } as never);
    dnd.applyDropInstruction(
      { type: "make-child" },
      { fragment: { tagName: "my-card" }, type: "block" },
      ["children", 0],
    );
    expect(tab.doc.document.$elements).toHaveLength(1);

    const doc2 = makeDoc();
    doc2.$elements = [{ $ref: "../shared/card.json" }];
    tab = resetWorkspaceWithTab(doc2);
    dnd.applyDropInstruction(
      { type: "make-child" },
      { fragment: { tagName: "my-card" }, type: "block" },
      ["children", 0],
    );
    expect(tab.doc.document.$elements).toHaveLength(1);
  });

  test("local component without a path is not imported", () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    componentRegistry.push({ tagName: "my-pathless" } as never);
    dnd.applyDropInstruction(
      { type: "make-child" },
      { fragment: { tagName: "my-pathless" }, type: "block" },
      ["children", 0],
    );
    expect(tab.doc.document.$elements).toBeUndefined();
  });

  test("plain tags and unknown custom elements skip auto-import", () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    dnd.applyDropInstruction(
      { type: "make-child" },
      { fragment: { tagName: "div" }, type: "block" },
      ["children", 0],
    );
    dnd.applyDropInstruction(
      { type: "make-child" },
      { fragment: { tagName: "not-registered" }, type: "block" },
      ["children", 0],
    );
    expect(tab.doc.document.$elements).toBeUndefined();
  });
});
