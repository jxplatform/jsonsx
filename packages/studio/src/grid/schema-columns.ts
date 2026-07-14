/**
 * Schema → grid-column mapping and cell value coercion.
 *
 * Pure functions shared by every grid source: derive `GridColumn[]` from a content-type JSON Schema
 * (same field-type semantics as settings/schema-field-ui `detectFieldType`), infer columns by
 * sniffing rows when no schema exists (pages, schemaless CSV), and convert between typed cell
 * values and the strings that editors, clipboards, and CSV files traffic in. Coercion mirrors the
 * parser extension's `coerceCSVRows` (currency-stripped numbers, `"true"` booleans, comma-split
 * arrays) so grid edits round-trip identically to the runtime content loader.
 */
import type { GridCellValue, GridColumn, GridColumnKind } from "./grid-source";
import type { JsonSchema } from "../ui/schema-form";

/** JSON-Schema property as it appears in content-type schemas (superset of ui JsonSchema). */
interface PropSchema extends JsonSchema {
  $ref?: string;
  maxLength?: number;
}

const KIND_WIDTHS: Record<GridColumnKind, number> = {
  array: 220,
  boolean: 70,
  date: 130,
  enum: 140,
  image: 180,
  number: 110,
  readonly: 200,
  reference: 200,
  string: 180,
  text: 340,
};

/** Longest-string width clamp used for sampled string/enum columns. */
function clampWidth(maxLen: number): number {
  return Math.min(340, Math.max(90, Math.round(maxLen * 7.5)));
}

/** Field kind for one schema property — same dispatch as schema-field-ui's detectFieldType. */
export function kindForProp(prop: PropSchema): GridColumnKind {
  if (prop.$ref) {
    return "reference";
  }
  if (prop.enum !== undefined && Array.isArray(prop.enum)) {
    return "enum";
  }
  const format = prop.type === "array" ? undefined : prop.format;
  if (format === "image") {
    return "image";
  }
  if (format === "date" || format === "date-time") {
    return "date";
  }
  switch (prop.type) {
    case "number":
    case "integer": {
      return "number";
    }
    case "boolean": {
      return "boolean";
    }
    case "array": {
      return "array";
    }
    case "object": {
      // Nested objects have no inline editor — surfaced read-only for now.
      return "readonly";
    }
    default: {
      return (prop.maxLength ?? 0) > 200 || prop.format === "markdown" ? "text" : "string";
    }
  }
}

/** Human column title from a camelCase/snake_case field name. */
export function titleForField(field: string): string {
  const spaced = field
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface ColumnsFromSchemaOptions {
  /** Field to pin as the identity column (frozen first, still editable unless readonly). */
  idField?: string | undefined;
  /** Extra fields to force read-only. */
  readonlyFields?: string[] | undefined;
}

/**
 * Map a content-type/JSON schema's properties to grid columns. Order: identity field first, then
 * required properties in declaration order, then the rest in declaration order.
 */
export function columnsFromSchema(
  schema: { properties?: Record<string, unknown>; required?: string[] } | null | undefined,
  opts: ColumnsFromSchemaOptions = {},
): GridColumn[] {
  const props = Object.entries(schema?.properties ?? {}) as [string, PropSchema][];
  const required = new Set(schema?.required);
  const readonly = new Set(opts.readonlyFields);

  const columns = props.map(([field, prop]): GridColumn => {
    const kind = readonly.has(field) ? "readonly" : kindForProp(prop);
    const enumLen = Array.isArray(prop.enum)
      ? Math.max(...(prop.enum as unknown[]).map((v) => String(v).length), 4)
      : 0;
    return {
      editable: kind !== "readonly",
      field,
      kind,
      pk: field === opts.idField,
      required: required.has(field),
      schema: prop,
      title: titleForField(field),
      widthHint: kind === "enum" ? clampWidth(enumLen + 3) : KIND_WIDTHS[kind],
    };
  });

  columns.sort((a, b) => {
    const rank = (c: GridColumn) => (c.pk ? 0 : c.required ? 1 : 2);
    const diff = rank(a) - rank(b);
    return diff === 0 ? 0 : diff;
  });
  return columns;
}

/**
 * Infer columns by sniffing row values (pages and schemaless CSV). Keys appear in first-seen order;
 * a column's kind is the narrowest type every non-empty sample value satisfies.
 */
export function inferColumnsFromRows(
  rows: Record<string, GridCellValue>[],
  sampleLimit = 50,
): GridColumn[] {
  const sample = rows.slice(0, sampleLimit);
  const fields: string[] = [];
  for (const row of sample) {
    for (const key of Object.keys(row)) {
      if (!fields.includes(key)) {
        fields.push(key);
      }
    }
  }

  return fields.map((field): GridColumn => {
    const values = sample
      .map((row) => row[field])
      .filter((v): v is Exclude<GridCellValue, null> => v !== null && v !== undefined && v !== "");
    const kind = inferKind(values);
    const maxLen = Math.max(...values.map((v) => cellToText(v).length), field.length, 4);
    return {
      editable: true,
      field,
      kind,
      title: titleForField(field),
      widthHint: kind === "string" || kind === "text" ? clampWidth(maxLen) : KIND_WIDTHS[kind],
    };
  });
}

function inferKind(values: Exclude<GridCellValue, null>[]): GridColumnKind {
  if (values.length === 0) {
    return "string";
  }
  if (values.some((v) => Array.isArray(v))) {
    return "array";
  }
  const texts = values.map(String);
  if (
    values.every((v) => typeof v === "boolean") ||
    texts.every((t) => /^(true|false)$/i.test(t))
  ) {
    return "boolean";
  }
  if (
    values.every((v) => typeof v === "number") ||
    texts.every((t) => t.trim() !== "" && !Number.isNaN(Number(t.replaceAll(/[$€£¥,\s]/g, ""))))
  ) {
    return "number";
  }
  if (texts.every((t) => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(t))) {
    return "date";
  }
  if (texts.some((t) => t.length > 200)) {
    return "text";
  }
  return "string";
}

// ─── Value coercion ───────────────────────────────────────────────────────────

/**
 * Coerce editor/clipboard input to the column's typed value. Empty input clears to null. Number and
 * array semantics mirror the parser extension's coerceCSVRows.
 */
export function coerceCellInput(raw: unknown, col: GridColumn): GridCellValue {
  if (raw === null || raw === undefined) {
    return null;
  }
  switch (col.kind) {
    case "number": {
      if (typeof raw === "number") {
        return Number.isNaN(raw) ? null : raw;
      }
      const cleaned = String(raw)
        .trim()
        .replaceAll(/[$€£¥,\s]/g, "");
      if (cleaned === "") {
        return null;
      }
      const n = Number(cleaned);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean": {
      if (typeof raw === "boolean") {
        return raw;
      }
      return String(raw).trim().toLowerCase() === "true";
    }
    case "array": {
      if (Array.isArray(raw)) {
        return raw.map(String);
      }
      const text = String(raw).trim();
      return text === ""
        ? []
        : text
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    case "reference": {
      // Relationship VALUES are plain target-entry ids ("jane-doe") — the $ref lives on the
      // Schema property, not in the data (specs/relationships.md; parser resolveContentTypeRefs).
      if (typeof raw === "object" && raw !== null && "$ref" in raw) {
        const ref = (raw as { $ref: unknown }).$ref;
        return typeof ref === "string" && ref !== "" ? ref : null;
      }
      const text = String(raw).trim();
      return text === "" ? null : text;
    }
    default: {
      const text = String(raw);
      return text === "" ? null : text;
    }
  }
}

/** Plain-text projection of a cell value — display, clipboard, and CSV share it. */
export function cellToText(value: GridCellValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "object") {
    return value.$ref;
  }
  return String(value);
}
