/**
 * Shared fake for `tabulator-tables` — grid tests never instantiate the real engine (it measures
 * layout, which happy-dom cannot do; same policy as monaco). Test files install it with:
 *
 * Void mock.module("tabulator-tables", () => tabulatorMockModule); void
 * mock.module("tabulator-tables/dist/css/tabulator.min.css", () => ({}));
 *
 * The fake records constructor options, exposes emit() to drive events, and implements the small
 * component surface (cells/rows/ranges) grid-view touches.
 */

type Handler = (...args: unknown[]) => void;

export interface FakeRow {
  data: Record<string, unknown>;
  element: HTMLElement;
  cells: FakeCell[];
  getData: () => Record<string, unknown>;
  getElement: () => HTMLElement;
  getCells: () => FakeCell[];
  reformat: () => void;
}

export interface FakeCell {
  row: FakeRow;
  field: string;
  element: HTMLElement;
  getValue: () => unknown;
  getField: () => string;
  getElement: () => HTMLElement;
  getRow: () => FakeRow;
  setValue: (value: unknown, mutate?: boolean) => void;
}

export interface FakeRange {
  getCells: () => FakeCell[][];
  getRows: () => FakeRow[];
}

export function fakeRow(data: Record<string, unknown>): FakeRow {
  const row: FakeRow = {
    cells: [],
    data,
    element: document.createElement("div"),
    getCells: () => row.cells,
    getData: () => row.data,
    getElement: () => row.element,
    reformat: () => {},
  };
  return row;
}

export function fakeCell(
  row: FakeRow,
  field: string,
  table: FakeTabulator | null = null,
): FakeCell {
  const cell: FakeCell = {
    element: document.createElement("div"),
    field,
    getElement: () => cell.element,
    getField: () => cell.field,
    getRow: () => cell.row,
    getValue: () => cell.row.data[cell.field],
    row,
    setValue: (value: unknown, _mutate?: boolean) => {
      cell.row.data[cell.field] = value;
      // Real Tabulator fires cellEdited for programmatic setValue too.
      table?.emit("cellEdited", cell);
    },
  };
  row.cells.push(cell);
  return cell;
}

export function fakeRange(cells: FakeCell[][]): FakeRange {
  return {
    getCells: () => cells,
    getRows: () => {
      const rows: FakeRow[] = [];
      for (const cellRow of cells) {
        const row = cellRow[0]?.getRow();
        if (row && !rows.includes(row)) {
          rows.push(row);
        }
      }
      return rows;
    },
  };
}

export class FakeTabulator {
  static instances: FakeTabulator[] = [];
  static registeredModules: unknown[] = [];

  host: HTMLElement;
  options: Record<string, unknown>;
  handlers = new Map<string, Handler[]>();
  data: Record<string, unknown>[];
  replaceDataCalls: Record<string, unknown>[][] = [];
  ranges: FakeRange[] = [];
  filter: ((data: Record<string, unknown>) => boolean) | null = null;
  clearFilterCalls = 0;
  destroyed = false;

  constructor(host: HTMLElement, options: Record<string, unknown>) {
    this.host = host;
    this.options = options;
    this.data = (options.data as Record<string, unknown>[]) ?? [];
    FakeTabulator.instances.push(this);
  }

  static registerModule(modules: unknown[]) {
    FakeTabulator.registeredModules.push(...modules);
  }

  static reset() {
    FakeTabulator.instances = [];
  }

  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  replaceData(data: Record<string, unknown>[]) {
    this.data = data;
    this.replaceDataCalls.push(data);
    return Promise.resolve();
  }

  getRows() {
    return this.data.map((row) => fakeRow(row));
  }

  getRanges() {
    return this.ranges;
  }

  setFilter(filter: (data: Record<string, unknown>) => boolean) {
    this.filter = filter;
  }

  clearFilter(_includeHeader?: boolean) {
    this.filter = null;
    this.clearFilterCalls += 1;
  }

  destroy() {
    this.destroyed = true;
  }
}

/** Module shape handed to mock.module for the tabulator-tables specifier. */
export const tabulatorMockModule = {
  ClipboardModule: {},
  EditModule: {},
  ExportModule: {},
  FilterModule: {},
  FormatModule: {},
  FrozenColumnsModule: {},
  InteractionModule: {},
  KeybindingsModule: {},
  MoveColumnsModule: {},
  ResizeColumnsModule: {},
  SelectRangeModule: {},
  SortModule: {},
  Tabulator: FakeTabulator,
  TooltipModule: {},
};
