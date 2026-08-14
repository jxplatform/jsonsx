import "./with-dom.ts";
import { describe, expect, test } from "bun:test";
import { createToolRegistry } from "@jxsuite/ai";
import { createTab, disposeTab } from "../src/tabs/tab";
import type { Tab } from "../src/tabs/tab";
import { beginBatch, endBatch, setTransactGate, undo } from "../src/tabs/transact";
import { registerAiTools } from "../src/services/ai-tools";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { beginTurn, endTurn, resetAiWrites } from "../src/services/ai-writes";

type AiToolsOptions = Parameters<typeof registerAiTools>[1];

/** Build a tab + registry with a no-op validator so tests assert mutation, not schema. */
function harness(doc: Record<string, unknown>, opts: Partial<AiToolsOptions> = {}) {
  const tab = createTab({ document: doc, id: "test" });
  const registry = createToolRegistry();
  registerAiTools(registry, { getTab: () => tab, validate: async () => [], ...opts });
  return { tab, registry };
}

/** Execute a tool and return only its error message (keeps assertions off await-member access). */
async function execErr(
  registry: ReturnType<typeof createToolRegistry>,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await registry.execute(name, args);
  return result.error;
}

describe("ai-tools — state tools (§14.1 regression)", () => {
  test("add_state writes under document.state, NOT the document root", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", state: { existing: 1 }, children: [] });

    const res = await registry.execute("add_state", { key: "count", value: 0 });

    expect(res.success).toBe(true);
    expect(tab.doc.document.state!.count).toBe(0); // Correct location
    expect(tab.doc.document.count).toBeUndefined(); // NOT the root (the original bug)
    expect(tab.history.index).toBe(1); // One undoable transaction
    disposeTab(tab);
  });

  test("add_state creates the state object when the document has none", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", children: [] });

    const res = await registry.execute("add_state", { key: "isOpen", value: false });

    expect(res.success).toBe(true);
    expect(tab.doc.document.state!.isOpen).toBe(false);
    disposeTab(tab);
  });

  test("add_state preserves an empty-string default (not deleted)", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", children: [] });

    const res = await registry.execute("add_state", { key: "title", value: "" });

    expect(res.success).toBe(true);
    expect(tab.doc.document.state).toHaveProperty("title");
    expect(tab.doc.document.state!.title).toBe("");
    disposeTab(tab);
  });

  test("add_state rejects a duplicate key", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", state: { count: 0 }, children: [] });

    const res = await registry.execute("add_state", { key: "count", value: 5 });

    expect(res.success).toBe(false);
    expect(tab.doc.document.state!.count).toBe(0); // Unchanged
    disposeTab(tab);
  });

  test("update_state changes an existing key and undo restores it", async () => {
    const { tab, registry } = harness({ tagName: "x-comp", state: { count: 0 }, children: [] });

    await registry.execute("update_state", { key: "count", value: 10 });
    expect(tab.doc.document.state!.count).toBe(10);

    undo(tab);
    expect(tab.doc.document.state!.count).toBe(0);
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
    expect(tab.doc.document.style!.backgroundColor).toBe("var(--color-accent)");
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
    const moveChildren = tab.doc.document.children as JxMutableNode[];
    expect(moveChildren[0]!.children).toHaveLength(0);
    expect((moveChildren[1]!.children as JxMutableNode[])[0]!.tagName).toBe("p");
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
    expect((tab.doc.document.children as JxMutableNode[])[1]!.textContent).toBe("two");
    disposeTab(tab);
  });

  test("add_child rejects a parentPath that points at a children array (trailing 'children')", async () => {
    // Regression (L6.3/L6.7): the model appended a trailing "children" segment, so parentPath
    // Resolved to the children array, not the node. The old code silently tacked a bogus
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
    const ulNode = (tab.doc.document.children as JxMutableNode[])[0]!;
    expect(ulNode.children).toHaveLength(1);
    // ...and no `.children` property was tacked onto the array object.
    expect((ulNode.children as unknown as Record<string, unknown>).children).toBeUndefined();
    disposeTab(tab);
  });
});

describe("ai-tools — open_document", () => {
  test("open_document switches the active document via openDocument callback", async () => {
    let openedPath: string | null = null;
    const secondDoc = { tagName: "section", children: [] };
    const secondTab = createTab({ document: secondDoc, id: "second" });

    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      {
        openDocument: async (path: string) => {
          openedPath = path;
        },
      },
    );

    const res = await registry.execute("open_document", { path: "pages/about.json" });

    expect(res.success).toBe(true);
    expect(openedPath as string | null).toBe("pages/about.json");
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
    const tabs: Record<string, Tab> = { "pages/index.json": tabA, "pages/about.json": tabB };
    let active = tabA;

    const registry = createToolRegistry();
    registerAiTools(registry, {
      getTab: () => active,
      validate: async () => [],
      openDocument: async (path) => {
        active = tabs[path]!;
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
    const tabAChild = (tabA.doc.document.children as JxMutableNode[])[0]!;
    const tabBChild = (tabB.doc.document.children as JxMutableNode[])[0]!;
    expect((tabAChild.children as string[])[0]).toBe("A edited");
    expect((tabBChild.children as string[])[0]).toBe("B edited");

    // Both documents have an undoable snapshot (index advanced past the base).
    expect(tabA.history.index).toBe(1);
    expect(tabB.history.index).toBe(1);

    // Undo rolls back each document's edit independently (set_text restores textContent).
    undo(tabB);
    expect((tabB.doc.document.children as JxMutableNode[])[0]!.textContent).toBe("B");
    undo(tabA);
    expect((tabA.doc.document.children as JxMutableNode[])[0]!.textContent).toBe("A");

    disposeTab(tabA);
    disposeTab(tabB);
  });
});

describe("ai-tools — read & inspect", () => {
  test("read_document returns the whole tree, a subtree, and reports bad paths", async () => {
    const { tab, registry } = harness({
      children: [{ tagName: "p", textContent: "hi" }],
      tagName: "div",
    });
    const whole = await registry.execute("read_document", {});
    expect(whole.success).toBe(true);
    expect((whole.data as JxMutableNode).tagName).toBe("div");

    const sub = await registry.execute("read_document", { path: ["children", 0] });
    expect((sub.data as JxMutableNode).tagName).toBe("p");

    const bad = await registry.execute("read_document", { path: ["children", 9] });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("No node exists");
    disposeTab(tab);
  });

  test("tools report when no document is open", async () => {
    const registry = createToolRegistry();
    registerAiTools(registry, { getTab: () => null, validate: async () => [] });
    expect(await execErr(registry, "read_document", {})).toContain("No document is open");
    expect(await execErr(registry, "set_property", { key: "id", path: [], value: "x" })).toContain(
      "No document is open",
    );
    expect(await execErr(registry, "set_text", { path: [], value: "x" })).toContain(
      "No document is open",
    );
    expect(await execErr(registry, "remove_node", { path: ["children", 0] })).toContain(
      "No document is open",
    );
  });
});

describe("ai-tools — set_property / set_text / remove_node", () => {
  test("set_property sets and removes a property", async () => {
    const { tab, registry } = harness({ id: "old", tagName: "div", children: [] });
    const set = await registry.execute("set_property", { key: "id", path: [], value: "new" });
    expect(set.success).toBe(true);
    expect(tab.doc.document.id).toBe("new");

    const removed = await registry.execute("set_property", { key: "id", path: [] });
    expect(removed.success).toBe(true);
    expect(tab.doc.document.id).toBeUndefined();
    disposeTab(tab);
  });

  test("set_property and set_text reject an invalid path", async () => {
    const { tab, registry } = harness({ tagName: "div", children: [] });
    expect(
      await execErr(registry, "set_property", { key: "id", path: ["children", 5], value: "x" }),
    ).toContain("No node exists");
    expect(await execErr(registry, "set_text", { path: ["children", 5], value: "x" })).toContain(
      "No node exists",
    );
    disposeTab(tab);
  });

  test("set_text replaces a node's children with the text", async () => {
    const { tab, registry } = harness({
      children: [{ tagName: "p", textContent: "old" }],
      tagName: "div",
    });
    const res = await registry.execute("set_text", { path: ["children", 0], value: "fresh" });
    expect(res.success).toBe(true);
    const p = (tab.doc.document.children as JxMutableNode[])[0]!;
    expect((p.children as string[])[0]).toBe("fresh");
    disposeTab(tab);
  });

  test("remove_node deletes a child, refuses the root, and rejects bad paths", async () => {
    const { tab, registry } = harness({
      children: [{ tagName: "p" }, { tagName: "span" }],
      tagName: "div",
    });
    const res = await registry.execute("remove_node", { path: ["children", 0] });
    expect(res.success).toBe(true);
    expect((tab.doc.document.children as JxMutableNode[])[0]!.tagName).toBe("span");

    expect(await execErr(registry, "remove_node", { path: [] })).toContain(
      "Cannot remove the document root",
    );
    expect(await execErr(registry, "remove_node", { path: ["children", 9] })).toContain(
      "No node exists",
    );
    disposeTab(tab);
  });
});

describe("ai-tools — validation feedback & render gate", () => {
  test("translateValidationError adds a targeted fix hint per error pattern", async () => {
    const schemaErrors = [
      "/style: must NOT have additional property",
      "/tagName: must match pattern",
      "/a: must be string",
      "/b: must be number",
      "/c: must be object",
      "/d: must be boolean",
      "root: must have required property 'tagName'",
      "/e: must be equal to one of the allowed values",
      "/f: some unrecognized error",
    ];
    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      { saveFile: async () => {}, validate: async () => schemaErrors },
    );
    const res = await registry.execute("create_component", {
      content: { tagName: "bad" },
      path: "components/bad.json",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("→ Fix:");
    expect(res.error).toContain("camelCase");
    expect(res.error).toContain("must contain a hyphen");
    expect(res.error).toContain("/f: some unrecognized error"); // Fallthrough kept verbatim
    disposeTab(tab);
  });

  test("a mutation that introduces new schema errors is reported with fixes", async () => {
    let call = 0;
    const validate = async () => {
      call += 1;
      return call === 1 ? [] : ["/tagName: must match pattern"]; // Before clean, after dirty
    };
    const { tab, registry } = harness({ tagName: "div", children: [] }, { validate });
    const res = await registry.execute("set_property", { key: "tagName", path: [], value: "x" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("introduced schema errors");
    expect(res.error).toContain("→ Fix:");
    disposeTab(tab);
  });

  test("a schema-valid mutation that breaks rendering is reported", async () => {
    let call = 0;
    const renderCheck = async () => {
      call += 1;
      return call === 1 ? ({ ok: true } as const) : ({ error: "render boom", ok: false } as const);
    };
    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      { renderCheck, validate: async () => [] },
    );
    const res = await registry.execute("set_property", { key: "id", path: [], value: "x" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("broke rendering");
    expect(res.error).toContain("render boom");
    disposeTab(tab);
  });

  test("a hardcoded design-token value yields a soft hint but still succeeds", async () => {
    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      { projectStyle: { "--color-accent": "#ff0000" }, validate: async () => [] },
    );
    const res = await registry.execute("set_style", {
      path: [],
      property: "color",
      value: "#ff0000",
    });
    expect(res.success).toBe(true);
    expect(res.summary).toContain("--color-accent");
    disposeTab(tab);
  });
});

describe("ai-tools — file creation", () => {
  test("create_component writes the file when storage is available", async () => {
    const saved: [string, string][] = [];
    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      {
        saveFile: async (p, c) => {
          saved.push([p, c]);
        },
        validate: async () => [],
      },
    );
    const res = await registry.execute("create_component", {
      content: { children: [], tagName: "my-card" },
      path: "components/card.json",
    });
    expect(res.success).toBe(true);
    expect(res.summary).toContain("Created component");
    expect(saved[0]![0]).toBe("components/card.json");
    disposeTab(tab);
  });

  test("create_component surfaces a render failure and a write failure", async () => {
    const { tab: t1, registry: r1 } = harness(
      { tagName: "div", children: [] },
      {
        renderCheck: async () => ({ error: "no render", ok: false }),
        saveFile: async () => {},
        validate: async () => [],
      },
    );
    expect(
      await execErr(r1, "create_component", { content: { tagName: "x" }, path: "c.json" }),
    ).toContain("fails to render");
    disposeTab(t1);

    const { tab: t2, registry: r2 } = harness(
      { tagName: "div", children: [] },
      {
        saveFile: async () => {
          throw new Error("disk full");
        },
        validate: async () => [],
      },
    );
    expect(
      await execErr(r2, "create_component", { content: { tagName: "x" }, path: "c.json" }),
    ).toContain("Failed to write file");
    disposeTab(t2);
  });

  test("create_page writes the file, and reports when storage is unavailable", async () => {
    const saved: [string, string][] = [];
    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      {
        saveFile: async (p, c) => {
          saved.push([p, c]);
        },
        validate: async () => [],
      },
    );
    const ok = await registry.execute("create_page", {
      content: { children: [], tagName: "div" },
      path: "pages/about.json",
    });
    expect(ok.success).toBe(true);
    expect(saved[0]![0]).toBe("pages/about.json");

    const { tab: t2, registry: r2 } = harness({ tagName: "div", children: [] }); // No saveFile
    expect(
      await execErr(r2, "create_page", { content: { tagName: "div" }, path: "p.json" }),
    ).toContain("not available");
    expect(
      await execErr(r2, "create_component", { content: { tagName: "x" }, path: "c.json" }),
    ).toContain("not available");
    disposeTab(tab);
    disposeTab(t2);
  });

  test("open_document reports when navigation leaves no active tab", async () => {
    let active: Tab | null = createTab({ document: { tagName: "div", children: [] }, id: "z" });
    const registry = createToolRegistry();
    registerAiTools(registry, {
      getTab: () => active,
      openDocument: async () => {
        active = null;
      },
      validate: async () => [],
    });
    const res = await registry.execute("open_document", { path: "p.json" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("no active tab");
  });
});

describe("ai-tools — write reconciliation with open tabs", () => {
  test("create_page refuses while the target file is open with unsaved changes", async () => {
    const openTab = createTab({ document: { children: [], tagName: "div" }, id: "pages/x.json" });
    openTab.documentPath = "pages/x.json";
    openTab.doc.dirty = true;
    const saved: string[] = [];
    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      {
        findOpenTab: (p) => (p === "pages/x.json" ? openTab : null),
        saveFile: async (p) => {
          saved.push(p);
        },
        validate: async () => [],
      },
    );
    const res = await registry.execute("create_page", {
      content: { children: [], tagName: "div" },
      path: "pages/x.json",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("unsaved changes");
    expect(saved).toHaveLength(0);
    disposeTab(openTab);
    disposeTab(tab);
  });

  test("create_component over a clean open tab reloads it and flags no-undo", async () => {
    const openTab = createTab({
      document: { children: [], tagName: "div" },
      id: "components/c.json",
    });
    openTab.documentPath = "components/c.json";
    const reloaded: string[] = [];
    const { tab, registry } = harness(
      { tagName: "div", children: [] },
      {
        findOpenTab: (p) => (p === "components/c.json" ? openTab : null),
        reloadTab: async (p) => {
          reloaded.push(p);
        },
        saveFile: async () => {},
        validate: async () => [],
      },
    );
    const res = await registry.execute("create_component", {
      content: { children: [], tagName: "my-c" },
      path: "components/c.json",
    });
    expect(res.success).toBe(true);
    expect(res.summary).toContain("refreshed");
    expect(res.summary).toContain("not undoable");
    expect(reloaded).toEqual(["components/c.json"]);
    disposeTab(openTab);
    disposeTab(tab);
  });

  test("the no-document error steers toward open_document and the file tools", async () => {
    const registry = createToolRegistry();
    registerAiTools(registry, { getTab: () => null, validate: async () => [] });
    const err = await execErr(registry, "read_document", {});
    expect(err).toContain("open_document");
    expect(err).toContain("write_file");
  });
});

// ─── §7.4: disk writes are recorded, including the ones that fail ────────────
/* `create_page`, `create_component` and `write_file` go straight to disk, where there is no undo
   and never was. The ledger records that fact so the panel can say it to the person holding ⌘Z —
   until now the caveat was appended to the MODEL-facing tool summary only. */

describe("create_page's three refusals, and the write ledger", () => {
  test("schema errors refuse before anything is written, and record nothing", async () => {
    resetAiWrites();
    beginTurn("t");
    const { tab, registry } = harness(
      { children: [], tagName: "div" },
      { saveFile: async () => {}, validate: async () => ["/tagName: must be string"] },
    );
    expect(await execErr(registry, "create_page", { content: {}, path: "p.json" })).toContain(
      "schema errors",
    );
    expect(endTurn("m1")).toEqual([]);
    disposeTab(tab);
  });

  test("a page that will not render refuses, and records nothing", async () => {
    resetAiWrites();
    beginTurn("t");
    const { tab, registry } = harness(
      { children: [], tagName: "div" },
      {
        renderCheck: async () => ({ error: "boom", ok: false }),
        saveFile: async () => {},
        validate: async () => [],
      },
    );
    expect(await execErr(registry, "create_page", { content: {}, path: "p.json" })).toContain(
      "fails to render",
    );
    expect(endTurn("m1")).toEqual([]);
    disposeTab(tab);
  });

  test("a write that lands is recorded as a disk write undo cannot reach", async () => {
    resetAiWrites();
    beginTurn("t");
    const { tab, registry } = harness(
      { children: [], tagName: "div" },
      { saveFile: async () => {}, validate: async () => [] },
    );
    await registry.execute("create_page", { content: { tagName: "div" }, path: "p.json" });
    expect(endTurn("m1")).toEqual([{ disk: true, ok: true, path: "p.json", tool: "create_page" }]);
    disposeTab(tab);
  });

  test("a write that fails is recorded too — a listed attempt that changed nothing", async () => {
    resetAiWrites();
    beginTurn("t");
    const { tab, registry } = harness(
      { children: [], tagName: "div" },
      {
        saveFile: async () => {
          throw new Error("EROFS");
        },
        validate: async () => [],
      },
    );
    expect(await execErr(registry, "create_page", { content: {}, path: "p.json" })).toContain(
      "EROFS",
    );
    expect(endTurn("m1")).toEqual([
      { disk: true, error: "EROFS", ok: false, path: "p.json", tool: "create_page" },
    ]);
    disposeTab(tab);
  });

  test("a failed create_component is recorded under its own tool name", async () => {
    resetAiWrites();
    beginTurn("t");
    const { tab, registry } = harness(
      { children: [], tagName: "div" },
      {
        saveFile: async () => {
          throw new Error("EROFS");
        },
        validate: async () => [],
      },
    );
    await registry.execute("create_component", { content: { tagName: "x-y" }, path: "c.json" });
    expect(endTurn("m1")[0]!.tool).toBe("create_component");
    disposeTab(tab);
  });

  test("a document mutation is recorded as reachable by undo", async () => {
    resetAiWrites();
    beginTurn("t");
    const tab = createTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/a.json",
      id: "t",
    });
    const registry = createToolRegistry();
    registerAiTools(registry, { getTab: () => tab, validate: async () => [] });
    await registry.execute("set_property", { key: "id", path: [], value: "x" });
    const [write] = endTurn("m1");
    expect(write!.disk).toBe(false);
    expect(write!.path).toBe("pages/a.json");
    disposeTab(tab);
  });
});

/**
 * A REFUSED MUTATION IS NOT A SUCCESSFUL ONE, and the model has no other way to find out.
 *
 * `transactDoc` consults the collab gate, which pauses structural editing for the whole room while
 * a source buffer is canonical. The tool used to carry on: a ledger entry ("Changed N files"), then
 * a validation of the UNCHANGED document — which produces no new errors, so the answer was
 * `success: true`. The model then built its next edits on a change that never existed.
 */
describe("ai-tools — a document the room has frozen", () => {
  test("reports the refusal instead of validating the unchanged document", async () => {
    const { tab, registry } = harness({ children: [], tagName: "div" });
    const before = JSON.stringify(tab.doc.document);
    setTransactGate(() => "source-canonical");
    let res;
    try {
      res = await registry.execute("set_text", { path: [], value: "hello" });
    } finally {
      setTransactGate(null);
    }
    expect(res.success).toBe(false);
    expect(res.error).toContain("frozen");
    expect(JSON.stringify(tab.doc.document)).toBe(before);
    expect(tab.doc.dirty).toBe(false);
    disposeTab(tab);
  });
});
