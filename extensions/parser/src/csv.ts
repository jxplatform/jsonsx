/**
 * Csv — CSV content format for Jx
 *
 * RFC 4180-style CSV parsing with schema-driven type coercion, packaged as a Jx
 * format-extension class. `parse` and `rewrite` are pure and browser-safe; `discover`, `load`, and
 * instance `resolve` touch the filesystem (or fetch remote URLs) and dynamically
 * import node modules so the module itself stays importable in the browser.
 *
 * There is no `serialize`, and there will not be one: a collection is a data source entries are
 * loaded FROM, and re-emitting one would mean choosing a quoting style, a line ending and a column
 * order the author already chose. `rewrite` is the narrower promise that covers the case that
 * actually needed it — a rename repairing a reference a row names (specs/extensions.md §8).
 *
 * @module @jxsuite/parser/csv
 * @license MIT
 */

import type { ContentTypeSchema } from "@jxsuite/schema/types";
import type { ContentLoaderEntry } from "./types.ts";

// ─── CSV parser (minimal, spec-compliant) ────────────────────────────────────

/**
 * Parse a CSV string into an array of objects using the first row as headers. Handles quoted fields
 * with commas and newlines.
 */
export function parseCSV(csv: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let current = "";
  let inQuotes = false;
  const lines: string[] = [];

  // Split into rows respecting quoted newlines (preserve raw characters)
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      current += ch;
      if (inQuotes && csv[i + 1] === '"') {
        current += csv[i + 1];
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === "\n" || (ch === "\r" && csv[i + 1] === "\n")) && !inQuotes) {
      lines.push(current);
      current = "";
      if (ch === "\r") {
        i += 1;
      }
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    lines.push(current);
  }

  if (lines.length === 0) {
    return [];
  }

  const parseRow = (line: string) => {
    const fields: string[] = [];
    let field = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          q = !q;
        }
      } else if (ch === "," && !q) {
        fields.push(field);
        field = "";
      } else {
        field += ch;
      }
    }
    fields.push(field);
    return fields;
  };

  const headers = parseRow(lines[0]!);
  for (let i = 1; i < lines.length; i++) {
    const fields = parseRow(lines[i]!);
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]!.trim()] = fields[j]?.trim() ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

// ─── Cell-level rewriting ────────────────────────────────────────────────────

/** One authored value to replace, wherever a data cell holds exactly it. */
export interface CsvEdit {
  /** The cell value as `parse` produced it — unquoted and trimmed. */
  from: string;
  /** What to write in its place. */
  to: string;
}

/** One field of a CSV source: where its bytes are, and what {@link parseCSV} made of it. */
interface CsvField {
  /** Row index in the source. Row 0 is the header. */
  row: number;
  /** Offsets of the field's raw text within the source, delimiting commas excluded. */
  start: number;
  end: number;
  /** The value {@link parseCSV} produces for it — unquoted and trimmed. */
  value: string;
}

/**
 * Row spans, splitting on newlines that are not inside quotes.
 *
 * A deliberate mirror of {@link parseCSV}'s first pass, offsets instead of text: the two must agree
 * on where a row ends or a rewrite would splice into the wrong cell. The accumulated text there is
 * exactly `source.slice(start, end)` here, because the only characters that pass are contiguous.
 */
function scanRows(csv: string): { start: number; end: number }[] {
  const rows: { start: number; end: number }[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === "\n" || (ch === "\r" && csv[i + 1] === "\n")) && !inQuotes) {
      rows.push({ end: i, start });
      if (ch === "\r") {
        i += 1;
      }
      start = i + 1;
    }
  }
  // The same test {@link parseCSV} applies to its final accumulated row, which is exactly this
  // Slice: a trailing newline leaves whitespace behind, and that is not a row.
  if (csv.slice(start).trim()) {
    rows.push({ end: csv.length, start });
  }
  return rows;
}

/** Field spans within one row, mirroring {@link parseCSV}'s second pass. */
function scanRowFields(csv: string, row: number, span: { start: number; end: number }): CsvField[] {
  const line = csv.slice(span.start, span.end);
  const fields: CsvField[] = [];
  let fieldStart = 0;
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push({
        end: span.start + i,
        row,
        start: span.start + fieldStart,
        value: value.trim(),
      });
      value = "";
      fieldStart = i + 1;
    } else {
      value += ch;
    }
  }
  fields.push({ end: span.end, row, start: span.start + fieldStart, value: value.trim() });
  return fields;
}

/** Every field of a CSV source in document order, with the offsets a splice needs. */
function scanFields(csv: string): CsvField[] {
  return scanRows(csv).flatMap((span, row) => scanRowFields(csv, row, span));
}

/**
 * Write `value` into the space a field's raw text occupied, keeping that field's own conventions.
 *
 * Padding survives because it is the author's, and quoting survives for the same reason — a column
 * written `"a","b"` stays quoted even when the new value would not need it. A value that WOULD be
 * misread unquoted (a comma, a quote, a newline, or padding of its own) is quoted regardless, which
 * is the only case where the output style is not simply the input's.
 */
function encodeField(raw: string, value: string): string {
  const lead = raw.slice(0, raw.length - raw.trimStart().length);
  const trail = raw.slice(raw.trimEnd().length);
  const core = raw.trim();
  const wasQuoted = core.length >= 2 && core.startsWith('"') && core.endsWith('"');
  const mustQuote = /["\r\n,]/.test(value) || value.trim() !== value;
  return lead + (wasQuoted || mustQuote ? `"${value.replaceAll('"', '""')}"` : value) + trail;
}

/**
 * Replace authored cell values in CSV source text, preserving every other byte.
 *
 * The `rewrite` capability (specs/extensions.md §8), and deliberately narrower than `serialize`. A
 * CSV collection is a data source entries are loaded FROM, not a document Jx round-trips, so it has
 * no serializer and never will — quoting style, line endings and column order are the author's and
 * the loader has no opinion about any of them. But the rename refactor does not need a document
 * back; it needs one cell's text changed. Without that, renaming a file a CSV row names updated
 * every other reference and reported this one as a remainder the author had to repair by hand
 * (issue 246).
 *
 * Matching is on the WHOLE cell value as {@link parseCSV} produced it, never on a substring:
 * `hero.jpg` must not rewrite the middle of `my-hero.jpg`. The HEADER row is never touched — it
 * names columns rather than files, `parse` does not expose it as a value, and an edit derived from
 * `parse` output therefore cannot legitimately name it.
 *
 * @param source — the CSV file's original text
 * @param edits — authored values to replace
 * @returns The source with exactly those cells rewritten
 */
export function rewriteCSV(source: string, edits: readonly CsvEdit[]): string {
  const replacements = new Map<string, string>();
  for (const edit of edits) {
    if (edit.from !== edit.to) {
      replacements.set(edit.from, edit.to);
    }
  }
  if (replacements.size === 0) {
    return source;
  }
  let out = "";
  let cursor = 0;
  for (const field of scanFields(source)) {
    if (field.row === 0) {
      continue;
    }
    const to = replacements.get(field.value);
    if (to === undefined) {
      continue;
    }
    out += source.slice(cursor, field.start);
    out += encodeField(source.slice(field.start, field.end), to);
    cursor = field.end;
  }
  return out + source.slice(cursor);
}

// ─── Type coercion ───────────────────────────────────────────────────────────

export interface CsvOptions {
  /** Content type schema — drives per-column type coercion. */
  schema?: ContentTypeSchema;
  /** Column used as entry id. Default fallback chain: id → sku → slug → Slug → row index. */
  idField?: string;
}

/**
 * Coerce raw CSV row strings to typed values per the schema. - number: strips currency
 * symbols/commas; null for empty cells - boolean: "true" → true, everything else → false - array:
 * comma-split, trimmed, empties dropped
 */
export function coerceCSVRows(
  rows: Record<string, string>[],
  schema?: ContentTypeSchema,
  idField?: string,
): ContentLoaderEntry[] {
  return rows.map((row, i) => {
    const data: Record<string, unknown> = { ...row };
    if (schema?.properties) {
      for (const [key, def] of Object.entries(schema.properties)) {
        if (!(key in data)) {
          continue;
        }
        if (def.type === "number") {
          const raw = String(data[key] ?? "").trim();
          if (raw === "") {
            data[key] = null;
          } else {
            const cleaned = raw.replaceAll(/[$€£¥,\s]/g, "");
            const n = Number(cleaned);
            data[key] = Number.isNaN(n) ? null : n;
          }
        } else if (def.type === "boolean") {
          data[key] = data[key] === "true";
        } else if (def.type === "array") {
          const raw = String(data[key] ?? "").trim();
          data[key] =
            raw === ""
              ? []
              : raw
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
        }
      }
    }
    const id =
      (idField ? (data[idField] as string | undefined) : undefined) ??
      (data.id as string | undefined) ??
      (data.sku as string | undefined) ??
      (data.slug as string | undefined) ??
      (data.Slug as string | undefined) ??
      String(i);
    return { body: null, data, id };
  });
}

// ─── Csv format class ────────────────────────────────────────────────────────

/**
 * CSV format-extension class. Satisfies the Jx external class contract ($prototype + instance
 * resolve) and the format capability contract (static parse / discover / load).
 *
 * @example
 *   { "$prototype": "Csv", "$src": "@jxsuite/parser/Csv.class.json", "src": "./products.csv" }
 */
export class Csv {
  config: { src: string; basePath?: string } & CsvOptions;

  constructor(config: { src: string; basePath?: string } & CsvOptions) {
    this.config = config;
  }

  /** Parse CSV source text into content entries (pure, browser-safe). */
  static parse(source: string, options: CsvOptions = {}): ContentLoaderEntry[] {
    return coerceCSVRows(parseCSV(source), options.schema, options.idField);
  }

  /**
   * Replace authored cell values, preserving every other byte (pure, browser-safe).
   *
   * The `rewrite` capability. Csv declares it and deliberately declares no `serialize`: rows are
   * loaded, not round-tripped, so there is no document to write back — but one cell's text can be
   * changed without inventing an opinion about quoting, line endings or column order. See
   * {@link rewriteCSV}.
   */
  static rewrite(source: string, edits: readonly CsvEdit[] = []): string {
    return rewriteCSV(source, edits);
  }

  /** List .csv entry files for a content-type source (file path or directory). */
  static async discover(source: string, options: { baseDir?: string } = {}): Promise<string[]> {
    const { existsSync, readdirSync } = await import("node:fs");
    const { resolve, extname } = await import("node:path");
    const resolved = options.baseDir ? resolve(options.baseDir, source) : resolve(source);

    if (extname(resolved)) {
      return existsSync(resolved) ? [resolved] : [];
    }
    try {
      return readdirSync(resolved, { recursive: true })
        .filter((f) => String(f).endsWith(".csv"))
        .map((f) => resolve(resolved, String(f)));
    } catch {
      return [];
    }
  }

  /** Load one CSV source (file path or http(s) URL) into content entries. */
  static async load(path: string, options: CsvOptions = {}): Promise<ContentLoaderEntry[]> {
    if (path.startsWith("http://") || path.startsWith("https://")) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch CSV from ${path}: ${response.status} ${response.statusText}`,
        );
      }
      return Csv.parse(await response.text(), options);
    }
    const { readFileSync } = await import("node:fs");
    return Csv.parse(readFileSync(path, "utf8"), options);
  }

  /** Runtime on-demand access: load the configured source. */
  async resolve(): Promise<ContentLoaderEntry[]> {
    const { src, basePath, ...options } = this.config;
    if (src.startsWith("http://") || src.startsWith("https://")) {
      return Csv.load(src, options);
    }
    const { resolve } = await import("node:path");
    const filePath = basePath ? resolve(basePath, src) : resolve(src);
    return Csv.load(filePath, options);
  }
}
