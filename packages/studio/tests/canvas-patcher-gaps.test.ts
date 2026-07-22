/**
 * Canvas patcher — classification edge verdicts left uncovered by canvas-patcher.test.ts: dynamic
 * (cases) paths for every op family, missing nodes at each lookup site, innerHTML/non-array
 * containers, parentless replace/move/remove paths, unsupported ops, and the inactive-tab /
 * no-panels rejections.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canvasPanels } from "../src/store";
import { closeAllTabs, openTab, workspace } from "../src/workspace/workspace";
import { setPatchConsumer } from "../src/tabs/patch-ops";
import { classifyOps, initCanvasPatcher } from "../src/canvas/canvas-patcher";
import { resetCanvasPerf } from "../src/canvas/canvas-perf";
import { toRaw } from "../src/reactivity";

import type { CanvasPanel } from "../src/types";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPatchOp } from "../src/tabs/patch-ops";
import type { Tab } from "../src/tabs/tab";

let tab: Tab;
let tabCount = 0;

function doc(): JxMutableNode {
  return toRaw(tab.doc.document) as JxMutableNode;
}

function reason(op: JxPatchOp): string {
  return classifyOps(tab, [op]).reason;
}

beforeEach(() => {
  resetCanvasPerf();
  tabCount += 1;
  tab = openTab({
    document: {
      children: [
        { style: { color: "red" }, tagName: "p", textContent: "hello" },
        { innerHTML: "<b>x</b>", tagName: "div" },
        { tagName: "span", textContent: "leaf" },
      ],
      tagName: "div",
    },
    id: `patcher-gaps-${tabCount}`,
  }) as Tab;

  canvasPanels.push({
    canvas: document.createElement("div"),
    mediaName: "",
    ready: true,
  } as unknown as CanvasPanel);

  initCanvasPatcher({
    getCanvasMode: () => "design",
    renderOverlays: () => {},
    scheduleCanvasRender: () => {},
  });
});

afterEach(() => {
  setPatchConsumer(null);
  canvasPanels.length = 0;
  closeAllTabs();
});

describe("classifyOps gate rejections", () => {
  test("rejects a batch for a background (inactive) tab", () => {
    const background = tab;
    openTab({ document: { children: [], tagName: "div" }, id: `patcher-gaps-fg-${tabCount}` });
    expect(workspace.activeTabId).not.toBe(background.id);
    const verdict = classifyOps(background, [{ op: "set-style", path: ["children", 0] }]);
    expect(verdict).toEqual({ patchable: false, reason: "inactive-tab" });
  });

  test("rejects when no canvas panels exist", () => {
    canvasPanels.length = 0;
    expect(reason({ op: "set-style", path: ["children", 0] })).toBe("no-panels");
  });
});

describe("style/text verdicts on dynamic or missing nodes", () => {
  test("set-style on a missing node reports node-not-found", () => {
    expect(reason({ op: "set-style", path: ["children", 9] })).toBe("node-not-found");
  });

  test("set-text on a cases path and on a missing node", () => {
    expect(reason({ op: "set-text", path: ["cases", "a"] })).toBe("text-on-cases-path");
    expect(reason({ op: "set-text", path: ["children", 9] })).toBe("node-not-found");
  });
});

describe("replace-family verdicts (set-prop / set-attr / replace)", () => {
  test("a cases path escalates for replace and non-event set-prop alike", () => {
    expect(reason({ op: "replace", path: ["cases", "a"] })).toBe("replace-on-cases-path");
    expect(reason({ isEvent: false, key: "title", op: "set-prop", path: ["cases", "a"] })).toBe(
      "replace-on-cases-path",
    );
  });

  test("a single-segment path has no parent element", () => {
    expect(reason({ op: "replace", path: ["children"] })).toBe("replace-no-parent");
  });

  test("a missing parent node reports node-not-found", () => {
    expect(reason({ attr: "title", op: "set-attr", path: ["children", 9, "children", 0] })).toBe(
      "node-not-found",
    );
  });

  test("an innerHTML parent renders opaque children — replace escalates", () => {
    expect(reason({ op: "replace", path: ["children", 1, "children", 0] })).toBe(
      "structure-with-innerhtml",
    );
  });
});

describe("structural container verdicts (insert / remove / move)", () => {
  test("insert under a cases parentPath escalates", () => {
    expect(reason({ index: 0, op: "insert", parentPath: ["cases", "a"] })).toBe(
      "structure-on-cases-path",
    );
  });

  test("insert under a missing ancestor reports node-not-found", () => {
    expect(reason({ index: 0, op: "insert", parentPath: ["children", 9] })).toBe("node-not-found");
  });

  test("insert into an innerHTML parent escalates", () => {
    expect(reason({ index: 0, op: "insert", parentPath: ["children", 1] })).toBe(
      "structure-with-innerhtml",
    );
  });

  test("insert into a leaf (children not an array) escalates", () => {
    expect(reason({ index: 0, op: "insert", parentPath: ["children", 2] })).toBe(
      "structure-children-not-array",
    );
  });

  test("remove with a parentless path escalates", () => {
    expect(reason({ op: "remove", path: ["children"] })).toBe("remove-no-parent");
  });

  test("move from a cases path or a parentless path escalates", () => {
    expect(reason({ fromPath: ["cases", "a"], op: "move", toIndex: 0, toParentPath: [] })).toBe(
      "structure-on-cases-path",
    );
    expect(reason({ fromPath: ["children"], op: "move", toIndex: 0, toParentPath: [] })).toBe(
      "move-no-parent",
    );
  });

  test("move checks the destination container too", () => {
    // The from-parent (root) is fine; the to-parent has innerHTML.
    expect(
      reason({
        fromPath: ["children", 0],
        op: "move",
        toIndex: 0,
        toParentPath: ["children", 1],
      }),
    ).toBe("structure-with-innerhtml");
  });
});

describe("unsupported ops", () => {
  test("an unknown op kind is rejected with an -unsupported reason", () => {
    expect(reason({ op: "frobnicate", path: [] } as unknown as JxPatchOp)).toBe(
      "frobnicate-unsupported",
    );
  });

  test("a fresh doc mutation keeps prior verdicts intact (sanity)", () => {
    (doc().children as JxMutableNode[]).push({ tagName: "em", textContent: "tail" });
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 3] }]).patchable).toBe(true);
  });
});
