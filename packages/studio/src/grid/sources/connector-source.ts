/**
 * Connector-table grid source — SQL rows through the platform data surface.
 *
 * Columns come from backend introspection (DataColumnMeta); the primary key and the
 * created_at/updated_at system columns are read-only (matching the old modal grid's rules). Paging
 * and ordering are remote — rows(query) maps straight onto DataRowsQuery — so the grid shows a
 * pager instead of loading whole tables. Commit flushes the batch as per-row API calls: one
 * dataUpdateRow per edited row (fields merged), dataInsertRow per new row, dataDeleteRow per
 * deletion. The server is authoritative — there are no file fingerprints; conflicts surface as
 * per-row API errors.
 */
import { deleteRow, fetchRows, insertRow, updateRow } from "../../services/data-service";
import { makeGridTabId } from "../grid-source";
import type { DataColumnMeta, DataRowsQuery } from "../../types";
import type {
  CommitResult,
  GridCellValue,
  GridColumn,
  GridColumnKind,
  GridEditBatch,
  GridQuery,
  GridRow,
  GridRowsResult,
  GridSource,
} from "../grid-source";

/** Page size when the query does not specify one (matches the old modal grid). */
export const DATA_PAGE_SIZE = 50;

/** SQL type → column kind (best-effort across sqlite/postgres type names). */
export function kindForSqlType(type: string): GridColumnKind {
  const t = type.toLowerCase();
  if (/(int|real|floa|doub|num|dec)/.test(t)) {
    return "number";
  }
  if (t.includes("bool")) {
    return "boolean";
  }
  if (/(timestamp|datetime|date)/.test(t)) {
    return "date";
  }
  return "string";
}

/** System-managed columns are display-only (same rule as the old modal grid). */
function editableColumn(column: DataColumnMeta): boolean {
  return !column.pk && column.name !== "created_at" && column.name !== "updated_at";
}

/** DB value → grid cell value (JSON-ish values surface as text). */
function toCellValue(value: unknown): GridCellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

/** Create the grid source for one connector table. */
export function createConnectorSource(connection: string | undefined, table: string): GridSource {
  let columnsMeta: DataColumnMeta[] = [];
  let pkName = "id";
  /** Map of rowKey → the pk value as the backend returned it (numeric pks stay numeric). */
  const pkValues = new Map<string, string | number>();

  const applyMeta = (columns: DataColumnMeta[]) => {
    if (columns.length > 0) {
      columnsMeta = columns;
      pkName = columns.find((c) => c.pk)?.name ?? "id";
    }
  };

  const toQuery = (query?: GridQuery): DataRowsQuery => ({
    table,
    ...(connection ? { connection } : {}),
    limit: query?.limit ?? DATA_PAGE_SIZE,
    offset: query?.offset ?? 0,
    ...(query?.orderBy ? { dir: query.dir ?? "asc", orderBy: query.orderBy } : {}),
  });

  const rowKeyOf = (row: Record<string, unknown>, index: number): string => {
    const pk = row[pkName];
    if (typeof pk === "string" || typeof pk === "number") {
      pkValues.set(String(pk), pk);
      return String(pk);
    }
    return `row-${index}`;
  };

  return {
    capabilities: { delete: true, insert: true, remotePaging: true, remoteSort: true },

    async columns(): Promise<GridColumn[]> {
      if (columnsMeta.length === 0) {
        const result = await fetchRows(toQuery({ limit: 1, offset: 0 }));
        applyMeta(result.columns);
      }
      return columnsMeta.map((meta): GridColumn => {
        const kind = editableColumn(meta) ? kindForSqlType(meta.type) : "readonly";
        return {
          editable: kind !== "readonly",
          field: meta.name,
          kind,
          pk: meta.pk === true,
          title: meta.name,
          widthHint: meta.pk ? 80 : undefined,
        };
      });
    },

    async commit(batch: GridEditBatch): Promise<CommitResult> {
      const result: CommitResult = { cells: [], deletes: [], inserts: [] };

      // Cell edits merge into one dataUpdateRow per row.
      const byRow = new Map<string, { field: string; value: GridCellValue }[]>();
      for (const cell of batch.cells) {
        const list = byRow.get(cell.rowKey) ?? [];
        list.push({ field: cell.field, value: cell.value });
        byRow.set(cell.rowKey, list);
      }
      for (const [rowKey, patches] of byRow) {
        const pk = pkValues.get(rowKey);
        const outcome = (ok: boolean, error?: string) => {
          for (const patch of patches) {
            result.cells.push({ error, field: patch.field, ok, rowKey });
          }
        };
        if (pk === undefined) {
          outcome(false, "Row has no primary key — refresh the grid");
          continue;
        }
        try {
          const set: Record<string, unknown> = {};
          for (const patch of patches) {
            set[patch.field] = patch.value;
          }
          await updateRow({ pk, set, table, ...(connection ? { connection } : {}) });
          outcome(true);
        } catch (error) {
          outcome(false, error instanceof Error ? error.message : String(error));
        }
      }

      for (const insert of batch.inserts) {
        try {
          const values: Record<string, unknown> = {};
          for (const [field, value] of Object.entries(insert.cells)) {
            if (value !== null) {
              values[field] = value;
            }
          }
          const { row } = await insertRow({ table, values, ...(connection ? { connection } : {}) });
          const pk = row[pkName];
          const newKey = typeof pk === "string" || typeof pk === "number" ? String(pk) : undefined;
          if (newKey !== undefined && (typeof pk === "string" || typeof pk === "number")) {
            pkValues.set(newKey, pk);
          }
          result.inserts.push({ newKey, ok: true, tempKey: insert.tempKey });
        } catch (error) {
          result.inserts.push({
            error: error instanceof Error ? error.message : String(error),
            ok: false,
            tempKey: insert.tempKey,
          });
        }
      }

      for (const del of batch.deletes) {
        const pk = pkValues.get(del.rowKey);
        if (pk === undefined) {
          result.deletes.push({
            error: "Row has no primary key — refresh the grid",
            ok: false,
            rowKey: del.rowKey,
          });
          continue;
        }
        try {
          await deleteRow({ pk, table, ...(connection ? { connection } : {}) });
          result.deletes.push({ ok: true, rowKey: del.rowKey });
        } catch (error) {
          result.deletes.push({
            error: error instanceof Error ? error.message : String(error),
            ok: false,
            rowKey: del.rowKey,
          });
        }
      }

      return result;
    },

    id: makeGridTabId({ connection: connection ?? "default", kind: "data", table }),
    label: table,

    async refresh(): Promise<void> {
      columnsMeta = [];
      pkValues.clear();
    },

    async rows(query?: GridQuery): Promise<GridRowsResult> {
      const result = await fetchRows(toQuery(query));
      applyMeta(result.columns);
      const rows: GridRow[] = result.rows.map((row, index) => {
        const key = rowKeyOf(row, index);
        const cells: Record<string, GridCellValue> = {};
        for (const meta of columnsMeta) {
          cells[meta.name] = toCellValue(row[meta.name]);
        }
        return { cells, key };
      });
      return { rows, total: result.total };
    },
  };
}
