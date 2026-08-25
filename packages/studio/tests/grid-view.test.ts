import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import { fakeCell, fakeRange, fakeRow, FakeTabulator, tabulatorMockModule } from "./tabulator-mock";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { undo } from "../src/tabs/transact";
import type { GridSource } from "../src/grid/grid-source";

void mock.module("tabulator-tables", () => tabulatorMockModule);
void mock.module("tabulator-tables/dist/css/tabulator.min.css", () => ({}));
void mock.module("../src/ui/layers.js", () => ({
  showConfirmDialog: async () => true,
}));
void mock.module("../src/ui/progress-modal.js", () => ({
  showProgressModal: () => ({ done: () => {}, fail: () => {}, setStatus: () => {} }),
}));
void mock.module("../src/services/notify.js", () => notifyModule(() => {}));

const popoverCalls: { column: string; value: unknown; commit: (v: unknown) => void }[] = [];
void mock.module("../src/grid/cell-popovers.js", () => ({
  hasPopoverEditor: (column: { kind: string }) =>
    column.kind === "image" || column.kind === "reference",
  openCellValuePopover: async (args: {
    column: { field: string };
    value: unknown;
    commit: (v: unknown) => void;
  }) => {
    popoverCalls.push({ column: args.column.field, commit: args.commit, value: args.value });
  },
  referenceTargetType: () => null,
}));

const { createGridController, ROW_KEY_FIELD } = await import("../src/grid/grid-controller");
const { createGridView } = await import("../src/grid/grid-view");
const { gridIdleBlockers } = await import("../src/grid/grid-idle");

function stubSource(overrides: Partial<GridSource> = {}): GridSource {
  return {
    capabilities: { delete: true, insert: true, remotePaging: false, remoteSort: false },
    columns: async () => [
      { editable: true, field: "id", kind: "readonly", pk: true, title: "Id" },
      { editable: true, field: "title", kind: "string", title: "Title" },
      { editable: true, field: "count", kind: "number", title: "Count" },
      { editable: true, field: "done", kind: "boolean", title: "Done" },
    ],
    commit: async (batch) => ({
      cells: batch.cells.map((c) => ({ field: c.field, ok: true, rowKey: c.rowKey })),
      deletes: batch.deletes.map((d) => ({ ok: true, rowKey: d.rowKey })),
      inserts: batch.inserts.map((i) => ({ ok: true, tempKey: i.tempKey })),
    }),
    id: "grid://collection/x",
    label: "x",
    rows: async () => ({
      rows: [
        { cells: { count: 1, done: false, id: "a", title: "One" }, key: "a" },
        { cells: { count: 2, done: true, id: "b", title: "Two" }, key: "b" },
      ],
      total: 2,
    }),
    ...overrides,
  };
}

async function setupView(source: GridSource = stubSource()) {
  const tab = openTab({
    capabilities: { modes: ["grid"] },
    document: { tagName: "div" },
    documentPath: null,
    id: source.id,
  });
  const controller = createGridController(tab, source);
  await controller.load();
  const host = document.createElement("div");
  document.body.append(host);
  const view = createGridView(host, controller);
  const table = FakeTabulator.instances.at(-1)!;
  return { controller, host, table, tab, view };
}

beforeEach(() => {
  resetStudioState();
  closeAllTabs();
  installMockPlatform();
  FakeTabulator.reset();
  popoverCalls.length = 0;
});

describe("createGridView — construction", () => {
  test("builds Tabulator with spreadsheet options and initial data", async () => {
    const { table } = await setupView();
    expect(table.options.index).toBe(ROW_KEY_FIELD);
    expect(table.options.selectableRange).toBe(1);
    expect(table.options.clipboardPasteAction).toBe("range");
    expect(table.options.editTriggerEvent).toBe("dblclick");
    expect(table.options.history).toBeFalse();
    expect(table.data).toHaveLength(2);
    expect(table.data[0]![ROW_KEY_FIELD]).toBe("a");
    expect(FakeTabulator.registeredModules.length).toBeGreaterThan(10);
  });

  test("maps columns: readonly gets no editor, pk freezes, filters/sort follow capabilities", async () => {
    const { table } = await setupView();
    const defs = table.options.columns as Record<string, unknown>[];
    const byField = new Map(defs.map((d) => [d.field, d]));
    expect(byField.get("id")!.editor).toBeUndefined();
    expect(byField.get("id")!.frozen).toBeTrue();
    expect(typeof byField.get("title")!.editor).toBe("function");
    expect(byField.get("title")!.headerFilter).toBe("input");
    expect(byField.get("done")!.headerFilter).toBeUndefined();
    expect(byField.get("title")!.headerSort).toBeTrue();
    expect(byField.get("count")!.sorter).toBe("number");
  });

  test("remote sources disable header sort and filters", async () => {
    const { table } = await setupView(
      stubSource({
        capabilities: { delete: true, insert: true, remotePaging: true, remoteSort: true },
        id: "grid://data/main/users",
      }),
    );
    const defs = table.options.columns as Record<string, unknown>[];
    expect(defs.every((d) => d.headerSort === false)).toBeTrue();
    expect(defs.every((d) => d.headerFilter === undefined)).toBeTrue();
  });
});

describe("gridIdleBlockers", () => {
  /*
   * Filtered by grid id rather than asserted whole. `liveGrids` is module state and every other
   * test in this file builds a view it never destroys, so an unfiltered assertion would pass or
   * fail on test ORDER — which is the one thing a quiescence test must not do.
   */
  const mine = (id: string) => gridIdleBlockers().filter((line) => line.includes(id));

  test("a grid is in-flight until it is built AND its range is laid out", async () => {
    const id = "grid://idle/built";
    const { table, view } = await setupView(stubSource({ id }));

    // `data.openGrid` has already resolved by here and `editor.kind` already reads "grid", which
    // Is precisely why the screenshot runner used to photograph the table mid-build.
    expect(mine(id)).toEqual([`grid[${id}]: building`]);

    table.emit("tableBuilt");
    expect(mine(id)).toEqual([`grid[${id}]: selection range not laid out`]);

    const row = fakeRow({ [ROW_KEY_FIELD]: "a" });
    const cell = fakeCell(row, "title", table);
    table.ranges.push(fakeRange([[cell]]));
    expect(mine(id)).toEqual([]);

    view.destroy();
    expect(mine(id)).toEqual([]);
  });

  test("an empty grid never waits for the range it will never be given", async () => {
    const id = "grid://idle/empty";
    const { table, view } = await setupView(
      stubSource({ id, rows: async () => ({ rows: [], total: 0 }) }),
    );

    table.emit("tableBuilt");
    // `selectableRange: 1` gives no range to a table with no cells, so requiring one here would
    // Block `probeIdle()` until it timed out.
    expect(mine(id)).toEqual([]);
    view.destroy();
  });

  test("a destroyed grid stops answering, even if it never finished building", async () => {
    const id = "grid://idle/torn-down";
    const { view } = await setupView(stubSource({ id }));
    expect(mine(id)).toEqual([`grid[${id}]: building`]);
    view.destroy();
    // A probe left behind on a torn-down table would block every later idle check forever.
    expect(mine(id)).toEqual([]);
  });
});

describe("cellEdited → buffer", () => {
  test("edits flow into the buffer with column-typed coercion and paint the cell dirty", async () => {
    const { controller, table } = await setupView();
    const row = fakeRow({ [ROW_KEY_FIELD]: "a", count: 1, title: "One" });
    const cell = fakeCell(row, "count", table);

    row.data.count = "42"; // Simulates a paste of text into a number column.
    table.emit("cellEdited", cell);

    expect(controller.buffer.effectiveValue("a", "count")).toBe(42);
    expect(row.data.count).toBe(42); // Normalized back into the table.
    expect(cell.element.classList.contains("jx-grid-cell--dirty")).toBeTrue();
  });

  test("pending-delete rows are not editable", async () => {
    const { controller, table } = await setupView();
    controller.buffer.deleteRow("a");
    const defs = table.options.columns as {
      field: string;
      editable: (cell: ReturnType<typeof fakeCell>) => boolean;
    }[];
    const titleDef = defs.find((d) => d.field === "title")!;
    const row = fakeRow({ [ROW_KEY_FIELD]: "a", title: "One" });
    const cell = fakeCell(row, "title", table);
    expect(titleDef.editable(cell)).toBeFalse();
    const rowB = fakeRow({ [ROW_KEY_FIELD]: "b", title: "Two" });
    expect(titleDef.editable(fakeCell(rowB, "title", table))).toBeTrue();
  });

  test("paste bursts group into one undo entry", async () => {
    const { controller, host, table } = await setupView();
    const rowA = fakeRow({ [ROW_KEY_FIELD]: "a", title: "One" });
    const rowB = fakeRow({ [ROW_KEY_FIELD]: "b", title: "Two" });

    host.dispatchEvent(new Event("paste", { bubbles: true }));
    rowA.data.title = "P1";
    table.emit("cellEdited", fakeCell(rowA, "title", table));
    rowB.data.title = "P2";
    table.emit("cellEdited", fakeCell(rowB, "title", table));
    await flush();

    expect(controller.buffer.dirtyCount()).toBe(2);
    controller.buffer.undo();
    expect(controller.buffer.dirtyCount()).toBe(0);
  });
});

describe("buffer → table sync", () => {
  test("tableBuilt flushes a queued refresh; undo through the tab delegate replaces data", async () => {
    const { controller, tab, table } = await setupView();
    table.emit("tableBuilt");

    const row = fakeRow({ [ROW_KEY_FIELD]: "a", count: 1, title: "One" });
    row.data.title = "Edited";
    table.emit("cellEdited", fakeCell(row, "title", table));
    expect(controller.buffer.isDirty()).toBeTrue();

    undo(tab);
    await flush();
    expect(controller.buffer.isDirty()).toBeFalse();
    const lastData = table.replaceDataCalls.at(-1)!;
    expect(lastData.find((r) => r[ROW_KEY_FIELD] === "a")!.title).toBe("One");
  });

  test("controller.addRow refreshes the table with the pending insert appended", async () => {
    const { controller, table } = await setupView();
    table.emit("tableBuilt");
    const tempKey = controller.addRow({ title: "Born" });
    await flush();
    const lastData = table.replaceDataCalls.at(-1)!;
    expect(lastData.at(-1)![ROW_KEY_FIELD]).toBe(tempKey);
    expect(lastData.at(-1)!.title).toBe("Born");
  });
});

describe("view actions", () => {
  test("fillDown copies the range's first row through the range as one undo group", async () => {
    const { controller, table, view } = await setupView();
    const rowA = fakeRow({ [ROW_KEY_FIELD]: "a", count: 1, title: "One" });
    const rowB = fakeRow({ [ROW_KEY_FIELD]: "b", count: 2, title: "Two" });
    const cells = [
      [fakeCell(rowA, "title", table), fakeCell(rowA, "count", table)],
      [fakeCell(rowB, "title", table), fakeCell(rowB, "count", table)],
    ];
    table.ranges = [fakeRange(cells)];

    view.fillDown();
    expect(controller.buffer.effectiveValue("b", "title")).toBe("One");
    expect(controller.buffer.effectiveValue("b", "count")).toBe(1);
    controller.buffer.undo(); // One group.
    expect(controller.buffer.isDirty()).toBeFalse();
  });

  test("fillDown without a multi-row range is a no-op", async () => {
    const { controller, table, view } = await setupView();
    view.fillDown();
    const rowA = fakeRow({ [ROW_KEY_FIELD]: "a", title: "One" });
    table.ranges = [fakeRange([[fakeCell(rowA, "title", table)]])];
    view.fillDown();
    expect(controller.buffer.isDirty()).toBeFalse();
  });

  test("getSelectedRowKeys dedupes across ranges", async () => {
    const { table, view } = await setupView();
    const rowA = fakeRow({ [ROW_KEY_FIELD]: "a" });
    const rowB = fakeRow({ [ROW_KEY_FIELD]: "b" });
    table.ranges = [
      fakeRange([[fakeCell(rowA, "title", table)]]),
      fakeRange([[fakeCell(rowA, "count", table)], [fakeCell(rowB, "count", table)]]),
    ];
    expect(view.getSelectedRowKeys().toSorted()).toEqual(["a", "b"]);
  });

  test("setSearch installs a cross-column text filter; empty clears it", async () => {
    const { table, view } = await setupView();
    view.setSearch("two");
    expect(table.filter).not.toBeNull();
    expect(table.filter!({ count: 2, title: "Two" })).toBeTrue();
    expect(table.filter!({ count: 1, title: "One" })).toBeFalse();
    view.setSearch("  ");
    expect(table.filter).toBeNull();
  });

  test("destroy tears down the table and unbinds the controller", async () => {
    const { controller, table, view } = await setupView();
    table.emit("tableBuilt");
    view.destroy();
    expect(table.destroyed).toBeTrue();
    const before = table.replaceDataCalls.length;
    controller.addRow({});
    expect(table.replaceDataCalls.length).toBe(before);
  });
});

describe("popover cells and insert-only columns", () => {
  const richSource = (): GridSource =>
    stubSource({
      columns: async () => [
        {
          editable: false,
          field: "__path",
          insertOnly: true,
          kind: "string",
          pk: true,
          title: "Path",
        },
        { editable: true, field: "cover", kind: "image", title: "Cover" },
        { editable: true, field: "title", kind: "string", title: "Title" },
      ],
      id: "grid://collection/rich",
    });

  test("image/reference columns get no inline editor; dblclick opens the popover", async () => {
    const { controller, table } = await setupView(richSource());
    const defs = table.options.columns as Record<string, unknown>[];
    const byField = new Map(defs.map((d) => [d.field, d]));
    expect(byField.get("cover")!.editor).toBeUndefined();
    expect(typeof byField.get("title")!.editor).toBe("function");

    controller.buffer.setCell("a", "cover", "/img/a.png");
    const row = fakeRow({ [ROW_KEY_FIELD]: "a", cover: "/img/a.png" });
    const cell = fakeCell(row, "cover", table);
    table.emit("cellDblClick", {}, cell);
    await flush();
    expect(popoverCalls).toHaveLength(1);
    expect(popoverCalls[0]!.value).toBe("/img/a.png");

    popoverCalls[0]!.commit("/img/b.png");
    expect(controller.buffer.effectiveValue("a", "cover")).toBe("/img/b.png");
    expect(row.data.cover).toBe("/img/b.png"); // Normalized into the table.
  });

  test("popover never opens for pending-delete rows or non-popover kinds", async () => {
    const { controller, table } = await setupView(richSource());
    controller.buffer.deleteRow("a");
    const row = fakeRow({ [ROW_KEY_FIELD]: "a", cover: "x" });
    table.emit("cellDblClick", {}, fakeCell(row, "cover", table));
    table.emit("cellDblClick", {}, fakeCell(row, "title", table));
    await flush();
    expect(popoverCalls).toHaveLength(0);
  });

  test("insert-only columns are editable only on pending-insert rows", async () => {
    const { controller, table } = await setupView(richSource());
    const defs = table.options.columns as {
      field: string;
      editable: (cell: ReturnType<typeof fakeCell>) => boolean;
    }[];
    const pathDef = defs.find((d) => d.field === "__path")!;

    const existing = fakeRow({ [ROW_KEY_FIELD]: "a" });
    expect(pathDef.editable(fakeCell(existing, "__path", table))).toBeFalse();

    const tempKey = controller.buffer.insertRow({});
    const inserted = fakeRow({ [ROW_KEY_FIELD]: tempKey });
    expect(pathDef.editable(fakeCell(inserted, "__path", table))).toBeTrue();
  });
});

describe("column layout persistence", () => {
  test("saved layout applies at creation; resize/move events persist changes", async () => {
    const { clearGridLayout, loadGridLayout, saveGridLayout } =
      await import("../src/grid/grid-layout");
    clearGridLayout("grid://collection/x");
    saveGridLayout("grid://collection/x", { order: ["count", "title"], widths: { title: 321 } });

    const { table } = await setupView();
    const defs = table.options.columns as { field: string; width?: number }[];
    expect(defs.map((d) => d.field)).toEqual(["count", "title", "id", "done"]);
    expect(defs.find((d) => d.field === "title")!.width).toBe(321);

    table.emit("columnResized", { getField: () => "done", getWidth: () => 77 });
    expect(loadGridLayout("grid://collection/x")!.widths!.done).toBe(77);

    table.emit("columnMoved", { getField: () => "done" }, [
      { getField: () => "done" },
      { getField: () => "id" },
    ]);
    expect(loadGridLayout("grid://collection/x")!.order).toEqual(["done", "id"]);
    clearGridLayout("grid://collection/x");
  });
});

describe("formatters and sorters", () => {
  test("the column formatter renders into a host and paints error state on render", async () => {
    const { controller, table } = await setupView();
    const defs = table.options.columns as {
      field: string;
      formatter: (
        cell: ReturnType<typeof fakeCell>,
        params: unknown,
        onRendered: (fn: () => void) => void,
      ) => HTMLElement;
    }[];
    const titleDef = defs.find((d) => d.field === "title")!;
    const row = fakeRow({ [ROW_KEY_FIELD]: "a", title: "One" });
    const cell = fakeCell(row, "title", table);

    controller.buffer.applyCommitResult({
      cells: [{ error: "bad value", field: "title", ok: false, rowKey: "a" }],
      deletes: [],
      inserts: [],
    });
    const rendered: (() => void)[] = [];
    const host = titleDef.formatter(cell, {}, (fn) => rendered.push(fn));
    expect(host.className).toContain("jx-grid-cell-content");
    expect(host.textContent).toBe("One");
    for (const fn of rendered) {
      fn();
    }
    expect(cell.element.classList.contains("jx-grid-cell--error")).toBeTrue();
    expect(cell.element.getAttribute("title")).toBe("bad value");
  });

  test("array columns sort by their joined text", async () => {
    const { table } = await setupView(
      stubSource({
        columns: async () => [
          { editable: true, field: "id", kind: "readonly", pk: true, title: "Id" },
          { editable: true, field: "tags", kind: "array", title: "Tags" },
        ],
        id: "grid://collection/arr",
      }),
    );
    const defs = table.options.columns as { field: string; sorter: unknown }[];
    const sorter = defs.find((d) => d.field === "tags")!.sorter as (
      a: unknown,
      b: unknown,
    ) => number;
    expect(sorter(["alpha"], ["beta"])).toBeLessThan(0);
    expect(sorter(["beta"], ["alpha"])).toBeGreaterThan(0);
    expect(sorter(["same"], ["same"])).toBe(0);
  });
});

describe("event guards and deferred refresh", () => {
  test("refreshData before tableBuilt queues and flushes once built", async () => {
    const { table, view } = await setupView();
    expect(table.replaceDataCalls).toHaveLength(0);
    view.refreshData(); // Not built yet — deferred.
    expect(table.replaceDataCalls).toHaveLength(0);
    table.emit("tableBuilt");
    await flush();
    expect(table.replaceDataCalls).toHaveLength(1);
  });

  test("cellEdited for an unknown field is ignored", async () => {
    const { controller, table } = await setupView();
    const row = fakeRow({ [ROW_KEY_FIELD]: "a", ghost: "x" });
    table.emit("cellEdited", fakeCell(row, "ghost", table));
    expect(controller.buffer.isDirty()).toBeFalse();
  });

  test("overlapping burst triggers share one open group; Delete keydown opens one", async () => {
    const { controller, host, table } = await setupView();
    // Two synchronous pastes — the second hits the group-already-open early return.
    host.dispatchEvent(new Event("paste", { bubbles: true }));
    host.dispatchEvent(new Event("paste", { bubbles: true }));
    const rowA = fakeRow({ [ROW_KEY_FIELD]: "a", title: "One" });
    rowA.data.title = "P1";
    table.emit("cellEdited", fakeCell(rowA, "title", table));
    await flush();
    controller.buffer.undo(); // One group despite two paste events.
    expect(controller.buffer.dirtyCount()).toBe(0);

    host.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "x" }));
    host.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }));
    const rowB = fakeRow({ [ROW_KEY_FIELD]: "b", title: "Two" });
    rowB.data.title = "";
    table.emit("cellEdited", fakeCell(rowB, "title", table));
    await flush();
    expect(controller.buffer.dirtyCount()).toBe(1);
    controller.buffer.undo();
    expect(controller.buffer.dirtyCount()).toBe(0);
  });
});

describe("row painting", () => {
  test("rowFormatter applies pending-delete and insert classes from buffer state", async () => {
    const { controller, table } = await setupView();
    const rowFormatter = table.options.rowFormatter as (row: ReturnType<typeof fakeRow>) => void;

    controller.buffer.deleteRow("a");
    const rowA = fakeRow({ [ROW_KEY_FIELD]: "a" });
    rowFormatter(rowA);
    expect(rowA.element.classList.contains("jx-grid-row--pending-delete")).toBeTrue();

    const tempKey = controller.buffer.insertRow({});
    const rowNew = fakeRow({ [ROW_KEY_FIELD]: tempKey });
    rowFormatter(rowNew);
    expect(rowNew.element.classList.contains("jx-grid-row--pending-insert")).toBeTrue();
  });
});
