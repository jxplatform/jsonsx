/**
 * Per-tab grid orchestration — no DOM, no grid engine.
 *
 * Owns the source, the reactive load state, and the edit buffer for one grid tab. Created inside
 * the tab's effectScope so everything (dirty mirroring, history delegate, fs subscription, the
 * registry entry) tears down when the tab closes. The buffer's dirtiness mirrors onto
 * `tab.doc.dirty`, which makes the existing tab-strip dot and close-confirm flows work unchanged;
 * undo/redo registers as the tab's HistoryDelegate, so Cmd-Z and the toolbar buttons route here
 * without any shortcut edits.
 *
 * Save is explicit and batched: validate required cells → confirm deletes → commit through the
 * source → clear/re-baseline what succeeded, keep failures dirty with errors, mark stale rows.
 */
import { effect, onScopeDispose, reactive, toRaw } from "../reactivity";
import { getPlatform } from "../platform";
import { setHistoryDelegate } from "../tabs/transact";
import { isRecentLocal } from "../files/fs-events";
import { statusMessage } from "../panels/statusbar";
import { showConfirmDialog } from "../ui/layers";
import { showProgressModal } from "../ui/progress-modal";
import { errorMessage } from "@jxsuite/schema/parse";
import { createEditBuffer } from "./edit-buffer";
import type { EditBuffer } from "./edit-buffer";
import type {
  CommitResult,
  GridCellValue,
  GridColumn,
  GridEditBatch,
  GridQuery,
  GridRow,
  GridSource,
} from "./grid-source";
import type { Tab } from "../tabs/tab";

export interface GridControllerState {
  columns: GridColumn[];
  /** Committed rows as last loaded/saved — baselines live here. */
  rows: GridRow[];
  total: number;
  loading: boolean;
  saving: boolean;
  error: string | null;
  query: GridQuery;
}

/** What the engine wrapper exposes back to the controller for out-of-band data changes. */
export interface GridViewBinding {
  /** Re-pull effectiveRows() into the table (undo/redo, save, refresh, row add/delete). */
  refreshData: () => void;
}

export interface GridController {
  tab: Tab;
  source: GridSource;
  state: GridControllerState;
  buffer: EditBuffer;
  load: () => Promise<void>;
  /** Reload from the source; asks before discarding pending edits. */
  refresh: () => Promise<void>;
  save: () => Promise<void>;
  /** Query change (connector paging/sorting) — reloads rows. */
  setQuery: (query: GridQuery) => Promise<void>;
  /** Plain row objects (committed + pending overlay + pending inserts) for the grid engine. */
  effectiveRows: () => Record<string, GridCellValue>[];
  /** Current file text including pending edits, for source-mode display (file grids only). */
  serializeForSource: () => Promise<string> | null;
  /** Attach/detach the engine wrapper. Edits flowing FROM the table never round-trip back. */
  bindView: (view: GridViewBinding | null) => void;
  /** Buffer a new row (pending insert) and sync the view. Returns its temp key. */
  addRow: (cells?: Record<string, GridCellValue>) => string;
  /** Buffer row deletions as one undo group and sync the view. */
  deleteRows: (rowKeys: string[]) => void;
  /** Drop one row's pending edits (not undoable) and sync the view. */
  discardRow: (rowKey: string) => void;
  /** Replace text across editable string/text cells (one undo group). Returns cells changed. */
  replaceAll: (find: string, replace: string) => number;
}

/** Row-object key carrying the grid row identity through the engine. */
export const ROW_KEY_FIELD = "__key";

const _controllers = new WeakMap<object, GridController>();

/** The grid controller for a tab, if it is a grid tab. */
export function getGridController(tab: Tab | null): GridController | null {
  return tab ? (_controllers.get(toRaw(tab as unknown as object)) ?? null) : null;
}

/** Create and register the controller for a grid tab. One per tab; lives in the tab's scope. */
export function createGridController(tab: Tab, source: GridSource): GridController {
  const state: GridControllerState = reactive({
    columns: [] as GridColumn[],
    error: null as string | null,
    loading: false,
    query: {} as GridQuery,
    rows: [] as GridRow[],
    saving: false,
    total: 0,
  }) as GridControllerState;

  let rowByKey = new Map<string, GridRow>();
  const indexRows = (rows: GridRow[]) => {
    rowByKey = new Map(rows.map((row) => [row.key, row]));
  };

  const buffer = createEditBuffer({
    resolveBaseline: (rowKey, field) => rowByKey.get(rowKey)?.cells[field] ?? null,
  });

  const reloadRows = async () => {
    const result = await source.rows(state.query);
    state.rows = result.rows;
    state.total = result.total;
    indexRows(result.rows);
  };

  /** Missing required cells block the save (marked as row/cell errors, like a failed commit). */
  const requiredViolations = (batch: GridEditBatch): CommitResult | null => {
    const required = state.columns.filter((c) => c.required && c.editable);
    if (required.length === 0) {
      return null;
    }
    const cells = batch.cells
      .filter((cell) => cell.value === null && required.some((c) => c.field === cell.field))
      .map((cell) => ({ error: "Required", field: cell.field, ok: false, rowKey: cell.rowKey }));
    const inserts = batch.inserts
      .filter((insert) =>
        required.some((c) => insert.cells[c.field] === null || insert.cells[c.field] === undefined),
      )
      .map((insert) => {
        const missing = required
          .filter((c) => insert.cells[c.field] === null || insert.cells[c.field] === undefined)
          .map((c) => c.field)
          .join(", ");
        return { error: `Missing required: ${missing}`, ok: false, tempKey: insert.tempKey };
      });
    if (cells.length === 0 && inserts.length === 0) {
      return null;
    }
    return { cells, deletes: [], inserts };
  };

  let viewBinding: GridViewBinding | null = null;
  const syncView = () => viewBinding?.refreshData();

  const controller: GridController = {
    addRow(cells = {}) {
      const tempKey = buffer.insertRow(cells);
      syncView();
      return tempKey;
    },

    bindView(view) {
      viewBinding = view;
    },

    buffer,

    deleteRows(rowKeys) {
      if (rowKeys.length === 0) {
        return;
      }
      buffer.group(() => {
        for (const rowKey of rowKeys) {
          buffer.deleteRow(rowKey);
        }
      });
      syncView();
    },

    discardRow(rowKey) {
      buffer.discardRow(rowKey);
      syncView();
    },

    replaceAll(find, replace) {
      if (find === "") {
        return 0;
      }
      const textColumns = state.columns.filter(
        (column) => column.editable && (column.kind === "string" || column.kind === "text"),
      );
      const rowKeys = [...state.rows.map((row) => row.key), ...buffer.state.inserts.keys()];
      let changed = 0;
      buffer.group(() => {
        for (const rowKey of rowKeys) {
          if (buffer.rowState(rowKey) === "pending-delete") {
            continue;
          }
          for (const column of textColumns) {
            const value = buffer.effectiveValue(rowKey, column.field);
            if (typeof value === "string" && value.includes(find)) {
              buffer.setCell(rowKey, column.field, value.replaceAll(find, replace));
              changed += 1;
            }
          }
        }
      });
      if (changed > 0) {
        syncView();
      }
      return changed;
    },

    effectiveRows() {
      // Detach values from reactive proxies — the grid engine must never hold live proxies.
      const plain = (value: GridCellValue): GridCellValue =>
        Array.isArray(value)
          ? [...value]
          : value !== null && typeof value === "object"
            ? { $ref: value.$ref }
            : value;
      const rowObject = (key: string) => {
        const cells: Record<string, GridCellValue> = { [ROW_KEY_FIELD]: key };
        for (const column of state.columns) {
          cells[column.field] = plain(buffer.effectiveValue(key, column.field));
        }
        return cells;
      };
      const rows = state.rows.map((row) => rowObject(row.key));
      for (const [tempKey] of buffer.state.inserts) {
        rows.push(rowObject(tempKey));
      }
      return rows;
    },

    async load() {
      state.loading = true;
      state.error = null;
      try {
        state.columns = await source.columns();
        await reloadRows();
      } catch (error) {
        state.error = errorMessage(error);
      } finally {
        state.loading = false;
      }
      syncView();
    },

    async refresh() {
      if (buffer.isDirty()) {
        const confirmed = await showConfirmDialog(
          "Refresh Grid",
          `Discard ${buffer.dirtyCount()} pending change(s) and reload?`,
          { confirmLabel: "Discard & Reload", destructive: true },
        );
        if (!confirmed) {
          return;
        }
      }
      buffer.reset();
      await source.refresh?.();
      await this.load();
    },

    async save() {
      if (state.saving) {
        return;
      }
      const batch = buffer.buildBatch();
      const changeCount = batch.cells.length + batch.inserts.length + batch.deletes.length;
      if (changeCount === 0) {
        statusMessage("No grid changes to save");
        return;
      }
      const violations = requiredViolations(batch);
      if (violations) {
        buffer.applyCommitResult(violations);
        statusMessage("Required cells are empty — fix the marked rows and save again", 5000);
        return;
      }
      if (batch.deletes.length > 0) {
        const confirmed = await showConfirmDialog(
          "Delete Rows",
          `Save will permanently delete ${batch.deletes.length} row(s). Continue?`,
          { confirmLabel: "Delete & Save", destructive: true },
        );
        if (!confirmed) {
          return;
        }
      }

      const affectedRows =
        new Set(batch.cells.map((c) => c.rowKey)).size +
        batch.inserts.length +
        batch.deletes.length;
      const progress = affectedRows > 5 ? showProgressModal({ title: "Saving grid" }) : null;
      state.saving = true;
      try {
        const result = await source.commit(batch);

        // Move baselines for saved cells before the buffer clears their pending entries.
        const cellKey = (rowKey: string, field: string) => `${rowKey} ${field}`;
        const batchCells = new Map(batch.cells.map((c) => [cellKey(c.rowKey, c.field), c]));
        for (const outcome of result.cells) {
          const cell = batchCells.get(cellKey(outcome.rowKey, outcome.field));
          if (outcome.ok && cell) {
            const row = rowByKey.get(outcome.rowKey);
            if (row) {
              row.cells[outcome.field] = cell.value;
            }
          }
        }
        buffer.applyCommitResult(result);

        const structural = result.inserts.some((r) => r.ok) || result.deletes.some((r) => r.ok);
        if (structural) {
          await reloadRows();
        }

        const okCount =
          result.cells.filter((r) => r.ok).length +
          result.inserts.filter((r) => r.ok).length +
          result.deletes.filter((r) => r.ok).length;
        const failed = changeCount - okCount;
        const staleCount =
          result.cells.filter((r) => r.stale).length + result.deletes.filter((r) => r.stale).length;
        statusMessage(
          failed === 0
            ? `Saved ${okCount} change(s)`
            : `Saved ${okCount} · ${failed} failed${staleCount ? ` (${staleCount} stale)` : ""} — kept pending`,
          failed === 0 ? 3000 : 6000,
        );
      } catch (error) {
        statusMessage(`Save error: ${errorMessage(error)}`, 6000);
      } finally {
        state.saving = false;
        progress?.done();
        syncView();
      }
    },

    serializeForSource() {
      if (!source.serializeForSource) {
        return null;
      }
      return source.serializeForSource(buffer.buildBatch());
    },

    async setQuery(query: GridQuery) {
      state.query = query;
      state.loading = true;
      try {
        await reloadRows();
      } catch (error) {
        state.error = errorMessage(error);
      } finally {
        state.loading = false;
      }
      syncView();
    },

    source,
    state,
    tab,
  };

  tab.scope.run(() => {
    // Buffer dirtiness IS the tab's dirty flag — tab-strip dot and close-confirm come for free.
    effect(() => {
      tab.doc.dirty = buffer.isDirty();
    });

    setHistoryDelegate(tab, {
      canRedo: () => buffer.canRedo(),
      canUndo: () => buffer.canUndo(),
      redo: () => {
        buffer.redo();
        syncView();
      },
      undo: () => {
        buffer.undo();
        syncView();
      },
    });

    const platform = getPlatform();
    if (platform.subscribeFileEvents && source.backingPaths) {
      const unsubscribe = platform.subscribeFileEvents((events) => {
        const backing = source.backingPaths!();
        const hitKeys = new Set<string>();
        for (const event of events) {
          if (event.isDir) {
            continue;
          }
          const path = event.path.replaceAll("\\", "/");
          const rowKey = backing.get(path);
          if (rowKey !== undefined && !isRecentLocal(path)) {
            hitKeys.add(rowKey);
          }
        }
        if (hitKeys.size === 0) {
          return;
        }
        if (buffer.isDirty()) {
          const keys = hitKeys.has("*") ? state.rows.map((row) => row.key) : [...hitKeys];
          buffer.markStale(keys);
          statusMessage("Grid rows changed on disk — marked stale (refresh to reload)", 5000);
          syncView();
        } else {
          void controller.refresh();
        }
      });
      onScopeDispose(unsubscribe);
    }

    onScopeDispose(() => {
      setHistoryDelegate(tab, null);
      _controllers.delete(toRaw(tab as unknown as object));
      source.dispose?.();
    });
  });

  _controllers.set(toRaw(tab as unknown as object), controller);
  return controller;
}
