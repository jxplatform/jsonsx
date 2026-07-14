import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { createEditBuffer } from "../src/grid/edit-buffer";
import type { GridCellValue } from "../src/grid/grid-source";

/** Buffer over a mutable committed-rows map, with a controllable clock. */
function makeBuffer(committed: Record<string, Record<string, GridCellValue>> = {}) {
  let time = 0;
  const buffer = createEditBuffer({
    now: () => time,
    resolveBaseline: (rowKey, field) => committed[rowKey]?.[field] ?? null,
  });
  return { advance: (ms: number) => (time += ms), buffer, committed };
}

describe("setCell", () => {
  test("stores pending values and prunes when the baseline value returns", () => {
    const { buffer } = makeBuffer({ r1: { title: "Old" } });
    buffer.setCell("r1", "title", "New");
    expect(buffer.effectiveValue("r1", "title")).toBe("New");
    expect(buffer.cellState("r1", "title")).toBe("dirty");
    expect(buffer.isDirty()).toBeTrue();

    buffer.setCell("r1", "title", "Old");
    expect(buffer.cellState("r1", "title")).toBe("clean");
    expect(buffer.isDirty()).toBeFalse();
  });

  test("no-op edits (equal to current effective value) record nothing", () => {
    const { buffer } = makeBuffer({ r1: { title: "Old" } });
    buffer.setCell("r1", "title", "Old");
    expect(buffer.canUndo()).toBeFalse();
  });

  test("array values compare structurally", () => {
    const { buffer } = makeBuffer({ r1: { tags: ["a", "b"] } });
    buffer.setCell("r1", "tags", ["a", "b"]);
    expect(buffer.isDirty()).toBeFalse();
    buffer.setCell("r1", "tags", ["a", "c"]);
    expect(buffer.effectiveValue("r1", "tags")).toEqual(["a", "c"]);
  });
});

describe("undo/redo", () => {
  test("cell edits undo and redo symmetrically", () => {
    const { advance, buffer } = makeBuffer({ r1: { n: 1 } });
    buffer.setCell("r1", "n", 2);
    advance(1000);
    buffer.setCell("r1", "n", 3);

    expect(buffer.undo()).toBeTrue();
    expect(buffer.effectiveValue("r1", "n")).toBe(2);
    expect(buffer.undo()).toBeTrue();
    expect(buffer.effectiveValue("r1", "n")).toBe(1);
    expect(buffer.isDirty()).toBeFalse();
    expect(buffer.undo()).toBeFalse();

    expect(buffer.redo()).toBeTrue();
    expect(buffer.effectiveValue("r1", "n")).toBe(2);
    expect(buffer.redo()).toBeTrue();
    expect(buffer.effectiveValue("r1", "n")).toBe(3);
    expect(buffer.redo()).toBeFalse();
  });

  test("consecutive edits to one cell coalesce inside the window", () => {
    const { advance, buffer } = makeBuffer({ r1: { t: "a" } });
    buffer.setCell("r1", "t", "ab");
    advance(100);
    buffer.setCell("r1", "t", "abc");
    advance(2000);
    buffer.setCell("r1", "t", "abcd");

    buffer.undo();
    expect(buffer.effectiveValue("r1", "t")).toBe("abc");
    buffer.undo();
    expect(buffer.effectiveValue("r1", "t")).toBe("a");
    expect(buffer.canUndo()).toBeFalse();
  });

  test("edits to different cells never coalesce", () => {
    const { buffer } = makeBuffer({ r1: { a: "x", b: "y" } });
    buffer.setCell("r1", "a", "x2");
    buffer.setCell("r1", "b", "y2");
    buffer.undo();
    expect(buffer.effectiveValue("r1", "b")).toBe("y");
    expect(buffer.effectiveValue("r1", "a")).toBe("x2");
  });

  test("a new edit clears the redo stack", () => {
    const { buffer } = makeBuffer({ r1: { t: "a" } });
    buffer.setCell("r1", "t", "b");
    buffer.undo();
    expect(buffer.canRedo()).toBeTrue();
    buffer.setCell("r1", "t", "c");
    expect(buffer.canRedo()).toBeFalse();
  });

  test("group ops undo/redo as one unit and may not nest", () => {
    const { buffer } = makeBuffer({ r1: { a: "1" }, r2: { a: "2" } });
    buffer.group(() => {
      buffer.setCell("r1", "a", "x");
      buffer.setCell("r2", "a", "x");
    });
    expect(buffer.dirtyCount()).toBe(2);
    buffer.undo();
    expect(buffer.isDirty()).toBeFalse();
    buffer.redo();
    expect(buffer.dirtyCount()).toBe(2);
    expect(() => buffer.group(() => buffer.group(() => {}))).toThrow();
  });

  test("single-op and empty groups collapse", () => {
    const { buffer } = makeBuffer({ r1: { a: "1" } });
    buffer.group(() => {});
    expect(buffer.canUndo()).toBeFalse();
    buffer.group(() => buffer.setCell("r1", "a", "2"));
    buffer.undo();
    expect(buffer.isDirty()).toBeFalse();
  });
});

describe("row inserts and deletes", () => {
  test("insertRow creates a pending row whose edits live on the insert", () => {
    const { buffer } = makeBuffer();
    const key = buffer.insertRow({ title: "New post" });
    expect(buffer.isInsertKey(key)).toBeTrue();
    expect(buffer.rowState(key)).toBe("pending-insert");
    expect(buffer.effectiveValue(key, "title")).toBe("New post");

    buffer.setCell(key, "title", "Renamed");
    expect(buffer.effectiveValue(key, "title")).toBe("Renamed");
    buffer.setCell(key, "title", null);
    expect(buffer.effectiveValue(key, "title")).toBeNull();

    const batch = buffer.buildBatch();
    expect(batch.inserts).toEqual([{ cells: {}, tempKey: key }]);
    expect(batch.cells).toEqual([]);
  });

  test("insert undo removes the row; redo restores it with its cells", () => {
    const { buffer } = makeBuffer();
    const key = buffer.insertRow({ a: "1" });
    buffer.undo();
    expect(buffer.isInsertKey(key)).toBeFalse();
    buffer.redo();
    expect(buffer.effectiveValue(key, "a")).toBe("1");
  });

  test("deleting an existing row marks pending-delete; its edits are excluded from the batch", () => {
    const { buffer } = makeBuffer({ r1: { t: "x" } });
    buffer.setCell("r1", "t", "y");
    buffer.deleteRow("r1");
    buffer.deleteRow("r1");
    expect(buffer.rowState("r1")).toBe("pending-delete");
    const batch = buffer.buildBatch();
    expect(batch.deletes).toEqual([{ rowKey: "r1" }]);
    expect(batch.cells).toEqual([]);
    expect(buffer.dirtyCount()).toBe(1);

    buffer.undo();
    expect(buffer.rowState("r1")).toBe("dirty");
    expect(batch.cells).toEqual([]);
  });

  test("deleting a pending insert drops it entirely; undo restores it", () => {
    const { buffer } = makeBuffer();
    const key = buffer.insertRow({ a: "1" });
    buffer.deleteRow(key);
    expect(buffer.isInsertKey(key)).toBeFalse();
    expect(buffer.rowState(key)).toBe("clean");
    expect(buffer.buildBatch().inserts).toEqual([]);
    expect(buffer.buildBatch().deletes).toEqual([]);

    buffer.undo();
    expect(buffer.effectiveValue(key, "a")).toBe("1");
  });
});

describe("buildBatch", () => {
  test("collects cells with live baselines plus inserts and deletes", () => {
    const { buffer, committed } = makeBuffer({ r1: { t: "old" }, r2: { t: "keep" } });
    buffer.setCell("r1", "t", "new");
    const insertKey = buffer.insertRow({ t: "born" });
    buffer.deleteRow("r2");

    const batch = buffer.buildBatch();
    expect(batch.cells).toEqual([{ baseline: "old", field: "t", rowKey: "r1", value: "new" }]);
    expect(batch.inserts).toEqual([{ cells: { t: "born" }, tempKey: insertKey }]);
    expect(batch.deletes).toEqual([{ rowKey: "r2" }]);

    committed.r1!.t = "moved";
    expect(buffer.buildBatch().cells[0]!.baseline).toBe("moved");
  });
});

describe("applyCommitResult", () => {
  test("clears succeeded, keeps failed with errors, marks stale", () => {
    const { buffer } = makeBuffer({ r1: { a: "1", b: "2" }, r2: { a: "9" } });
    buffer.setCell("r1", "a", "x");
    buffer.setCell("r1", "b", "y");
    buffer.setCell("r2", "a", "z");

    buffer.applyCommitResult({
      cells: [
        { field: "a", ok: true, rowKey: "r1" },
        { error: "boom", field: "b", ok: false, rowKey: "r1" },
        { field: "a", ok: false, rowKey: "r2", stale: true },
      ],
      deletes: [],
      inserts: [],
    });

    expect(buffer.cellState("r1", "a")).toBe("clean");
    expect(buffer.cellState("r1", "b")).toBe("error");
    expect(buffer.cellError("r1", "b")).toBe("boom");
    expect(buffer.cellState("r2", "a")).toBe("error");
    expect(buffer.rowState("r2")).toBe("stale");
    expect(buffer.isDirty()).toBeTrue();
  });

  test("committed inserts/deletes leave the buffer and drop their history", () => {
    const { buffer } = makeBuffer({ gone: { t: "x" } });
    const insertKey = buffer.insertRow({ t: "new" });
    buffer.deleteRow("gone");

    buffer.applyCommitResult({
      cells: [],
      deletes: [{ ok: true, rowKey: "gone" }],
      inserts: [{ newKey: "real-key", ok: true, tempKey: insertKey }],
    });

    expect(buffer.isDirty()).toBeFalse();
    expect(buffer.canUndo()).toBeFalse();
  });

  test("failed inserts/deletes keep row-level errors", () => {
    const { buffer } = makeBuffer({ r1: { t: "x" } });
    const insertKey = buffer.insertRow({});
    buffer.deleteRow("r1");
    buffer.applyCommitResult({
      cells: [],
      deletes: [{ error: "db", ok: false, rowKey: "r1", stale: true }],
      inserts: [{ error: "slug required", ok: false, tempKey: insertKey }],
    });
    expect(buffer.cellError(insertKey, "anything")).toBe("slug required");
    expect(buffer.cellError("r1", "t")).toBe("db");
    expect(buffer.state.stale.has("r1")).toBeTrue();
  });

  test("cell history survives a commit — post-save undo re-dirties against the new baseline", () => {
    const { buffer, committed } = makeBuffer({ r1: { t: "old" } });
    buffer.setCell("r1", "t", "new");
    buffer.applyCommitResult({
      cells: [{ field: "t", ok: true, rowKey: "r1" }],
      deletes: [],
      inserts: [],
    });
    committed.r1!.t = "new";
    expect(buffer.isDirty()).toBeFalse();
    expect(buffer.canUndo()).toBeTrue();

    buffer.undo();
    expect(buffer.effectiveValue("r1", "t")).toBe("old");
    expect(buffer.cellState("r1", "t")).toBe("dirty");
  });
});

describe("staleness, discard, reset", () => {
  test("markStale flags rows; a successful commit for the row clears it", () => {
    const { buffer } = makeBuffer({ r1: { t: "x" } });
    buffer.setCell("r1", "t", "y");
    buffer.markStale(["r1"]);
    expect(buffer.cellState("r1", "t")).toBe("stale");
    expect(buffer.rowState("r1")).toBe("stale");
  });

  test("discardRow drops pending state, errors, and that row's history only", () => {
    const { buffer } = makeBuffer({ r1: { t: "x" }, r2: { t: "y" } });
    buffer.setCell("r1", "t", "1");
    buffer.setCell("r2", "t", "2");
    buffer.markStale(["r1"]);
    buffer.discardRow("r1");

    expect(buffer.rowState("r1")).toBe("clean");
    expect(buffer.effectiveValue("r1", "t")).toBe("x");
    expect(buffer.effectiveValue("r2", "t")).toBe("2");
    buffer.undo();
    expect(buffer.effectiveValue("r2", "t")).toBe("y");
    expect(buffer.canUndo()).toBeFalse();
  });

  test("reset clears everything", () => {
    const { buffer } = makeBuffer({ r1: { t: "x" } });
    buffer.setCell("r1", "t", "1");
    buffer.insertRow({});
    buffer.deleteRow("r1");
    buffer.markStale(["r1"]);
    buffer.reset();
    expect(buffer.isDirty()).toBeFalse();
    expect(buffer.dirtyCount()).toBe(0);
    expect(buffer.canUndo()).toBeFalse();
    expect(buffer.canRedo()).toBeFalse();
    expect(buffer.rowState("r1")).toBe("clean");
  });
});
