/** Gap coverage for src/panels/data-explorer.ts — expansion, type labels, tree rendering. */
import { flush, renderInto } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderDataExplorerTemplate, renderDataTreeTemplate } from "../src/panels/data-explorer";

const renderCanvas = mock(() => {});
const refreshData = mock(() => {});
const renderLeftPanel = mock(() => {});
const callbacks = {
  defBadgeLabel: () => "Signal",
  defCategory: () => "data",
  refreshData,
  renderCanvas,
  renderLeftPanel,
};

async function renderExplorer(
  state: Record<string, unknown>,
  liveScope: Record<string, unknown> | null,
) {
  return renderInto(renderDataExplorerTemplate(state, liveScope, callbacks));
}

beforeEach(() => {
  renderCanvas.mockClear();
  refreshData.mockClear();
  renderLeftPanel.mockClear();
});

describe("data explorer type labels", () => {
  test("labels null, pending, arrays, objects and scalars", async () => {
    const state = {
      arr: {},
      flag: {},
      missing: {},
      nil: {},
      obj: {},
      txt: {},
    };
    const scope = {
      arr: [1, 2, 3],
      flag: true,
      nil: null,
      obj: { a: 1, b: 2 },
      txt: "hello",
    };
    const el = await renderExplorer(state, scope);
    const rows = [...el.querySelectorAll(".data-row")];
    const typeOf = (name: string) =>
      rows
        .find((r) => r.querySelector(".data-name")?.textContent === name)
        ?.querySelector(".data-type")?.textContent;
    expect(typeOf("arr")).toBe("Array(3)");
    expect(typeOf("flag")).toBe("boolean");
    expect(typeOf("missing")).toBe("pending");
    expect(typeOf("nil")).toBe("null");
    expect(typeOf("obj")).toBe("{2}");
    expect(typeOf("txt")).toBe("string");
  });

  test("unwraps Vue refs before labelling", async () => {
    const el = await renderExplorer({ count: {} }, { count: { __v_isRef: true, value: 42 } });
    expect(el.querySelector(".data-type")?.textContent).toBe("number");
  });

  test("marks null values as pending style", async () => {
    const el = await renderExplorer({ nil: {} }, { nil: null });
    expect(el.querySelector(".data-type")?.classList.contains("data-pending")).toBe(true);
  });
});

describe("data explorer expansion", () => {
  test("clicking a row header expands it and re-renders left panel", async () => {
    const state = { post: {} };
    const scope = { post: { id: 7, title: "Hi" } };
    let el = await renderExplorer(state, scope);
    expect(el.querySelector(".data-tree")).toBeNull();

    (el.querySelector(".data-row-header") as HTMLElement).click();
    expect(renderLeftPanel).toHaveBeenCalledTimes(1);

    el = await renderExplorer(state, scope);
    expect(el.querySelector(".data-row-header")?.classList.contains("expanded")).toBe(true);
    const tree = el.querySelector(".data-tree");
    expect(tree?.textContent).toContain("id:");
    expect(tree?.textContent).toContain("7");
    expect(tree?.textContent).toContain('"Hi"');

    // Collapse again
    (el.querySelector(".data-row-header") as HTMLElement).click();
    el = await renderExplorer(state, scope);
    expect(el.querySelector(".data-tree")).toBeNull();
  });

  test("refresh button re-fetches through refreshData, then re-renders the left panel", async () => {
    const el = await renderExplorer({ a: {} }, {});
    (el.querySelector(".data-refresh-btn") as HTMLElement).click();
    // RefreshData, not renderCanvas: a plain re-render leaves automatic `Request` entries gated in
    // Edit/design, and re-firing them is exactly what this button promises.
    expect(refreshData).toHaveBeenCalledTimes(1);
    expect(renderCanvas).not.toHaveBeenCalled();
    expect(renderLeftPanel).not.toHaveBeenCalled();
    await new Promise((resolve) => {
      setTimeout(resolve, 220);
    });
    await flush();
    expect(renderLeftPanel).toHaveBeenCalledTimes(1);
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
