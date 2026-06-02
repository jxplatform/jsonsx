import "./with-dom.js";
import { effect } from "../src/reactivity";
import { createTab, disposeTab } from "../src/tabs/tab";
import type { JxMutableNode } from "@jxsuite/schema/types";
import {
  transactDoc,
  undo,
  redo,
  mutateInsertNode,
  mutateRemoveNode,
  mutateDuplicateNode,
  mutateWrapNode,
  mutateMoveNode,
  mutateUpdateProperty,
  mutateUpdateStyle,
  mutateUpdateAttribute,
  mutateUpdateMediaStyle,
  mutateAddDef,
  mutateRemoveDef,
  mutateUpdateDef,
  mutateRenameDef,
  mutateUpdateProp,
  mutateUpdateFrontmatter,
} from "../src/tabs/transact";
import { test, expect, describe } from "bun:test";

function makeTab(
  doc: JxMutableNode = { tagName: "div", children: [{ tagName: "p", textContent: "Hello" }] },
) {
  return createTab({ id: "test", document: doc });
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

    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }), { skipHistory: true });

    expect(tab.doc.dirty).toBe(true);
    expect(tab.history.index).toBe(0);
    expect(tab.history.snapshots).toHaveLength(1);

    disposeTab(tab);
  });

  test("triggers reactive effects", () => {
    const tab = makeTab();
    let childCount = 0;
    const stop = effect(() => {
      childCount = tab.doc.document.children?.length ?? 0;
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

  test("undo restores selection", () => {
    const tab = makeTab();
    tab.session.selection = ["children", 0];
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
    // snapshot 1 captured selection as ["children", 0]
    tab.session.selection = ["children", 1];
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 1], "textContent", "world"));
    // snapshot 2 captured selection as ["children", 1]

    undo(tab); // restores snapshot 1 → selection ["children", 0]
    expect(tab.session.selection).toEqual(["children", 0]);
    undo(tab); // restores snapshot 0 → selection null
    expect(tab.session.selection).toBeNull();
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
      tagName: "div",
      children: [
        { tagName: "section", children: [] },
        { tagName: "p", textContent: "move me" },
      ],
    };
    const tab = makeTab(doc);
    transactDoc(tab, (t) => mutateMoveNode(t, ["children", 1], ["children", 0], 0));
    expect(tab.doc.document.children).toHaveLength(1);
    expect((tab.doc.document as any).children[0].children[0].textContent).toBe("move me");
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
    const doc = { tagName: "my-button", $props: { label: "Click" } };
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
      id: "fm-test",
      documentPath: "pages/index.md",
      document: { tagName: "main" },
      frontmatter: { title: "Home" },
    });

    mutateUpdateFrontmatter(tab, "title", "New Title");
    expect(tab.doc.content.frontmatter.title).toBe("New Title");
    expect(tab.doc.dirty).toBe(true);

    mutateUpdateFrontmatter(tab, "title", "");
    expect(tab.doc.content.frontmatter.title).toBeUndefined();
    disposeTab(tab);
  });
});
