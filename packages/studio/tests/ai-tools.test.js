import "./with-dom.ts";
import { describe, expect, test } from "bun:test";
import { createToolRegistry } from "@jxsuite/ai";
import { createTab, disposeTab } from "../src/tabs/tab";
import { undo } from "../src/tabs/transact";
import { registerAiTools } from "../src/services/ai-tools";

/** Build a tab + registry with a no-op validator so tests assert mutation, not schema. */
function harness(doc) {
  const tab = createTab({ document: doc, id: "test" });
  const registry = createToolRegistry();
  registerAiTools(registry, { getTab: () => tab, validate: async () => [] });
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
});
