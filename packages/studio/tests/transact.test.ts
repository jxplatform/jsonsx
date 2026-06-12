import "./with-dom.js";
import { effect } from "../src/reactivity";
import { jsonClone } from "../src/utils/studio-utils";
import { createTab, disposeTab } from "../src/tabs/tab";
import type { JxMutableNode } from "@jxsuite/schema/types";
import {
  mutateAddDef,
  mutateDuplicateNode,
  mutateInsertNode,
  mutateMoveNode,
  mutateRemoveDef,
  mutateRemoveNode,
  mutateRenameDef,
  mutateUpdateAttribute,
  mutateUpdateDef,
  mutateUpdateFrontmatter,
  mutateUpdateMediaStyle,
  mutateUpdateProp,
  mutateUpdateProperty,
  mutateUpdateStyle,
  mutateWrapNode,
  redo,
  transactDoc,
  undo,
} from "../src/tabs/transact";
import { describe, expect, test } from "bun:test";

function makeTab(doc?: JxMutableNode) {
  const document = doc ?? {
    children: [{ tagName: "p", textContent: "Hello" }],
    tagName: "div",
  };
  return createTab({ document, id: "test" });
}

describe("transactDoc", () => {
  test("pushes history and marks dirty", () => {
    const tab = makeTab();
    expect(tab.history.index).toBe(0);
    expect(tab.doc.dirty).toBe(false);

    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));

    expect(tab.doc.dirty).toBe(true);
    expect(tab.history.index).toBe(1);
    expect(tab.history.snapshots).toHaveLength(2);
    expect(tab.doc.document.children).toHaveLength(2);
    expect((tab.doc.document as any).children[1].tagName).toBe("span");

    disposeTab(tab);
  });

  test("skipHistory does not push snapshot", () => {
    const tab = makeTab();

    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }), {
      skipHistory: true,
    });

    expect(tab.doc.dirty).toBe(true);
    expect(tab.history.index).toBe(0);
    expect(tab.history.snapshots).toHaveLength(1);

    disposeTab(tab);
  });

  test("triggers reactive effects", () => {
    const tab = makeTab();
    let childCount = 0;
    const stop = effect(() => {
      const kids = tab.doc.document.children;
      childCount = Array.isArray(kids) ? kids.length : 0;
    });

    expect(childCount).toBe(1);
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
    expect(childCount).toBe(2);

    stop();
    disposeTab(tab);
  });
});

describe("undo/redo", () => {
  test("undo restores previous document state", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
    expect(tab.doc.document.children).toHaveLength(2);

    undo(tab);
    expect(tab.doc.document.children).toHaveLength(1);
    expect(tab.history.index).toBe(0);
  });

  test("redo restores next document state", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
    undo(tab);
    expect(tab.doc.document.children).toHaveLength(1);

    redo(tab);
    expect(tab.doc.document.children).toHaveLength(2);
    expect(tab.history.index).toBe(1);
  });

  test("undo at start is a no-op", () => {
    const tab = makeTab();
    undo(tab);
    expect(tab.history.index).toBe(0);
    disposeTab(tab);
  });

  test("redo at end is a no-op", () => {
    const tab = makeTab();
    redo(tab);
    expect(tab.history.index).toBe(0);
    disposeTab(tab);
  });

  test("undo restores the selection from just before the undone edit", () => {
    const tab = makeTab();
    tab.session.selection = ["children", 0];
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
    tab.session.selection = ["children", 1];
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 1], "textContent", "world"));

    undo(tab); // Selection as it was before the text edit
    expect(tab.session.selection).toEqual(["children", 1]);
    undo(tab); // Selection as it was before the insert
    expect(tab.session.selection).toEqual(["children", 0]);
  });
});

describe("mutateInsertNode", () => {
  test("inserts at given index", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateInsertNode(t, [], 0, { tagName: "header" }));
    expect((tab.doc.document as any).children[0].tagName).toBe("header");
    expect((tab.doc.document as any).children[1].tagName).toBe("p");
    disposeTab(tab);
  });

  test("creates children array if absent", () => {
    const tab = makeTab({ tagName: "div" });
    transactDoc(tab, (t) => mutateInsertNode(t, [], 0, { tagName: "span" }));
    expect(tab.doc.document.children).toHaveLength(1);
    disposeTab(tab);
  });
});

describe("mutateRemoveNode", () => {
  test("removes node at path", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateRemoveNode(t, ["children", 0]));
    expect(tab.doc.document.children).toHaveLength(0);
    disposeTab(tab);
  });

  test("clears selection if removed node is selected", () => {
    const tab = makeTab();
    tab.session.selection = ["children", 0];
    transactDoc(tab, (t) => mutateRemoveNode(t, ["children", 0]));
    expect(tab.session.selection).toBeNull();
    disposeTab(tab);
  });
});

describe("mutateDuplicateNode", () => {
  test("duplicates and selects the clone", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateDuplicateNode(t, ["children", 0]));
    expect(tab.doc.document.children).toHaveLength(2);
    expect((tab.doc.document as any).children[1].tagName).toBe("p");
    expect(tab.session.selection).toEqual(["children", 1]);
    disposeTab(tab);
  });
});

describe("mutateWrapNode", () => {
  test("wraps node in new element", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateWrapNode(t, ["children", 0], "section"));
    expect((tab.doc.document as any).children[0].tagName).toBe("section");
    expect((tab.doc.document as any).children[0].children[0].tagName).toBe("p");
    disposeTab(tab);
  });
});

describe("mutateMoveNode", () => {
  test("moves node between parents", () => {
    const doc = {
      children: [
        { children: [], tagName: "section" },
        { tagName: "p", textContent: "move me" },
      ],
      tagName: "div",
    };
    const tab = makeTab(doc);
    transactDoc(tab, (t) => mutateMoveNode(t, ["children", 1], ["children", 0], 0));
    expect(tab.doc.document.children).toHaveLength(1);
    expect((tab.doc.document as any).children[0].children[0].textContent).toBe("move me");
    disposeTab(tab);
  });

  test("out-of-range source index is a no-op (no undefined inserted)", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateMoveNode(t, ["children", 5], [], 0));
    expect(tab.doc.document.children).toHaveLength(1);
    expect((tab.doc.document as any).children[0]).toBeDefined();
    expect((tab.doc.document as any).children[0].tagName).toBe("p");
    disposeTab(tab);
  });

  test("non-numeric source index is a no-op", () => {
    const tab = makeTab();
    const before = jsonClone(tab.doc.document);
    transactDoc(tab, (t) => mutateMoveNode(t, ["children"], [], 0));
    expect(jsonClone(tab.doc.document)).toEqual(before);
    disposeTab(tab);
  });

  test("missing source parent is a no-op", () => {
    const tab = makeTab();
    const before = jsonClone(tab.doc.document);
    transactDoc(tab, (t) => mutateMoveNode(t, ["children", 3, "children", 0], [], 0));
    expect(jsonClone(tab.doc.document)).toEqual(before);
    disposeTab(tab);
  });

  test("move within same parent adjusts index", () => {
    const doc = {
      children: [
        { tagName: "p", textContent: "a" },
        { tagName: "p", textContent: "b" },
        { tagName: "p", textContent: "c" },
      ],
      tagName: "div",
    };
    const tab = makeTab(doc);
    // Move "a" below "c" (insert index 3, adjusted to 2 after removal)
    transactDoc(tab, (t) => mutateMoveNode(t, ["children", 0], [], 3));
    expect((tab.doc.document as any).children.map((c: any) => c.textContent)).toEqual([
      "b",
      "c",
      "a",
    ]);
    disposeTab(tab);
  });
});

describe("mutateUpdateProperty", () => {
  test("sets a property", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "World"));
    expect((tab.doc.document as any).children[0].textContent).toBe("World");
    disposeTab(tab);
  });

  test("deletes property when value is empty", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", ""));
    expect((tab.doc.document as any).children[0].textContent).toBeUndefined();
    disposeTab(tab);
  });
});

describe("mutateUpdateStyle", () => {
  test("sets and removes style", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateUpdateStyle(t, [], "color", "red"));
    expect((tab.doc.document as any).style.color).toBe("red");

    transactDoc(tab, (t) => mutateUpdateStyle(t, [], "color", ""));
    expect(tab.doc.document.style).toBeUndefined();
    disposeTab(tab);
  });
});

describe("mutateUpdateAttribute", () => {
  test("sets and removes attribute", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateUpdateAttribute(t, ["children", 0], "id", "main"));
    expect((tab.doc.document as any).children[0].attributes.id).toBe("main");

    transactDoc(tab, (t) => mutateUpdateAttribute(t, ["children", 0], "id", ""));
    expect((tab.doc.document as any).children[0].attributes).toBeUndefined();
    disposeTab(tab);
  });
});

describe("mutateUpdateMediaStyle", () => {
  test("sets media-scoped style", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateUpdateMediaStyle(t, [], "--md", "display", "flex"));
    expect((tab.doc.document as any).style["@--md"].display).toBe("flex");
    disposeTab(tab);
  });
});

describe("state definitions", () => {
  test("mutateAddDef / mutateRemoveDef", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateAddDef(t, "count", { $value: 0 }));
    expect((tab.doc.document as any).state.count.$value).toBe(0);

    transactDoc(tab, (t) => mutateRemoveDef(t, "count"));
    expect(tab.doc.document.state).toBeUndefined();
    disposeTab(tab);
  });

  test("mutateUpdateDef", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateAddDef(t, "name", { $value: "hello" }));
    transactDoc(tab, (t) => mutateUpdateDef(t, "name", { $value: "world" }));
    expect((tab.doc.document as any).state.name.$value).toBe("world");
    disposeTab(tab);
  });

  test("mutateRenameDef", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateAddDef(t, "old", { $value: 1 }));
    transactDoc(tab, (t) => mutateRenameDef(t, "old", "new"));
    expect((tab.doc.document as any).state.new.$value).toBe(1);
    expect((tab.doc.document as any).state.old).toBeUndefined();
    disposeTab(tab);
  });
});

describe("mutateUpdateProp", () => {
  test("sets and removes $props", () => {
    const doc = { $props: { label: "Click" }, tagName: "my-button" };
    const tab = makeTab(doc);
    transactDoc(tab, (t) => mutateUpdateProp(t, [], "label", "Submit"));
    expect((tab.doc.document as any).$props.label).toBe("Submit");

    transactDoc(tab, (t) => mutateUpdateProp(t, [], "label", ""));
    expect(tab.doc.document.$props).toBeUndefined();
    disposeTab(tab);
  });
});

describe("mutateUpdateFrontmatter", () => {
  test("sets and removes frontmatter field", () => {
    const tab = createTab({
      document: { tagName: "main" },
      documentPath: "pages/index.md",
      frontmatter: { title: "Home" },
      id: "fm-test",
    });

    mutateUpdateFrontmatter(tab, "title", "New Title");
    expect(tab.doc.content.frontmatter.title).toBe("New Title");
    expect(tab.doc.dirty).toBe(true);

    mutateUpdateFrontmatter(tab, "title", "");
    expect(tab.doc.content.frontmatter.title).toBeUndefined();
    disposeTab(tab);
  });
});
