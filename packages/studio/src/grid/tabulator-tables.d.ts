/**
 * Minimal ambient types for tabulator-tables 6.x — the package ships no declarations. Only the
 * surface grid-view.ts touches is typed; extend here as usage grows.
 */
declare module "tabulator-tables" {
  export interface CellComponent {
    getValue: () => unknown;
    getField: () => string;
    getElement: () => HTMLElement;
    getRow: () => RowComponent;
    setValue: (value: unknown, mutate?: boolean) => void;
  }

  export interface RowComponent {
    getData: () => Record<string, unknown>;
    getElement: () => HTMLElement;
    getCells: () => CellComponent[];
    reformat: () => void;
  }

  export interface RangeComponent {
    getRows: () => RowComponent[];
    getCells: () => CellComponent[][];
  }

  export type CellEditor = (
    cell: CellComponent,
    onRendered: (fn: () => void) => void,
    success: (value: unknown) => void,
    cancel: () => void,
  ) => HTMLElement | false;

  export type CellFormatter = (
    cell: CellComponent,
    formatterParams: Record<string, unknown>,
    onRendered: (fn: () => void) => void,
  ) => HTMLElement | string;

  export interface ColumnDefinition {
    title: string;
    field?: string | undefined;
    width?: number | undefined;
    frozen?: boolean | undefined;
    editor?: CellEditor | undefined;
    editable?: boolean | ((cell: CellComponent) => boolean) | undefined;
    formatter?: CellFormatter | undefined;
    sorter?: string | ((a: unknown, b: unknown) => number) | undefined;
    headerSort?: boolean | undefined;
    headerFilter?: string | undefined;
    cssClass?: string | undefined;
    resizable?: boolean | string | undefined;
    headerSortTristate?: boolean | undefined;
  }

  export interface Options {
    data?: Record<string, unknown>[];
    columns?: ColumnDefinition[];
    index?: string;
    layout?: string;
    height?: string | number;
    renderVertical?: string;
    renderHorizontal?: string;
    history?: boolean;
    reactiveData?: boolean;
    editTriggerEvent?: string;
    headerSortClickElement?: string;
    selectableRange?: number | boolean;
    selectableRangeColumns?: boolean;
    selectableRangeRows?: boolean;
    selectableRangeClearCells?: boolean;
    selectableRangeClearCellsValue?: unknown;
    clipboard?: boolean;
    clipboardCopyStyled?: boolean;
    clipboardCopyConfig?: Record<string, unknown>;
    clipboardCopyRowRange?: string;
    clipboardPasteParser?: string;
    clipboardPasteAction?: string;
    movableColumns?: boolean;
    columnDefaults?: Partial<ColumnDefinition>;
    rowFormatter?: (row: RowComponent) => void;
    placeholder?: string;
  }

  export class Tabulator {
    constructor(host: HTMLElement, options: Options);
    static registerModule(modules: unknown[]): void;
    on(event: string, callback: (...args: never[]) => void): void;
    replaceData(data: Record<string, unknown>[]): Promise<void>;
    getRows(activeOnly?: string): RowComponent[];
    getRanges(): RangeComponent[];
    setFilter(filter: (data: Record<string, unknown>) => boolean): void;
    clearFilter(includeHeaderFilters?: boolean): void;
    redraw(force?: boolean): void;
    destroy(): void;
  }

  export const EditModule: unknown;
  export const FormatModule: unknown;
  export const SortModule: unknown;
  export const FilterModule: unknown;
  export const ResizeColumnsModule: unknown;
  export const MoveColumnsModule: unknown;
  export const FrozenColumnsModule: unknown;
  export const SelectRangeModule: unknown;
  export const ClipboardModule: unknown;
  export const ExportModule: unknown;
  export const KeybindingsModule: unknown;
  export const InteractionModule: unknown;
  export const TooltipModule: unknown;
}

declare module "tabulator-tables/dist/css/tabulator.min.css" {
  const css: unknown;
  export default css;
}
