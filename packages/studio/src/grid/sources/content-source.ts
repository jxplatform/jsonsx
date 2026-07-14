/**
 * Content-collection grid source — one row per entry file, columns from the collection schema.
 *
 * Rows load by enumerating the collection's source directory and parsing each entry through the
 * format registry (same path the editor tabs use); cells are the entry frontmatter. Commit is
 * per-row: each affected file is guarded (stale-on-disk check against the load-time text, and a
 * skip when the file is open in a dirty tab), then its frontmatter is patched and re-serialized
 * through the format's roundtrip capability — the same lossy-YAML semantics as saving a single tab.
 * Inserts write `<dir>/<slug><ext>` from the required Path cell; deletes remove files.
 */
import { getPlatform } from "../../platform";
import { projectState } from "../../store";
import { workspace } from "../../workspace/workspace";
import { isRecentLocal, markLocalMutation } from "../../files/fs-events";
import {
  defaultContentFormat,
  formatByName,
  formatSerialize,
  loadFormats,
} from "../../format/format-host";
import { parseSourceForPath } from "../../files/file-ops";
import { columnsFromSchema, inferColumnsFromRows } from "../schema-columns";
import { makeGridTabId } from "../grid-source";
import type {
  CommitResult,
  GridCellValue,
  GridColumn,
  GridEditBatch,
  GridRow,
  GridRowsResult,
  GridSource,
} from "../grid-source";
import type { ContentSectionEntry } from "../../types";

/** The synthetic identity column: the entry's project path. Editable only on pending inserts. */
export const PATH_FIELD = "__path";

interface EntryRecord {
  frontmatter: Record<string, unknown>;
  document: Record<string, unknown>;
  rawText: string;
  formatName: string;
}

interface CollectionInfo {
  name: string;
  def: ContentSectionEntry;
  dir: string;
  ext: string;
}

/** Resolve a content type's definition, source dir, and entry extension from project config. */
export function collectionInfo(typeName: string): CollectionInfo | null {
  const content = (projectState?.projectConfig?.content ?? {}) as Record<
    string,
    ContentSectionEntry
  >;
  const def = content[typeName];
  if (!def?.source) {
    return null;
  }
  const dir = def.source.replace(/^\.\//, "").replace(/\/$/, "");
  const ext =
    def.format === "json"
      ? ".json"
      : (formatByName(def.format)?.extensions[0] ??
        defaultContentFormat()?.extensions[0] ??
        ".json");
  return { def, dir, ext, name: typeName };
}

/** Directory-backed collections in the project (for "Edit collection in Grid" affordances). */
export function collectionDirs(): { name: string; dir: string }[] {
  const content = (projectState?.projectConfig?.content ?? {}) as Record<
    string,
    ContentSectionEntry
  >;
  return Object.entries(content)
    .filter(([, def]) => {
      const source = def.source?.replace(/^\.\//, "") ?? "";
      return source !== "" && !/\.[a-z0-9]+$/i.test(source);
    })
    .map(([name, def]) => ({ dir: def.source!.replace(/^\.\//, "").replace(/\/$/, ""), name }));
}

/** Recursively list entry files under a collection dir with the collection's extension. */
async function listEntryFiles(dir: string, ext: string): Promise<string[]> {
  const platform = getPlatform();
  const results: string[] = [];
  const walk = async (current: string) => {
    let children;
    try {
      children = await platform.listDirectory(current);
    } catch {
      return; // Missing/unreadable directory — an empty collection, not an error.
    }
    for (const entry of children) {
      if (entry.type === "directory") {
        await walk(entry.path);
      } else if (entry.path.endsWith(ext)) {
        results.push(entry.path);
      }
    }
  };
  await walk(dir);
  return results.toSorted();
}

/** Entry ids (file stems) of a collection — used by relationship cell editors. */
export async function listCollectionEntryIds(typeName: string): Promise<string[]> {
  await loadFormats().catch(() => {}); // Extension resolution needs the format registry.
  const info = collectionInfo(typeName);
  if (!info) {
    return [];
  }
  const files = await listEntryFiles(info.dir, info.ext);
  return files.map((path) => {
    const base = path.split("/").pop() ?? path;
    return base.slice(0, base.length - info.ext.length);
  });
}

/** Bounded-concurrency map that preserves item order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Frontmatter value → grid cell value. Nested objects surface as read-only JSON text. */
function toCellValue(value: unknown): GridCellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((v) => typeof v !== "object" || v === null)) {
    return value.map(String);
  }
  return JSON.stringify(value);
}

/** The path a pending insert's Path cell resolves to (dir prefix + extension enforced). */
function insertPath(raw: string, info: CollectionInfo): string {
  let path = raw.trim().replace(/^\.\//, "").replace(/^\//, "");
  if (!path.includes("/")) {
    path = `${info.dir}/${path}`;
  }
  if (!path.endsWith(info.ext)) {
    path = `${path}${info.ext}`;
  }
  return path;
}

/** A tab open on this path, if any (raw Map scan — workspace tabs key by id = path). */
function openTabFor(path: string) {
  for (const tab of workspace.tabs.values()) {
    if (tab.documentPath === path) {
      return tab;
    }
  }
  return null;
}

/** Create the grid source for one content collection. */
export function createCollectionSource(typeName: string): GridSource {
  const entries = new Map<string, EntryRecord>();
  let loadPromise: Promise<void> | null = null;
  let columnsCache: GridColumn[] | null = null;

  const requireInfo = (): CollectionInfo => {
    const info = collectionInfo(typeName);
    if (!info) {
      throw new Error(`No content collection named "${typeName}" in project.json`);
    }
    return info;
  };

  const load = (force = false): Promise<void> => {
    if (!force && loadPromise) {
      return loadPromise;
    }
    loadPromise = (async () => {
      await loadFormats().catch(() => {}); // Extension resolution needs the format registry.
      const info = requireInfo();
      const platform = getPlatform();
      const files = await listEntryFiles(info.dir, info.ext);
      entries.clear();
      columnsCache = null;
      await mapLimit(files, 8, async (path) => {
        try {
          const text = await platform.readFile(path);
          const parsed = await parseSourceForPath(path, text);
          entries.set(path, {
            document: parsed.document,
            formatName: parsed.format.name,
            frontmatter: parsed.frontmatter ?? {},
            rawText: text,
          });
        } catch {
          // Unparseable entry — leave it out rather than failing the whole grid.
        }
      });
    })();
    return loadPromise;
  };

  const buildColumns = (): GridColumn[] => {
    if (columnsCache) {
      return columnsCache;
    }
    const info = requireInfo();
    const pathColumn: GridColumn = {
      editable: false,
      field: PATH_FIELD,
      insertOnly: true,
      kind: "string",
      pk: true,
      required: true,
      title: "Path",
      widthHint: 220,
    };
    const schemaColumns = columnsFromSchema(info.def.schema);
    const known = new Set([PATH_FIELD, ...schemaColumns.map((c) => c.field)]);

    // Keys present in entry data but absent from the schema still get (inferred) columns.
    const extraRows = [...entries.values()].map((entry) => {
      const cells: Record<string, GridCellValue> = {};
      for (const [key, value] of Object.entries(entry.frontmatter)) {
        if (!known.has(key) && !key.startsWith("$")) {
          cells[key] = toCellValue(value);
        }
      }
      return cells;
    });
    const extraColumns = inferColumnsFromRows(extraRows);
    for (const column of extraColumns) {
      // Values we had to stringify (nested objects) must not round-trip as strings.
      column.editable = column.kind !== "text" || extraRowsAreStrings(extraRows, column.field);
    }

    columnsCache = [pathColumn, ...schemaColumns, ...extraColumns];
    return columnsCache;
  };

  const rowFor = (path: string, entry: EntryRecord): GridRow => {
    const cells: Record<string, GridCellValue> = { [PATH_FIELD]: path };
    for (const column of buildColumns()) {
      if (column.field === PATH_FIELD) {
        continue;
      }
      cells[column.field] = toCellValue(entry.frontmatter[column.field]);
    }
    return { cells, fingerprint: entry.rawText, key: path };
  };

  /** Re-serialize one entry with patched frontmatter and write it (same path as tab saves). */
  const writeEntry = async (
    path: string,
    entry: EntryRecord,
    patches: { field: string; value: GridCellValue }[],
  ): Promise<void> => {
    const platform = getPlatform();
    const frontmatter = { ...entry.frontmatter };
    for (const patch of patches) {
      if (patch.value === null) {
        delete frontmatter[patch.field];
      } else {
        frontmatter[patch.field] = patch.value;
      }
    }
    const doc = entry.document;
    const fullDoc = { ...frontmatter, ...doc, children: doc.children ?? [] };
    const text = await formatSerialize(entry.formatName, fullDoc, { mode: "roundtrip" });
    markLocalMutation(path);
    await platform.writeFile(path, text);
    entries.set(path, { ...entry, frontmatter, rawText: text });
  };

  return {
    backingPaths: () => new Map([...entries.keys()].map((path) => [path, path])),
    capabilities: { delete: true, insert: true, remotePaging: false, remoteSort: false },

    async columns(): Promise<GridColumn[]> {
      await load();
      return buildColumns();
    },

    async commit(batch: GridEditBatch): Promise<CommitResult> {
      await load();
      const info = requireInfo();
      const platform = getPlatform();
      const result: CommitResult = { cells: [], deletes: [], inserts: [] };

      // Cell edits, grouped per file so each entry is read/checked/written once.
      const byRow = new Map<string, { field: string; value: GridCellValue }[]>();
      for (const cell of batch.cells) {
        const list = byRow.get(cell.rowKey) ?? [];
        list.push({ field: cell.field, value: cell.value });
        byRow.set(cell.rowKey, list);
      }
      for (const [path, patches] of byRow) {
        const outcome = (ok: boolean, error?: string, stale?: boolean) => {
          for (const patch of patches) {
            result.cells.push({ error, field: patch.field, ok, rowKey: path, stale });
          }
        };
        const entry = entries.get(path);
        if (!entry) {
          outcome(false, "Entry no longer loaded — refresh the grid");
          continue;
        }
        const openTab = openTabFor(path);
        if (openTab?.doc.dirty) {
          outcome(false, "Open in a tab with unsaved changes — save or close it first");
          continue;
        }
        let onDisk: string | null = null;
        try {
          onDisk = await platform.readFile(path);
        } catch {
          onDisk = null;
        }
        if (onDisk !== entry.rawText && !isRecentLocal(path)) {
          outcome(false, "File changed on disk — refresh to reload", true);
          continue;
        }
        try {
          await writeEntry(path, entry, patches);
          outcome(true);
          if (openTab) {
            // Clean open tab: reload it so the editor reflects the grid's write. Dynamic import —
            // Files.ts imports the grid modules, so a static import here would be a cycle.
            const { reloadFileInTab } = await import("../../files/files");
            void reloadFileInTab(path);
          }
        } catch (error) {
          outcome(false, error instanceof Error ? error.message : String(error));
        }
      }

      // Inserts: new entry files from the Path cell.
      for (const insert of batch.inserts) {
        const rawPath = insert.cells[PATH_FIELD];
        if (typeof rawPath !== "string" || rawPath.trim() === "") {
          result.inserts.push({ error: "Path is required", ok: false, tempKey: insert.tempKey });
          continue;
        }
        const path = insertPath(rawPath, info);
        let exists = entries.has(path);
        if (!exists) {
          try {
            await platform.readFile(path);
            exists = true;
          } catch {
            exists = false;
          }
        }
        if (exists) {
          result.inserts.push({
            error: `${path} already exists`,
            ok: false,
            tempKey: insert.tempKey,
          });
          continue;
        }
        try {
          const frontmatter: Record<string, unknown> = {};
          for (const [field, value] of Object.entries(insert.cells)) {
            if (field !== PATH_FIELD && value !== null) {
              frontmatter[field] = value;
            }
          }
          const text = await formatSerialize(
            info.def.format && formatByName(info.def.format)
              ? formatByName(info.def.format)!.name
              : (defaultContentFormat()?.name ?? "Markdown"),
            { ...frontmatter, children: [] },
            { frontmatter: Object.keys(frontmatter).length > 0, mode: "roundtrip" },
          );
          markLocalMutation(path);
          await platform.writeFile(path, text);
          const parsed = await parseSourceForPath(path, text);
          entries.set(path, {
            document: parsed.document,
            formatName: parsed.format.name,
            frontmatter: parsed.frontmatter ?? {},
            rawText: text,
          });
          result.inserts.push({ newKey: path, ok: true, tempKey: insert.tempKey });
        } catch (error) {
          result.inserts.push({
            error: error instanceof Error ? error.message : String(error),
            ok: false,
            tempKey: insert.tempKey,
          });
        }
      }

      // Deletes: remove entry files (never while a tab is open on them).
      for (const del of batch.deletes) {
        if (openTabFor(del.rowKey)) {
          result.deletes.push({
            error: "Open in a tab — close it first",
            ok: false,
            rowKey: del.rowKey,
          });
          continue;
        }
        try {
          markLocalMutation(del.rowKey);
          await platform.deleteFile(del.rowKey);
          entries.delete(del.rowKey);
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

    id: makeGridTabId({ kind: "collection", name: typeName }),
    label: typeName,

    async refresh(): Promise<void> {
      await load(true);
    },

    async rows(): Promise<GridRowsResult> {
      await load();
      const rows = [...entries.entries()].map(([path, entry]) => rowFor(path, entry));
      return { rows, total: rows.length };
    },
  };
}

/** Whether every sampled value for a field was a genuine string (vs. stringified objects). */
function extraRowsAreStrings(rows: Record<string, GridCellValue>[], field: string): boolean {
  return rows.every((row) => {
    const value = row[field];
    return value === null || value === undefined || typeof value !== "string"
      ? true
      : !value.startsWith("{") && !value.startsWith("[");
  });
}
