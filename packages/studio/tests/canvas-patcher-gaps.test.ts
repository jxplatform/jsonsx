/**
 * Canvas patcher — gap coverage beyond canvas-patcher.test.ts: classification rejection reasons
 * (inactive tab, missing panels, cases paths, custom-element containers, missing nodes), hover
 * invalidation, media-override re-application, inline-edit text protection, set-prop application,
 * unsupported ops, path-remap guards, subtree disposal, and text display for $ref/non-string
 * values.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canvasPanels, elToPath, elToRenderScope } from "../src/store";
import { view } from "../src/view";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { setPatchConsumer } from "../src/tabs/patch-ops";
import { applyPatchBatch, classifyOps, initCanvasPatcher } from "../src/canvas/canvas-patcher";
import { canvasPerf, resetCanvasPerf } from "../src/canvas/canvas-perf";
import { makePathMapper } from "../src/canvas/canvas-live-render";
import { toRaw } from "../src/reactivity";

import type { CanvasPanel } from "../src/types";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";

let tab: Tab;
let tabCount = 0;
let panel: CanvasPanel;
let rootEl: HTMLElement;
let pEl: HTMLElement;
let spanEl: HTMLElement;
let divEl: HTMLElement;
let emEl: HTMLElement;
let canvasMode = "design";
const ctxCalls = {
  mediaOverrides: [] as unknown[][],
  overlays: 0,
  scheduled: 0,
};

function doc(): JxMutableNode {
  return toRaw(tab.doc.document) as JxMutableNode;
}

function child(i: number): JxMutableNode {
  return (doc().children as JxMutableNode[])[i];
}

beforeEach(() => {
  resetCanvasPerf();
  canvasMode = "design";
  ctxCalls.mediaOverrides = [];
  ctxCalls.overlays = 0;
  ctxCalls.scheduled = 0;

  tabCount += 1;
  tab = openTab({
    document: {
      children: [
        { style: { color: "red" }, tagName: "p", textContent: "hello" },
        { tagName: "span", textContent: "world" },
        { children: [{ tagName: "em", textContent: "deep" }], tagName: "div" },
      ],
      tagName: "div",
    },
    id: `patcher-gaps-${tabCount}`,
  }) as Tab;

  const canvas = document.createElement("div");
  rootEl = document.createElement("div");
  pEl = document.createElement("p");
  pEl.textContent = "hello";
  pEl.style.color = "red";
  spanEl = document.createElement("span");
  spanEl.textContent = "world";
  divEl = document.createElement("div");
  emEl = document.createElement("em");
  emEl.textContent = "deep";
  divEl.append(emEl);
  rootEl.append(pEl, spanEl, divEl);
  canvas.append(rootEl);
  document.body.append(canvas);
  elToPath.set(rootEl, []);
  elToPath.set(pEl, ["children", 0]);
  elToPath.set(spanEl, ["children", 1]);
  elToPath.set(divEl, ["children", 2]);
  elToPath.set(emEl, ["children", 2, "children", 0]);

  panel = {
    activeBreakpoints: new Set<string>(),
    canvas,
    liveCtx: {
      canvasMode: "design",
      layoutWrapped: false,
      mapParentPaths: new Set(),
      pageContentPrefix: null,
      pathMapper: makePathMapper({
        canvasMode: "design",
        layoutWrapped: false,
        mapParentPaths: new Set(),
        pageContentPrefix: null,
      }),
      scope: {},
    },
    mediaName: "",
    ready: true,
  } as unknown as CanvasPanel;
  canvasPanels.push(panel);

  initCanvasPatcher({
    applyCanvasMediaOverrides: (canvasEl, bps) => {
      ctxCalls.mediaOverrides.push([canvasEl, bps]);
    },
    enterComponentInlineEdit: () => {},
    getCanvasMode: () => canvasMode,
    registerSubtreeDnD: () => {},
    renderOverlays: () => {
      ctxCalls.overlays += 1;
    },
    scheduleCanvasRender: () => {
      ctxCalls.scheduled += 1;
    },
    updateForcedPseudoPreview: () => {},
  });
});

afterEach(() => {
  setPatchConsumer(null);
  view.componentInlineEdit = null;
  canvasPanels.length = 0;
  document.body.innerHTML = "";
  for (const s of document.head.querySelectorAll("style")) {
    s.remove();
  }
  closeAllTabs();
});

describe("classifyOps rejection reasons", () => {
  test("rejects ops for a tab that is not active", () => {
    const inactive = tab;
    openTab({ document: { tagName: "div" }, id: `patcher-gaps-other-${tabCount}` });
    const verdict = classifyOps(inactive, [{ op: "set-style", path: ["children", 0] }]);
    expect(verdict.reason).toBe("inactive-tab");
    expect(canvasPerf.escalations).toBe(1);
  });

  test("rejects when no canvas panels exist", () => {
    canvasPanels.length = 0;
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).reason).toBe("no-panels");
  });

  test("insert: cases path, missing parent node, innerHTML, and non-array children", () => {
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: ["cases", "a"] }]).reason).toBe(
      "structure-on-cases-path",
    );
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: ["children", 9] }]).reason).toBe(
      "node-not-found",
    );
    child(0).innerHTML = "<b>x</b>";
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: ["children", 0] }]).reason).toBe(
      "structure-with-innerhtml",
    );
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: ["children", 1] }]).reason).toBe(
      "structure-children-not-array",
    );
  });

  test("replace: cases path, no parent, custom-element ancestor, missing node", () => {
    expect(classifyOps(tab, [{ op: "replace", path: ["cases", "a"] }]).reason).toBe(
      "replace-on-cases-path",
    );
    expect(classifyOps(tab, [{ op: "replace", path: ["children"] }]).reason).toBe(
      "replace-no-parent",
    );
    expect(classifyOps(tab, [{ op: "replace", path: ["children", 7] }]).reason).toBe(
      "node-not-found",
    );
    child(2).tagName = "my-box";
    expect(classifyOps(tab, [{ op: "replace", path: ["children", 2, "children", 0] }]).reason).toBe(
      "structure-in-custom-element",
    );
  });

  test("set-text: cases path and missing node", () => {
    expect(classifyOps(tab, [{ op: "set-text", path: ["cases", "x"] }]).reason).toBe(
      "text-on-cases-path",
    );
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 9] }]).reason).toBe(
      "node-not-found",
    );
  });

  test("set-style: missing node", () => {
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 9] }]).reason).toBe(
      "node-not-found",
    );
  });

  test("set-prop (non-event): verdict follows replace rules", () => {
    expect(
      classifyOps(tab, [{ isEvent: false, key: "href", op: "set-prop", path: ["children", 9] }])
        .reason,
    ).toBe("node-not-found");
  });

  test("unknown op kinds are rejected as unsupported", () => {
    expect(classifyOps(tab, [{ op: "frobnicate", path: [] } as never]).reason).toBe(
      "frobnicate-unsupported",
    );
  });

  test("move: cases path, no parent, custom-element destination", () => {
    expect(
      classifyOps(tab, [{ fromPath: ["cases", "a"], op: "move", toIndex: 0, toParentPath: [] }])
        .reason,
    ).toBe("structure-on-cases-path");
    expect(
      classifyOps(tab, [{ fromPath: ["children"], op: "move", toIndex: 0, toParentPath: [] }])
        .reason,
    ).toBe("move-no-parent");
    child(2).tagName = "my-box";
    expect(
      classifyOps(tab, [
        { fromPath: ["children", 0], op: "move", toIndex: 0, toParentPath: ["children", 2] },
      ]).reason,
    ).toBe("structure-in-custom-element");
  });
});

describe("applyPatchBatch gaps", () => {
  test("structural ops clear the session hover; in-place ops keep it", () => {
    tab.session.hover = ["children", 0];
    child(0).style = { color: "blue" };
    applyPatchBatch(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(tab.session.hover).toEqual(["children", 0]);

    (doc().children as JxMutableNode[]).splice(1, 1);
    applyPatchBatch(tab, [{ op: "remove", path: ["children", 1] }]);
    expect(tab.session.hover).toBeNull();
  });

  test("set-style re-applies media overrides when the panel has active breakpoints", () => {
    panel.activeBreakpoints = new Set(["(min-width: 640px)"]);
    child(0).style = { color: "blue" };
    applyPatchBatch(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(ctxCalls.mediaOverrides.length).toBe(1);
    expect(ctxCalls.mediaOverrides[0][0]).toBe(panel.canvas);
  });

  test("insert re-applies media overrides when the panel has active breakpoints", () => {
    panel.activeBreakpoints = new Set(["(min-width: 640px)"]);
    (doc().children as JxMutableNode[]).push({ tagName: "h3", textContent: "new" });
    applyPatchBatch(tab, [{ index: 3, op: "insert", parentPath: [] }]);
    expect(ctxCalls.mediaOverrides.length).toBe(1);
  });

  test("set-text leaves the live DOM alone while the element is inline-edited", () => {
    view.componentInlineEdit = {
      el: pEl,
      mediaName: null,
      originalText: "hello",
      path: ["children", 0],
    };
    child(0).textContent = "committed";
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    expect(pEl.textContent).toBe("hello");
    expect(canvasPerf.patchedOps).toBe(1);
  });

  test("set-prop with isEvent is a canvas no-op", () => {
    applyPatchBatch(tab, [
      { isEvent: true, key: "onclick", op: "set-prop", path: ["children", 0] },
    ]);
    expect(canvasPerf.subtreeRenders).toBe(0);
    expect(rootEl.children[0]).toBe(pEl);
  });

  test("set-prop without isEvent re-renders the subtree in place", () => {
    child(0).className = "fancy";
    applyPatchBatch(tab, [
      { isEvent: false, key: "className", op: "set-prop", path: ["children", 0] },
    ]);
    expect(pEl.isConnected).toBe(false);
    const replaced = rootEl.children[0] as HTMLElement;
    expect(replaced.classList.contains("fancy")).toBe(true);
    expect(replaced.textContent).toBe("hello");
    expect(elToPath.get(replaced)).toEqual(["children", 0]);
    expect(canvasPerf.subtreeRenders).toBe(1);
  });

  test("unknown ops throw so transactDoc can escalate", () => {
    expect(() => {
      applyPatchBatch(tab, [{ op: "frobnicate", path: [] } as never]);
    }).toThrow(/unsupported-op:frobnicate/);
  });

  test("remap skips unmapped elements and paths outside the parent prefix", () => {
    const stray = document.createElement("i"); // No elToPath entry
    const casesEl = document.createElement("b");
    elToPath.set(casesEl, ["cases", "x"]);
    const foreign = document.createElement("u");
    elToPath.set(foreign, ["children", 1, "children", 5]); // Not under ["children", 2]
    divEl.append(stray, casesEl, foreign);

    (child(2).children as JxMutableNode[]).splice(0, 0, { tagName: "b", textContent: "first" });
    applyPatchBatch(tab, [{ index: 0, op: "insert", parentPath: ["children", 2] }]);

    expect(elToPath.get(casesEl)).toEqual(["cases", "x"]);
    expect(elToPath.get(foreign)).toEqual(["children", 1, "children", 5]);
    expect(elToPath.get(emEl)).toEqual(["children", 2, "children", 1]);
  });

  test("move rewrites only descendants under the moved prefix", () => {
    const shortPath = document.createElement("i");
    elToPath.set(shortPath, ["x"]);
    const foreign = document.createElement("u");
    elToPath.set(foreign, ["children", 9, "children", 0]);
    divEl.append(shortPath, foreign);

    const children = doc().children as JxMutableNode[];
    const [moved] = children.splice(2, 1);
    children.splice(0, 0, moved);
    applyPatchBatch(tab, [{ fromPath: ["children", 2], op: "move", toIndex: 0, toParentPath: [] }]);

    expect(elToPath.get(divEl)).toEqual(["children", 0]);
    expect(elToPath.get(emEl)).toEqual(["children", 0, "children", 0]);
    expect(elToPath.get(shortPath)).toEqual(["x"]);
    expect(elToPath.get(foreign)).toEqual(["children", 9, "children", 0]);
  });

  test("replace disposes the old subtree's scoped style tag", () => {
    child(0).style = { ":hover": { color: "green" }, color: "blue" };
    applyPatchBatch(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(document.head.querySelectorAll("style").length).toBe(1);

    (doc().children as JxMutableNode[])[0] = { tagName: "p", textContent: "fresh" };
    applyPatchBatch(tab, [{ op: "replace", path: ["children", 0] }]);
    expect(document.head.querySelectorAll("style").length).toBe(0);
  });

  test("remove stops and forgets the render scope of surgically rendered subtrees", () => {
    (doc().children as JxMutableNode[]).push({ tagName: "h4", textContent: "temp" });
    applyPatchBatch(tab, [{ index: 3, op: "insert", parentPath: [] }]);
    const inserted = rootEl.children[3] as HTMLElement;
    expect(elToRenderScope.get(inserted)).toBeDefined();

    (doc().children as JxMutableNode[]).splice(3, 1);
    applyPatchBatch(tab, [{ op: "remove", path: ["children", 3] }]);
    expect(inserted.isConnected).toBe(false);
    expect(elToRenderScope.get(inserted)).toBeUndefined();
  });

  test("set-style with a non-object style definition clears styles without throwing", () => {
    (child(0) as Record<string, unknown>).style = "color: red";
    applyPatchBatch(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(pEl.style.color).toBe("");
    expect(canvasPerf.patchedOps).toBe(1);
  });

  test("set-text renders $ref and non-string textContent as display values", () => {
    (child(0) as Record<string, unknown>).textContent = { $ref: "#/state/title" };
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    expect(pEl.textContent).toBe("{title}");

    (child(0) as Record<string, unknown>).textContent = { $ref: "#/$defs/items" };
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    expect(pEl.textContent).toBe("{#/$defs/items}");

    (child(0) as Record<string, unknown>).textContent = 42;
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    expect(pEl.textContent).toBe("42");
  });
});
