/**
 * Csv — CSV content format for Jx
 *
 * RFC 4180-style CSV parsing with schema-driven type coercion, packaged as a Jx
 * format-extension class. `parse` is pure and browser-safe; `discover`, `load`, and
 * instance `resolve` touch the filesystem (or fetch remote URLs) and dynamically
 * import node modules so the module itself stays importable in the browser.
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
