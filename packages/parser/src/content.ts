/**
 * Content.js — ContentCollection and ContentEntry class implementations
 *
 * Provides the $implementation sidecar for ContentCollection.class.json and
 * ContentEntry.class.json. Also exports the pure query functions (evaluateFilterRule,
 * queryContentType, findEntry) used by both the classes and the server endpoint.
 */

import type { ContentLoaderEntry } from "./types";

interface CollectionConfig {
  contentType?: string;
  filter?: unknown;
  sort?: unknown;
  limit?: number;
  _project?: { contentTypes?: Map<string, ContentLoaderEntry[]>; [k: string]: unknown };
  [k: string]: unknown;
}

interface EntryConfig {
  contentType?: string;
  id?: unknown;
  field?: string;
  _project?: { contentTypes?: Map<string, ContentLoaderEntry[]>; [k: string]: unknown };
  _document?: { route?: { _pathParams?: Record<string, string> }; [k: string]: unknown };
  [k: string]: unknown;
}

// ─── Query Functions ────────────────────────────────────────────────────────

/**
 * Evaluate a single filter rule against an entry.
 *
 * @param {{ field: string; op: string; value?: unknown }} rule
 * @param {ContentLoaderEntry} entry
 * @returns {boolean}
 */
export function evaluateFilterRule(
  rule: { field: string; op: string; value?: unknown },
  entry: ContentLoaderEntry,
) {
  const actual = rule.field === "id" ? entry.id : entry.data[rule.field];
  switch (rule.op) {
    case "==":
      return actual === rule.value;
    case "!=":
      return actual !== rule.value;
    case "empty":
      return actual == null || actual === "" || (Array.isArray(actual) && actual.length === 0);
    case "not empty":
      return actual != null && actual !== "" && !(Array.isArray(actual) && actual.length === 0);
    case "contains":
      return typeof actual === "string" && actual.includes(String(rule.value ?? ""));
    case "not contains":
      return typeof actual === "string" && !actual.includes(String(rule.value ?? ""));
    case ">":
      return Number(actual) > Number(rule.value);
    case "<":
      return Number(actual) < Number(rule.value);
    case ">=":
      return Number(actual) >= Number(rule.value);
    case "<=":
      return Number(actual) <= Number(rule.value);
    default:
      return true;
  }
}

/**
 * Query a loaded content type with filter, sort, and limit.
 *
 * @param {ContentLoaderEntry[]} entries - Full content type entries
 * @param {{
 *   filter?: Record<string, unknown> | Array<{ field: string; op: string; value?: unknown }>;
 *   sort?: { field: string; order?: string } | Array<{ field: string; order?: string }>;
 *   limit?: number;
 * }} [query]
 * @returns {ContentLoaderEntry[]} Filtered, sorted, limited entries
 */
export function queryContentType(
  entries: ContentLoaderEntry[],
  query: {
    filter?: Record<string, unknown> | Array<{ field: string; op: string; value?: unknown }>;
    sort?: { field: string; order?: string } | Array<{ field: string; order?: string }>;
    limit?: number;
  } = {},
) {
  let result = [...entries];

  // Filter
  if (query.filter) {
    let rules: { field: string; op: string; value?: unknown }[];
    if (Array.isArray(query.filter)) {
      rules = query.filter;
    } else if (typeof query.filter === "object") {
      rules = Object.entries(query.filter).map(([field, value]) => ({ field, op: "==", value }));
    } else {
      rules = [];
    }
    result = result.filter((entry) => rules.every((rule) => evaluateFilterRule(rule, entry)));
  }

  // Sort
  if (query.sort) {
    const sortRules = Array.isArray(query.sort) ? query.sort : [query.sort];
    result.sort((a, b) => {
      for (const { field, order = "asc" } of sortRules) {
        const aVal = field === "id" ? a.id : ((a.data[field] ?? "") as string | number);
        const bVal = field === "id" ? b.id : ((b.data[field] ?? "") as string | number);
        if (aVal < bVal) return order === "asc" ? -1 : 1;
        if (aVal > bVal) return order === "asc" ? 1 : -1;
      }
      return 0;
    });
  }

  // Limit
  if (query.limit && query.limit > 0) {
    result = result.slice(0, query.limit);
  }

  return result;
}

/**
 * Find a single entry by ID in a content type.
 *
 * @param {ContentLoaderEntry[]} entries - Full content type entries
 * @param {string} id - Entry ID to find
 * @returns {ContentLoaderEntry | null} The matching entry or null
 */
export function findEntry(entries: ContentLoaderEntry[], id: string) {
  return entries.find((e) => e.id === id) ?? null;
}

// ─── Class Implementations ──────────────────────────────────────────────────

export class ContentCollection {
  config: CollectionConfig;
  /** @param {CollectionConfig} config */
  constructor(config: CollectionConfig) {
    this.config = config;
  }

  resolve() {
    const { contentType, filter, sort, limit, _project } = this.config;
    const entries = _project?.contentTypes?.get(contentType ?? "");
    if (!entries) return [];
    return queryContentType(entries, {
      filter: filter as
        | Record<string, unknown>
        | Array<{ field: string; op: string; value?: unknown }>
        | undefined,
      sort: sort as
        | { field: string; order?: string }
        | Array<{ field: string; order?: string }>
        | undefined,
      limit,
    });
  }
}

export class ContentEntry {
  config: EntryConfig;
  /** @param {EntryConfig} config */
  constructor(config: EntryConfig) {
    this.config = config;
  }

  resolve() {
    const { contentType, id, field, _project, _document } = this.config;
    const entries = _project?.contentTypes?.get(contentType ?? "");
    if (!entries) return null;

    let resolvedId = id;
    if (
      resolvedId &&
      typeof resolvedId === "object" &&
      (resolvedId as { $ref?: string }).$ref?.startsWith("#/$params/")
    ) {
      const paramName = (resolvedId as { $ref: string }).$ref.replace("#/$params/", "");
      resolvedId = _document?.route?._pathParams?.[paramName];
    }
    if (!resolvedId) return null;

    if (field && field !== "id") {
      return entries.find((e: ContentLoaderEntry) => e.data[field] === resolvedId) ?? null;
    }
    return findEntry(entries, resolvedId as string);
  }
}
