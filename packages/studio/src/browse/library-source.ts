/**
 * The Library as a {@link GridSource}.
 *
 * The Library is one more source over the same contract the CSV, collection, pages and connector
 * grids already use, which is what makes Table a real grid rather than a fifth hand-written table:
 * columns come from {@link libraryColumns}, rows are the scan, and every layout — Cards, Media,
 * Calendar, Board — draws the SAME rows through a different arrangement. A layout switch never
 * re-reads the project.
 *
 * It is a **read-only** source, and says so rather than pretending. Renaming, duplicating and
 * deleting a file are real operations with real consequences (a rename rewrites references; a
 * delete needs the reference count in its confirmation), and they belong to the commands that
 * already do that work correctly. A grid cell that silently renamed a file on blur would bypass
 * both. {@link LibrarySource.commit} therefore refuses, naming the surface that can.
 */

import { getPlatform } from "../platform";
import { projectState } from "../store";
import { makeGridTabId } from "../grid/grid-source";
import { scanLibrary } from "./library-model";
import type { LibraryFile, LibraryScan, ScanFailure } from "./library-model";
import type {
  CommitResult,
  GridColumn,
  GridEditBatch,
  GridRow,
  GridRowsResult,
  GridSource,
} from "../grid/grid-source";

/** Why a cell edit is refused — printed by the grid, so the author is told where to go instead. */
export const LIBRARY_READ_ONLY =
  "The Library lists files; it does not edit them. Rename, duplicate or delete from the file's " +
  "context menu, or open the file to edit it.";

/** The Table layout's columns. `path` is the row key and is never editable. */
export function libraryColumns(): GridColumn[] {
  return [
    { editable: false, field: "name", kind: "string", pk: true, title: "Name", widthHint: 260 },
    { editable: false, field: "category", kind: "string", title: "Category", widthHint: 120 },
    { editable: false, field: "locale", kind: "string", title: "Locale", widthHint: 90 },
    { editable: false, field: "type", kind: "string", title: "Type", widthHint: 120 },
    { editable: false, field: "size", kind: "number", title: "Size", widthHint: 90 },
    { editable: false, field: "modified", kind: "date", title: "Modified", widthHint: 160 },
    { editable: false, field: "path", kind: "readonly", title: "Path", widthHint: 320 },
  ];
}

/** One scanned file as a grid row. */
export function libraryRow(file: LibraryFile): GridRow {
  return {
    cells: {
      category: file.category,
      // Null, not "": the platform reported no locale directory for this file, and a grid cell
      // Distinguishes "no value" from "the empty string" everywhere else in this contract.
      locale: file.locale ?? null,
      modified: file.modified ?? null,
      name: file.name,
      path: file.path,
      size: file.size ?? null,
      type: file.type,
    },
    key: file.path,
  };
}

/**
 * A Library source, plus the two questions a grid source cannot ask but the Library must answer:
 * what the scan could not read, and the files behind the rows (the non-table layouts want the typed
 * record, not a cell bag).
 */
export interface LibrarySource extends GridSource {
  /** The scanned files, in path order. Empty before the first {@link GridSource.rows} call. */
  files: () => readonly LibraryFile[];
  /** Directories the last scan could not read. NON-EMPTY MEANS THE LISTING IS INCOMPLETE. */
  failures: () => readonly ScanFailure[];
  /** Whether a scan has completed at least once — "not loaded yet" is not "empty". */
  scanned: () => boolean;
}

/** The Library's tab id. One Library per window; category and layout are view state, not identity. */
export function libraryTabId(): string {
  return makeGridTabId({ kind: "library" });
}

/**
 * Build the Library source. The scan is lazy: nothing is read until the first `rows()`.
 *
 * @param {() => readonly string[]} [dirs] Project directories to scan, injectable for tests and for
 *   the perf measurement; defaults to the open project's own list.
 */
export function createLibrarySource(dirs?: () => readonly string[]): LibrarySource {
  let scan: LibraryScan | null = null;
  let inFlight: Promise<LibraryScan> | null = null;

  const projectDirs = dirs ?? (() => (projectState?.projectDirs ?? []) as readonly string[]);

  async function ensureScan(): Promise<LibraryScan> {
    if (scan) {
      return scan;
    }
    // Coalesce: five layouts and a command can all ask at once on the first paint, and the answer
    // Is one walk of the project, not six.
    inFlight ??= scanLibrary(projectDirs(), getPlatform()).then((result) => {
      scan = result;
      inFlight = null;
      return result;
    });
    return inFlight;
  }

  return {
    capabilities: { delete: false, insert: false, remotePaging: false, remoteSort: false },
    columns: () => Promise.resolve(libraryColumns()),
    commit(batch: GridEditBatch): Promise<CommitResult> {
      return Promise.resolve({
        cells: batch.cells.map((cell) => ({
          error: LIBRARY_READ_ONLY,
          field: cell.field,
          ok: false,
          rowKey: cell.rowKey,
        })),
        deletes: batch.deletes.map((row) => ({
          error: LIBRARY_READ_ONLY,
          ok: false,
          rowKey: row.rowKey,
        })),
        inserts: batch.inserts.map((row) => ({
          error: LIBRARY_READ_ONLY,
          ok: false,
          tempKey: row.tempKey,
        })),
      });
    },
    failures: () => scan?.failures ?? [],
    files: () => scan?.files ?? [],
    id: libraryTabId(),
    label: "Library",
    async refresh() {
      scan = null;
      inFlight = null;
      await ensureScan();
    },
    async rows(): Promise<GridRowsResult> {
      const result = await ensureScan();
      return { rows: result.files.map((file) => libraryRow(file)), total: result.files.length };
    },
    scanned: () => scan !== null,
  };
}
