/**
 * Grid data-source contracts and grid-tab identity.
 *
 * A GridSource adapts one tabular backing store (a CSV file, a content collection, the pages tree,
 * a connector table) to the grid editor. Sources load columns/rows and commit a batched set of
 * pending edits; they never see the grid engine. Grid tabs over non-file sources are "virtual" —
 * their tab id is a `grid://` URI rather than a document path.
 */
import type { JsonSchema } from "../ui/schema-form";

/** A single cell value. JSON-shaped so batches serialize cleanly. */
export type GridCellValue = string | number | boolean | string[] | null | { $ref: string };

/** How a column edits/renders. Drives the cell editor/formatter mapping. */
export type GridColumnKind =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "array"
  | "image"
  | "date"
  | "reference"
  | "readonly";

export interface GridColumn {
  /** Row-object key. */
  field: string;
  title: string;
  kind: GridColumnKind;
  /** Original JSON-Schema property, when the column came from a schema. */
  schema?: JsonSchema | undefined;
  required?: boolean | undefined;
  editable: boolean;
  /** Row-identity column (frozen first, never editable). */
  pk?: boolean | undefined;
  /** Editable only on pending-insert rows (e.g. a new entry's path). */
  insertOnly?: boolean | undefined;
  /** Preferred initial width in px. */
  widthHint?: number | undefined;
}

export interface GridRow {
  /** Stable row id: file path, csv row id, or table pk value. */
  key: string;
  cells: Record<string, GridCellValue>;
  /** Staleness token (raw file text, content hash, …); absent for server-authoritative rows. */
  fingerprint?: string;
}

export interface GridQuery {
  offset?: number;
  limit?: number;
  orderBy?: string;
  dir?: "asc" | "desc";
}

export interface GridRowsResult {
  rows: GridRow[];
  total: number;
}

/** Pending edits, flattened for commit. Cells on pending-insert/delete rows are folded away. */
export interface GridEditBatch {
  cells: { rowKey: string; field: string; value: GridCellValue; baseline: GridCellValue }[];
  inserts: { tempKey: string; cells: Record<string, GridCellValue> }[];
  deletes: { rowKey: string }[];
}

export interface CommitResult {
  cells: {
    rowKey: string;
    field: string;
    ok: boolean;
    error?: string | undefined;
    stale?: boolean | undefined;
  }[];
  inserts: {
    tempKey: string;
    ok: boolean;
    newKey?: string | undefined;
    error?: string | undefined;
  }[];
  deletes: {
    rowKey: string;
    ok: boolean;
    error?: string | undefined;
    stale?: boolean | undefined;
  }[];
}

export interface GridSourceCapabilities {
  insert: boolean;
  delete: boolean;
  /** Rows are paged by the backend — the grid shows a pager instead of loading everything. */
  remotePaging: boolean;
  /** Sorting must go through rows(query) rather than the local engine. */
  remoteSort: boolean;
}

export interface GridSource {
  /** Equals the tab id of the grid tab hosting it. */
  id: string;
  label: string;
  capabilities: GridSourceCapabilities;
  columns: () => Promise<GridColumn[]>;
  rows: (query?: GridQuery) => Promise<GridRowsResult>;
  commit: (batch: GridEditBatch) => Promise<CommitResult>;
  /** Re-read the backing store; the next columns()/rows() serve fresh data. */
  refresh?: (() => Promise<void>) | undefined;
  /** Full-file text including pending edits — source-mode display for file-backed grids. */
  serializeForSource?: ((batch: GridEditBatch) => Promise<string>) | undefined;
  /** Project paths backing rows, for fs-watch staleness (path → rowKey; "*" = every row). */
  backingPaths?: (() => Map<string, string>) | undefined;
  dispose?: (() => void) | undefined;
}

// ─── Value comparison ─────────────────────────────────────────────────────────

/** Structural equality over GridCellValue (arrays element-wise, $ref by target). */
export function cellValuesEqual(a: GridCellValue, b: GridCellValue): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    return a.$ref === b.$ref;
  }
  return false;
}

// ─── Grid tab identity ────────────────────────────────────────────────────────

const GRID_SCHEME = "grid://";

export type GridTabRef =
  | { kind: "pages" }
  | { kind: "collection"; name: string }
  | { kind: "data"; connection: string; table: string };

/** Build a virtual grid-tab id (`grid://…`). Segments are URI-encoded so `/` in names survives. */
export function makeGridTabId(ref: GridTabRef): string {
  switch (ref.kind) {
    case "pages": {
      return `${GRID_SCHEME}pages`;
    }
    case "collection": {
      return `${GRID_SCHEME}collection/${encodeURIComponent(ref.name)}`;
    }
    default: {
      return `${GRID_SCHEME}data/${encodeURIComponent(ref.connection)}/${encodeURIComponent(ref.table)}`;
    }
  }
}

/** Whether a tab id is a virtual grid-tab id. */
export function isGridTabId(id: string): boolean {
  return id.startsWith(GRID_SCHEME);
}

/** Parse a `grid://` tab id back into its source reference; null when not a grid id. */
export function parseGridTabId(id: string): GridTabRef | null {
  if (!isGridTabId(id)) {
    return null;
  }
  const parts = id.slice(GRID_SCHEME.length).split("/");
  if (parts[0] === "pages" && parts.length === 1) {
    return { kind: "pages" };
  }
  if (parts[0] === "collection" && parts.length === 2 && parts[1]) {
    return { kind: "collection", name: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === "data" && parts.length === 3 && parts[1] && parts[2]) {
    return {
      connection: decodeURIComponent(parts[1]),
      kind: "data",
      table: decodeURIComponent(parts[2]),
    };
  }
  return null;
}

/** Short human label for a grid tab ("posts · grid", "users @ main · grid", "Pages · grid"). */
export function gridTabLabel(id: string): string | null {
  const ref = parseGridTabId(id);
  if (!ref) {
    return null;
  }
  switch (ref.kind) {
    case "pages": {
      return "Pages · grid";
    }
    case "collection": {
      return `${ref.name} · grid`;
    }
    default: {
      return `${ref.table} @ ${ref.connection} · grid`;
    }
  }
}
