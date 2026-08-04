import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { canRedo, canUndo, redo, undo } from "../src/tabs/transact";
import type { CommitResult, GridEditBatch, GridSource } from "../src/grid/grid-source";
import type { FsEvent } from "../src/types";

const confirmCalls: string[] = [];
let confirmResult = true;
const statusCalls: string[] = [];
let progressOpens = 0;

void mock.module("../src/ui/layers.js", () => ({
  showConfirmDialog: async (headline: string) => {
    confirmCalls.push(headline);
    return confirmResult;
  },
}));
void mock.module("../src/ui/progress-modal.js", () => ({
  showProgressModal: () => {
    progressOpens += 1;
    return { done: () => {}, fail: () => {}, setStatus: () => {} };
  },
}));
// `notify` is NOT mocked: it is a reactive store with no I/O, so the honest assertion is what the
// Controller actually recorded, in the tier it recorded it in.
void mock.module("../src/services/notify.js", () =>
  notifyModule((call) => statusCalls.push(call.message)),
);

const { createGridController, getGridController, ROW_KEY_FIELD } =
  await import("../src/grid/grid-controller");

interface StubOptions {
  commit?: (batch: GridEditBatch) => Promise<CommitResult> | CommitResult;
  backingPaths?: Map<string, string>;
}

function stubSource(opts: StubOptions = {}): GridSource & { commits: GridEditBatch[] } {
  const commits: GridEditBatch[] = [];
  // Stateful: the default commit applies the batch, so post-save reloads return saved values.
  let data = [
    { cells: { count: 1, title: "One" } as Record<string, unknown>, key: "a" },
    { cells: { count: 2, title: "Two" } as Record<string, unknown>, key: "b" },
  ];
  return {
    ...(opts.backingPaths ? { backingPaths: () => opts.backingPaths! } : {}),
    capabilities: { delete: true, insert: true, remotePaging: false, remoteSort: false },
    columns: async () => [
      { editable: true, field: "title", kind: "string", required: true, title: "Title" },
      { editable: true, field: "count", kind: "number", title: "Count" },
    ],
    async commit(batch) {
      commits.push(batch);
      if (opts.commit) {
        return opts.commit(batch);
      }
      for (const cell of batch.cells) {
        const row = data.find((r) => r.key === cell.rowKey);
        if (row) {
          row.cells[cell.field] = cell.value;
        }
      }
      for (const insert of batch.inserts) {
        data.push({ cells: { ...insert.cells }, key: `real-${insert.tempKey}` });
      }
      data = data.filter((row) => !batch.deletes.some((d) => d.rowKey === row.key));
      return {
        cells: batch.cells.map((c) => ({ field: c.field, ok: true, rowKey: c.rowKey })),
        deletes: batch.deletes.map((d) => ({ ok: true, rowKey: d.rowKey })),
        inserts: batch.inserts.map((i) => ({
          newKey: `real-${i.tempKey}`,
          ok: true,
          tempKey: i.tempKey,
        })),
      };
    },
    commits,
    id: "grid://collection/test",
    label: "test",
    rows: async () => ({
      rows: data.map((row) => ({ cells: { ...row.cells } as never, key: row.key })),
      total: data.length,
    }),
  };
}

function openGridTab(id = "grid://collection/test") {
  return openTab({
    capabilities: { modes: ["grid"] },
    document: { tagName: "div" },
    documentPath: null,
    id,
  });
}

beforeEach(() => {
  resetStudioState();
  closeAllTabs();
  confirmCalls.length = 0;
  statusCalls.length = 0;
  confirmResult = true;
  progressOpens = 0;
});

describe("createGridController", () => {
  test("registers in the tab registry and unregisters on tab close", () => {
    installMockPlatform();
    const tab = openGridTab();
    const controller = createGridController(tab, stubSource());
    expect(getGridController(tab)).toBe(controller);
    closeAllTabs();
    expect(getGridController(tab)).toBeNull();
  });

  test("load populates columns/rows; a failing source lands in state.error", async () => {
    installMockPlatform();
    const tab = openGridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    expect(controller.state.columns.map((c) => c.field)).toEqual(["title", "count"]);
    expect(controller.state.total).toBe(2);
    expect(controller.state.loading).toBeFalse();

    const bad = stubSource();
    bad.rows = async () => {
      throw new Error("nope");
    };
    const tab2 = openGridTab("grid://collection/bad");
    const controller2 = createGridController(tab2, bad);
    await controller2.load();
    expect(controller2.state.error).toContain("nope");
  });

  test("buffer dirtiness mirrors onto tab.doc.dirty", async () => {
    installMockPlatform();
    const tab = openGridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    await flush();
    expect(tab.doc.dirty).toBeFalse();

    controller.buffer.setCell("a", "title", "Edited");
    await flush();
    expect(tab.doc.dirty).toBeTrue();

    controller.buffer.undo();
    await flush();
    expect(tab.doc.dirty).toBeFalse();
  });

  test("undo/redo route through the tab HistoryDelegate", async () => {
    installMockPlatform();
    const tab = openGridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    expect(canUndo(tab)).toBeFalse();

    controller.buffer.setCell("a", "title", "Edited");
    expect(canUndo(tab)).toBeTrue();
    undo(tab);
    expect(controller.buffer.effectiveValue("a", "title")).toBe("One");
    expect(canRedo(tab)).toBeTrue();
    redo(tab);
    expect(controller.buffer.effectiveValue("a", "title")).toBe("Edited");
  });

  test("effectiveRows overlays pending edits and appends pending inserts", async () => {
    installMockPlatform();
    const tab = openGridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    controller.buffer.setCell("a", "count", 9);
    const tempKey = controller.buffer.insertRow({ title: "New" });

    const rows = controller.effectiveRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]![ROW_KEY_FIELD]).toBe("a");
    expect(rows[0]!.count).toBe(9);
    expect(rows[2]![ROW_KEY_FIELD]).toBe(tempKey);
    expect(rows[2]!.title).toBe("New");
    expect(rows[2]!.count).toBeNull();
  });
});

describe("save", () => {
  test("no pending changes is a friendly no-op", async () => {
    installMockPlatform();
    const controller = createGridController(openGridTab(), stubSource());
    await controller.load();
    await controller.save();
    expect(statusCalls.at(-1)).toContain("No grid changes");
  });

  test("blocks on required violations and marks them as errors", async () => {
    installMockPlatform();
    const source = stubSource();
    const controller = createGridController(openGridTab(), source);
    await controller.load();
    controller.buffer.setCell("a", "title", null);
    const tempKey = controller.buffer.insertRow({ count: 1 });

    await controller.save();
    expect(source.commits).toHaveLength(0);
    expect(controller.buffer.cellState("a", "title")).toBe("error");
    expect(controller.buffer.cellError(tempKey, "title")).toContain("Missing required: title");
    expect(statusCalls.at(-1)).toContain("Required cells");
  });

  test("asks before deleting rows and aborts on cancel", async () => {
    installMockPlatform();
    const source = stubSource();
    const controller = createGridController(openGridTab(), source);
    await controller.load();
    controller.buffer.deleteRow("a");

    confirmResult = false;
    await controller.save();
    expect(confirmCalls).toHaveLength(1);
    expect(source.commits).toHaveLength(0);
    expect(controller.buffer.rowState("a")).toBe("pending-delete");
  });

  test("commits, rebaselines saved cells, and reloads after structural changes", async () => {
    installMockPlatform();
    const source = stubSource();
    const controller = createGridController(openGridTab(), source);
    await controller.load();
    controller.buffer.setCell("a", "title", "Renamed");
    controller.buffer.insertRow({ count: 5, title: "Born" });
    controller.buffer.deleteRow("b");

    await controller.save();
    expect(source.commits).toHaveLength(1);
    expect(controller.buffer.isDirty()).toBeFalse();
    // Rebaselined: the committed value is now the baseline, so re-entering it stays clean.
    controller.buffer.setCell("a", "title", "Renamed");
    expect(controller.buffer.isDirty()).toBeFalse();
    expect(statusCalls.at(-1)).toContain("Saved 3 change(s)");
  });

  test("partial failures stay pending with errors and report counts", async () => {
    installMockPlatform();
    const source = stubSource({
      commit: (batch) => ({
        cells: batch.cells.map((c, i) => ({
          error: i === 0 ? "locked" : undefined,
          field: c.field,
          ok: i !== 0,
          rowKey: c.rowKey,
        })),
        deletes: [],
        inserts: [],
      }),
    });
    const controller = createGridController(openGridTab(), source);
    await controller.load();
    controller.buffer.setCell("a", "title", "X");
    controller.buffer.setCell("b", "title", "Y");

    await controller.save();
    expect(controller.buffer.cellState("a", "title")).toBe("error");
    expect(controller.buffer.cellState("b", "title")).toBe("clean");
    expect(statusCalls.at(-1)).toContain("1 failed");
  });

  test("shows a progress modal for larger batches and a save error toast on throw", async () => {
    installMockPlatform();
    const source = stubSource({
      commit: () => {
        throw new Error("io");
      },
    });
    const controller = createGridController(openGridTab(), source);
    await controller.load();
    controller.buffer.group(() => {
      for (let i = 0; i < 6; i++) {
        controller.buffer.insertRow({ title: `Row ${i}` });
      }
    });
    await controller.save();
    expect(progressOpens).toBe(1);
    expect(statusCalls.at(-1)).toContain("Could not save the grid");
    expect(controller.state.saving).toBeFalse();
  });
});

describe("row actions and view binding", () => {
  test("deleteRows buffers as one undo group and syncs the view; empty is a no-op", async () => {
    installMockPlatform();
    const controller = createGridController(openGridTab(), stubSource());
    await controller.load();
    let refreshes = 0;
    controller.bindView({ refreshData: () => (refreshes += 1) });

    controller.deleteRows([]);
    expect(refreshes).toBe(0);

    controller.deleteRows(["a", "b"]);
    expect(controller.buffer.rowState("a")).toBe("pending-delete");
    expect(controller.buffer.rowState("b")).toBe("pending-delete");
    expect(refreshes).toBe(1);

    controller.buffer.undo(); // One group covers both.
    expect(controller.buffer.isDirty()).toBeFalse();
  });

  test("addRow and discardRow sync the view", async () => {
    installMockPlatform();
    const controller = createGridController(openGridTab(), stubSource());
    await controller.load();
    let refreshes = 0;
    controller.bindView({ refreshData: () => (refreshes += 1) });

    const tempKey = controller.addRow({ title: "X" });
    expect(refreshes).toBe(1);
    controller.discardRow(tempKey);
    expect(refreshes).toBe(2);
    expect(controller.buffer.isDirty()).toBeFalse();
  });

  test("closing the tab disposes the source", async () => {
    installMockPlatform();
    let disposed = 0;
    const source = stubSource();
    source.dispose = () => {
      disposed += 1;
    };
    createGridController(openGridTab(), source);
    closeAllTabs();
    expect(disposed).toBe(1);
  });
});

describe("replaceAll", () => {
  test("replaces across editable text cells (existing + pending inserts) as one undo group", async () => {
    installMockPlatform();
    const controller = createGridController(openGridTab(), stubSource());
    await controller.load();
    let refreshes = 0;
    controller.bindView({ refreshData: () => (refreshes += 1) });
    const tempKey = controller.addRow({ title: "One more" });

    const changed = controller.replaceAll("One", "Uno");
    expect(changed).toBe(2);
    expect(controller.buffer.effectiveValue("a", "title")).toBe("Uno");
    expect(controller.buffer.effectiveValue(tempKey, "title")).toBe("Uno more");
    expect(refreshes).toBeGreaterThanOrEqual(2);

    controller.buffer.undo(); // One group reverts both replacements.
    expect(controller.buffer.effectiveValue("a", "title")).toBe("One");
    expect(controller.buffer.effectiveValue(tempKey, "title")).toBe("One more");
  });

  test("skips pending-delete rows, non-text columns, and empty finds", async () => {
    installMockPlatform();
    const controller = createGridController(openGridTab(), stubSource());
    await controller.load();
    controller.buffer.deleteRow("a");
    expect(controller.replaceAll("", "x")).toBe(0);
    expect(controller.replaceAll("One", "Uno")).toBe(0); // Row "a" is pending-delete.
    expect(controller.replaceAll("2", "9")).toBe(0); // Count is a number column.
  });
});

describe("refresh and fs staleness", () => {
  test("refresh with pending edits asks first; cancel keeps the buffer", async () => {
    installMockPlatform();
    const controller = createGridController(openGridTab(), stubSource());
    await controller.load();
    controller.buffer.setCell("a", "title", "Edited");

    confirmResult = false;
    await controller.refresh();
    expect(confirmCalls).toHaveLength(1);
    expect(controller.buffer.isDirty()).toBeTrue();

    confirmResult = true;
    await controller.refresh();
    expect(controller.buffer.isDirty()).toBeFalse();
  });

  test("fs events on backing paths mark pending rows stale; clean grids just reload", async () => {
    let fsHandler: ((events: FsEvent[]) => void) | null = null;
    installMockPlatform({
      subscribeFileEvents: (handler) => {
        fsHandler = handler;
        return () => {
          fsHandler = null;
        };
      },
    });
    const source = stubSource({
      backingPaths: new Map([
        ["content/a.md", "a"],
        ["content/b.md", "b"],
      ]),
    });
    let rowCalls = 0;
    const baseRows = source.rows;
    source.rows = async (q) => {
      rowCalls += 1;
      return baseRows(q);
    };
    const controller = createGridController(openGridTab(), source);
    await controller.load();
    expect(fsHandler).not.toBeNull();

    controller.buffer.setCell("b", "title", "Pending");
    fsHandler!([{ isDir: false, path: "content/a.md", type: "change" }]);
    expect(controller.buffer.rowState("a")).toBe("stale");
    expect(statusCalls.at(-1)).toContain("stale");

    // Unrelated paths are ignored.
    fsHandler!([{ isDir: false, path: "elsewhere.md", type: "change" }]);
    expect(controller.buffer.rowState("b")).toBe("dirty");

    // A clean grid reloads instead of marking stale.
    controller.buffer.reset();
    const rowCallsBefore = rowCalls;
    fsHandler!([{ isDir: false, path: "content/b.md", type: "change" }]);
    await flush();
    expect(rowCalls).toBeGreaterThan(rowCallsBefore);

    // Tab close unsubscribes.
    closeAllTabs();
    expect(fsHandler).toBeNull();
  });
});
