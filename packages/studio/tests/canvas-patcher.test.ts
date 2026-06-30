/**
 * Canvas patcher — surgical DOM updates for style/text edits. Verifies classification rules,
 * in-place style/text application (element identity preserved, no full render), scoped style-tag
 * replacement, and the consumed-document handshake.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canvasPanels, elToPath } from "../src/store";
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
    canvas,
    mediaName: "",
    ready: true,
  } as unknown as CanvasPanel;
  canvasPanels.push(panel);

  initCanvasPatcher({
    getCanvasMode: () => canvasMode,
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
  test("classification is host-agnostic: the iframe admits the full surgical op set", () => {
    // After Phase 3b the iframe applies every op the legacy patcher does (in-place, structural
    // Relocation, and subtree re-renders), so classify no longer rejects anything extra in iframe
    // Mode — an op the iframe can't apply escalates at apply time instead.
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 0] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ fromPath: ["children", 0], op: "move", toIndex: 1, toParentPath: [] }])
        .patchable,
    ).toBe(true);
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "replace", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ key: "id", op: "set-prop", path: ["children", 0] }]).patchable).toBe(
      true,
    );
  });

  test("admits patches on a panel with no parent-side render context — iframe-mode panel state", () => {
    // In iframe mode the parent never runs a legacy in-realm render, so the panel holds no
    // Parent-side render scope; classification keys only off `ready`, never escalating on its
    // Absence (it did once, escalating every iframe edit to a full render).
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).patchable).toBe(true);
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
