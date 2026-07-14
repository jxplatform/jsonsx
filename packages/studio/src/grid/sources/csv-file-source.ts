/**
 * CSV file grid source — one `.csv` project file edited as a grid.
 *
 * The file loads once into a positional string matrix (csv-codec). Columns are typed by the
 * matching content-type schema when the CSV backs a collection (same resolver as the head panel),
 * otherwise inferred by sampling values. Commit is atomic whole-file: pending edits are applied to
 * the matrix, the document is re-serialized, and a save-time staleness check (file text vs. the
 * load-time text) aborts the entire commit rather than clobber an external change. Only edited
 * cells are canonicalized — untouched cells keep their raw file text.
 */
import { getPlatform } from "../../platform";
import { projectState } from "../../store";
import { findContentTypeSchema } from "../../utils/studio-utils";
import { isRecentLocal, markLocalMutation } from "../../files/fs-events";
import { parseCsv, serializeCsv } from "../csv-codec";
import {
  cellToText,
  coerceCellInput,
  columnsFromSchema,
  inferColumnsFromRows,
} from "../schema-columns";
import type { CsvDocument } from "../csv-codec";
import type {
  CommitResult,
  GridCellValue,
  GridColumn,
  GridEditBatch,
  GridRow,
  GridRowsResult,
  GridSource,
} from "../grid-source";

/** Candidate identity columns, in the parser extension's fallback order. */
const ID_FIELDS = ["id", "sku", "slug", "Slug"];

interface CsvModel {
  doc: CsvDocument;
  /** Unique field name per column position (duplicate/empty headers get positional names). */
  fields: string[];
  columns: GridColumn[];
  /** Map of rowKey → matrix row index. */
  keyToIndex: Map<string, number>;
  /** Matrix row index → rowKey. */
  keys: string[];
  /** File text at load time — the whole-file staleness fingerprint. */
  loadText: string;
}

/** Unique grid field names for CSV headers (duplicates/empties fall back to positional names). */
export function fieldNamesForHeaders(headers: string[]): string[] {
  const used = new Set<string>();
  return headers.map((header, i) => {
    let name = header.trim() === "" ? `column${i + 1}` : header;
    if (used.has(name)) {
      name = `${name}__${i + 1}`;
    }
    used.add(name);
    return name;
  });
}

/** Pick the identity column: first id-chain field whose values are all unique and non-empty. */
function pickIdField(fields: string[], doc: CsvDocument): string | null {
  for (const candidate of ID_FIELDS) {
    const idx = fields.indexOf(candidate);
    if (idx === -1) {
      continue;
    }
    const values = doc.rows.map((row) => row[idx] ?? "");
    if (values.every((v) => v !== "") && new Set(values).size === values.length) {
      return candidate;
    }
  }
  return null;
}

function buildModel(text: string, path: string): CsvModel {
  const doc = parseCsv(text);
  const fields = fieldNamesForHeaders(doc.headers);
  const idField = pickIdField(fields, doc);
  const idIndex = idField ? fields.indexOf(idField) : -1;
  const keys = doc.rows.map((row, i) => (idIndex === -1 ? String(i) : row[idIndex]!));
  const keyToIndex = new Map(keys.map((key, i) => [key, i]));

  // Typed columns when this CSV is a collection source; sniffed kinds otherwise.
  const contentType = findContentTypeSchema(path, projectState?.projectConfig);
  const schemaProps = contentType?.schema?.properties ?? {};
  const sampleRows = doc.rows.slice(0, 50).map((row) => {
    const cells: Record<string, GridCellValue> = {};
    for (const [i, field] of fields.entries()) {
      cells[field] = row[i] ?? "";
    }
    return cells;
  });
  const inferred = new Map(inferColumnsFromRows(sampleRows).map((c) => [c.field, c]));
  const typed = new Map(
    columnsFromSchema(contentType?.schema, { idField: idField ?? undefined }).map((c) => [
      c.field,
      c,
    ]),
  );

  const columns = fields.map((field, i): GridColumn => {
    const fromSchema = field in schemaProps ? typed.get(field) : undefined;
    const column = fromSchema ??
      inferred.get(field) ?? {
        editable: true,
        field,
        kind: "string" as const,
        title: doc.headers[i] || field,
      };
    return { ...column, pk: field === idField, title: doc.headers[i]?.trim() || column.title };
  });

  return { columns, doc, fields, keys, keyToIndex, loadText: text };
}

/** Typed cell values for one matrix row. */
function rowCells(model: CsvModel, rowIndex: number): Record<string, GridCellValue> {
  const cells: Record<string, GridCellValue> = {};
  const row = model.doc.rows[rowIndex] ?? [];
  for (const [i, field] of model.fields.entries()) {
    const column = model.columns[i]!;
    const raw = row[i] ?? "";
    cells[field] =
      column.kind === "string" || column.kind === "text" || column.kind === "readonly"
        ? raw
        : coerceCellInput(raw, column);
  }
  return cells;
}

/** Apply a batch to a copy of the matrix (cells, then inserts, then deletes). */
function applyBatch(model: CsvModel, batch: GridEditBatch): CsvDocument {
  const rows = model.doc.rows.map((row) => [...row]);
  const colFor = (field: string) => model.fields.indexOf(field);

  for (const cell of batch.cells) {
    const rowIndex = model.keyToIndex.get(cell.rowKey);
    const colIndex = colFor(cell.field);
    if (rowIndex === undefined || colIndex === -1) {
      continue;
    }
    rows[rowIndex]![colIndex] = cellToText(cell.value);
  }
  for (const insert of batch.inserts) {
    const row = model.fields.map((field) => cellToText(insert.cells[field] ?? null));
    rows.push(row);
  }
  const dropIndexes = batch.deletes
    .map((del) => model.keyToIndex.get(del.rowKey))
    .filter((i): i is number => i !== undefined)
    .toSorted((a, b) => b - a);
  for (const index of dropIndexes) {
    rows.splice(index, 1);
  }
  return { ...model.doc, rows };
}

/** All batch items resolved with one shared outcome (whole-file commits are atomic). */
function uniformResult(
  batch: GridEditBatch,
  outcome: { ok: boolean; error?: string; stale?: boolean },
): CommitResult {
  return {
    cells: batch.cells.map((c) => ({ field: c.field, rowKey: c.rowKey, ...outcome })),
    deletes: batch.deletes.map((d) => ({ rowKey: d.rowKey, ...outcome })),
    inserts: batch.inserts.map((i) => ({
      error: outcome.error,
      ok: outcome.ok,
      tempKey: i.tempKey,
    })),
  };
}

/** Create the grid source for one CSV file. The tab id is the file path. */
export function createCsvFileSource(path: string): GridSource {
  let loadPromise: Promise<CsvModel> | null = null;

  const load = (force = false): Promise<CsvModel> => {
    if (!force && loadPromise) {
      return loadPromise;
    }
    loadPromise = getPlatform()
      .readFile(path)
      .then((text) => buildModel(text, path));
    return loadPromise;
  };

  return {
    backingPaths: () => new Map([[path, "*"]]),
    capabilities: { delete: true, insert: true, remotePaging: false, remoteSort: false },

    async columns(): Promise<GridColumn[]> {
      const current = await load();
      return current.columns;
    },

    async commit(batch: GridEditBatch): Promise<CommitResult> {
      const current = await load();
      const platform = getPlatform();

      // Whole-file staleness: abort if the file changed under us (and it wasn't our own write).
      let onDisk: string | null = null;
      try {
        onDisk = await platform.readFile(path);
      } catch {
        onDisk = null; // Deleted underneath — treat as stale.
      }
      if (onDisk !== current.loadText && !isRecentLocal(path)) {
        return uniformResult(batch, {
          error: "File changed on disk — refresh to reload",
          ok: false,
          stale: true,
        });
      }

      const nextDoc = applyBatch(current, batch);
      const text = serializeCsv(nextDoc);
      markLocalMutation(path);
      await platform.writeFile(path, text);
      loadPromise = Promise.resolve(buildModel(text, path));
      return uniformResult(batch, { ok: true });
    },

    id: path,
    label: path.split("/").pop() ?? path,

    async refresh(): Promise<void> {
      await load(true);
    },

    async rows(): Promise<GridRowsResult> {
      const current = await load();
      const rows: GridRow[] = current.doc.rows.map((_, i) => ({
        cells: rowCells(current, i),
        key: current.keys[i]!,
      }));
      return { rows, total: rows.length };
    },

    async serializeForSource(batch: GridEditBatch): Promise<string> {
      const current = await load();
      return serializeCsv(applyBatch(current, batch));
    },
  };
}
