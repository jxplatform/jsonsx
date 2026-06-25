import "./with-dom.ts";
import { describe, expect, test } from "bun:test";
import { createToolRegistry } from "@jxsuite/ai";
import { createTab, disposeTab } from "../src/tabs/tab";
import { beginBatch, endBatch, undo } from "../src/tabs/transact";
import { registerAiTools } from "../src/services/ai-tools";

/** Build a tab + registry with a no-op validator so tests assert mutation, not schema. */
function harness(doc, opts = {}) {
  const tab = createTab({ document: doc, id: "test" });
  const registry = createToolRegistry();
  registerAiTools(registry, { getTab: () => tab, validate: async () => [], ...opts });
  return { tab, registry };
}

describe("ai-tools — state tools (§14.1 regression)", () => {
  test("add_state writes under document.state, NOT the document root", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", state: { existing: 1 }, children: [] });

    const res = await registry.execute("add_state", { key: "count", value: 0 });

    expect(res.success).toBe(true);
    expect(tab.doc.document.state.count).toBe(0); // Correct location
    expect(tab.doc.document.count).toBeUndefined(); // NOT the root (the original bug)
    expect(tab.history.index).toBe(1); // One undoable transaction
    disposeTab(tab);
  });

  test("add_state creates the state object when the document has none", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", children: [] });

    const res = await registry.execute("add_state", { key: "isOpen", value: false });

    expect(res.success).toBe(true);
    expect(tab.doc.document.state.isOpen).toBe(false);
    disposeTab(tab);
  });

  test("add_state preserves an empty-string default (not deleted)", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", children: [] });

    const res = await registry.execute("add_state", { key: "title", value: "" });

    expect(res.success).toBe(true);
    expect(tab.doc.document.state).toHaveProperty("title");
    expect(tab.doc.document.state.title).toBe("");
    disposeTab(tab);
  });

  test("add_state rejects a duplicate key", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", state: { count: 0 }, children: [] });

    const res = await registry.execute("add_state", { key: "count", value: 5 });

    expect(res.success).toBe(false);
    expect(tab.doc.document.state.count).toBe(0); // Unchanged
    disposeTab(tab);
  });

  test("update_state changes an existing key and undo restores it", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", state: { count: 0 }, children: [] });

    await registry.execute("update_state", { key: "count", value: 10 });
    expect(tab.doc.document.state.count).toBe(10);

    undo(tab);
    expect(tab.doc.document.state.count).toBe(0);
    disposeTab(tab);
  });

  test("update_state removes a key when value is null", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", state: { count: 0 }, children: [] });

    const res = await registry.execute("update_state", { key: "count", value: null });

    expect(res.success).toBe(true);
    expect(tab.doc.document.state).not.toHaveProperty("count");
    disposeTab(tab);
  });

  test("update_state errors on an unknown key", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", state: {}, children: [] });

    const res = await registry.execute("update_state", { key: "ghost", value: 1 });

    expect(res.success).toBe(false);
    disposeTab(tab);
  });
});

describe("ai-tools — style & structure", () => {
  test("set_style sets a CSS property on a node", async () => {
    const { tab, registry } = harness({ tagName: "div", children: [] });

    const res = await registry.execute("set_style", {
      path: [],
      property: "backgroundColor",
      value: "var(--color-accent)",
    });

    expect(res.success).toBe(true);
    expect(tab.doc.document.style.backgroundColor).toBe("var(--color-accent)");
    disposeTab(tab);
  });

  test("set_style removes a property when value is null", async () => {
    const { tab, registry } = harness({ tagName: "div", style: { color: "red" }, children: [] });

    const res = await registry.execute("set_style", { path: [], property: "color", value: null });

    expect(res.success).toBe(true);
    expect(tab.doc.document.style?.color).toBeUndefined();
    disposeTab(tab);
  });

  test("move_node relocates a node between parents", async () => {
    const { tab, registry } = harness({
      tagName: "div",
      children: [
        { tagName: "section", children: [{ tagName: "p", textContent: "move me" }] },
        { tagName: "aside", children: [] },
      ],
    });

    const res = await registry.execute("move_node", {
      fromPath: ["children", 0, "children", 0],
      toParentPath: ["children", 1],
      toIndex: 0,
    });

    expect(res.success).toBe(true);
    expect(tab.doc.document.children[0].children).toHaveLength(0);
    expect(tab.doc.document.children[1].children[0].tagName).toBe("p");
    disposeTab(tab);
  });

  test("move_node refuses to move the document root", async () => {
    const { tab, registry } = harness({ tagName: "div", children: [] });

    const res = await registry.execute("move_node", {
      fromPath: [],
      toParentPath: [],
      toIndex: 0,
    });

    expect(res.success).toBe(false);
    disposeTab(tab);
  });

  test("add_child appends a node to the parent's children", async () => {
    const { tab, registry } = harness({
      tagName: "ul",
      children: [{ tagName: "li", textContent: "one" }],
    });

    const res = await registry.execute("add_child", {
      parentPath: [],
      index: 1,
      node: { tagName: "li", textContent: "two" },
    });

    expect(res.success).toBe(true);
    expect(tab.doc.document.children).toHaveLength(2);
    expect(tab.doc.document.children[1].textContent).toBe("two");
    disposeTab(tab);
  });

  test("add_child rejects a parentPath that points at a children array (trailing 'children')", async () => {
    // Regression (L6.3/L6.7): the model appended a trailing "children" segment, so parentPath
    // resolved to the children array, not the node. The old code silently tacked a bogus
    // `.children` onto the array and reported success — the node never rendered.
    const { tab, registry } = harness({
      tagName: "div",
      children: [{ tagName: "ul", children: [{ tagName: "li", textContent: "one" }] }],
    });

    const res = await registry.execute("add_child", {
      parentPath: ["children", 0, "children"], // <- points at the <ul>'s children array
      index: 1,
      node: { tagName: "li", textContent: "two" },
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("children array");
    // The bogus insert must NOT have happened: the real children array is untouched...
    expect(tab.doc.document.children[0].children).toHaveLength(1);
    // ...and no `.children` property was tacked onto the array object.
    expect(tab.doc.document.children[0].children.children).toBeUndefined();
    disposeTab(tab);
  });
});

describe("ai-tools — open_document", () => {
  test("open_document switches the active document via openDocument callback", async () => {
    let openedPath = null;
    const secondDoc = { tagName: "section", children: [] };
    const secondTab = createTab({ document: secondDoc, id: "second" });

    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      {
        openDocument: async (path) => {
          openedPath = path;
        },
      },
    );

    const res = await registry.execute("open_document", { path: "pages/about.json" });

    expect(res.success).toBe(true);
    expect(openedPath).toBe("pages/about.json");
    expect(res.summary).toContain("pages/about.json");
    disposeTab(tab);
    disposeTab(secondTab);
  });

  test("open_document errors when openDocument is not available", async () => {
    const { tab, registry } = harness({ tagName: "div", children: [] });

    const res = await registry.execute("open_document", { path: "pages/about.json" });

    expect(res.success).toBe(false);
    expect(res.error).toContain("not available");
    disposeTab(tab);
  });

  test("open_document surfaces file-not-found errors", async () => {
    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      {
        openDocument: async () => {
          throw new Error("File not found: pages/missing.json");
        },
      },
    );

    const res = await registry.execute("open_document", { path: "pages/missing.json" });

    expect(res.success).toBe(false);
    expect(res.error).toContain("File not found");
    disposeTab(tab);
  });

  test("cross-document edits stay undoable inside a batch (mid-loop tab switch)", async () => {
    // Reproduces the batching bug: the agent loop opens ONE batch on the tab active at start.
    // Without the open_document flush, edits to a tab opened mid-loop get no history snapshot.
    const tabA = createTab({
      document: { tagName: "div", children: [{ tagName: "h1", textContent: "A" }] },
      id: "pages/index.json",
    });
    const tabB = createTab({
      document: { tagName: "div", children: [{ tagName: "h1", textContent: "B" }] },
      id: "pages/about.json",
    });
    const tabs = { "pages/index.json": tabA, "pages/about.json": tabB };
    let active = tabA;

    const registry = createToolRegistry();
    registerAiTools(registry, {
      getTab: () => active,
      validate: async () => [],
      openDocument: async (path) => {
        active = tabs[path];
      },
    });

    // Simulate the agent loop: one batch opened on the tab active at loop start (tab A).
    beginBatch(tabA);

    // Edit tab A.
    await registry.execute("set_text", { path: ["children", 0], value: "A edited" });
    // Switch to tab B mid-loop — should flush A's batch and open one on B.
    await registry.execute("open_document", { path: "pages/about.json" });
    // Edit tab B.
    await registry.execute("set_text", { path: ["children", 0], value: "B edited" });

    // Loop end.
    endBatch();

    // Both documents reflect the edits.
    expect(tabA.doc.document.children[0].children[0]).toBe("A edited");
    expect(tabB.doc.document.children[0].children[0]).toBe("B edited");

    // Both documents have an undoable snapshot (index advanced past the base).
    expect(tabA.history.index).toBe(1);
    expect(tabB.history.index).toBe(1);

    // Undo rolls back each document's edit independently (set_text restores textContent).
    undo(tabB);
    expect(tabB.doc.document.children[0].textContent).toBe("B");
    undo(tabA);
    expect(tabA.doc.document.children[0].textContent).toBe("A");

    disposeTab(tabA);
    disposeTab(tabB);
  });
});
