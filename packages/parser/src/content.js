/**
 * Content.js — ContentCollection and ContentEntry class implementations
 *
 * Provides the $implementation sidecar for ContentCollection.class.json and
 * ContentEntry.class.json. Also exports the pure query functions (evaluateFilterRule,
 * queryContentType, findEntry) used by both the classes and the server endpoint.
 */

// ─── Query Functions ────────────────────────────────────────────────────────

/**
 * Evaluate a single filter rule against an entry.
 *
 * @param {{ field: string; op: string; value?: unknown }} rule
 * @param {ContentLoaderEntry} entry
 * @returns {boolean}
 */
export function evaluateFilterRule(rule, entry) {
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
      return /** @type {any} */ (actual) > /** @type {any} */ (rule.value);
    case "<":
      return /** @type {any} */ (actual) < /** @type {any} */ (rule.value);
    case ">=":
      return /** @type {any} */ (actual) >= /** @type {any} */ (rule.value);
    case "<=":
      return /** @type {any} */ (actual) <= /** @type {any} */ (rule.value);
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
export function queryContentType(entries, query = {}) {
  let result = [...entries];

  // Filter
  if (query.filter) {
    /** @type {{ field: string; op: string; value?: unknown }[]} */
    let rules;
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
        const aVal = /** @type {string | number} */ (field === "id" ? a.id : (a.data[field] ?? ""));
        const bVal = /** @type {string | number} */ (field === "id" ? b.id : (b.data[field] ?? ""));
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
export function findEntry(entries, id) {
  return entries.find((e) => e.id === id) ?? null;
}

// ─── Class Implementations ──────────────────────────────────────────────────

/**
 * @typedef {{
 *   contentType?: string;
 *   filter?: unknown;
 *   sort?: unknown;
 *   limit?: number;
 *   _project?: { contentTypes?: Map<string, ContentLoaderEntry[]>; [k: string]: unknown };
 *   [k: string]: unknown;
 * }} CollectionConfig
 *
 * @typedef {{
 *   contentType?: string;
 *   id?: unknown;
 *   field?: string;
 *   _project?: { contentTypes?: Map<string, ContentLoaderEntry[]>; [k: string]: unknown };
 *   _document?: { route?: { _pathParams?: Record<string, string> }; [k: string]: unknown };
 *   [k: string]: unknown;
 * }} EntryConfig
 */

export class ContentCollection {
  /** @param {CollectionConfig} config */
  constructor(config) {
    this.config = config;
  }

  resolve() {
    const { contentType, filter, sort, limit, _project } = this.config;
    const entries = _project?.contentTypes?.get(contentType ?? "");
    if (!entries) return [];
    return queryContentType(entries, /** @type {any} */ ({ filter, sort, limit }));
  }
}

export class ContentEntry {
  /** @param {EntryConfig} config */
  constructor(config) {
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
      /** @type {{ $ref?: string }} */ (resolvedId).$ref?.startsWith("#/$params/")
    ) {
      const paramName = /** @type {{ $ref: string }} */ (resolvedId).$ref.replace("#/$params/", "");
      resolvedId = _document?.route?._pathParams?.[paramName];
    }
    if (!resolvedId) return null;

    if (field && field !== "id") {
      return entries.find((e) => e.data[field] === resolvedId) ?? null;
    }
    return findEntry(entries, /** @type {string} */ (resolvedId));
  }
}
