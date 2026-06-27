/**
 * Canvas patcher — surgical DOM updates for style/text edits. Verifies classification rules,
 * in-place style/text application (element identity preserved, no full render), scoped style-tag
 * replacement, and the consumed-document handshake.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canvasPanels, elToPath } from "../src/store";
import { view } from "../src/view";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { getPatchConsumer, setPatchConsumer } from "../src/tabs/patch-ops";
import {
  applyPatchBatch,
  classifyOps,
  consumePatchedDocument,
  escalateToFullRender,
  initCanvasPatcher,
} from "../src/canvas/canvas-patcher";
import { canvasPerf, resetCanvasPerf } from "../src/canvas/canvas-perf";
import { setCanvasHostOverride } from "../src/canvas/canvas-host";
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
  dndRegistered: 0,
  inlineEdits: [] as unknown[],
  overlays: 0,
  pseudo: 0,
  scheduled: 0,
};

function doc(): JxMutableNode {
  return toRaw(tab.doc.document) as JxMutableNode;
}

function child(i: number): JxMutableNode {
  return (doc().children as JxMutableNode[])[i]!;
}

beforeEach(() => {
  resetCanvasPerf();
  canvasMode = "design";
  ctxCalls.dndRegistered = 0;
  ctxCalls.inlineEdits = [];
  ctxCalls.overlays = 0;
  ctxCalls.pseudo = 0;
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
    id: `patcher-test-${tabCount}`,
  }) as Tab;

  const canvas = document.createElement("div");
  rootEl = document.createElement("div");
  pEl = document.createElement("p");
  pEl.textContent = "hello";
  pEl.style.color = "red";
  pEl.style.pointerEvents = "none";
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
      arrayPaths: new Set(),
      pageContentPrefix: null,
      pathMapper: makePathMapper({
        canvasMode: "design",
        layoutWrapped: false,
        arrayPaths: new Set(),
        pageContentPrefix: null,
      }),
      scope: {},
    },
    mediaName: "",
    ready: true,
  } as unknown as CanvasPanel;
  canvasPanels.push(panel);

  initCanvasPatcher({
    applyCanvasMediaOverrides: () => {},
    enterComponentInlineEdit: (el, path) => {
      ctxCalls.inlineEdits.push([el, path]);
    },
    getCanvasMode: () => canvasMode,
    registerSubtreeDnD: () => {
      ctxCalls.dndRegistered += 1;
    },
    renderOverlays: () => {
      ctxCalls.overlays += 1;
    },
    scheduleCanvasRender: () => {
      ctxCalls.scheduled += 1;
    },
    updateForcedPseudoPreview: () => {
      ctxCalls.pseudo += 1;
    },
  });
});

afterEach(() => {
  setPatchConsumer(null);
  canvasPanels.length = 0;
  document.body.innerHTML = "";
  for (const s of document.head.querySelectorAll("style")) {
    s.remove();
  }
  closeAllTabs();
});

describe("classifyOps", () => {
  test("accepts style and leaf-text ops in design mode with ready panels", () => {
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 0] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ isEvent: true, key: "onclick", op: "set-prop", path: ["children", 0] }])
        .patchable,
    ).toBe(true);
  });

  test("rejects outside design/edit modes", () => {
    canvasMode = "preview";
    const verdict = classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(verdict.patchable).toBe(false);
    expect(verdict.reason).toBe("mode-preview");
  });

  test("rejects when a panel is not ready", () => {
    panel.ready = false;
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).reason).toBe(
      "panels-not-ready",
    );
  });

  test("rejects $switch cases paths but accepts $map template paths", () => {
    expect(classifyOps(tab, [{ op: "set-style", path: ["cases", "a"] }]).reason).toBe(
      "style-on-cases-path",
    );
    // Give the doc a $map container: children[3] = ul with a mapped-array template
    (doc().children as JxMutableNode[]).push({
      children: {
        $prototype: "Array",
        items: ["a", "b"],
        map: { tagName: "li", textContent: "item" },
      } as unknown as JxMutableNode[],
      tagName: "ul",
    });
    expect(
      classifyOps(tab, [{ op: "set-style", path: ["children", 3, "children", "map"] }]).patchable,
    ).toBe(true);
  });

  test("patches a $map template style through the repeater perimeter", () => {
    // DOM as the full render produces it: ul > .repeater-perimeter > li(template)
    (doc().children as JxMutableNode[]).push({
      children: {
        $prototype: "Array",
        items: ["a"],
        map: { style: { color: "red" }, tagName: "li", textContent: "item" },
      } as unknown as JxMutableNode[],
      tagName: "ul",
    });
    const ul = document.createElement("ul");
    const perimeter = document.createElement("div");
    perimeter.className = "repeater-perimeter";
    const li = document.createElement("li");
    li.textContent = "item";
    perimeter.append(li);
    ul.append(perimeter);
    rootEl.append(ul);
    elToPath.set(ul, ["children", 3]);
    elToPath.set(perimeter, ["children", 3, "children"]);
    elToPath.set(li, ["children", 3, "children", "map"]);

    const mapPath = ["children", 3, "children", "map"];
    const template = (
      (doc().children as JxMutableNode[])[3]!.children as unknown as { map: JxMutableNode }
    ).map;
    template.style = { color: "green" };
    applyPatchBatch(tab, [{ op: "set-style", path: mapPath }]);
    expect(li.style.color).toBe("green");
    expect(perimeter.children[0]).toBe(li);
  });

  test("array member node: structural ops on it patch; structural ops inside its template escalate", () => {
    // Array pseudo-element as a member at children[3].
    (doc().children as JxMutableNode[]).push({
      $prototype: "Array",
      items: ["a", "b"],
      map: { children: [{ tagName: "span" }], tagName: "li" },
    } as unknown as JxMutableNode);

    // Removing/moving the array node itself is a normal sibling splice → patchable.
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 3] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ fromPath: ["children", 3], op: "move", toIndex: 0, toParentPath: [] }])
        .patchable,
    ).toBe(true);
    // Inserting a sibling next to the array (parent is the root children array) → patchable.
    expect(classifyOps(tab, [{ index: 3, op: "insert", parentPath: [] }]).patchable).toBe(true);

    // Structural edits *inside* the repeater template escalate (the perimeter holds one instance).
    expect(
      classifyOps(tab, [{ index: 1, op: "insert", parentPath: ["children", 3, "map"] }]).reason,
    ).toBe("structure-on-map-path");
    expect(
      classifyOps(tab, [{ op: "remove", path: ["children", 3, "map", "children", 0] }]).reason,
    ).toBe("structure-on-map-path");
  });

  test("rejects text ops on nodes with children, innerHTML, or custom-element tags", () => {
    expect(classifyOps(tab, [{ op: "set-text", path: [] }]).reason).toBe("text-with-children");
    child(0).innerHTML = "<b>x</b>";
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 0] }]).reason).toBe(
      "text-with-innerhtml",
    );
    delete child(0).innerHTML;
    child(0).tagName = "my-widget";
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 0] }]).reason).toBe(
      "text-on-custom-element",
    );
  });

  test("accepts structural and non-event prop ops", () => {
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 0] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ fromPath: ["children", 0], op: "move", toIndex: 1, toParentPath: [] }])
        .patchable,
    ).toBe(true);
    expect(
      classifyOps(tab, [{ isEvent: false, key: "href", op: "set-prop", path: ["children", 0] }])
        .patchable,
    ).toBe(true);
  });

  test("rejects structural ops in custom-element containers and root replaces", () => {
    expect(classifyOps(tab, [{ op: "replace", path: [] }]).reason).toBe("replace-root");
    doc().tagName = "my-app";
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).reason).toBe(
      "structure-in-custom-element",
    );
  });

  test("rejects structural ops while an inline edit session is live", () => {
    view.componentInlineEdit = {
      el: pEl,
      mediaName: null,
      originalText: "hello",
      path: ["children", 0],
    };
    try {
      expect(classifyOps(tab, [{ op: "remove", path: ["children", 1] }]).reason).toBe(
        "inline-edit-active",
      );
      // Non-structural ops are still fine during inline editing
      expect(classifyOps(tab, [{ op: "set-style", path: ["children", 1] }]).patchable).toBe(true);
    } finally {
      view.componentInlineEdit = null;
    }
  });
});

describe("structural patches", () => {
  test("insert renders the new node in place and shifts sibling paths", () => {
    (doc().children as JxMutableNode[]).splice(1, 0, { tagName: "h2", textContent: "new" });
    applyPatchBatch(tab, [{ index: 1, op: "insert", parentPath: [] }]);

    expect(rootEl.children.length).toBe(4);
    const inserted = rootEl.children[1] as HTMLElement;
    expect(inserted.tagName).toBe("H2");
    expect(inserted.textContent).toBe("new");
    expect(inserted.style.pointerEvents).toBe("none");
    expect(elToPath.get(inserted)).toEqual(["children", 1]);
    expect(elToPath.get(pEl)).toEqual(["children", 0]);
    expect(elToPath.get(spanEl)).toEqual(["children", 2]);
    expect(elToPath.get(divEl)).toEqual(["children", 3]);
    expect(elToPath.get(emEl)).toEqual(["children", 3, "children", 0]);
    expect(ctxCalls.dndRegistered).toBe(1);
    expect(canvasPerf.subtreeRenders).toBe(1);
    expect(canvasPerf.fullRenders).toBe(0);
  });

  test("remove drops the element and shifts following sibling paths down", () => {
    (doc().children as JxMutableNode[]).splice(0, 1);
    applyPatchBatch(tab, [{ op: "remove", path: ["children", 0] }]);

    expect(pEl.isConnected).toBe(false);
    expect(rootEl.children.length).toBe(2);
    expect(elToPath.get(spanEl)).toEqual(["children", 0]);
    expect(elToPath.get(divEl)).toEqual(["children", 1]);
    expect(elToPath.get(emEl)).toEqual(["children", 1, "children", 0]);
  });

  test("move reorders DOM and rewrites the moved subtree's paths", () => {
    // Move div (index 2) to index 0
    const children = doc().children as JxMutableNode[];
    const moved = children.splice(2, 1)[0]!;
    children.splice(0, 0, moved);
    applyPatchBatch(tab, [{ fromPath: ["children", 2], op: "move", toIndex: 0, toParentPath: [] }]);

    expect([...rootEl.children]).toEqual([divEl, pEl, spanEl]);
    expect(elToPath.get(divEl)).toEqual(["children", 0]);
    expect(elToPath.get(emEl)).toEqual(["children", 0, "children", 0]);
    expect(elToPath.get(pEl)).toEqual(["children", 1]);
    expect(elToPath.get(spanEl)).toEqual(["children", 2]);
  });

  test("move into another container", () => {
    // Move p (index 0) into div, at index 1 (after em)
    const children = doc().children as JxMutableNode[];
    const moved = children.splice(0, 1)[0]!;
    const target = children[1] as JxMutableNode; // The div, now at index 1
    (target.children as JxMutableNode[]).push(moved);
    applyPatchBatch(tab, [
      { fromPath: ["children", 0], op: "move", toIndex: 1, toParentPath: ["children", 2] },
    ]);

    expect([...rootEl.children]).toEqual([spanEl, divEl]);
    expect([...divEl.children]).toEqual([emEl, pEl]);
    expect(elToPath.get(spanEl)).toEqual(["children", 0]);
    expect(elToPath.get(divEl)).toEqual(["children", 1]);
    expect(elToPath.get(emEl)).toEqual(["children", 1, "children", 0]);
    expect(elToPath.get(pEl)).toEqual(["children", 1, "children", 1]);
  });

  test("replace swaps the subtree in place", () => {
    const children = doc().children as JxMutableNode[];
    children[0] = { children: [{ tagName: "p", textContent: "wrapped" }], tagName: "section" };
    applyPatchBatch(tab, [{ op: "replace", path: ["children", 0] }]);

    expect(pEl.isConnected).toBe(false);
    const section = rootEl.children[0] as HTMLElement;
    expect(section.tagName).toBe("SECTION");
    expect(elToPath.get(section)).toEqual(["children", 0]);
    expect(elToPath.get(section.children[0] as HTMLElement)).toEqual([
      "children",
      0,
      "children",
      0,
    ]);
    expect(elToPath.get(spanEl)).toEqual(["children", 1]);
  });

  test("set-attr applies as a subtree replace", () => {
    const children = doc().children as JxMutableNode[];
    children[0]!.attributes = { title: "tip" };
    applyPatchBatch(tab, [{ attr: "title", op: "set-attr", path: ["children", 0] }]);

    const replaced = rootEl.children[0] as HTMLElement;
    expect(replaced.getAttribute("title")).toBe("tip");
    expect(replaced.textContent).toBe("hello");
    expect(elToPath.get(replaced)).toEqual(["children", 0]);
  });

  test("remove toggles the parent's empty-placeholder class", () => {
    const children = doc().children as JxMutableNode[];
    const div = children[2] as JxMutableNode;
    (div.children as JxMutableNode[]).splice(0, 1);
    applyPatchBatch(tab, [{ op: "remove", path: ["children", 2, "children", 0] }]);

    expect(emEl.isConnected).toBe(false);
    expect(divEl.classList.contains("empty-container-placeholder")).toBe(true);

    (div.children as JxMutableNode[]).push({ tagName: "em", textContent: "again" });
    applyPatchBatch(tab, [{ index: 0, op: "insert", parentPath: ["children", 2] }]);
    expect(divEl.classList.contains("empty-container-placeholder")).toBe(false);
  });
});

describe("applyPatchBatch", () => {
  test("set-style patches inline styles in place and preserves element identity", () => {
    child(0).style = { color: "blue", fontSize: "20px" };
    applyPatchBatch(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(pEl.style.color).toBe("blue");
    expect(pEl.style.fontSize).toBe("20px");
    expect(pEl.style.pointerEvents).toBe("none");
    expect(rootEl.children[0]).toBe(pEl);
    expect(canvasPerf.patchedOps).toBe(1);
    expect(canvasPerf.fullRenders).toBe(0);
    expect(ctxCalls.overlays).toBe(1);
  });

  test("set-style replaces the emitted scoped style tag instead of accumulating", () => {
    child(0).style = { ":hover": { color: "green" }, color: "blue" };
    applyPatchBatch(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(document.head.querySelectorAll("style").length).toBe(1);
    const firstUid = pEl.dataset.jx;
    expect(firstUid).toBeTruthy();

    child(0).style = { ":hover": { color: "purple" }, color: "blue" };
    applyPatchBatch(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(document.head.querySelectorAll("style").length).toBe(1);
    expect(document.head.querySelector("style")?.textContent).toContain("purple");
  });

  test("set-style blanks template-string values like prepareForEditMode", () => {
    child(0).style = { color: "${theme}" };
    applyPatchBatch(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(pEl.style.color).toBe("");
  });

  test("set-text updates text in place, managing placeholder classes", () => {
    child(0).textContent = "updated";
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    expect(pEl.textContent).toBe("updated");
    expect(rootEl.children[0]).toBe(pEl);

    delete child(0).textContent;
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    expect(pEl.textContent).toBe("");
    expect(pEl.classList.contains("empty-text-placeholder")).toBe(true);

    child(0).textContent = "back";
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    expect(pEl.classList.contains("empty-text-placeholder")).toBe(false);
  });

  test("set-text renders template strings as edit-mode display text", () => {
    child(0).textContent = "Count: ${count}";
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    expect(pEl.textContent).toBe("Count: ❪ count ❫");
  });

  test("ops apply to every panel", () => {
    const canvas2 = document.createElement("div");
    const root2 = document.createElement("div");
    const p2 = document.createElement("p");
    p2.textContent = "hello";
    root2.append(p2);
    canvas2.append(root2);
    document.body.append(canvas2);
    elToPath.set(root2, []);
    elToPath.set(p2, ["children", 0]);
    canvasPanels.push({ ...panel, canvas: canvas2 } as CanvasPanel);

    child(0).textContent = "both";
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    expect(pEl.textContent).toBe("both");
    expect(p2.textContent).toBe("both");
  });

  test("throws when the target element is missing (caller escalates)", () => {
    expect(() => applyPatchBatch(tab, [{ op: "set-text", path: ["children", 5] }])).toThrow(
      /element-not-found/,
    );
  });

  test("consumes a pendingInlineEdit set around the transaction", async () => {
    (tab.session.ui as unknown as Record<string, unknown>).pendingInlineEdit = {
      mediaName: "",
      path: ["children", 1],
    };
    child(0).textContent = "x";
    applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }]);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(tab.session.ui.pendingInlineEdit).toBeNull();
    expect(ctxCalls.inlineEdits).toEqual([[spanEl, ["children", 1]]]);
  });
});

describe("consumed-document handshake", () => {
  test("consumePatchedDocument is one-shot per marked reference", () => {
    const consumer = getPatchConsumer()!;
    consumer.markConsumed(toRaw(tab.doc.document) as object);
    expect(consumePatchedDocument(tab.doc.document)).toBe(true);
    expect(canvasPerf.skippedFullRenders).toBe(1);
    expect(consumePatchedDocument(tab.doc.document)).toBe(false);
  });

  test("escalateToFullRender schedules a render and records the reason", () => {
    escalateToFullRender("test-reason");
    expect(ctxCalls.scheduled).toBe(1);
    expect(canvasPerf.escalations).toBe(1);
    expect(canvasPerf.lastEscalationReason).toBe("test-reason");
  });
});

// ─── Iframe canvas host (Phase 3a): narrower classify gate + post-over-bridge apply ─────

describe("iframe canvas host gating", () => {
  beforeEach(() => {
    setCanvasHostOverride("iframe");
  });
  afterEach(() => {
    setCanvasHostOverride(null);
  });

  test("rejects ops the iframe can't patch surgically yet (need a subtree re-render — Phase 3b-2)", () => {
    // These pass the legacy verdicts but the iframe gate rejects them (they need rendering).
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).reason).toBe(
      "iframe-unsupported-insert",
    );
    expect(classifyOps(tab, [{ op: "replace", path: ["children", 0] }]).reason).toBe(
      "iframe-unsupported-replace",
    );
    expect(classifyOps(tab, [{ key: "id", op: "set-prop", path: ["children", 0] }]).reason).toBe(
      "iframe-unsupported-set-prop",
    );
  });

  test("admits in-place ops plus the no-render structural ops (remove / move)", () => {
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 0] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ isEvent: true, key: "onclick", op: "set-prop", path: ["children", 0] }])
        .patchable,
    ).toBe(true);
    // Phase 3b-1: remove + move are pure DOM relocation in the iframe — no render needed.
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 0] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ fromPath: ["children", 0], op: "move", toIndex: 1, toParentPath: [] }])
        .patchable,
    ).toBe(true);
  });

  test("apply leaves the parent DOM untouched and throws when no iframe host is ready", () => {
    const before = pEl.textContent;
    expect(() =>
      applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }], {
        docOps: [
          {
            forward: { key: "textContent", op: "set-key", path: ["children", 0], value: "X" },
            inverse: { key: "textContent", op: "set-key", path: ["children", 0], value: "hello" },
          },
        ],
        invertible: true,
        ops: [{ op: "set-text", path: ["children", 0] }],
      }),
    ).toThrow(/no-ready-iframe-host/);
    // In iframe mode the parent owns no canvas DOM — the edit crosses the bridge, never mutates here.
    expect(pEl.textContent).toBe(before);
  });
});
