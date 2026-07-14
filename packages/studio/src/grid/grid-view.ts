/**
 * Grid view — the ONLY module that instantiates Tabulator.
 *
 * Everything engine-specific stays behind this wrapper (and cell-editors' factories) so the engine
 * remains swappable: it maps GridColumn[] to Tabulator column definitions, forwards user edits into
 * the edit buffer, renders buffer state (dirty/error/stale/pending-delete classes), and exposes the
 * few actions the panel toolbar needs. Data flows one way per direction: user edits go table →
 * buffer (cellEdited); programmatic changes go buffer → table only through refreshData()
 * (replaceData under a suppress guard).
 */
import {
  ClipboardModule,
  EditModule,
  ExportModule,
  FilterModule,
  FormatModule,
  FrozenColumnsModule,
  InteractionModule,
  KeybindingsModule,
  MoveColumnsModule,
  ResizeColumnsModule,
  SelectRangeModule,
  SortModule,
  Tabulator,
  TooltipModule,
} from "tabulator-tables";
import "tabulator-tables/dist/css/tabulator.min.css";
import { cellValuesEqual } from "./grid-source";
import { cellToText, coerceCellInput } from "./schema-columns";
import { rectOf } from "../utils/geometry";
import { editorForColumn, formatterForColumn } from "./cell-editors";
import { hasPopoverEditor, openCellValuePopover } from "./cell-popovers";
import { ROW_KEY_FIELD } from "./grid-controller";
import { applyGridLayout, loadGridLayout, saveGridLayout } from "./grid-layout";
import type {
  CellComponent,
  ColumnComponent,
  ColumnDefinition,
  RowComponent,
} from "tabulator-tables";
import type { GridCellValue, GridColumn } from "./grid-source";
import type { GridController } from "./grid-controller";

export interface GridView {
  /** Re-pull controller.effectiveRows() into the table (buffer → table sync). */
  refreshData: () => void;
  /** Copy the range's first row down through the rest of the range, as one undo group. */
  fillDown: () => void;
  /** Row keys covered by the active selection range. */
  getSelectedRowKeys: () => string[];
  /** Local text filter across all columns (empty clears). */
  setSearch: (term: string) => void;
  destroy: () => void;
}

let modulesRegistered = false;

function ensureModules() {
  if (modulesRegistered) {
    return;
  }
  Tabulator.registerModule([
    ClipboardModule,
    EditModule,
    ExportModule,
    FilterModule,
    FormatModule,
    FrozenColumnsModule,
    InteractionModule,
    KeybindingsModule,
    MoveColumnsModule,
    ResizeColumnsModule,
    SelectRangeModule,
    SortModule,
    TooltipModule,
  ]);
  modulesRegistered = true;
}

/**
 * THE single sanctioned imperative element creation in the grid: Tabulator's editor/formatter
 * contract requires returning a detached element for it to parent into the cell, and lit-html needs
 * a container to render into. Everything rendered INTO these hosts is lit.
 */
function makeHost(className: string): HTMLElement {
  const host = document.createElement("div");
  host.className = className;
  return host;
}

function sorterForColumn(column: GridColumn): ColumnDefinition["sorter"] {
  switch (column.kind) {
    case "number": {
      return "number";
    }
    case "boolean": {
      return "boolean";
    }
    case "array": {
      return (a: unknown, b: unknown) =>
        cellToText(a as GridCellValue).localeCompare(cellToText(b as GridCellValue));
    }
    default: {
      return "string";
    }
  }
}

/** Create the Tabulator instance for a grid tab and bind it to the controller. */
export function createGridView(host: HTMLElement, controller: GridController): GridView {
  ensureModules();
  const { buffer } = controller;
  const { columns } = controller.state;
  const columnByField = new Map(columns.map((column) => [column.field, column]));
  const localFilters = !controller.source.capabilities.remotePaging;

  let suppress = false;
  let built = false;
  let pendingRefresh = false;

  const rowKeyOf = (row: RowComponent) => String(row.getData()[ROW_KEY_FIELD] ?? "");

  const paintRow = (row: RowComponent) => {
    const rowState = buffer.rowState(rowKeyOf(row));
    const el = row.getElement();
    el.classList.toggle("jx-grid-row--pending-delete", rowState === "pending-delete");
    el.classList.toggle("jx-grid-row--pending-insert", rowState === "pending-insert");
    el.classList.toggle("jx-grid-row--stale", rowState === "stale");
  };

  const paintCell = (cell: CellComponent) => {
    const cellState = buffer.cellState(rowKeyOf(cell.getRow()), cell.getField());
    const el = cell.getElement();
    el.classList.toggle("jx-grid-cell--dirty", cellState === "dirty");
    el.classList.toggle("jx-grid-cell--error", cellState === "error");
    el.classList.toggle("jx-grid-cell--stale", cellState === "stale");
    const error = buffer.cellError(rowKeyOf(cell.getRow()), cell.getField());
    if (error) {
      el.title = error;
    } else {
      el.removeAttribute("title");
    }
  };

  const cellEditable = (column: GridColumn, rowKey: string) =>
    (column.editable || (column.insertOnly === true && buffer.isInsertKey(rowKey))) &&
    buffer.rowState(rowKey) !== "pending-delete";

  const columnDefs: ColumnDefinition[] = columns.map((column) => {
    const baseFormatter = formatterForColumn(column, makeHost);
    return {
      editable: (cell: CellComponent) => cellEditable(column, rowKeyOf(cell.getRow())),
      // Image/reference cells edit through an anchored popover (dblclick), not an editor session.
      editor: hasPopoverEditor(column) ? undefined : editorForColumn(column, makeHost),
      field: column.field,
      formatter: (cell, _params, onRendered) => {
        onRendered(() => paintCell(cell));
        return baseFormatter(cell);
      },
      frozen: column.pk === true ? true : undefined,
      headerFilter: localFilters && column.kind !== "boolean" ? "input" : undefined,
      headerSort: !controller.source.capabilities.remoteSort,
      sorter: sorterForColumn(column),
      title: column.title,
      width: column.widthHint,
    };
  });

  const gridId = controller.source.id;
  const layout = loadGridLayout(gridId);

  const table = new Tabulator(host, {
    clipboard: true,
    clipboardCopyConfig: { columnHeaders: false, rowHeaders: false },
    clipboardCopyRowRange: "range",
    clipboardCopyStyled: false,
    clipboardPasteAction: "range",
    clipboardPasteParser: "range",
    columnDefaults: { headerSortTristate: true, resizable: "header" },
    columns: applyGridLayout(columnDefs, layout),
    data: controller.effectiveRows(),
    editTriggerEvent: "dblclick",
    headerSortClickElement: "icon",
    height: "100%",
    history: false,
    index: ROW_KEY_FIELD,
    layout: "fitDataFill",
    movableColumns: true,
    placeholder: "No rows",
    reactiveData: false,
    renderHorizontal: "virtual",
    renderVertical: "virtual",
    rowFormatter: paintRow,
    selectableRange: 1,
    selectableRangeClearCells: true,
    selectableRangeClearCellsValue: null,
    selectableRangeColumns: true,
    selectableRangeRows: true,
  });

  const refreshData = () => {
    if (!built) {
      pendingRefresh = true;
      return;
    }
    suppress = true;
    void table
      .replaceData(controller.effectiveRows())
      .catch(() => {})
      .finally(() => {
        suppress = false;
      });
  };

  controller.bindView({ refreshData });

  table.on("tableBuilt", () => {
    built = true;
    if (pendingRefresh) {
      pendingRefresh = false;
      refreshData();
    }
  });

  table.on("cellEdited", (cell: CellComponent) => {
    if (suppress) {
      return;
    }
    const field = cell.getField();
    const column = columnByField.get(field);
    if (!column) {
      return;
    }
    const rowKey = rowKeyOf(cell.getRow());
    const value = coerceCellInput(cell.getValue(), column);
    buffer.setCell(rowKey, field, value);
    // Normalize what the table shows to the typed value (e.g. pasted "42" in a number column).
    if (!cellValuesEqual(value, cell.getValue() as GridCellValue)) {
      suppress = true;
      try {
        cell.setValue(value, true);
      } finally {
        suppress = false;
      }
    }
    paintCell(cell);
    paintRow(cell.getRow());
  });

  table.on("columnResized", (column: ColumnComponent) => {
    saveGridLayout(gridId, { widths: { [column.getField()]: column.getWidth() } });
  });

  table.on("columnMoved", (_column: ColumnComponent, ordered: ColumnComponent[]) => {
    saveGridLayout(gridId, { order: ordered.map((c) => c.getField()) });
  });

  table.on("cellDblClick", (_event: unknown, cell: CellComponent) => {
    const column = columnByField.get(cell.getField());
    const rowKey = rowKeyOf(cell.getRow());
    if (!column || !hasPopoverEditor(column) || !cellEditable(column, rowKey)) {
      return;
    }
    const rect = rectOf(cell.getElement());
    void openCellValuePopover({
      anchor: { bottom: rect.bottom, left: rect.left },
      column,
      commit: (value) => {
        buffer.setCell(rowKey, column.field, value);
        suppress = true;
        try {
          cell.setValue(value, true);
        } finally {
          suppress = false;
        }
        paintCell(cell);
        paintRow(cell.getRow());
      },
      value: buffer.effectiveValue(rowKey, column.field),
    });
  });

  // Group edit bursts (paste, range clear) into single undo entries. The burst's cellEdited
  // Events run synchronously inside the triggering event, so a microtask reliably closes it.
  let groupOpen = false;
  const openBurstGroup = () => {
    if (groupOpen) {
      return;
    }
    groupOpen = true;
    buffer.beginGroup();
    queueMicrotask(() => {
      groupOpen = false;
      buffer.endGroup();
    });
  };
  host.addEventListener("paste", openBurstGroup, true);
  host.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        openBurstGroup();
      }
    },
    true,
  );

  return {
    destroy() {
      controller.bindView(null);
      table.destroy();
    },

    fillDown() {
      const [range] = table.getRanges();
      if (!range) {
        return;
      }
      const cellRows = range.getCells();
      if (cellRows.length < 2) {
        return;
      }
      const [sourceRow] = cellRows;
      if (!sourceRow) {
        return;
      }
      buffer.group(() => {
        for (const cellRow of cellRows.slice(1)) {
          for (const [i, cell] of cellRow.entries()) {
            const from = sourceRow[i];
            if (from) {
              cell.setValue(from.getValue(), true);
            }
          }
        }
      });
    },

    getSelectedRowKeys() {
      const keys = new Set<string>();
      for (const range of table.getRanges()) {
        for (const row of range.getRows()) {
          keys.add(rowKeyOf(row));
        }
      }
      return [...keys];
    },

    refreshData,

    setSearch(term: string) {
      const query = term.trim().toLowerCase();
      if (query === "") {
        table.clearFilter(false);
        return;
      }
      const fields = columns.map((column) => column.field);
      table.setFilter((data: Record<string, unknown>) =>
        fields.some((field) =>
          cellToText(data[field] as GridCellValue)
            .toLowerCase()
            .includes(query),
        ),
      );
    },
  };
}
