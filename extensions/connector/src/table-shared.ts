/**
 * Table-shared — pure helpers behind the table state classes and their `lower` capability.
 *
 * Everything here is browser-safe string building: /_jx/data URL construction with
 * template-placeholder preservation, `#/$params/` id resolution, and the JS-source emission used by
 * lowered action bodies.
 *
 * Cache-busting convention (`_v`): lowered TableQuery Requests append `_v=${(state._v || 0)}` to
 * their URL, and lowered write actions end with `state._v = (state._v || 0) + 1`. The compiled
 * Request effect re-runs whenever a template-referenced signal changes, so bumping `_v` after a
 * successful write refetches every query on the page — read-after-write without any bespoke runtime
 * machinery.
 */

/** A `${...}` template span (Jx binding syntax preserved through lowering). */
const TEMPLATE_SPAN = /(\$\{[^}]*\})/;

/**
 * Percent-encode a query value while leaving `${...}` template spans intact, so the runtime's
 * template evaluation still sees them after lowering.
 *
 * @param {string} value
 * @returns {string}
 */
export function encodeQueryValue(value: string): string {
  return value
    .split(TEMPLATE_SPAN)
    .map((part) => (TEMPLATE_SPAN.test(part) ? part : encodeURIComponent(part)))
    .join("");
}

/** The wire-facing query options a TableQuery/TableEntry def may carry. */
export interface TableQueryDef {
  table?: string;
  filter?: unknown;
  sort?: unknown;
  limit?: number;
  offset?: number;
  include?: string | string[];
  [key: string]: unknown;
}

/**
 * Build a /_jx/data URL for a query def, preserving template placeholders.
 *
 * @param {TableQueryDef} def
 * @param {{ id?: string; versionParam?: boolean }} [options] - `id` appends a row path segment;
 *   `versionParam` appends the `_v` cache-busting template (lowered Requests only)
 * @returns {string}
 */
export function buildDataUrl(
  def: TableQueryDef,
  options: { id?: string; versionParam?: boolean } = {},
): string {
  const table = def.table ?? "";
  const parts: string[] = [];
  if (def.filter !== undefined && def.filter !== null) {
    parts.push(`filter=${encodeQueryValue(JSON.stringify(def.filter))}`);
  }
  if (def.sort !== undefined && def.sort !== null) {
    parts.push(`sort=${encodeQueryValue(JSON.stringify(def.sort))}`);
  }
  if (typeof def.limit === "number") {
    parts.push(`limit=${def.limit}`);
  }
  if (typeof def.offset === "number") {
    parts.push(`offset=${def.offset}`);
  }
  const include = Array.isArray(def.include) ? def.include.join(",") : def.include;
  if (include) {
    parts.push(`include=${encodeQueryValue(include)}`);
  }
  if (options.versionParam) {
    // Read-after-write: writes bump state._v, re-running the compiled Request effect.
    parts.push("_v=${(state._v || 0)}");
  }
  const path = options.id === undefined ? `/_jx/data/${table}` : `/_jx/data/${table}/${options.id}`;
  return parts.length > 0 ? `${path}?${parts.join("&")}` : path;
}

/**
 * Resolve an id value: `#/$params/<name>` refs read route params, everything else passes through as
 * a string (template placeholders included).
 *
 * @param {unknown} id - The def's id value
 * @param {Record<string, string> | undefined} pathParams - Route params when known
 * @returns {string | undefined}
 */
export function resolveIdValue(
  id: unknown,
  pathParams: Record<string, string> | undefined,
): string | undefined {
  if (id === null || id === undefined) {
    return undefined;
  }
  if (typeof id === "object") {
    const ref = (id as { $ref?: string }).$ref;
    if (typeof ref === "string" && ref.startsWith("#/$params/")) {
      const param = ref.slice("#/$params/".length);
      return pathParams?.[param];
    }
    return undefined;
  }
  return String(id);
}

/**
 * Emit the JS source for a literal value inside a lowered Function body. Strings carrying `${...}`
 * become template literals (evaluated against state at runtime); everything else is inlined JSON.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function jsValueSource(value: unknown): string {
  if (typeof value === "string" && value.includes("${")) {
    const escaped = value.replaceAll("\\", String.raw`\\`).replaceAll("`", "\\`");
    return `\`${escaped}\``;
  }
  return JSON.stringify(value) ?? "null";
}

/** Emit the JS source of an object literal whose values go through {@link jsValueSource}. */
export function jsObjectSource(values: Record<string, unknown> | undefined): string {
  if (!values || Object.keys(values).length === 0) {
    return "{}";
  }
  const entries = Object.entries(values).map(
    ([key, value]) => `${JSON.stringify(key)}: ${jsValueSource(value)}`,
  );
  return `{ ${entries.join(", ")} }`;
}
