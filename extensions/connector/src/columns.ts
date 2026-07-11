/**
 * Columns — single source of truth for field schema → SQL column mapping and value coercion.
 *
 * Table column schemas are plain Jx field schemas (the core field union) plus relationship refs
 * (specs/relationships.md). This module derives the physical column plan for a table — scalar
 * columns, reference FK columns, and junction tables for table↔table to-many refs — and the two-way
 * value coercion between JSON payloads and SQL storage.
 *
 * Storage model (v1, uniform across sqlite and postgres):
 *
 * - String → text · number → real/double precision · integer → integer
 * - Boolean → integer 0/1 on sqlite, boolean on postgres
 * - Array/object → JSON-serialized text
 * - To-one reference (`{ $ref }`) → text FK column named `<field>_id` storing the target id
 * - To-many reference to a table (`array` of `$ref` into the same data section) → junction table
 *   `${sourceTable}_${fieldName}` (relationships.md §3), no column on the source table
 * - To-many reference to any other section → JSON text column of id strings
 */

import type { TableDef } from "./types.ts";

export type SqlDialectKind = "sqlite" | "postgres";

/** Parsed relationship-ref target: `#/<sectionKey>/<entryName>`. */
export interface RefTarget {
  section: string;
  name: string;
}

/** Parse a relationship ref pointer, or null when the string is not one. */
export function parseRefPointer(pointer: unknown): RefTarget | null {
  if (typeof pointer !== "string") {
    return null;
  }
  const match = pointer.match(/^#\/([A-Za-z][\w-]*)\/([\w.-]+)$/);
  if (!match) {
    return null;
  }
  return { name: match[2]!, section: match[1]! };
}

/** How a column's values are stored and coerced. */
export type ColumnStorage = "text" | "number" | "integer" | "boolean" | "json";

/** One physical column derived from a schema field. */
export interface ColumnSpec {
  /** Schema field name (the wire-payload key). */
  field: string;
  /** Physical column name (`<field>_id` for to-one references). */
  column: string;
  /** SQL data type passed to the Kysely schema builder. */
  dataType: string;
  storage: ColumnStorage;
  /** Set for reference fields (to-one FK columns and to-many JSON id lists). */
  ref: RefTarget | null;
  /** True for to-many reference fields stored as JSON id arrays (non-table targets). */
  manyRef: boolean;
}

/** A junction table materializing a table↔table to-many reference (relationships.md §3). */
export interface JunctionSpec {
  /** Junction table name: `${sourceTable}_${fieldName}`. */
  table: string;
  /** Schema field on the source table this junction materializes. */
  field: string;
  sourceTable: string;
  targetTable: string;
  /** `${sourceTable}_id`. */
  sourceColumn: string;
  /** `${targetTable}_id`, suffixed `_2` when the reference is self-referential. */
  targetColumn: string;
  sourceIdType: string;
  targetIdType: string;
}

/** The full physical plan for one table. */
export interface TablePlan {
  table: string;
  idType: "uuid" | "integer";
  timestamps: boolean;
  columns: ColumnSpec[];
  junctions: JunctionSpec[];
  indexes: string[][];
}

/** SQL data type of a table's primary key. */
export function idDataType(idKind: "uuid" | "integer"): string {
  return idKind === "uuid" ? "text" : "integer";
}

/** Map a scalar field schema type to the SQL data type for a dialect. */
function scalarDataType(type: string | undefined, dialect: SqlDialectKind): string {
  switch (type) {
    case "number": {
      return dialect === "postgres" ? "double precision" : "real";
    }
    case "integer": {
      return "integer";
    }
    case "boolean": {
      return dialect === "postgres" ? "boolean" : "integer";
    }
    default: {
      return "text";
    }
  }
}

/** Storage class for a scalar field schema type. */
function scalarStorage(type: string | undefined): ColumnStorage {
  switch (type) {
    case "number": {
      return "number";
    }
    case "integer": {
      return "integer";
    }
    case "boolean": {
      return "boolean";
    }
    case "array":
    case "object": {
      return "json";
    }
    default: {
      return "text";
    }
  }
}

/**
 * Derive the physical plan for a table: columns, junction tables, and index column lists.
 *
 * @param {string} tableName - The data-section key naming the table
 * @param {TableDef} table - The table definition
 * @param {Record<string, TableDef>} allTables - The full data section (junction id types)
 * @param {SqlDialectKind} dialect - SQL dialect family
 * @returns {TablePlan}
 */
export function planTable(
  tableName: string,
  table: TableDef,
  allTables: Record<string, TableDef>,
  dialect: SqlDialectKind,
): TablePlan {
  const idType = table.id ?? "uuid";
  const columns: ColumnSpec[] = [];
  const junctions: JunctionSpec[] = [];

  for (const [field, schema] of Object.entries(table.schema.properties ?? {})) {
    const toOne = parseRefPointer(schema.$ref);
    if (toOne) {
      columns.push({
        column: `${field}_id`,
        dataType: "text",
        field,
        manyRef: false,
        ref: toOne,
        storage: "text",
      });
      continue;
    }

    const itemsRef = schema.type === "array" ? parseRefPointer(schema.items?.$ref) : null;
    if (itemsRef && itemsRef.section === "data" && allTables[itemsRef.name]) {
      const target = allTables[itemsRef.name]!;
      const selfRef = itemsRef.name === tableName;
      junctions.push({
        field,
        sourceColumn: `${tableName}_id`,
        sourceIdType: idDataType(idType),
        sourceTable: tableName,
        table: `${tableName}_${field}`,
        targetColumn: selfRef ? `${itemsRef.name}_id_2` : `${itemsRef.name}_id`,
        targetIdType: idDataType(target.id ?? "uuid"),
        targetTable: itemsRef.name,
      });
      continue;
    }
    if (itemsRef) {
      // To-many reference into a non-table section (e.g. content): JSON array of id strings.
      columns.push({
        column: field,
        dataType: "text",
        field,
        manyRef: true,
        ref: itemsRef,
        storage: "json",
      });
      continue;
    }

    columns.push({
      column: field,
      dataType: scalarDataType(schema.type, dialect),
      field,
      manyRef: false,
      ref: null,
      storage: scalarStorage(schema.type),
    });
  }

  // The owner column backs "owner" permission rules even when the schema does not declare it —
  // The data mount writes it via setColumns and scopes reads/writes through whereOwner.
  if (table.ownerField && !columns.some((c) => c.field === table.ownerField)) {
    columns.push({
      column: table.ownerField,
      dataType: "text",
      field: table.ownerField,
      manyRef: false,
      ref: null,
      storage: "text",
    });
  }

  const byField = new Map(columns.map((c) => [c.field, c.column]));
  const indexes: string[][] = [];
  for (const index of table.indexes ?? []) {
    const fields = Array.isArray(index) ? index : [index];
    const cols = fields.map((f) => byField.get(f) ?? f);
    indexes.push(cols);
  }

  return {
    columns,
    idType,
    indexes,
    junctions,
    table: tableName,
    timestamps: table.timestamps !== false,
  };
}

/** Generate a fresh primary key for an insert, or undefined when the database assigns one. */
export function newRowId(idKind: "uuid" | "integer"): string | undefined {
  return idKind === "uuid" ? crypto.randomUUID() : undefined;
}

/**
 * Coerce one JSON payload value to its SQL storage representation.
 *
 * @param {ColumnSpec} spec
 * @param {unknown} value - Already-validated payload value
 * @param {SqlDialectKind} dialect
 * @returns {unknown}
 */
export function toStorage(spec: ColumnSpec, value: unknown, dialect: SqlDialectKind): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (spec.storage) {
    case "boolean": {
      return dialect === "postgres" ? value === true : value === true ? 1 : 0;
    }
    case "json": {
      return JSON.stringify(value);
    }
    default: {
      return value;
    }
  }
}

/**
 * Coerce a database row back to its JSON payload shape (booleans, JSON columns).
 *
 * @param {ColumnSpec[]} specs - Column plan of the table
 * @param {Record<string, unknown>} row - Raw row from the driver
 * @returns {Record<string, unknown>}
 */
export function fromStorage(
  specs: ColumnSpec[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const spec of specs) {
    const value = out[spec.column];
    if (value === null || value === undefined) {
      continue;
    }
    if (spec.storage === "boolean" && typeof value !== "boolean") {
      out[spec.column] = value === 1 || value === "1" || value === true;
    } else if (spec.storage === "json" && typeof value === "string") {
      try {
        out[spec.column] = JSON.parse(value) as unknown;
      } catch {
        // Malformed stored JSON stays a string rather than failing the read.
      }
    }
  }
  return out;
}
