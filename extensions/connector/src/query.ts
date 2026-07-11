/**
 * Query — the content filter grammar over Kysely.
 *
 * Dynamic tables answer the same filter/sort/limit grammar content collections use
 * (`@jxsuite/parser/content`): a filter is an array of `{ field, op, value }` rules (or an object
 * shorthand of equality pairs), sort is `{ field, order }` (or a list), and every rule must match
 * (AND). This module translates those rules into `where()` expressions with the same semantics the
 * in-memory evaluator has — including `!=` matching NULL and `empty` treating '' and '[]' as
 * empty.
 */

import type { ExpressionBuilder, ExpressionWrapper, SelectQueryBuilder, SqlBool } from "kysely";
import type { ColumnSpec } from "./columns.ts";

/** One filter rule of the shared content grammar. */
export interface FilterRule {
  field: string;
  op: string;
  value?: unknown;
}

export interface SortRule {
  field: string;
  order?: string;
}

/** Loosely-typed database shape for dynamic tables (columns are only known at runtime). */
export type DynamicDatabase = Record<string, Record<string, unknown>>;

type DynamicSelect = SelectQueryBuilder<DynamicDatabase, string, Record<string, unknown>>;
type DynamicEb = ExpressionBuilder<DynamicDatabase, string>;
type BoolExpr = ExpressionWrapper<DynamicDatabase, string, SqlBool>;

/**
 * Normalize a wire filter (rule array or equality-object shorthand) into rules.
 *
 * @param {unknown} filter
 * @returns {FilterRule[]}
 */
export function normalizeFilter(filter: unknown): FilterRule[] {
  if (Array.isArray(filter)) {
    return (filter as FilterRule[]).filter(
      (rule) => rule && typeof rule === "object" && typeof rule.field === "string",
    );
  }
  if (filter && typeof filter === "object") {
    return Object.entries(filter as Record<string, unknown>).map(([field, value]) => ({
      field,
      op: "==",
      value,
    }));
  }
  return [];
}

/** Normalize a wire sort (single rule or list) into rules. */
export function normalizeSort(sort: unknown): SortRule[] {
  const list = Array.isArray(sort) ? sort : sort ? [sort] : [];
  return (list as SortRule[]).filter(
    (rule) => rule && typeof rule === "object" && typeof rule.field === "string",
  );
}

/** Resolve a grammar field name to its physical column (`author` → `author_id` for refs). */
export function columnForField(field: string, specs: ColumnSpec[]): string {
  if (field === "id") {
    return "id";
  }
  const spec = specs.find((s) => s.field === field || s.column === field);
  return spec?.column ?? field;
}

/**
 * Apply filter rules to a select builder (AND semantics, matching the in-memory evaluator).
 *
 * @param {DynamicSelect} qb
 * @param {FilterRule[]} rules
 * @param {ColumnSpec[]} specs - Column plan (field → column mapping, storage classes)
 * @returns {DynamicSelect}
 */
export function applyFilter(
  qb: DynamicSelect,
  rules: FilterRule[],
  specs: ColumnSpec[],
): DynamicSelect {
  let out = qb;
  for (const rule of rules) {
    const column = columnForField(rule.field, specs);
    const spec = specs.find((s) => s.column === column) ?? null;
    out = out.where((eb) => ruleExpression(eb, rule, column, spec));
  }
  return out;
}

/**
 * Translate one filter rule into a boolean expression.
 *
 * @param {DynamicEb} eb
 * @param {FilterRule} rule
 * @param {string} column - Physical column name
 * @param {ColumnSpec | null} spec - Column spec when known (storage-aware `contains`)
 * @returns {BoolExpr}
 */
function ruleExpression(
  eb: DynamicEb,
  rule: FilterRule,
  column: string,
  spec: ColumnSpec | null,
): BoolExpr {
  const { op, value } = rule;
  switch (op) {
    case "==": {
      return value === null || value === undefined
        ? eb(column, "is", null)
        : eb(column, "=", storageValue(spec, value));
    }
    case "!=": {
      // NULL never equals the probe in the in-memory grammar, so NULL rows match `!=`.
      return value === null || value === undefined
        ? eb(column, "is not", null)
        : eb.or([eb(column, "!=", storageValue(spec, value)), eb(column, "is", null)]);
    }
    case "empty": {
      return eb.or([eb(column, "is", null), eb(column, "=", ""), eb(column, "=", "[]")]);
    }
    case "not empty": {
      return eb.and([eb(column, "is not", null), eb(column, "!=", ""), eb(column, "!=", "[]")]);
    }
    case "contains": {
      return eb(column, "like", containsPattern(spec, value));
    }
    case "not contains": {
      return eb.or([eb(column, "not like", containsPattern(spec, value)), eb(column, "is", null)]);
    }
    case ">":
    case "<":
    case ">=":
    case "<=": {
      return eb(column, op, Number(value));
    }
    default: {
      // Unknown ops match everything, like the in-memory evaluator.
      return eb.lit(true as SqlBool);
    }
  }
}

/** LIKE pattern for `contains`: JSON columns match the JSON-encoded element. */
function containsPattern(spec: ColumnSpec | null, value: unknown): string {
  if (spec?.storage === "json") {
    const encoded = JSON.stringify(value);
    return `%${escapeLike(encoded)}%`;
  }
  return `%${escapeLike(String(value ?? ""))}%`;
}

/** Escape LIKE wildcards in a literal probe. */
function escapeLike(text: string): string {
  return text.replaceAll("%", String.raw`\%`).replaceAll("_", String.raw`\_`);
}

/** Coerce a filter probe value to the column's storage representation. */
function storageValue(spec: ColumnSpec | null, value: unknown): string | number {
  if (spec?.storage === "boolean") {
    const truthy = value === true || value === "true" || value === 1 || value === "1";
    return truthy ? 1 : 0;
  }
  if (spec?.storage === "json") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return String(value);
}

/**
 * Apply sort rules to a select builder.
 *
 * @param {DynamicSelect} qb
 * @param {SortRule[]} rules
 * @param {ColumnSpec[]} specs
 * @returns {DynamicSelect}
 */
export function applySort(
  qb: DynamicSelect,
  rules: SortRule[],
  specs: ColumnSpec[],
): DynamicSelect {
  let out = qb;
  for (const rule of rules) {
    const column = columnForField(rule.field, specs);
    out = out.orderBy(column, rule.order === "desc" ? "desc" : "asc");
  }
  return out;
}
