import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { closeTab, openTab, workspace } from "../src/workspace/workspace";
import { applyDropInstruction } from "../src/panels/dnd";
import type { JxMutableNode } from "@jxsuite/schema/types";

function openDoc(doc: JxMutableNode) {
  return openTab({ document: doc, id: "dnd-test" });
}

function makeDoc(): JxMutableNode {
  return {
    children: [
      {
        children: [{ tagName: "h2", textContent: "title" }],
        tagName: "section",
      },
      { tagName: "p", textContent: "first" },
      { tagName: "p", textContent: "second" },
    ],
    tagName: "div",
  };
}

/** Walk the tree and assert no children array contains undefined/null holes */
function assertNoHoles(node: JxMutableNode | string | number | boolean) {
  if (typeof node !== "object" || node === null) {
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      expect(child).toBeDefined();
      expect(child).not.toBeNull();
      assertNoHoles(child as JxMutableNode);
    }
  }
}

describe("applyDropInstruction — tree-node moves", () => {
  beforeEach(() => {
    for (const id of workspace.tabs.keys()) {
      closeTab(id);
    }
  });

  test("reorder-above moves node before target", () => {
    const tab = openDoc(makeDoc());
    applyDropInstruction({ type: "reorder-above" }, { path: ["children", 2], type: "tree-node" }, [
      "children",
      0,
    ]);
    const children = tab.doc.document.children as JxMutableNode[];
    expect(children.map((c) => c.textContent ?? c.tagName)).toEqual(["second", "section", "first"]);
    assertNoHoles(tab.doc.document);
  });

  test("reorder-below moves node after target", () => {
    const tab = openDoc(makeDoc());
    applyDropInstruction({ type: "reorder-below" }, { path: ["children", 0], type: "tree-node" }, [
      "children",
      2,
    ]);
    const children = tab.doc.document.children as JxMutableNode[];
    expect(children.map((c) => c.textContent ?? c.tagName)).toEqual(["first", "second", "section"]);
    assertNoHoles(tab.doc.document);
  });

  test("make-child appends node into target's children", () => {
    const tab = openDoc(makeDoc());
    applyDropInstruction({ type: "make-child" }, { path: ["children", 1], type: "tree-node" }, [
      "children",
      0,
    ]);
    const section = (tab.doc.document as any).children[0];
    expect(section.children).toHaveLength(2);
    expect(section.children[1].textContent).toBe("first");
    expect(tab.doc.document.children).toHaveLength(2);
    assertNoHoles(tab.doc.document);
  });

  test("repeated application with stale paths never corrupts the document", () => {
    // Regression: pragmatic-dnd fires onDrop on every stacked drop target, so the
    // Same drop used to apply once per nested ancestor. After the first move the
    // Source path is stale; subsequent applications spliced undefined into children
    // And crashed the layers panel. The mutation layer must stay corruption-free
    // Even if called repeatedly with the same (now stale) arguments.
    const tab = openDoc(makeDoc());
    const src = { path: ["children", 2], type: "tree-node" };
    applyDropInstruction({ type: "make-child" }, src, ["children", 0]);
    // Simulate the outer stacked targets firing with the same stale source path
    applyDropInstruction({ type: "make-child" }, src, ["children", 0, "children", 0]);
    applyDropInstruction({ type: "reorder-above" }, src, ["children", 0]);

    assertNoHoles(tab.doc.document);
    // First application moved "second" into the section; stale repeats were no-ops
    const children = tab.doc.document.children as JxMutableNode[];
    expect(children).toHaveLength(2);
    const section = children[0] as any;
    expect(section.children.map((c: JxMutableNode) => c.textContent)).toEqual(["title", "second"]);
  });

  test("reorder around a root-level path is a no-op", () => {
    const tab = openDoc(makeDoc());
    const before = JSON.parse(JSON.stringify(tab.doc.document));
    // TargetPath ["children"] has no parent element and a non-numeric index
    applyDropInstruction({ type: "reorder-above" }, { path: ["children", 1], type: "tree-node" }, [
      "children",
    ]);
    expect(JSON.parse(JSON.stringify(tab.doc.document))).toEqual(before);
  });
});

describe("applyDropInstruction — block inserts", () => {
  beforeEach(() => {
    for (const id of workspace.tabs.keys()) {
      closeTab(id);
    }
  });

  test("reorder-above inserts fragment before target", () => {
    const tab = openDoc(makeDoc());
    applyDropInstruction(
      { type: "reorder-above" },
      { fragment: { tagName: "hr" }, type: "block" },
      ["children", 1],
    );
    const children = tab.doc.document.children as JxMutableNode[];
    expect(children).toHaveLength(4);
    expect(children[1].tagName).toBe("hr");
    assertNoHoles(tab.doc.document);
  });

  test("make-child appends fragment into target", () => {
    const tab = openDoc(makeDoc());
    applyDropInstruction({ type: "make-child" }, { fragment: { tagName: "img" }, type: "block" }, [
      "children",
      0,
    ]);
    const section = (tab.doc.document as any).children[0];
    expect(section.children).toHaveLength(2);
    expect(section.children[1].tagName).toBe("img");
    assertNoHoles(tab.doc.document);
  });

  test("reorder on a root-level path is a no-op", () => {
    const tab = openDoc(makeDoc());
    const before = JSON.parse(JSON.stringify(tab.doc.document));
    applyDropInstruction(
      { type: "reorder-below" },
      { fragment: { tagName: "hr" }, type: "block" },
      ["children"],
    );
    expect(JSON.parse(JSON.stringify(tab.doc.document))).toEqual(before);
  });
});
