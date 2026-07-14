/**
 * Engine-agnostic edit buffer for grid tabs — the batch-save model's core.
 *
 * Cell edits, row inserts, and row deletes accumulate here (nothing touches disk/API until the user
 * saves); the grid engine only renders this state. Values equal to their baseline prune back to
 * clean. Undo/redo is an inverse-op stack over the buffer and SURVIVES save: a commit re-baselines
 * instead of clearing history, so a post-save undo simply makes cells dirty again. The one
 * exception is structural history — ops referencing successfully committed row inserts/deletes are
 * filtered out, because their temp keys/rows no longer exist.
 *
 * Baselines are resolved through `opts.resolveBaseline` at comparison time (not captured), which is
 * what lets history outlive commits.
 */
import { reactive } from "../reactivity";
import { cellValuesEqual } from "./grid-source";
import type { CommitResult, GridCellValue, GridEditBatch } from "./grid-source";

export type BufferOp =
  | {
      kind: "cell";
      rowKey: string;
      field: string;
      before: GridCellValue;
      after: GridCellValue;
      at: number;
    }
  | { kind: "insert"; tempKey: string; cells: Record<string, GridCellValue> }
  | { kind: "drop-insert"; tempKey: string; cells: Record<string, GridCellValue> }
  | { kind: "delete"; rowKey: string }
  | { kind: "group"; ops: BufferOp[] };

export type CellState = "clean" | "dirty" | "error" | "stale";

export type RowState = "clean" | "dirty" | "pending-insert" | "pending-delete" | "stale";

export interface EditBufferState {
  /** Map of rowKey → field → pending value (existing rows only). */
  pending: Map<string, Map<string, { value: GridCellValue }>>;
  /** Map of tempKey → the new row's cells (inserted rows carry their edits directly). */
  inserts: Map<string, Record<string, GridCellValue>>;
  deletes: Set<string>;
  /** Map of rowKey → field (or "*" for whole-row) → error message from the last commit. */
  errors: Map<string, Map<string, string>>;
  stale: Set<string>;
  undoStack: BufferOp[];
  redoStack: BufferOp[];
}

export interface EditBufferOptions {
  /** Current committed value of a cell — consulted at comparison time, never captured. */
  resolveBaseline: (rowKey: string, field: string) => GridCellValue;
  /** Merge window for consecutive edits to the same cell (ms). */
  coalesceMs?: number;
  now?: () => number;
}

export interface EditBuffer {
  state: EditBufferState;
  setCell: (rowKey: string, field: string, value: GridCellValue) => void;
  /** Add a pending new row; returns its temp key. */
  insertRow: (cells?: Record<string, GridCellValue>) => string;
  deleteRow: (rowKey: string) => void;
  /** Run edits as one undo group (paste, fill, multi-delete). Groups may not nest. */
  group: (fn: () => void) => void;
  /** Imperative group boundaries for edit bursts that span event callbacks (engine paste). */
  beginGroup: () => void;
  endGroup: () => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;
  isDirty: () => boolean;
  /** Pending cells + inserts + deletes — the Save button badge. */
  dirtyCount: () => number;
  isInsertKey: (rowKey: string) => boolean;
  effectiveValue: (rowKey: string, field: string) => GridCellValue;
  cellState: (rowKey: string, field: string) => CellState;
  rowState: (rowKey: string) => RowState;
  cellError: (rowKey: string, field: string) => string | null;
  buildBatch: () => GridEditBatch;
  applyCommitResult: (result: CommitResult) => void;
  markStale: (rowKeys: string[]) => void;
  /** Drop one row's pending edits (and its history — a discard is not undoable). */
  discardRow: (rowKey: string) => void;
  reset: () => void;
}

let _tempCounter = 0;

/** Create the reactive edit buffer for one grid tab. */
export function createEditBuffer(opts: EditBufferOptions): EditBuffer {
  const coalesceMs = opts.coalesceMs ?? 800;
  const now = opts.now ?? (() => Date.now());

  const state: EditBufferState = reactive({
    deletes: new Set<string>(),
    errors: new Map<string, Map<string, string>>(),
    inserts: new Map<string, Record<string, GridCellValue>>(),
    pending: new Map<string, Map<string, { value: GridCellValue }>>(),
    redoStack: [] as BufferOp[],
    stale: new Set<string>(),
    undoStack: [] as BufferOp[],
  }) as EditBufferState;

  let groupOps: BufferOp[] | null = null;

  // NB: on create paths, inner maps are built COMPLETE before insertion. Inserting an empty raw
  // Map and then mutating the held reference writes past the reactive proxy — effects get
  // Triggered at the empty intermediate state and never hear about the real content.
  const setError = (rowKey: string, field: string, message: string) => {
    const row = state.errors.get(rowKey);
    if (row) {
      row.set(field, message);
    } else {
      state.errors.set(rowKey, new Map([[field, message]]));
    }
  };

  const clearCellError = (rowKey: string, field: string) => {
    const row = state.errors.get(rowKey);
    row?.delete(field);
    if (row?.size === 0) {
      state.errors.delete(rowKey);
    }
  };

  const pushOp = (op: BufferOp) => {
    state.redoStack.length = 0;
    if (groupOps) {
      groupOps.push(op);
      return;
    }
    const last = state.undoStack.at(-1);
    if (
      op.kind === "cell" &&
      last?.kind === "cell" &&
      last.rowKey === op.rowKey &&
      last.field === op.field &&
      op.at - last.at <= coalesceMs
    ) {
      last.after = op.after;
      last.at = op.at;
      return;
    }
    state.undoStack.push(op);
  };

  /** Write a pending value without recording history (shared by user edits and undo/redo). */
  const writeCell = (rowKey: string, field: string, value: GridCellValue) => {
    const insertCells = state.inserts.get(rowKey);
    if (insertCells) {
      if (value === null) {
        delete insertCells[field];
      } else {
        insertCells[field] = value;
      }
      return;
    }
    if (cellValuesEqual(value, opts.resolveBaseline(rowKey, field))) {
      const row = state.pending.get(rowKey);
      row?.delete(field);
      if (row?.size === 0) {
        state.pending.delete(rowKey);
      }
      return;
    }
    const row = state.pending.get(rowKey);
    if (row) {
      row.set(field, { value });
    } else {
      state.pending.set(rowKey, new Map([[field, { value }]]));
    }
  };

  const effectiveValue = (rowKey: string, field: string): GridCellValue => {
    const insertCells = state.inserts.get(rowKey);
    if (insertCells) {
      return insertCells[field] ?? null;
    }
    const pending = state.pending.get(rowKey)?.get(field);
    return pending ? pending.value : opts.resolveBaseline(rowKey, field);
  };

  const cellError = (rowKey: string, field: string): string | null => {
    const row = state.errors.get(rowKey);
    return row?.get(field) ?? row?.get("*") ?? null;
  };

  const applyOp = (op: BufferOp, direction: "undo" | "redo") => {
    switch (op.kind) {
      case "cell": {
        writeCell(op.rowKey, op.field, direction === "undo" ? op.before : op.after);
        break;
      }
      case "insert": {
        if (direction === "undo") {
          state.inserts.delete(op.tempKey);
        } else {
          state.inserts.set(op.tempKey, { ...op.cells });
        }
        break;
      }
      case "drop-insert": {
        if (direction === "undo") {
          state.inserts.set(op.tempKey, { ...op.cells });
        } else {
          state.inserts.delete(op.tempKey);
        }
        break;
      }
      case "delete": {
        if (direction === "undo") {
          state.deletes.delete(op.rowKey);
        } else {
          state.deletes.add(op.rowKey);
        }
        break;
      }
      default: {
        const ops = direction === "undo" ? op.ops.toReversed() : op.ops;
        for (const child of ops) {
          applyOp(child, direction);
        }
        break;
      }
    }
  };

  const beginGroup = () => {
    if (groupOps) {
      throw new Error("edit-buffer: groups may not nest");
    }
    groupOps = [];
  };

  const endGroup = () => {
    const ops = groupOps;
    groupOps = null;
    if (!ops) {
      return;
    }
    if (ops.length === 1) {
      state.undoStack.push(ops[0]!);
    } else if (ops.length > 1) {
      state.undoStack.push({ kind: "group", ops });
    }
  };

  /** Ops referencing a committed/discarded row can no longer replay — filter them out. */
  const pruneHistory = (dropRow: (rowKey: string) => boolean) => {
    const keep = (op: BufferOp): BufferOp | null => {
      switch (op.kind) {
        case "cell": {
          return dropRow(op.rowKey) ? null : op;
        }
        case "insert":
        case "drop-insert": {
          return dropRow(op.tempKey) ? null : op;
        }
        case "delete": {
          return dropRow(op.rowKey) ? null : op;
        }
        default: {
          const ops = op.ops.map((child) => keep(child)).filter((o): o is BufferOp => o !== null);
          return ops.length > 0 ? { kind: "group", ops } : null;
        }
      }
    };
    state.undoStack = state.undoStack.map(keep).filter((o): o is BufferOp => o !== null);
    state.redoStack = state.redoStack.map(keep).filter((o): o is BufferOp => o !== null);
  };

  return {
    applyCommitResult(result) {
      const committedRows = new Set<string>();
      for (const cell of result.cells) {
        if (cell.ok) {
          const row = state.pending.get(cell.rowKey);
          row?.delete(cell.field);
          if (row?.size === 0) {
            state.pending.delete(cell.rowKey);
          }
          clearCellError(cell.rowKey, cell.field);
        } else {
          setError(cell.rowKey, cell.field, cell.error ?? "Save failed");
          if (cell.stale) {
            state.stale.add(cell.rowKey);
          }
        }
      }
      for (const ins of result.inserts) {
        if (ins.ok) {
          state.inserts.delete(ins.tempKey);
          state.errors.delete(ins.tempKey);
          committedRows.add(ins.tempKey);
        } else {
          setError(ins.tempKey, "*", ins.error ?? "Insert failed");
        }
      }
      for (const del of result.deletes) {
        if (del.ok) {
          state.deletes.delete(del.rowKey);
          state.pending.delete(del.rowKey);
          state.errors.delete(del.rowKey);
          committedRows.add(del.rowKey);
        } else {
          setError(del.rowKey, "*", del.error ?? "Delete failed");
          if (del.stale) {
            state.stale.add(del.rowKey);
          }
        }
      }
      for (const row of committedRows) {
        state.stale.delete(row);
      }
      if (committedRows.size > 0) {
        pruneHistory((rowKey) => committedRows.has(rowKey));
      }
    },

    buildBatch(): GridEditBatch {
      const cells: GridEditBatch["cells"] = [];
      for (const [rowKey, fields] of state.pending) {
        if (state.deletes.has(rowKey)) {
          continue;
        }
        for (const [field, cell] of fields) {
          cells.push({
            baseline: opts.resolveBaseline(rowKey, field),
            field,
            rowKey,
            value: cell.value,
          });
        }
      }
      return {
        cells,
        deletes: [...state.deletes].map((rowKey) => ({ rowKey })),
        inserts: [...state.inserts].map(([tempKey, insertCells]) => ({
          cells: { ...insertCells },
          tempKey,
        })),
      };
    },

    canRedo: () => state.redoStack.length > 0,
    canUndo: () => state.undoStack.length > 0,
    cellError,

    cellState(rowKey, field) {
      if (cellError(rowKey, field) !== null) {
        return "error";
      }
      if (state.stale.has(rowKey)) {
        return "stale";
      }
      if (state.inserts.has(rowKey) || state.pending.get(rowKey)?.has(field)) {
        return "dirty";
      }
      return "clean";
    },

    deleteRow(rowKey) {
      if (state.deletes.has(rowKey)) {
        return;
      }
      const insertCells = state.inserts.get(rowKey);
      if (insertCells) {
        // Deleting a not-yet-saved insert just drops it (the row disappears entirely).
        const cells = { ...insertCells };
        state.inserts.delete(rowKey);
        state.errors.delete(rowKey);
        state.stale.delete(rowKey);
        pushOp({ cells, kind: "drop-insert", tempKey: rowKey });
        return;
      }
      state.deletes.add(rowKey);
      pushOp({ kind: "delete", rowKey });
    },

    dirtyCount() {
      let count = state.inserts.size + state.deletes.size;
      for (const [rowKey, fields] of state.pending) {
        if (!state.deletes.has(rowKey)) {
          count += fields.size;
        }
      }
      return count;
    },

    discardRow(rowKey) {
      state.pending.delete(rowKey);
      state.deletes.delete(rowKey);
      state.inserts.delete(rowKey);
      state.errors.delete(rowKey);
      state.stale.delete(rowKey);
      pruneHistory((key) => key === rowKey);
    },

    effectiveValue,

    beginGroup,

    endGroup,

    group(fn) {
      beginGroup();
      try {
        fn();
      } finally {
        endGroup();
      }
    },

    insertRow(cells = {}) {
      _tempCounter += 1;
      const tempKey = `__new-${_tempCounter}`;
      state.inserts.set(tempKey, { ...cells });
      pushOp({ cells: { ...cells }, kind: "insert", tempKey });
      return tempKey;
    },

    isDirty: () => state.pending.size > 0 || state.inserts.size > 0 || state.deletes.size > 0,

    isInsertKey: (rowKey) => state.inserts.has(rowKey),

    markStale(rowKeys) {
      for (const rowKey of rowKeys) {
        state.stale.add(rowKey);
      }
    },

    redo() {
      const op = state.redoStack.pop();
      if (!op) {
        return false;
      }
      applyOp(op, "redo");
      state.undoStack.push(op);
      return true;
    },

    reset() {
      state.pending.clear();
      state.inserts.clear();
      state.deletes.clear();
      state.errors.clear();
      state.stale.clear();
      state.undoStack.length = 0;
      state.redoStack.length = 0;
    },

    rowState(rowKey) {
      if (state.deletes.has(rowKey)) {
        return "pending-delete";
      }
      if (state.inserts.has(rowKey)) {
        return "pending-insert";
      }
      if (state.stale.has(rowKey)) {
        return "stale";
      }
      if (state.pending.has(rowKey) || state.errors.has(rowKey)) {
        return "dirty";
      }
      return "clean";
    },

    setCell(rowKey, field, value) {
      const before = effectiveValue(rowKey, field);
      if (cellValuesEqual(before, value)) {
        return;
      }
      writeCell(rowKey, field, value);
      pushOp({ after: value, at: now(), before, field, kind: "cell", rowKey });
    },

    state,

    undo() {
      const op = state.undoStack.pop();
      if (!op) {
        return false;
      }
      applyOp(op, "undo");
      state.redoStack.push(op);
      return true;
    },
  };
}
