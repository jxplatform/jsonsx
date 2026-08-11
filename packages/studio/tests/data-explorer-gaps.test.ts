/**
 * Coverage for src/panels/data-explorer.ts — the type label, the per-tab expansion record and the
 * value tree.
 *
 * The panel's own row list is gone: plan §11.2 folds "definitions + live values into one row", so
 * the rows are `renderSignalsTemplate`'s and the cases that used to drive
 * `renderDataExplorerTemplate` drive that instead. What is left in this module is the machinery
 * those rows read, which is what this file exercises.
 */
import { flush, renderInto, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "lit-html";
import { renderDataTreeTemplate, resetDataRowExpansion } from "../src/panels/data-explorer";
import { renderSignalsTemplate } from "../src/panels/signals-panel";
import { activeTab } from "../src/workspace/workspace";
import type { JxMutableNode } from "@jxsuite/schema/types";

const refreshData = mock(() => {});
const renderLeftPanel = mock(() => {});

/** Mount the merged Data panel over a document with `state`, and a canvas that resolved `scope`. */
function mountData(state: Record<string, unknown>, scope: Record<string, unknown> | null) {
  resetWorkspaceWithTab({ children: [], state, tagName: "div" } as unknown as JxMutableNode);
  const tab = activeTab.value!;
  tab.session.canvas.scope = scope;
  const container = document.createElement("div");
  // The record the Data panel hands the template — `NavigatorPanelContext.doc`, built the way
  // `left-panel.ts` builds it, so this drives the same shape the app does.
  const S = {
    canvas: tab.session.canvas,
    document: tab.doc.document,
    mode: tab.doc.mode,
    selection: tab.session.selection,
    ui: tab.session.ui,
  };
  const ctx = {
    refreshData: () => {
      refreshData();
    },
    renderLeftPanel: () => {
      renderLeftPanel();
      render(renderSignalsTemplate(S as never, ctx), container);
    },
  };
  render(renderSignalsTemplate(S as never, ctx), container);
  renderLeftPanel.mockClear();
  return { container, ctx };
}

beforeEach(() => {
  refreshData.mockClear();
  renderLeftPanel.mockClear();
});

describe("the resolved-value column", () => {
  const typeOf = (el: HTMLElement, name: string) =>
    [...el.querySelectorAll(".signal-row")]
      .find((r) => r.querySelector(".signal-name")?.textContent === name)
      ?.querySelector(".data-type")?.textContent;

  test("labels null, pending, arrays, objects and scalars", () => {
    const { container } = mountData(
      { arr: {}, flag: {}, missing: {}, nil: {}, obj: {}, txt: {} },
      { arr: [1, 2, 3], flag: true, nil: null, obj: { a: 1, b: 2 }, txt: "hello" },
    );
    expect(typeOf(container, "arr")).toBe("Array(3)");
    expect(typeOf(container, "flag")).toBe("boolean");
    expect(typeOf(container, "missing")).toBe("pending");
    expect(typeOf(container, "nil")).toBe("null");
    expect(typeOf(container, "obj")).toBe("{2}");
    expect(typeOf(container, "txt")).toBe("string");
  });

  test("unwraps Vue refs before labelling", () => {
    const { container } = mountData({ count: {} }, { count: { __v_isRef: true, value: 42 } });
    expect(typeOf(container, "count")).toBe("number");
  });

  test("marks null values as pending style", () => {
    const { container } = mountData({ nil: {} }, { nil: null });
    expect(container.querySelector(".data-type")?.classList.contains("data-pending")).toBe(true);
  });

  test("with NO scope at all the row says how the entry is defined instead", () => {
    // One slot, and the value wins it — but only when there is one. A panel opened before the
    // Canvas has rendered knows nothing about any entry, and labelling the whole list "pending"
    // There would be a fact about the panel dressed up as a fact about the data.
    const { container } = mountData({ greeting: { default: "hi", type: "string" } }, null);
    expect(container.querySelector(".data-type")).toBeNull();
    expect(container.querySelector(".signal-hint")).not.toBeNull();
  });
});

describe("expansion", () => {
  const rowFor = (el: HTMLElement, name: string) =>
    [...el.querySelectorAll(".signal-row")].find(
      (r) => r.querySelector(".signal-name")?.textContent === name,
    ) as HTMLElement;

  test("a row shows the definition AND what it resolved to", () => {
    // The whole point of the merge: one click, and you see how a value is defined next to the value
    // It became. These were two panels, listing the same names, one rail tab apart.
    const { container } = mountData({ post: {} }, { post: { id: 7, title: "Hi" } });
    expect(container.querySelector(".data-tree")).toBeNull();

    rowFor(container, "post").click();
    expect(renderLeftPanel).toHaveBeenCalledTimes(1);

    const editor = rowFor(container, "post").nextElementSibling!;
    expect(editor.querySelector('[data-prop="Name"]')).not.toBeNull();
    const tree = editor.querySelector(".data-tree");
    expect(tree?.textContent).toContain("id:");
    expect(tree?.textContent).toContain("7");
    expect(tree?.textContent).toContain('"Hi"');

    rowFor(container, "post").click();
    expect(container.querySelector(".data-tree")).toBeNull();
  });

  test("SEVERAL rows stay open at once — comparing two entries means seeing both", () => {
    const { container } = mountData({ a: {}, b: {} }, { a: 1, b: 2 });
    rowFor(container, "a").click();
    rowFor(container, "b").click();
    expect(container.querySelectorAll(".signal-editor").length).toBe(2);
  });

  test("expansion is PER TAB — it does not follow you to a document without that entry", () => {
    const first = mountData({ onlyHere: {} }, {});
    rowFor(first.container, "onlyHere").click();
    expect(first.container.querySelectorAll(".signal-editor").length).toBe(1);

    // A different document, and the module-global Set this replaced would have kept `onlyHere`
    // Marked open — a name the new document does not even define.
    const second = mountData({ somethingElse: {} }, {});
    expect(second.container.querySelectorAll(".signal-editor").length).toBe(0);
  });

  test("resetDataRowExpansion drops the focused tab's rows", () => {
    const { container, ctx } = mountData({ a: {} }, {});
    rowFor(container, "a").click();
    expect(container.querySelectorAll(".signal-editor").length).toBe(1);
    resetDataRowExpansion();
    ctx.renderLeftPanel();
    expect(container.querySelectorAll(".signal-editor").length).toBe(0);
  });

  test("with no tab open, writing an expansion is a no-op rather than a crash", async () => {
    const { closeAllTabs } = await import("../src/workspace/workspace");
    closeAllTabs();
    const { isDataRowExpanded, setDataRowExpanded } = await import("../src/panels/data-explorer");
    setDataRowExpanded("ghost", true);
    expect(isDataRowExpanded("ghost")).toBe(false);
    resetDataRowExpansion();
  });
});

describe("the Refresh button", () => {
  test("re-fetches through refreshData, then re-renders the panel", async () => {
    const { container } = mountData({ a: {} }, {});
    (container.querySelector(".data-refresh-btn") as HTMLElement).click();
    // RefreshData, not a plain repaint: automatic `Request` entries stay gated in edit/design, and
    // Re-firing them is exactly what this button promises.
    expect(refreshData).toHaveBeenCalledTimes(1);
    expect(renderLeftPanel).not.toHaveBeenCalled();
    await new Promise((resolve) => {
      setTimeout(resolve, 220);
    });
    await flush();
    expect(renderLeftPanel).toHaveBeenCalledTimes(1);
  });

  test("is not drawn over a document with no data — there is nothing to re-fetch", () => {
    const { container } = mountData({}, {});
    expect(container.querySelector(".data-refresh-btn")).toBeNull();
  });
});

describe("renderDataTreeTemplate", () => {
  async function renderTree(value: unknown, depth = 0, maxDepth = 5) {
    return renderInto(renderDataTreeTemplate(value, depth, maxDepth));
  }

  test("renders ellipsis past maxDepth", async () => {
    const el = await renderTree({ a: 1 }, 6);
    expect(el.querySelector(".data-ellipsis")?.textContent?.trim()).toBe("…");
  });

  test("renders null and undefined leaves", async () => {
    const elNull = await renderTree(null);
    expect(elNull.querySelector(".data-null")?.textContent?.trim()).toBe("null");
    const elUndef = await renderInto(renderDataTreeTemplate(undefined, 0));
    expect(elUndef.querySelector(".data-null")?.textContent?.trim()).toBe("undefined");
  });

  test("renders scalar leaves with JSON formatting", async () => {
    const el = await renderTree("hello");
    expect(el.querySelector(".data-string")?.textContent).toContain('"hello"');
    const elNum = await renderTree(3.5);
    expect(elNum.querySelector(".data-number")?.textContent).toContain("3.5");
  });

  test("truncates long scalar strings at 200 chars", async () => {
    const el = await renderTree("x".repeat(250));
    const text = el.querySelector(".data-string")?.textContent ?? "";
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(230);
  });

  test("renders array items with index keys and caps at 20", async () => {
    const el = await renderTree(Array.from({ length: 25 }, (_, i) => i));
    const branches = el.querySelectorAll(".data-branch");
    expect(branches.length).toBe(20);
    expect(branches[0]!.querySelector(".data-key")?.textContent).toContain("[0]");
    expect(el.querySelector(".data-ellipsis")?.textContent).toContain("5 more");
  });

  test("truncates long strings inside arrays at 80 chars", async () => {
    const el = await renderTree(["y".repeat(120)]);
    const text = el.querySelector(".data-value")?.textContent ?? "";
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(100);
  });

  test("nested array items show labels and recurse", async () => {
    const el = await renderTree([[1, 2], { a: 1 }]);
    const labels = [...el.querySelectorAll(".data-object-label")].map((n) => n.textContent);
    expect(labels).toContain("Array(2)");
    expect(labels).toContain("{1}");
    // Recursed leaves rendered one level deeper
    expect(el.textContent).toContain("[0]");
    expect(el.textContent).toContain("a:");
  });

  test("renders object entries and caps at 30 keys", async () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 35; i++) {
      big[`k${i}`] = i;
    }
    const el = await renderTree(big);
    expect(el.querySelectorAll(".data-branch").length).toBe(30);
    expect(el.querySelector(".data-ellipsis")?.textContent).toContain("5 more");
  });

  test("object values that are objects show labels and recurse", async () => {
    const el = await renderTree({ list: [1], meta: { x: 1, y: 2 } });
    const labels = [...el.querySelectorAll(".data-object-label")].map((n) => n.textContent);
    expect(labels).toContain("Array(1)");
    expect(labels).toContain("{2}");
    expect(el.textContent).toContain("x:");
  });

  test("truncates long object string values at 80 chars", async () => {
    const el = await renderTree({ body: "z".repeat(150) });
    const text = el.querySelector(".data-value")?.textContent ?? "";
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(100);
  });

  test("null values inside objects and arrays use null styling", async () => {
    const el = await renderTree({ gone: null });
    expect(el.querySelector(".data-value.data-null")?.textContent).toContain("null");
    const elArr = await renderTree([null]);
    expect(elArr.querySelector(".data-value.data-null")).not.toBeNull();
  });
});
