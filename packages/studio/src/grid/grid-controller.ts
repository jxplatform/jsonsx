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
import { notify } from "../services/notify";
import { setHistoryDelegate } from "../tabs/transact";
import { isRecentLocal } from "../files/fs-events";
import { showConfirmDialog } from "../ui/layers";
import { showProgressModal } from "../ui/progress-modal";
import { errorMessage } from "@jxsuite/schema/parse";
import { createEditBuffer } from "./edit-buffer";
import { cellToText } from "./schema-columns";
import type { EditBuffer } from "./edit-buffer";
import type { GridSortSpec } from "./grid-layout";
import type {
  CommitResult,
  GridCellValue,
  GridColumn,
  GridColumnKind,
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
  /**
   * The field whose value gathers rows into contiguous groups, or null.
   *
   * Grouping is a ROW ORDER, not a second data set: {@link GridController.effectiveRows} emits the
   * groups back to back in first-appearance order, so every layer above — the engine, the
   * clipboard, Fill Down — sees one list and needs to know nothing about groups.
   */
  grouping: string | null;
}

/** One group of the current grouping, in the order {@link GridController.effectiveRows} emits them. */
export interface GridGroup {
  /** The group field's text value; `""` for rows where it is empty. */
  value: string;
  count: number;
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
  /**
   * Set (or clear) the row order.
   *
   * ONE sort contract for every source. `GridQuery.orderBy`/`dir` has always been the way a source
   * is asked for an order, and a remote-sorting source still answers it by reloading; a source that
   * does not sort remotely is now sorted here instead of the query being silently ignored, which is
   * what let a saved view record a sort nothing applied. A header click in the engine is a
   * separate, ad-hoc re-sort of what is already loaded and is deliberately not captured by a view.
   */
  setSort: (sort: GridSortSpec | null) => Promise<void>;
  /** Group rows contiguously by a field's value, or ungroup with null. */
  setGrouping: (field: string | null) => void;
  /** The groups the current grouping produces, in emitted order. Empty when ungrouped. */
  groups: () => GridGroup[];
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
    grouping: null as string | null,
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

  // ─── Row order: grouping first, then sort ───────────────────────────────────

  /** Whether a cell has nothing in it. Blanks sort LAST in both directions — a hole is not a value. */
  const isBlank = (value: GridCellValue) =>
    value === null || value === "" || (Array.isArray(value) && value.length === 0);

  const compareCells = (a: GridCellValue, b: GridCellValue, kind: GridColumnKind | undefined) => {
    if (kind === "number") {
      return (typeof a === "number" ? a : 0) - (typeof b === "number" ? b : 0);
    }
    if (kind === "boolean") {
      return (a === true ? 1 : 0) - (b === true ? 1 : 0);
    }
    return cellToText(a).localeCompare(cellToText(b));
  };

  /**
   * Committed row keys in display order: grouped, then sorted within each group.
   *
   * Sorting is skipped for a source that sorts remotely — it already answered the query, and
   * re-sorting its answer locally would reorder one PAGE of a result set by a rule the other pages
   * were not subject to. Pending inserts are never in here: a row you just added stays at the
   * bottom where you added it, rather than sorting itself out of sight while you are still typing
   * into it.
   */
  const orderedKeys = (): string[] => {
    let keys = state.rows.map((row) => row.key);
    const { dir, orderBy } = state.query;
    if (orderBy && !source.capabilities.remoteSort) {
      const kind = state.columns.find((column) => column.field === orderBy)?.kind;
      const sign = dir === "desc" ? -1 : 1;
      keys = keys.toSorted((ka, kb) => {
        const a = buffer.effectiveValue(ka, orderBy);
        const b = buffer.effectiveValue(kb, orderBy);
        if (isBlank(a) !== isBlank(b)) {
          return isBlank(a) ? 1 : -1;
        }
        return sign * compareCells(a, b, kind);
      });
    }
    return state.grouping ? [...groupBuckets(keys).values()].flat() : keys;
  };

  /** Group key → row keys, in first-appearance order. Called only when `state.grouping` is set. */
  const groupBuckets = (keys: string[]): Map<string, string[]> => {
    const buckets = new Map<string, string[]>();
    for (const key of keys) {
      const value = cellToText(buffer.effectiveValue(key, state.grouping!));
      const bucket = buckets.get(value);
      if (bucket) {
        bucket.push(key);
      } else {
        buckets.set(value, [key]);
      }
    }
    return buckets;
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
      const rows = orderedKeys().map((key) => rowObject(key));
      for (const [tempKey] of buffer.state.inserts) {
        rows.push(rowObject(tempKey));
      }
      return rows;
    },

    groups() {
      if (!state.grouping) {
        return [];
      }
      return [...groupBuckets(orderedKeys())].map(([value, keys]) => ({
        count: keys.length,
        value,
      }));
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
        notify.info("No grid changes to save.", { key: "grid.save" });
        return;
      }
      const violations = requiredViolations(batch);
      if (violations) {
        buffer.applyCommitResult(violations);
        notify.warn("Required cells are empty — fix the marked rows, then save again.", {
          key: "grid.save",
          source: "Data",
          tier: "problem",
        });
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
        if (failed === 0) {
          notify.success(`Saved ${okCount} change(s).`, { key: "grid.save" });
        } else {
          // A partial commit leaves rows pending on disk: a state to fix, not a line to read.
          notify.error(
            `Saved ${okCount} · ${failed} failed${staleCount ? ` (${staleCount} stale)` : ""} — kept pending.`,
            { action: "file.save", key: "grid.save", source: "Data" },
          );
        }
      } catch (error) {
        notify.error("Could not save the grid.", {
          action: "file.save",
          detail: errorMessage(error),
          key: "grid.save",
          source: "Data",
        });
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

    setGrouping(field: string | null) {
      state.grouping = field;
      syncView();
    },

    async setSort(sort: GridSortSpec | null) {
      const query: GridQuery = { ...state.query };
      if (sort) {
        query.orderBy = sort.field;
        query.dir = sort.dir;
      } else {
        delete query.orderBy;
        delete query.dir;
      }
      // A local sort is a reordering of rows already in hand: reloading would re-walk a directory
      // Or re-parse a file to receive the same rows back in the same order.
      if (!source.capabilities.remoteSort) {
        state.query = query;
        syncView();
        return;
      }
      await this.setQuery(query);
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
          notify.warn("Grid rows changed on disk — marked stale; refresh to reload.", {
            key: "grid.stale",
            source: "Data",
          });
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
