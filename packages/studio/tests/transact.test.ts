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
    tab.session.selection = [["children", 0]];
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
    tab.session.selection = [["children", 1]];
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 1], "textContent", "world"));

    undo(tab); // Selection as it was before the text edit
    expect(tab.session.selection).toEqual([["children", 1]]);
    undo(tab); // Selection as it was before the insert
    expect(tab.session.selection).toEqual([["children", 0]]);
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
    tab.session.selection = [["children", 0]];
    transactDoc(tab, (t) => mutateRemoveNode(t, ["children", 0]));
    expect(tab.session.selection).toEqual([]);
    disposeTab(tab);
  });
});

describe("mutateDuplicateNode", () => {
  test("duplicates and selects the clone", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateDuplicateNode(t, ["children", 0]));
    expect(tab.doc.document.children).toHaveLength(2);
    expect((tab.doc.document as any).children[1].tagName).toBe("p");
    expect(tab.session.selection).toEqual([["children", 1]]);
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

  /**
   * A PATH THAT NO LONGER RESOLVES IS AN ORDINARY STATE OF THE DOCUMENT, not a programming error.
   *
   * Deletions arrive from collaborators and from the author's own undo while a surface addressing
   * the deleted node is still open. `getNodeAtPath` answers `undefined` for the coordinate, and
   * `node[key]` on that threw `undefined is not an object` from INSIDE the mutation — rolled back
   * and rethrown by `transactDoc`, correctly, into whatever asked for the edit. For the dock's
   * debounced body commit that caller is `commitBufferWrites`, and the throw came out of the dock
   * panel's `afterRender`: the repaint aborted with the editor undisposed and its 500ms timer still
   * armed over a container lit was about to replace.
   */
  test("a path that no longer resolves changes nothing instead of throwing", () => {
    const tab = makeTab();
    expect(() =>
      transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 7], "onclick", { body: "x" })),
    ).not.toThrow();
    expect((tab.doc.document as any).children[7]).toBeUndefined();
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
  function makeFmTab(frontmatter: Record<string, unknown>) {
    return createTab({
      document: { tagName: "main" },
      documentPath: "pages/index.md",
      frontmatter,
      id: "fm-test",
    });
  }

  test("sets and removes frontmatter field", () => {
    const tab = makeFmTab({ title: "Home" });

    mutateUpdateFrontmatter(tab, "title", "New Title");
    expect(tab.doc.content.frontmatter.title).toBe("New Title");
    expect(tab.doc.dirty).toBe(true);

    mutateUpdateFrontmatter(tab, "title", "");
    expect(tab.doc.content.frontmatter.title).toBeUndefined();
    disposeTab(tab);
  });

  test("undo reverts a frontmatter change and redo re-applies it", () => {
    const tab = makeFmTab({ title: "Home" });

    transactDoc(tab, (t) => mutateUpdateFrontmatter(t, "title", "Changed"));
    expect(tab.history.index).toBe(1);

    undo(tab);
    expect(tab.doc.content.frontmatter.title).toBe("Home");
    expect(tab.history.index).toBe(0);

    redo(tab);
    expect(tab.doc.content.frontmatter.title).toBe("Changed");
    expect(tab.history.index).toBe(1);
    disposeTab(tab);
  });

  test("undo of a field add deletes the key; undo of a delete restores the value", () => {
    const tab = makeFmTab({ title: "Home" });

    transactDoc(tab, (t) => mutateUpdateFrontmatter(t, "draft", true));
    undo(tab);
    expect("draft" in tab.doc.content.frontmatter).toBe(false);
    redo(tab);
    expect(tab.doc.content.frontmatter.draft).toBe(true);

    transactDoc(tab, (t) => mutateUpdateFrontmatter(t, "title"));
    expect("title" in tab.doc.content.frontmatter).toBe(false);
    undo(tab);
    expect(tab.doc.content.frontmatter.title).toBe("Home");
    disposeTab(tab);
  });

  test("array values round-trip through undo/redo detached from live references", () => {
    const tab = makeFmTab({ tags: ["a", "b"] });

    transactDoc(tab, (t) => mutateUpdateFrontmatter(t, "tags", ["x", "y", "z"]));
    (tab.doc.content.frontmatter.tags as string[]).push("mutated-live");

    undo(tab);
    expect(tab.doc.content.frontmatter.tags).toEqual(["a", "b"]);
    redo(tab);
    expect(tab.doc.content.frontmatter.tags).toEqual(["x", "y", "z"]);
    disposeTab(tab);
  });

  test("sequential frontmatter edits undo step by step back to the original", () => {
    const tab = makeFmTab({ title: "One" });

    transactDoc(tab, (t) => mutateUpdateFrontmatter(t, "title", "Two"));
    transactDoc(tab, (t) => mutateUpdateFrontmatter(t, "title", "Three"));

    undo(tab);
    expect(tab.doc.content.frontmatter.title).toBe("Two");
    undo(tab);
    expect(tab.doc.content.frontmatter.title).toBe("One");
    expect(tab.history.index).toBe(0);
    disposeTab(tab);
  });

  test("a transaction mixing doc and frontmatter mutations undoes both", () => {
    const tab = makeFmTab({ title: "Home" });

    transactDoc(tab, (t) => {
      mutateInsertNode(t, [], 0, { tagName: "span" });
      mutateUpdateFrontmatter(t, "title", "Changed");
    });
    expect(tab.doc.document.children).toHaveLength(1);
    expect(tab.doc.content.frontmatter.title).toBe("Changed");

    undo(tab);
    expect(tab.doc.document.children ?? []).toHaveLength(0);
    expect(tab.doc.content.frontmatter.title).toBe("Home");

    redo(tab);
    expect(tab.doc.document.children).toHaveLength(1);
    expect(tab.doc.content.frontmatter.title).toBe("Changed");
    disposeTab(tab);
  });
});

describe("the debug history-consistency assertion", () => {
  /**
   * Ops-based undo/redo and checkpoint replay must land on the same state. The check only runs
   * behind the `jx-canvas-debug` flag — it JSON-stringifies the whole document twice per step, so
   * it cannot be on by default — which means nothing exercises it unless a test sets the flag.
   */
  test("stays silent when the flag is off, and when replay agrees", () => {
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const tab = makeTab();
      transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
      undo(tab);
      redo(tab);
      expect(errors).toHaveLength(0);

      localStorage.setItem("jx-canvas-debug", "1");
      undo(tab);
      redo(tab);
      // The ops path and the replay path agree, so the flag being on changes nothing.
      expect(errors).toHaveLength(0);
      disposeTab(tab);
    } finally {
      localStorage.removeItem("jx-canvas-debug");
      console.error = realError;
    }
  });

  test("reports divergence when the live document has drifted from its snapshot", () => {
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      localStorage.setItem("jx-canvas-debug", "1");
      const tab = makeTab();
      transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));

      // Drift the live document behind history's back — exactly the class of bug the assertion
      // Exists to catch, and the only way to reach its reporting branch.
      (tab.doc.document.children as JxMutableNode[]).push({ tagName: "em" });
      undo(tab);
      redo(tab);

      expect(errors.length).toBeGreaterThan(0);
      expect(String(errors[0]?.[0])).toContain("diverged from checkpoint replay");
      disposeTab(tab);
    } finally {
      localStorage.removeItem("jx-canvas-debug");
      console.error = realError;
    }
  });
});
